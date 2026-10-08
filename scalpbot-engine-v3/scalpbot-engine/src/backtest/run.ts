import { DateTime } from "luxon";
import { TF_SECONDS, appPair, type Config, type Instrument } from "../config.js";
import { Settings } from "../api/lovable.js";
import { analyzeBars } from "../analysis.js";
import { buildCtx } from "../context.js";
import { evaluate } from "../evaluate.js";
import { NewsSource } from "../news.js";
import { commissionInPrice } from "../sltp.js";
import { istWindow } from "../levels/sessions.js";
import { newPairState, type Bar } from "../types.js";
import { fetchRange, spreadByHour, type BtBar } from "./data.js";
import { simulate } from "./sim.js";
import type { BtTrade } from "./report.js";

export interface BtOptions { from: number; to: number; pairs: Instrument[]; profile: "conservative" | "standard" | "aggressive"; commissionPerLot: number }

const M5 = TF_SECONDS.M5 * 1000, M15 = TF_SECONDS.M15 * 1000;

export async function runBacktest(cfg: Config, o: BtOptions): Promise<BtTrade[]> {
  const settings = Settings.parse({ profile: o.profile });
  const news = new NewsSource(); // historical calendar is not available; manual NEWS_BLACKOUT list applies
  const warm = o.from - 5 * 24 * 60 * 60_000;
  const data = new Map<Instrument, { m1: BtBar[]; m5: BtBar[]; m15: BtBar[]; spreadH: number[] }>();
  const all = [...new Set<Instrument>([...o.pairs, "EUR_USD"])];
  for (const i of all) {
    process.stderr.write(`downloading ${i}\n`);
    const [m1, m5, m15] = [await fetchRange(cfg, i, "M1", o.from, o.to), await fetchRange(cfg, i, "M5", warm, o.to), await fetchRange(cfg, i, "M15", warm, o.to)];
    data.set(i, { m1, m5, m15, spreadH: spreadByHour(m5) });
  }

  const trades: BtTrade[] = [];
  for (const instrument of o.pairs) {
    const d = data.get(instrument)!;
    const eur = data.get("EUR_USD")!;
    const state = newPairState();
    const open: { exitT: number; netR: number }[] = [];
    const winCount = new Map<number, number>();
    let j15 = 0, jE5 = 0, jE15 = 0, m1i = 0;

    for (let i = 0; i < d.m5.length; i++) {
      const bar = d.m5[i]!;
      const closeT = bar.t + M5;
      if (closeT <= o.from) continue;
      // closed bars only: no lookahead
      while (j15 < d.m15.length && d.m15[j15]!.t + M15 <= closeT) j15++;
      while (jE5 < eur.m5.length && eur.m5[jE5]!.t + M5 <= closeT) jE5++;
      while (jE15 < eur.m15.length && eur.m15[jE15]!.t + M15 <= closeT) jE15++;
      const m5: Bar[] = d.m5.slice(Math.max(0, i - 600), i + 1);
      const m15: Bar[] = d.m15.slice(Math.max(0, j15 - 400), j15);
      const win = istWindow(closeT - 1, settings.window_start, settings.window_end);
      if (!win.inWindow) continue;

      // settle trades whose exit is now in the past
      for (let k = open.length - 1; k >= 0; k--) if (open[k]!.exitT <= closeT) {
        if (open[k]!.netR < 0) state.lastLossAt = open[k]!.exitT;
        open.splice(k, 1);
      }
      const snap = analyzeBars(instrument, m5, m15, news.soon(closeT, 30) !== null);
      if (!snap) continue;
      const eSnap = analyzeBars("EUR_USD", eur.m5.slice(Math.max(0, jE5 - 600), jE5), eur.m15.slice(Math.max(0, jE15 - 400), jE15));
      const spread = d.spreadH[new Date(closeT).getUTCHours()] ?? bar.spread;
      const bid = bar.c - spread / 2, ask = bar.c + spread / 2;
      const ctx = buildCtx({
        instrument, t: closeT, m5, m15, snap, eurRegime: eSnap?.regime ?? null, bid, ask, settings,
        commissionPerLot: o.commissionPerLot, news, state, stale: false, openTrades: open.length, signalsThisWindow: winCount.get(win.open) ?? 0,
      });
      for (const out of evaluate(ctx)) {
        if (out.kind !== "signal") continue;
        const s = out.signal;
        while (m1i < d.m1.length && d.m1[m1i]!.t < closeT) m1i++;
        const res = simulate({ side: s.side, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, atr: snap.m5.atr14, spread, commissionPrice: commissionInPrice(instrument, o.commissionPerLot), partialPct: settings.partial_pct, startT: closeT }, d.m1, m1i);
        state.recent.push({ side: s.side, t: closeT });
        open.push({ exitT: res.exitT, netR: res.netR });
        winCount.set(win.open, (winCount.get(win.open) ?? 0) + 1);
        trades.push({ strategy: s.strategy, pair: appPair(instrument), side: s.side, t: closeT, exitT: res.exitT, hourIst: DateTime.fromMillis(closeT, { zone: "Asia/Kolkata" }).hour, netR: res.netR, score: s.score, outcome: res.outcome });
      }
    }
  }
  return trades.sort((a, b) => a.t - b.t);
}
