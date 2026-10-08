export interface BtTrade { strategy: string; pair: string; side: string; t: number; exitT: number; hourIst: number; netR: number; score: number; outcome: string }
export interface Stats { trades: number; winRate: number; avgWinR: number; avgLossR: number; expectancyR: number; profitFactor: number; maxDrawdownR: number; losingStreak: number; netR: number }

export function stats(trades: BtTrade[]): Stats {
  const wins = trades.filter((t) => t.netR > 0), losses = trades.filter((t) => t.netR <= 0);
  const gw = wins.reduce((a, t) => a + t.netR, 0), gl = -losses.reduce((a, t) => a + t.netR, 0);
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const t of [...trades].sort((a, b) => a.t - b.t)) {
    eq += t.netR; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    streak = t.netR <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak);
  }
  const n = trades.length;
  return {
    trades: n,
    winRate: n ? wins.length / n : 0,
    avgWinR: wins.length ? gw / wins.length : 0,
    avgLossR: losses.length ? -gl / losses.length : 0,
    expectancyR: n ? (gw - gl) / n : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    maxDrawdownR: dd,
    losingStreak: worst,
    netR: gw - gl,
  };
}

export interface Gate { pass: boolean; reasons: string[] }
/** LIVE GATE on out-of-sample: >=100 trades, expectancy >= +0.15R, PF >= 1.3, max DD <= 10R. */
export function liveGate(s: Stats): Gate {
  const reasons: string[] = [];
  if (s.trades < 100) reasons.push(`trades ${s.trades} < 100`);
  if (s.expectancyR < 0.15) reasons.push(`expectancy ${s.expectancyR.toFixed(3)}R < 0.15R`);
  if (s.profitFactor < 1.3) reasons.push(`PF ${s.profitFactor.toFixed(2)} < 1.3`);
  if (s.maxDrawdownR > 10) reasons.push(`max DD ${s.maxDrawdownR.toFixed(1)}R > 10R`);
  return { pass: reasons.length === 0, reasons };
}

export function groupBy<T>(xs: T[], key: (x: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of xs) (out[key(x)] ??= []).push(x);
  return out;
}

export function equityCsv(trades: BtTrade[]): string {
  let eq = 0;
  const rows = ["exit_time_utc,strategy,pair,side,score,outcome,net_r,equity_r"];
  for (const t of [...trades].sort((a, b) => a.exitT - b.exitT)) {
    eq += t.netR;
    rows.push([new Date(t.exitT).toISOString(), t.strategy, t.pair, t.side, t.score, t.outcome, t.netR.toFixed(3), eq.toFixed(3)].join(","));
  }
  return rows.join("\n") + "\n";
}
