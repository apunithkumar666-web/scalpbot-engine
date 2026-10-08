/** Wilder RSI. Seeds avg gain/loss with the simple mean of the first n changes. */
export function rsi(closes: number[], n = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d; else loss -= d;
  }
  let ag = gain / n, al = loss / n;
  const val = () => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));
  out[n] = val();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}
