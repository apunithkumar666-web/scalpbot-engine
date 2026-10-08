import { describe, expect, it } from "vitest";
import { sweep } from "../src/strategies/sweep.js";
import { globalFilter, duplicateFilter } from "../src/filters.js";
import { Settings } from "../src/api/lovable.js";
import { NewsSource } from "../src/news.js";
import { newPairState, type EvalCtx } from "../src/types.js";

const t = Date.parse("2026-10-07T14:30:00Z"); // 20:00 IST
function ctx(over: Partial<EvalCtx> = {}): EvalCtx {
  const m5 = Array.from({ length: 30 }, (_, i) => ({ t: t - (30 - i) * 300_000, o: 2400, h: 2401, l: 2399, c: 2400 }));
  return {
    instrument: "XAU_USD", t, m5, m15: [], eurRegime: null, windowOpen: Date.parse("2026-10-07T13:00:00Z"),
    snap: { instrument: "XAU_USD", regime: "RANGE", m5: { ema20: 2400, ema50: 2400, atr14: 3, rsi14: 50, atrPct: 50, slope50: 0, trend: "none", bos: false }, m15: { ema20: 2400, ema50: 2400, ema200: 2400, atr14: 5, slope50: 0 } },
    sessions: { prevDay: null, asian: null, london: { high: 2405, low: 2390 }, or: null }, levels: [],
    bid: 2403.5, ask: 2403.7, settings: Settings.parse({}), commissionPerLot: 0, news: NewsSource.fromEvents([]),
    state: newPairState(), stale: false, openTrades: 0, signalsThisWindow: 0, ...over,
  };
}

describe("sweep reversal", () => {
  it("sells a London-high sweep with a long upper wick", () => {
    const c = ctx();
    c.m5.push({ t: t - 300_000, o: 2403.8, h: 2406.5, l: 2403.2, c: 2403.6 }); // pierces 2405 by 1.5 (0.5 ATR), closes back below
    const s = sweep(c);
    expect(s?.side).toBe("SELL");
    expect(s?.sl).toBeCloseTo(2406.5 + 0.6 + 0.2, 5);
    expect(s?.levelUsed).toBe("London high");
  });
  it("ignores a pierce deeper than 1.0*ATR", () => {
    const c = ctx();
    c.m5.push({ t: t - 300_000, o: 2403.8, h: 2409, l: 2403.2, c: 2403.6 });
    expect(sweep(c)).toBeNull();
  });
});

describe("hard filters", () => {
  it("blocks outside window, DEAD regime, news, caps and cooldown", () => {
    expect(globalFilter(ctx({ t: Date.parse("2026-10-07T18:00:00Z") }))).toBe("outside window");
    expect(globalFilter(ctx({ snap: { ...ctx().snap, regime: "DEAD" } }))).toMatch(/DEAD/);
    expect(globalFilter(ctx({ news: NewsSource.fromEvents([{ t: t + 5 * 60_000, title: "CPI", country: "USD" }]) }))).toMatch(/news/);
    expect(globalFilter(ctx({ signalsThisWindow: 6 }))).toMatch(/cap/);
    const st = newPairState(); st.lastLossAt = t - 2 * 60_000;
    expect(globalFilter(ctx({ state: st }))).toMatch(/cooldown/);
    expect(globalFilter(ctx())).toBeNull();
  });
  it("blocks same pair+side within 15 min", () => {
    const st = newPairState(); st.recent.push({ side: "BUY", t: t - 10 * 60_000 });
    expect(duplicateFilter(ctx({ state: st }), "BUY")).toMatch(/15 min/);
    expect(duplicateFilter(ctx({ state: st }), "SELL")).toBeNull();
  });
});
