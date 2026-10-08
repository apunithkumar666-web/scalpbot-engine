/** Percent rank (0-100) of the last value among the last `lookback` finite values (inclusive). */
export function percentileRank(values: number[], lookback = 200): number {
  const win = values.filter(Number.isFinite).slice(-lookback);
  const cur = win[win.length - 1];
  if (cur === undefined || win.length < 2) return 50;
  const below = win.filter((v) => v < cur).length;
  const equal = win.filter((v) => v === cur).length;
  return ((below + 0.5 * equal) / win.length) * 100;
}

/** Slope50 = (EMA50_t - EMA50_{t-5}) / ATR14_t */
export function slopeNorm(ema50: number[], atr14: number[], lag = 5): number {
  const i = ema50.length - 1;
  const a = ema50[i], b = ema50[i - lag], r = atr14[atr14.length - 1];
  if (a === undefined || b === undefined || r === undefined || !Number.isFinite(a) || !Number.isFinite(b) || !r) return 0;
  return (a - b) / r;
}
