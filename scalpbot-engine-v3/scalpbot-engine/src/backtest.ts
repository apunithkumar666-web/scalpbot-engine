/**
 * Replay backtest using the same strategy code as live.
 *   node dist/backtest.js --from 2026-06-01 --to 2026-09-30 --pair XAU_USD [--pair EUR_USD] [--profile aggressive] [--commission 7] [--apply]
 * --apply posts the live-gate result (enable/disable per strategy) to the app.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { INSTRUMENTS, loadConfig, type Instrument } from "./config.js";
import { LovableApi } from "./api/lovable.js";
import { runBacktest } from "./backtest/run.js";
import { equityCsv, groupBy, liveGate, stats } from "./backtest/report.js";

function arg(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!); });
  return out;
}

async function main() {
  const cfg = loadConfig();
  const from = Date.parse(arg("from")[0] ?? "");
  const to = Date.parse(arg("to")[0] ?? new Date().toISOString());
  if (!Number.isFinite(from) || !(to > from)) throw new Error("Usage: --from YYYY-MM-DD --to YYYY-MM-DD --pair XAU_USD");
  const pairs = (arg("pair").length ? arg("pair") : [...INSTRUMENTS]) as Instrument[];
  for (const p of pairs) if (!INSTRUMENTS.includes(p)) throw new Error(`Unknown pair ${p}`);
  const profile = (arg("profile")[0] ?? "aggressive") as "conservative" | "standard" | "aggressive";
  const commissionPerLot = Number(arg("commission")[0] ?? 0);

  const trades = await runBacktest(cfg, { from, to, pairs, profile, commissionPerLot });
  // walk-forward: nothing is optimized on the last 30%; reported separately
  const split = from + (to - from) * 0.7;
  const ins = trades.filter((t) => t.t < split), oos = trades.filter((t) => t.t >= split);

  const report: Record<string, unknown> = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), split: new Date(split).toISOString(), profile, total: stats(trades), in_sample: stats(ins), out_of_sample: stats(oos) };
  const per = (xs: typeof trades, key: (t: (typeof trades)[number]) => string) => Object.fromEntries(Object.entries(groupBy(xs, key)).map(([k, v]) => [k, stats(v)]));
  report["by_strategy_pair"] = per(trades, (t) => `${t.strategy}/${t.pair}`);
  report["by_strategy_pair_hour_ist"] = per(trades, (t) => `${t.strategy}/${t.pair}/${String(t.hourIst).padStart(2, "0")}`);
  report["oos_by_strategy_pair"] = per(oos, (t) => `${t.strategy}/${t.pair}`);
  const gates = Object.fromEntries(["pullback", "sweep", "orb"].map((s) => [s, liveGate(stats(oos.filter((t) => t.strategy === s)))]));
  report["live_gate"] = gates;

  mkdirSync("backtest-out", { recursive: true });
  writeFileSync("backtest-out/report.json", JSON.stringify(report, null, 2));
  writeFileSync("backtest-out/equity_all.csv", equityCsv(trades));
  writeFileSync("backtest-out/equity_oos.csv", equityCsv(oos));
  for (const [s, ts] of Object.entries(groupBy(trades, (t) => t.strategy))) writeFileSync(`backtest-out/equity_${s}.csv`, equityCsv(ts));

  console.table(Object.fromEntries(Object.entries(report["oos_by_strategy_pair"] as Record<string, ReturnType<typeof stats>>).map(([k, v]) => [k, { trades: v.trades, win: (v.winRate * 100).toFixed(0) + "%", expR: v.expectancyR.toFixed(2), PF: v.profitFactor.toFixed(2), DD: v.maxDrawdownR.toFixed(1) }])));
  for (const [s, g] of Object.entries(gates)) console.log(`LIVE GATE ${s}: ${g.pass ? "PASS" : "FAIL — " + g.reasons.join("; ")}`);
  console.log("Wrote backtest-out/report.json and equity CSVs");

  if (process.argv.includes("--apply")) {
    const api = new LovableApi(cfg);
    for (const [s, g] of Object.entries(gates)) await api.strategyStatus(s, g.pass, g.pass ? "passed backtest live gate" : `failed live gate: ${g.reasons.join("; ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
