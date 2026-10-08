import type { Instrument } from "./config.js";
import type { Level } from "./levels/sessions.js";
import type { Side } from "./types.js";

export const roundPrice = (i: Instrument, p: number) => Number(p.toFixed(i === "XAU_USD" ? 2 : 5));
/** commission per lot (USD, round trip) expressed in price units */
export const commissionInPrice = (i: Instrument, perLot: number) => perLot / (i === "XAU_USD" ? 100 : 100_000);

export interface SltpInput {
  instrument: Instrument;
  side: Side;
  bid: number;
  ask: number;
  sl: number;
  atr: number;
  tp1R: number;
  tp2R: number;
  levels: Level[];
  commissionPerLot: number;
  tp2Alt?: number;
}

export type SltpResult =
  | { ok: true; entry: number; sl: number; tp1: number; tp2: number; risk: number; rr1: number; rr2: number; costRatio: number; pathR: number | null; tp2Capped: boolean }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

/**
 * Entry = ask for BUY, bid for SELL. TP1 = entry ± tp1R*risk, TP2 = entry ± tp2R*risk,
 * capped just before the next key level when that still leaves >= 1.5R, otherwise skipped.
 */
export function buildSltp(x: SltpInput): SltpResult {
  const d = x.side === "BUY" ? 1 : -1;
  const entry = x.side === "BUY" ? x.ask : x.bid;
  const spread = x.ask - x.bid;
  const risk = (entry - x.sl) * d;
  if (!(risk > 0)) return { ok: false, reason: "SL on wrong side of entry" };

  const slAtr = risk / x.atr;
  if (slAtr < 0.8 || slAtr > 2.0) return { ok: false, reason: `SL distance ${slAtr.toFixed(2)}x ATR outside [0.8, 2.0]`, detail: { slAtr } };

  const costRatio = (spread + commissionInPrice(x.instrument, x.commissionPerLot)) / risk;
  if (costRatio > 0.15) return { ok: false, reason: `Cost ratio ${costRatio.toFixed(3)} > 0.15`, detail: { costRatio } };

  const tp1 = entry + d * x.tp1R * risk;
  let tp2 = entry + d * x.tp2R * risk;
  if (x.tp2Alt !== undefined && (x.tp2Alt - entry) * d >= 1.5 * risk) tp2 = x.tp2Alt;

  // levels strictly in the path, nearest first (ignore levels within 0.05R — that's where we are)
  const path = x.levels
    .map((l) => ({ ...l, dist: (l.price - entry) * d }))
    .filter((l) => l.dist > 0.05 * risk)
    .sort((a, b) => a.dist - b.dist);
  const first = path[0];
  const pathR = first ? first.dist / risk : null;

  if (first && first.dist < 1.0 * risk && first.dist < (tp1 - entry) * d + 1e-12)
    return { ok: false, reason: `Key level ${first.name} ${first.price} within ${(first.dist / risk).toFixed(2)}R before TP1`, detail: { level: first.name } };

  let tp2Capped = false;
  const blocker = path.find((l) => l.dist < (tp2 - entry) * d && l.dist > (tp1 - entry) * d);
  if (blocker) {
    const cap = blocker.price - d * Math.max(spread, 0.05 * x.atr);
    if ((cap - entry) * d >= 1.5 * risk) { tp2 = cap; tp2Capped = true; }
    else return { ok: false, reason: `TP2 blocked by ${blocker.name} ${blocker.price} (< 1.5R)`, detail: { level: blocker.name } };
  }

  const r = (p: number) => roundPrice(x.instrument, p);
  const out = { entry: r(entry), sl: r(x.sl), tp1: r(tp1), tp2: r(tp2) };
  const rr1 = ((out.tp1 - out.entry) * d) / ((out.entry - out.sl) * d);
  const rr2 = ((out.tp2 - out.entry) * d) / ((out.entry - out.sl) * d);
  if (rr1 < 1.0 - 1e-9) return { ok: false, reason: `RR(TP1) ${rr1.toFixed(2)} < 1.0` };
  if (rr2 < 1.5 - 1e-9) return { ok: false, reason: `RR(TP2) ${rr2.toFixed(2)} < 1.5` };
  return { ok: true, ...out, risk, rr1, rr2, costRatio, pathR, tp2Capped };
}
