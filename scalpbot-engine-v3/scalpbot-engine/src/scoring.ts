import { DateTime } from "luxon";
import type { Instrument } from "./config.js";
import type { Regime } from "./regime.js";
import { usdProxy } from "./regime.js";
import type { PatternKind, Side } from "./types.js";

export interface ScoreInput {
  instrument: Instrument;
  side: Side;
  regime: Regime;
  eurRegime: Regime | null;
  pattern: PatternKind;
  pathR: number | null;
  rsi: number;
  rsiPrev: number;
  slope50: number;
  atrPct: number;
  t: number;
  costRatio: number;
  counterTrend: boolean;
  newsWithin30: boolean;
}

export interface ScoreBreakdown {
  bias: number; pattern: number; level: number; momentum: number; volatility: number;
  timing: number; usdProxy: number; cost: number; counterTrend: number; news: number; total: number;
}

export function score(x: ScoreInput): ScoreBreakdown {
  const long = x.side === "BUY";
  const bias = x.regime === "TREND_UP" ? (long ? 25 : 0) : x.regime === "TREND_DOWN" ? (long ? 0 : 25) : 10;
  const pattern = x.pattern === "engulf" || x.pattern === "pin" ? 20 : 10;
  const level = x.pathR === null || x.pathR >= 2 ? 15 : x.pathR >= 1.5 ? 8 : 0;
  const rsiAligned = long ? x.rsi > 50 && x.rsi > x.rsiPrev : x.rsi < 50 && x.rsi < x.rsiPrev;
  const slopeAligned = long ? x.slope50 > 0 : x.slope50 < 0;
  const momentum = (rsiAligned ? 6 : 0) + (slopeAligned ? 4 : 0);
  const volatility = x.atrPct >= 30 && x.atrPct <= 80 ? 10 : 0;
  const ist = DateTime.fromMillis(x.t, { zone: "Asia/Kolkata" });
  const mins = ist.hour * 60 + ist.minute;
  const timing = mins >= 19 * 60 && mins <= 21 * 60 + 30 ? 10 : 5;
  const proxy = x.eurRegime ? usdProxy(x.eurRegime) : "neutral";
  // XAU and EUR both rise when USD is weak
  const usd = (long && proxy === "usd_weak") || (!long && proxy === "usd_strong") ? 5 : 0;
  const cost = x.costRatio <= 0.1 ? 5 : 0;
  const counterTrend = x.counterTrend ? -15 : 0;
  const news = x.newsWithin30 ? -20 : 0;
  const total = Math.max(0, Math.min(100, bias + pattern + level + momentum + volatility + timing + usd + cost + counterTrend + news));
  return { bias, pattern, level, momentum, volatility, timing, usdProxy: usd, cost, counterTrend, news, total };
}
