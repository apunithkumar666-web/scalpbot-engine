export interface HL { t: number; h: number; l: number; c: number }
export interface Swing { kind: "high" | "low"; t: number; price: number; index: number }
export type Trend = "up" | "down" | "none";

/** Fractal swings with n bars each side; a swing at i is confirmed only at i+n. */
export function swings(bars: HL[], n = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = n; i < bars.length - n; i++) {
    const b = bars[i]!;
    let hi = true, lo = true;
    for (let k = 1; k <= n; k++) {
      const a = bars[i - k]!, c = bars[i + k]!;
      if (!(b.h > a.h && b.h > c.h)) hi = false;
      if (!(b.l < a.l && b.l < c.l)) lo = false;
    }
    if (hi) out.push({ kind: "high", t: b.t, price: b.h, index: i });
    if (lo) out.push({ kind: "low", t: b.t, price: b.l, index: i });
  }
  return out;
}

/** HH+HL = up, LH+LL = down, from the last two swing highs and lows. */
export function trendFromSwings(s: Swing[]): Trend {
  const highs = s.filter((x) => x.kind === "high").slice(-2);
  const lows = s.filter((x) => x.kind === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "none";
  const hh = highs[1]!.price > highs[0]!.price, hl = lows[1]!.price > lows[0]!.price;
  const lh = highs[1]!.price < highs[0]!.price, ll = lows[1]!.price < lows[0]!.price;
  if (hh && hl) return "up";
  if (lh && ll) return "down";
  return "none";
}

/** Break of structure: last close beyond the last swing in trend direction. */
export function bos(bars: HL[], s: Swing[], trend: Trend): boolean {
  const last = bars[bars.length - 1];
  if (!last || trend === "none") return false;
  const kind = trend === "up" ? "high" : "low";
  const sw = [...s].reverse().find((x) => x.kind === kind);
  if (!sw) return false;
  return trend === "up" ? last.c > sw.price : last.c < sw.price;
}
