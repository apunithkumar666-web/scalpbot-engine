import { DateTime } from "luxon";
import { displacement, engulfing, pinBar } from "../patterns/candles.js";
import type { EvalCtx, PatternKind, Setup, Side } from "../types.js";

/** Opening-range breakout + retest (after 19:00 IST). */
export function orb(ctx: EvalCtx): Setup | null {
  const { m5, snap, sessions } = ctx;
  const or = sessions.or;
  const atr = snap.m5.atr14;
  if (!or || !(atr > 0)) return null;
  if (ctx.t < ctx.windowOpen + 30 * 60_000) return null;
  if (or.width < 1.5 * atr || or.width > 6 * atr) return null;
  const n = m5.length;
  const cur = m5[n - 1], prev = m5[n - 2];
  if (!cur || !prev) return null;
  const day = DateTime.fromMillis(ctx.t, { zone: "Asia/Kolkata" }).toISODate();
  const orEnd = ctx.windowOpen + 30 * 60_000;
  const spread = ctx.ask - ctx.bid;

  for (const side of ["BUY", "SELL"] as Side[]) {
    const long = side === "BUY";
    const key = `${day}:${side}`;
    if (ctx.state.orbAttempts.has(key)) continue;
    // M15 bias must match or be neutral
    if (long && snap.regime === "TREND_DOWN") continue;
    if (!long && snap.regime === "TREND_UP") continue;
    const boundary = long ? or.high : or.low;
    const dir = long ? "bull" : "bear";

    // breakout bar within the 6 bars before the current one
    for (let k = 2; k <= 7; k++) {
      const bi = n - k;
      const b = m5[bi];
      if (!b || b.t < orEnd) continue;
      const beyond = long ? b.c >= boundary + 0.1 * atr : b.c <= boundary - 0.1 * atr;
      if (!beyond || displacement(b, atr) !== dir) continue;
      const after = m5.slice(bi + 1, n);
      // close back inside OR = fakeout, flag for sweep strategy
      if (after.some((x) => (long ? x.c < or.high : x.c > or.low))) {
        ctx.state.fakeoutAt = ctx.t;
        ctx.state.orbAttempts.add(key);
        break;
      }
      const touches = long ? cur.l <= boundary + 0.15 * atr && cur.l >= boundary - 0.15 * atr : cur.h >= boundary - 0.15 * atr && cur.h <= boundary + 0.15 * atr;
      let pattern: PatternKind | null = null;
      if (pinBar(cur) === dir) pattern = "pin";
      else if (engulfing(prev, cur) === dir) pattern = "engulf";
      const closesBack = long ? cur.c > boundary : cur.c < boundary;
      if (!touches || !pattern || !closesBack) continue;

      ctx.state.orbAttempts.add(key);
      const mid = (or.high + or.low) / 2;
      const extreme = long ? cur.l : cur.h;
      // the closer of retest extreme or OR midpoint
      const base = long ? Math.max(extreme, mid) : Math.min(extreme, mid);
      const sl = long ? base - 0.2 * atr - spread : base + 0.2 * atr + spread;
      const entry = long ? ctx.ask : ctx.bid;
      const tp2Alt = entry + (long ? 1 : -1) * or.width;
      return { strategy: "orb", side, pattern, sl, counterTrend: false, tp2Alt, levelUsed: `OR ${long ? "high" : "low"}`, notes: { orHigh: or.high, orLow: or.low, orWidth: or.width, breakoutT: b.t } };
    }
  }
  return null;
}
