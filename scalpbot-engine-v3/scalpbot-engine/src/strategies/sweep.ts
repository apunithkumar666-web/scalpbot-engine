import { DateTime } from "luxon";
import { PROFILES } from "../config.js";
import { engulfing, geometry, pinBar } from "../patterns/candles.js";
import type { Range } from "../levels/sessions.js";
import type { Bar, EvalCtx, PatternKind, Setup, Side } from "../types.js";

interface NamedRange { name: string; range: Range; isPrevDay: boolean }

/** Liquidity sweep reversal at session extremes. */
export function sweep(ctx: EvalCtx): Setup | null {
  const { snap, m5, sessions } = ctx;
  const atr = snap.m5.atr14;
  const n = m5.length;
  const cur = m5[n - 1];
  if (!cur || n < 10) return null;
  const ist = DateTime.fromMillis(ctx.t, { zone: "Asia/Kolkata" });
  const afterOr = ist.hour * 60 + ist.minute >= 19 * 60;

  const ranges: NamedRange[] = [];
  if (sessions.london) ranges.push({ name: "London", range: sessions.london, isPrevDay: false });
  if (sessions.prevDay) ranges.push({ name: "PrevDay", range: sessions.prevDay, isPrevDay: true });
  if (sessions.asian) ranges.push({ name: "Asian", range: sessions.asian, isPrevDay: false });
  if (afterOr && sessions.or) ranges.push({ name: "OR", range: sessions.or, isPrevDay: false });

  const aggressive = ctx.settings.profile === "aggressive" && PROFILES.aggressive.sweepCounterTrend;
  const spread = ctx.ask - ctx.bid;

  for (const nr of ranges) {
    for (const side of ["SELL", "BUY"] as Side[]) {
      const level = side === "SELL" ? nr.range.high : nr.range.low;
      const hit = findSweep(m5, level, side, atr);
      if (!hit) continue;
      // Skip strong counter-trend unless the level is a prev-day extreme or profile is aggressive
      const against = side === "SELL" ? snap.m15.slope50 >= 0.6 : snap.m15.slope50 <= -0.6;
      if (against && !nr.isPrevDay && !aggressive) continue;
      const counterTrend = (side === "SELL" && snap.regime === "TREND_UP") || (side === "BUY" && snap.regime === "TREND_DOWN");
      const extreme = side === "SELL" ? hit.bar.h : hit.bar.l;
      const sl = side === "SELL" ? extreme + 0.2 * atr + spread : extreme - 0.2 * atr - spread;
      const mid = (nr.range.high + nr.range.low) / 2;
      const entry = side === "BUY" ? ctx.ask : ctx.bid;
      const d = side === "BUY" ? 1 : -1;
      const risk = (entry - sl) * d;
      // TP2 = nearer of 2R or opposite range midpoint, min 1.5R
      const twoR = entry + d * 2 * risk;
      let tp2Alt = (mid - entry) * d > 0 && (mid - entry) * d < 2 * risk ? mid : twoR;
      if ((tp2Alt - entry) * d < 1.5 * risk) tp2Alt = entry + d * 1.5 * risk;
      return {
        strategy: "sweep", side, pattern: hit.pattern, sl, counterTrend, tp2Alt, levelUsed: `${nr.name} ${side === "SELL" ? "high" : "low"}`,
        notes: { level, sweepBarT: hit.bar.t, confirmation: hit.confirmed, fakeoutFlag: ctx.state.fakeoutAt !== undefined && ctx.t - ctx.state.fakeoutAt < 60 * 60_000 },
      };
    }
  }
  return null;
}

function pierced(b: Bar, level: number, side: Side, atr: number) {
  const depth = side === "SELL" ? b.h - level : level - b.l;
  const closedBack = side === "SELL" ? b.c < level : b.c > level;
  return depth >= 0.1 * atr && depth <= 1.0 * atr && closedBack;
}

function findSweep(m5: Bar[], level: number, side: Side, atr: number): { bar: Bar; pattern: PatternKind; confirmed: boolean } | null {
  const n = m5.length;
  const cur = m5[n - 1]!, prev = m5[n - 2]!;
  // 1) the just-closed bar is the sweep bar with a dominant rejection wick
  if (pierced(cur, level, side, atr)) {
    const g = geometry(cur);
    const wick = side === "SELL" ? g.upperWick : g.lowerWick;
    if (g.range > 0 && wick >= 0.5 * g.range) {
      const pat: PatternKind = pinBar(cur) === (side === "SELL" ? "bear" : "bull") ? "pin" : engulfing(prev, cur) === (side === "SELL" ? "bear" : "bull") ? "engulf" : "break";
      return { bar: cur, pattern: pat, confirmed: false };
    }
  }
  // 2) confirmation within 3 bars: close beyond the sweep bar's opposite extreme
  for (let k = 2; k <= 4; k++) {
    const sb = m5[n - k];
    if (!sb || !pierced(sb, level, side, atr)) continue;
    const between = m5.slice(n - k + 1, n - 1);
    const already = between.some((b) => (side === "SELL" ? b.c < sb.l : b.c > sb.l));
    if (already) return null;
    const ok = side === "SELL" ? cur.c < sb.l : cur.c > sb.h;
    if (ok) return { bar: { ...sb, h: Math.max(sb.h, ...between.map((b) => b.h), cur.h), l: Math.min(sb.l, ...between.map((b) => b.l), cur.l) }, pattern: "break", confirmed: true };
  }
  return null;
}
