/** EMA series. k = 2/(n+1); seeded with SMA of the first n values. Entries before the seed are NaN. */
export function ema(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
