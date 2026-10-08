import { ema } from "../indicators/ema.js";
import { rsi } from "../indicators/rsi.js";
import { displacement, engulfing, geometry, pinBar } from "../patterns/candles.js";
import type { EvalCtx, PatternKind, Setup } from "../types.js";

/** Momentum pullback in the direction of the M15 trend regime. */
export function pullback(ctx: EvalCtx): Setup | null {
  const { snap, m5 } = ctx;
  const long = snap.regime === "TREND_UP";
  if (!long && snap.regime !== "TREND_DOWN") return null;
  const n = m5.length;
  const cur = m5[n - 1], prev = m5[n - 2];
  if (!cur || !prev || n < 60) return null;
  const closes = m5.map((b) => b.c);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const atr = snap.m5.atr14;
  const E20 = e20[n - 1]!, E50 = e50[n - 1]!;
  if (long ? !(E20 > E50) : !(E20 < E50)) return null;

  const last8 = m5.slice(-9, -1);
  const touched = last8.some((b, k) => {
    const i = n - 9 + k;
    return long ? b.l <= e20[i]! + 0.25 * atr : b.h >= e20[i]! - 0.25 * atr;
  });
  const respected = last8.every((b, k) => {
    const i = n - 9 + k;
    return long ? b.c >= e50[i]! : b.c <= e50[i]!;
  });
  if (!touched || !respected) return null;

  const dir = long ? "bull" : "bear";
  let pattern: PatternKind | null = null;
  if (engulfing(prev, cur) === dir) pattern = "engulf";
  else if (pinBar(cur) === dir) pattern = "pin";
  else {
    const g = geometry(cur);
    const strong = long ? g.closePos >= 0.7 && cur.c > prev.h : g.closePos <= 0.3 && cur.c < prev.l;
    if (displacement(cur, atr) === dir && strong) pattern = "displacement";
    else if (strong) pattern = "break";
  }
  if (!pattern) return null;
  if (long ? !(cur.c > E20) : !(cur.c < E20)) return null;
  const R = r[n - 1]!, Rp = r[n - 2]!;
  if (long ? !(R > 50 && R > Rp) : !(R < 50 && R < Rp)) return null;

  const spread = ctx.ask - ctx.bid;
  const swingLow = Math.min(...last8.map((b) => b.l), cur.l);
  const swingHigh = Math.max(...last8.map((b) => b.h), cur.h);
  const sl = long ? Math.min(cur.l, swingLow) - 0.2 * atr - spread : Math.max(cur.h, swingHigh) + 0.2 * atr + spread;
  return { strategy: "pullback", side: long ? "BUY" : "SELL", pattern, sl, counterTrend: false, notes: { ema20: E20, ema50: E50, rsi: R, rsiPrev: Rp } };
}
