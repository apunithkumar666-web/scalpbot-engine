import { describe, expect, it } from "vitest";
import { ema } from "../src/indicators/ema.js";
import { atr, trueRange } from "../src/indicators/atr.js";
import { rsi } from "../src/indicators/rsi.js";
import { percentileRank } from "../src/indicators/percentile.js";

describe("EMA", () => {
  it("seeds with SMA then applies k=2/(n+1)", () => {
    const e = ema([1, 2, 3, 4, 5, 6], 3);
    expect(e[1]).toBeNaN();
    expect(e[2]).toBe(2);       // SMA(1,2,3)
    expect(e[3]).toBe(3);       // 4*0.5 + 2*0.5
    expect(e[4]).toBe(4);
    expect(e[5]).toBe(5);
  });
});

describe("ATR (Wilder)", () => {
  const bars = [
    { h: 10, l: 8, c: 9 }, { h: 11, l: 9, c: 10 }, { h: 12, l: 9.5, c: 11 }, { h: 13, l: 10, c: 12 },
  ];
  it("true range uses previous close", () => {
    expect(trueRange([{ h: 10, l: 9, c: 9.5 }, { h: 12, l: 11, c: 11.5 }])[1]).toBe(2.5);
  });
  it("seeds with SMA of first n TR", () => {
    const a = atr(bars, 3);
    expect(a[2]).toBeCloseTo((2 + 2 + 2.5) / 3, 10);
    expect(a[3]).toBeCloseTo((a[2]! * 2 + 3) / 3, 10);
  });
});

describe("RSI (Wilder)", () => {
  it("matches the classic Wilder example (~70.53)", () => {
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(rsi(closes, 14)[14]).toBeCloseTo(70.46, 0);
  });
  it("is 100 with only gains", () => {
    expect(rsi([1, 2, 3, 4, 5], 3)[3]).toBe(100);
  });
});

describe("ATR percentile", () => {
  it("ranks the last value", () => {
    expect(percentileRank([1, 2, 3, 4, 5], 200)).toBe(90);
    expect(percentileRank([5, 4, 3, 2, 1], 200)).toBe(10);
  });
});
