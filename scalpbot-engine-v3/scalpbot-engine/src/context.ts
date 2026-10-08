import type { Instrument } from "./config.js";
import type { Settings } from "./api/lovable.js";
import type { Snapshot } from "./analysis.js";
import type { Regime } from "./regime.js";
import { asianRange, buildLevels, istWindow, londonRange, openingRange, prevDay, psychLevels } from "./levels/sessions.js";
import type { NewsSource } from "./news.js";
import type { Bar, EvalCtx, PairState, Sessions } from "./types.js";

export function buildCtx(a: {
  instrument: Instrument; t: number; m5: Bar[]; m15: Bar[]; snap: Snapshot; eurRegime: Regime | null;
  bid: number; ask: number; settings: Settings; commissionPerLot: number; news: NewsSource; state: PairState;
  stale: boolean; openTrades: number; signalsThisWindow: number;
}): EvalCtx {
  const w = istWindow(a.t - 1, a.settings.window_start, a.settings.window_end);
  const sessions: Sessions = {
    prevDay: prevDay(a.m15, a.t),
    asian: asianRange(a.m15, a.t),
    london: londonRange(a.m15, a.t, w.open),
    or: a.t >= w.open + 30 * 60_000 ? openingRange(a.m5, w.open) : null,
  };
  const levels = buildLevels({ prevDay: sessions.prevDay, asian: sessions.asian, london: sessions.london, or: sessions.or, psych: psychLevels(a.instrument, a.m5[a.m5.length - 1]?.c ?? a.bid) });
  return { ...a, sessions, levels, windowOpen: w.open };
}
