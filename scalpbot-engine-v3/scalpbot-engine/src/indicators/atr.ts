export interface HLC { h: number; l: number; c: number }

/** True range; first bar uses H-L. */
export function trueRange(bars: HLC[]): number[] {
  return bars.map((b, i) => {
    const prev = bars[i - 1];
    if (!prev) return b.h - b.l;
    return Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
  });
}

/** Wilder ATR: seed = SMA of first n TR, then ATR_t = (ATR_{t-1}*(n-1) + TR_t)/n. */
export function atr(bars: HLC[], n = 14): number[] {
  const tr = trueRange(bars);
  const out = new Array<number>(bars.length).fill(NaN);
  if (tr.length < n) return out;
  let prev = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < tr.length; i++) {
    prev = (prev * (n - 1) + tr[i]!) / n;
    out[i] = prev;
  }
  return out;
}
