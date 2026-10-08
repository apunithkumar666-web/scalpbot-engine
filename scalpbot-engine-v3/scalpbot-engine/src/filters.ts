import { PROFILES, type Instrument } from "./config.js";
import { appPair } from "./config.js";
import { istWindow } from "./levels/sessions.js";
import type { EvalCtx, Side } from "./types.js";

/** Global hard filters for this pair/bar. Returns a reason when blocked. */
export function globalFilter(ctx: EvalCtx): string | null {
  const s = ctx.settings;
  if (!istWindow(ctx.t - 1, s.window_start, s.window_end).inWindow) return "outside window";
  if (ctx.stale) return "stale data";
  if (s.paused) return "paused";
  if (!s.pairs_enabled.includes(appPair(ctx.instrument))) return "pair disabled";
  if (ctx.snap.regime === "DEAD" || ctx.snap.regime === "VOLATILE") return `regime ${ctx.snap.regime}`;
  const spread = ctx.ask - ctx.bid;
  const max = maxSpread(ctx.instrument, s.spread_max_xau, s.spread_max_eur);
  if (spread > max) return `spread ${spread.toFixed(5)} > max ${Number(max.toFixed(6))}`;
  const ev = ctx.news.blackout(ctx.t);
  if (ev) return `news blackout: ${ev.country} ${ev.title}`;
  const prof = PROFILES[s.profile];
  if (ctx.openTrades >= s.max_open) return `open trades cap ${s.max_open}`;
  const cap = Math.min(s.max_signals_per_window, prof.maxSignals);
  if (ctx.signalsThisWindow >= cap) return `signals per window cap ${cap}`;
  if (ctx.state.lastLossAt && ctx.t - ctx.state.lastLossAt < prof.cooldownMin * 60_000) return `cooldown after loss (${prof.cooldownMin} min)`;
  return null;
}

/** Same pair+side within the last 15 minutes. */
export function duplicateFilter(ctx: EvalCtx, side: Side): string | null {
  const recent = ctx.state.recent.find((r) => r.side === side && ctx.t - r.t < 15 * 60_000);
  return recent ? `same ${side} signal within 15 min` : null;
}

/**
 * Max spread in price units. The app stores EURUSD in pips (e.g. 1.2) — anything >= 0.01 is
 * treated as pips and converted (1 pip = 0.0001). XAUUSD is in dollars.
 */
export const maxSpread = (i: Instrument, xau: number, eur: number) => (i === "XAU_USD" ? xau : eur >= 0.01 ? eur * 0.0001 : eur);
