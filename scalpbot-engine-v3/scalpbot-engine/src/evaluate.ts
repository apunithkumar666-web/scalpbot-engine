import { PROFILES, appPair } from "./config.js";
import { duplicateFilter, globalFilter } from "./filters.js";
import { buildSltp } from "./sltp.js";
import { score } from "./scoring.js";
import { rsi } from "./indicators/rsi.js";
import { pullback } from "./strategies/pullback.js";
import { sweep } from "./strategies/sweep.js";
import { orb } from "./strategies/orb.js";
import type { EvalCtx, Setup, Side, StrategyName } from "./types.js";

export interface SignalOut {
  pair: "XAUUSD" | "EURUSD"; side: Side; entry: number; sl: number; tp1: number; tp2: number;
  score: number; strategy: StrategyName; entry_time: string; features: Record<string, unknown>; idempotency_key: string;
}
export interface SkipOut { pair: "XAUUSD" | "EURUSD"; strategy: string; side?: Side; reason: string; features: Record<string, unknown> }
export type Outcome = { kind: "signal"; signal: SignalOut } | { kind: "skip"; skip: SkipOut; post: boolean };

const STRATS: Record<StrategyName, (c: EvalCtx) => Setup | null> = { pullback, sweep, orb };

/** Evaluate all strategies for one pair on a just-closed M5 bar. Used by live and backtest. */
export function evaluate(ctx: EvalCtx): Outcome[] {
  if (ctx.settings.pre_arm_enabled) return [];
  const pair = appPair(ctx.instrument);
  const base = baseFeatures(ctx);
  const g = globalFilter(ctx);
  if (g) return [{ kind: "skip", skip: { pair, strategy: "all", reason: g, features: base }, post: g !== "outside window" && g !== "paused" }];

  const out: Outcome[] = [];
  const prof = PROFILES[ctx.settings.profile];
  for (const name of Object.keys(STRATS) as StrategyName[]) {
    if (ctx.settings.strategies_enabled[name] === false) continue;
    const setup = STRATS[name](ctx);
    if (!setup) continue;
    const skip = (reason: string, extra: Record<string, unknown> = {}): Outcome =>
      ({ kind: "skip", post: true, skip: { pair, strategy: name, side: setup.side, reason, features: { ...base, setup: setup.notes, ...extra } } });

    const dup = duplicateFilter(ctx, setup.side);
    if (dup) { out.push(skip(dup)); continue; }

    const st = buildSltp({
      instrument: ctx.instrument, side: setup.side, bid: ctx.bid, ask: ctx.ask, sl: setup.sl, atr: ctx.snap.m5.atr14,
      tp1R: ctx.settings.tp1_r, tp2R: ctx.settings.tp2_r, levels: ctx.levels, commissionPerLot: ctx.commissionPerLot,
      ...(setup.tp2Alt !== undefined ? { tp2Alt: setup.tp2Alt } : {}),
    });
    if (!st.ok) { out.push(skip(st.reason, st.detail ?? {})); continue; }

    const closes = ctx.m5.map((b) => b.c);
    const r = rsi(closes, 14);
    const sc = score({
      instrument: ctx.instrument, side: setup.side, regime: ctx.snap.regime, eurRegime: ctx.eurRegime, pattern: setup.pattern,
      pathR: st.pathR, rsi: r[r.length - 1] ?? 50, rsiPrev: r[r.length - 2] ?? 50, slope50: ctx.snap.m15.slope50,
      atrPct: ctx.snap.m5.atrPct, t: ctx.t, costRatio: st.costRatio, counterTrend: setup.counterTrend,
      newsWithin30: ctx.news.soon(ctx.t, 30) !== null,
    });
    const features = { ...base, setup: setup.notes, pattern: setup.pattern, level_used: setup.levelUsed ?? null, score: sc, rr1: st.rr1, rr2: st.rr2, cost_ratio: st.costRatio, path_r: st.pathR, tp1_r: st.tp1R, tp2_r: st.tp2R };
    const minScore = Math.max(prof.minScore, ctx.settings.min_score);
    if (sc.total < minScore) { out.push(skip(`score ${sc.total} < ${minScore}`, { score: sc })); continue; }

    out.push({
      kind: "signal",
      signal: {
        pair, side: setup.side, entry: st.entry, sl: st.sl, tp1: st.tp1, tp2: st.tp2, score: sc.total, strategy: name,
        entry_time: new Date(ctx.t).toISOString(), features, idempotency_key: `${name}:${pair}:${new Date(ctx.t).toISOString()}`,
      },
    });
  }
  return out;
}

function baseFeatures(ctx: EvalCtx): Record<string, unknown> {
  return {
    bar_close: new Date(ctx.t).toISOString(), regime: ctx.snap.regime, eur_regime: ctx.eurRegime, m5: ctx.snap.m5, m15: ctx.snap.m15,
    bid: ctx.bid, ask: ctx.ask, spread: ctx.ask - ctx.bid, sessions: ctx.sessions, profile: ctx.settings.profile,
  };
}
