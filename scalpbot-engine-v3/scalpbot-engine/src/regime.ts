export type Regime = "TREND_UP" | "TREND_DOWN" | "VOLATILE" | "DEAD" | "RANGE";

export interface RegimeInput {
  m15Close: number; ema20: number; ema50: number; ema200: number;
  slope50: number; atrPct: number; newsWithin30: boolean;
}

export function regime(x: RegimeInput): Regime {
  if (x.atrPct > 90 || x.newsWithin30) return "VOLATILE";
  if (x.atrPct < 20) return "DEAD";
  if (x.m15Close > x.ema200 && x.ema20 > x.ema50 && x.slope50 >= 0.3) return "TREND_UP";
  if (x.m15Close < x.ema200 && x.ema20 < x.ema50 && x.slope50 <= -0.3) return "TREND_DOWN";
  return "RANGE";
}

/** EUR up = USD weak = supportive for XAU longs. */
export function usdProxy(eurRegime: Regime): "usd_weak" | "usd_strong" | "neutral" {
  if (eurRegime === "TREND_UP") return "usd_weak";
  if (eurRegime === "TREND_DOWN") return "usd_strong";
  return "neutral";
}
