import { describe, expect, it } from "vitest";
import { buildSltp, commissionInPrice, roundPrice } from "../src/sltp.js";
import { score } from "../src/scoring.js";
import { simulate } from "../src/backtest/sim.js";
import { liveGate, stats } from "../src/backtest/report.js";

const base = { instrument: "XAU_USD" as const, side: "BUY" as const, bid: 2400.0, ask: 2400.2, atr: 3, tp1R: 1, tp2R: 2, levels: [], commissionPerLot: 0 };

describe("SL/TP", () => {
  it("BUY enters at ask, TP1=1R, TP2=2R, XAU rounded to 2dp", () => {
    const r = buildSltp({ ...base, sl: 2396.2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry).toBe(2400.2);
    expect(r.tp1).toBe(2404.2);
    expect(r.tp2).toBe(2408.2);
  });
  it("SELL enters at bid, EUR rounded to 5dp", () => {
    const r = buildSltp({ ...base, instrument: "EUR_USD", side: "SELL", bid: 1.08501, ask: 1.08509, atr: 0.0006, sl: 1.08571 });
    expect(r.ok && r.entry).toBe(1.08501);
    expect(r.ok && r.tp1).toBe(1.08431);
    expect(roundPrice("EUR_USD", 1.234567)).toBe(1.23457);
  });
  it("rejects SL outside [0.8, 2.0]*ATR", () => {
    expect(buildSltp({ ...base, sl: 2398.2 }).ok).toBe(false);  // 2/3 ATR
    expect(buildSltp({ ...base, sl: 2393.0 }).ok).toBe(false);  // 2.4 ATR
  });
  it("rejects cost ratio > 0.15", () => {
    const r = buildSltp({ ...base, bid: 2399.4, ask: 2400.2, sl: 2397.2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Cost ratio/);
  });
  it("commission converts to price units", () => {
    expect(commissionInPrice("XAU_USD", 7)).toBeCloseTo(0.07);
    expect(commissionInPrice("EUR_USD", 7)).toBeCloseTo(0.00007);
  });
  it("skips when a key level sits within 1R before TP1", () => {
    const r = buildSltp({ ...base, sl: 2396.2, levels: [{ name: "London high", price: 2402.5 }] });
    expect(r.ok).toBe(false);
  });
  it("caps TP2 just before a level if >= 1.5R remains", () => {
    const r = buildSltp({ ...base, sl: 2396.2, levels: [{ name: "PDH", price: 2407.5 }] });
    expect(r.ok && r.tp2Capped).toBe(true);
    expect(r.ok && r.tp2).toBeLessThan(2407.5);
  });
  it("skips when the TP2 cap would leave < 1.5R", () => {
    const r = buildSltp({ ...base, sl: 2396.2, levels: [{ name: "PDH", price: 2405.0 }] });
    expect(r.ok).toBe(false);
  });
});

describe("score", () => {
  const x = { instrument: "XAU_USD" as const, side: "BUY" as const, regime: "TREND_UP" as const, eurRegime: "TREND_UP" as const, pattern: "engulf" as const, pathR: 3, rsi: 60, rsiPrev: 55, slope50: 0.5, atrPct: 50, t: Date.parse("2026-10-07T14:00:00Z"), costRatio: 0.05, counterTrend: false, newsWithin30: false };
  it("max is 100", () => { expect(score(x).total).toBe(100); });
  it("components & penalties", () => {
    const s = score({ ...x, pattern: "break", pathR: 1.7, regime: "RANGE", counterTrend: true, newsWithin30: true, t: Date.parse("2026-10-07T16:30:00Z") });
    expect(s.pattern).toBe(10); expect(s.level).toBe(8); expect(s.bias).toBe(10); expect(s.timing).toBe(5);
    expect(s.counterTrend).toBe(-15); expect(s.news).toBe(-20);
  });
});

describe("backtest sim", () => {
  const bar = (t: number, o: number, h: number, l: number, c: number) => ({ t, o, h, l, c, spread: 0 });
  const trade = { side: "BUY" as const, entry: 100, sl: 99, tp1: 101, tp2: 102, atr: 1, spread: 0, commissionPrice: 0, partialPct: 50, startT: 0 };
  it("SL first when SL and TP are in the same bar", () => {
    expect(simulate(trade, [bar(0, 100, 101.5, 98.5, 100)], 0).netR).toBeCloseTo(-1);
  });
  it("TP1 then TP2 = 0.5*1 + 0.5*2 = 1.5R", () => {
    const r = simulate(trade, [bar(0, 100, 101.2, 99.8, 101), bar(60_000, 101, 102.3, 100.6, 102)], 0);
    expect(r.outcome).toBe("TP1_TP2");
    expect(r.netR).toBeCloseTo(1.5);
  });
  it("TP1 then breakeven = 0.5R", () => {
    const r = simulate(trade, [bar(0, 100, 101.2, 99.8, 101), bar(60_000, 101, 101.1, 99.5, 99.6)], 0);
    expect(r.outcome).toBe("BE");
    expect(r.netR).toBeCloseTo(0.5);
  });
});

describe("report & live gate", () => {
  it("stats and gate", () => {
    const tr = Array.from({ length: 120 }, (_, i) => ({ strategy: "pullback", pair: "XAUUSD", side: "BUY", t: i, exitT: i, hourIst: 19, netR: i % 2 ? 1.5 : -1, score: 80, outcome: "x" }));
    const s = stats(tr);
    expect(s.trades).toBe(120);
    expect(s.expectancyR).toBeCloseTo(0.25);
    expect(s.profitFactor).toBeCloseTo(1.5);
    expect(s.losingStreak).toBe(1);
    expect(liveGate(s).pass).toBe(true);
    expect(liveGate(stats(tr.slice(0, 50))).pass).toBe(false);
  });
});
