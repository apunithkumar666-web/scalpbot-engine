import { describe, expect, it } from "vitest";
import { displacement, engulfing, geometry, insideBarBreakout, pinBar } from "../src/patterns/candles.js";
import { bos, swings, trendFromSwings } from "../src/structure/swings.js";
import { regime } from "../src/regime.js";
import { istWindow, nextLevel, forexDayStart, psychLevels } from "../src/levels/sessions.js";
import { reconcile } from "../src/candles/reconcile.js";
import { CandleBuilder } from "../src/candles/builder.js";
import { parseLine } from "../src/oanda/stream.js";
import type { Candle } from "../src/candles/types.js";

describe("patterns", () => {
  it("geometry", () => {
    expect(geometry({ o: 10, h: 12, l: 9, c: 11 })).toEqual({ range: 3, body: 1, upperWick: 1, lowerWick: 1, closePos: 2 / 3 });
  });
  it("bull engulfing", () => {
    expect(engulfing({ o: 10, h: 10.2, l: 9, c: 9.2 }, { o: 9.1, h: 10.6, l: 9, c: 10.5 })).toBe("bull");
    expect(engulfing({ o: 10, h: 10.2, l: 9, c: 9.2 }, { o: 9.1, h: 10, l: 9, c: 9.8 })).toBeNull();
  });
  it("pin bars", () => {
    expect(pinBar({ o: 9.8, h: 10, l: 8, c: 9.9 })).toBe("bull");
    expect(pinBar({ o: 8.2, h: 10, l: 8, c: 8.1 })).toBe("bear");
  });
  it("displacement", () => {
    expect(displacement({ o: 10, h: 11.05, l: 9.95, c: 11 }, 1)).toBe("bull");
    expect(displacement({ o: 10, h: 10.5, l: 9.9, c: 10.4 }, 1)).toBeNull();
  });
  it("inside bar breakout", () => {
    expect(insideBarBreakout({ o: 10, h: 12, l: 8, c: 11 }, { o: 10, h: 11, l: 9, c: 10 }, { o: 10, h: 11.5, l: 10, c: 11.3 })).toBe("bull");
  });
});

describe("structure", () => {
  const bars = [1, 3, 2, 1.5, 4, 2.5, 2, 5, 3, 2.8, 2.6].map((h, i) => ({ t: i, h, l: h - 1, c: h - 0.5 }));
  it("fractal swings and trend", () => {
    const s = swings(bars, 2);
    expect(s.some((x) => x.kind === "high" && x.price === 4)).toBe(true);
    expect(trendFromSwings([
      { kind: "high", t: 0, price: 10, index: 0 }, { kind: "low", t: 1, price: 8, index: 1 },
      { kind: "high", t: 2, price: 11, index: 2 }, { kind: "low", t: 3, price: 9, index: 3 },
    ])).toBe("up");
  });
  it("BOS", () => {
    const s = [{ kind: "high" as const, t: 0, price: 5, index: 0 }];
    expect(bos([{ t: 1, h: 6, l: 5, c: 5.5 }], s, "up")).toBe(true);
  });
});

describe("regime", () => {
  const base = { m15Close: 2400, ema20: 2395, ema50: 2390, ema200: 2350, slope50: 0.5, atrPct: 50, newsWithin30: false };
  it("classifies", () => {
    expect(regime(base)).toBe("TREND_UP");
    expect(regime({ ...base, atrPct: 95 })).toBe("VOLATILE");
    expect(regime({ ...base, atrPct: 10 })).toBe("DEAD");
    expect(regime({ ...base, slope50: 0.1 })).toBe("RANGE");
  });
});

describe("levels & time zones", () => {
  it("IST window 18:30-22:30", () => {
    expect(istWindow(Date.parse("2026-10-07T14:00:00Z"), "18:30", "22:30").inWindow).toBe(true);
    expect(istWindow(Date.parse("2026-10-07T17:05:00Z"), "18:30", "22:30").inWindow).toBe(false);
  });
  it("forex day starts 17:00 New York (DST aware)", () => {
    expect(new Date(forexDayStart(Date.parse("2026-10-07T22:00:00Z"))).toISOString()).toBe("2026-10-07T21:00:00.000Z");
    expect(new Date(forexDayStart(Date.parse("2026-12-07T23:00:00Z"))).toISOString()).toBe("2026-12-07T22:00:00.000Z");
  });
  it("psych levels and nextLevel", () => {
    const lv = psychLevels("XAU_USD", 2413);
    expect(nextLevel(lv, 2413, "up")?.price).toBe(2420);
    expect(nextLevel(lv, 2413, "down")?.price).toBe(2410);
  });
});

describe("candles", () => {
  const c = (o: number): Candle => ({ instrument: "XAU_USD", tf: "M1", t: 0, o, h: o + 1, l: o - 1, c: o, ticks: 5, avgSpread: 0.2, maxSpread: 0.3, source: "stream" });
  it("REST overwrites when diff > tolerance", () => {
    expect(reconcile(c(2400), { ...c(2400.5), source: "rest" }, "XAU_USD").mismatch).toBe(true);
    expect(reconcile(c(2400), { ...c(2400.2), source: "rest" }, "XAU_USD").mismatch).toBe(false);
  });
  it("builder finalizes on first tick of next bucket", () => {
    const closed: Candle[] = [];
    const b = new CandleBuilder((x) => closed.push(x));
    const tick = (t: number, mid: number) => b.push({ instrument: "EUR_USD", time: t, bid: mid - 0.00005, ask: mid + 0.00005, mid, spread: 0.0001 });
    tick(Date.parse("2026-10-07T13:00:05Z"), 1.1);
    tick(Date.parse("2026-10-07T13:00:40Z"), 1.102);
    expect(closed.length).toBe(0);
    tick(Date.parse("2026-10-07T13:01:01Z"), 1.101);
    const m1 = closed.find((x) => x.tf === "M1")!;
    expect(m1.o).toBe(1.1); expect(m1.h).toBe(1.102); expect(m1.ticks).toBe(2);
  });
  it("parses stream lines", () => {
    const r = parseLine('{"type":"PRICE","instrument":"XAU_USD","time":"2026-10-07T13:00:00Z","bids":[{"price":"2400.10"}],"asks":[{"price":"2400.40"}]}');
    expect(r?.kind).toBe("tick");
    expect(parseLine('{"type":"HEARTBEAT","time":"x"}')?.kind).toBe("heartbeat");
  });
});
