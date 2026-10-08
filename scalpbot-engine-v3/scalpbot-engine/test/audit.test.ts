// Audit suite: fixtures with hand-computed answers for every area of the engine spec.
import { describe, expect, it, vi } from "vitest";
import { ema } from "../src/indicators/ema.js";
import { atr } from "../src/indicators/atr.js";
import { rsi } from "../src/indicators/rsi.js";
import { percentileRank, slopeNorm } from "../src/indicators/percentile.js";
import { bucketStart, CandleBuilder } from "../src/candles/builder.js";
import { CandleStore } from "../src/candles/store.js";
import { reconcile } from "../src/candles/reconcile.js";
import type { Candle, Tick } from "../src/candles/types.js";
import { FeedGuard } from "../src/guard.js";
import { asianRange, forexDayStart, istWindow, londonRange, marketOpen, openingRange, prevDay } from "../src/levels/sessions.js";
import { swings, trendFromSwings } from "../src/structure/swings.js";
import { displacement, engulfing, insideBarBreakout, pinBar } from "../src/patterns/candles.js";
import { pullback } from "../src/strategies/pullback.js";
import { sweep } from "../src/strategies/sweep.js";
import { orb } from "../src/strategies/orb.js";
import { duplicateFilter, globalFilter, maxSpread } from "../src/filters.js";
import { buildSltp, roundPrice } from "../src/sltp.js";
import { score } from "../src/scoring.js";
import { evaluate } from "../src/evaluate.js";
import { HttpError, SignalOutbox } from "../src/outbox.js";
import { TradeManager, type Quote } from "../src/manager.js";
import { LovableApi, Settings, type OpenTrade } from "../src/api/lovable.js";
import { NewsSource } from "../src/news.js";
import { simulate } from "../src/backtest/sim.js";
import { liveGate, stats } from "../src/backtest/report.js";
import { analyzeBars } from "../src/analysis.js";
import { buildCtx } from "../src/context.js";
import { loadConfig, type Instrument } from "../src/config.js";
import { redact, registerSecrets } from "../src/logger.js";
import { newPairState, type EvalCtx } from "../src/types.js";

const MIN = 60_000;
const T = Date.parse("2026-10-07T14:30:00Z"); // 20:00 IST
const WOPEN = Date.parse("2026-10-07T13:00:00Z"); // 18:30 IST

function ctx(over: Partial<EvalCtx> = {}): EvalCtx {
  const m5 = Array.from({ length: 30 }, (_, i) => ({ t: T - (31 - i) * 300_000, o: 2400, h: 2401, l: 2399, c: 2400 }));
  return {
    instrument: "XAU_USD", t: T, m5, m15: [], eurRegime: null, windowOpen: WOPEN,
    snap: { instrument: "XAU_USD", regime: "RANGE", m5: { ema20: 2400, ema50: 2400, atr14: 3, rsi14: 50, atrPct: 50, slope50: 0, trend: "none", bos: false }, m15: { ema20: 2400, ema50: 2400, ema200: 2400, atr14: 5, slope50: 0 } },
    sessions: { prevDay: null, asian: null, london: { high: 2405, low: 2390 }, or: null }, levels: [],
    bid: 2403.5, ask: 2403.7, settings: Settings.parse({}), commissionPerLot: 0, news: NewsSource.fromEvents([]),
    state: newPairState(), stale: false, openTrades: 0, signalsThisWindow: 0, ...over,
  };
}

// ---------------- 1 indicators ----------------
describe("1 indicators (hand-computed)", () => {
  it("EMA(3) of 1..5 = NaN,NaN,2,3,4", () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(e.slice(2)).toEqual([2, 3, 4]);
    expect(ema([1, 2], 3).every(Number.isNaN)).toBe(true); // not enough warm-up
  });
  it("Wilder ATR(3): seed 7/3, then 26/9", () => {
    const a = atr([{ h: 10, l: 8, c: 9 }, { h: 11, l: 9, c: 10 }, { h: 12, l: 9, c: 11 }, { h: 15, l: 11, c: 14 }], 3);
    expect(a[1]).toBeNaN();
    expect(a[2]).toBeCloseTo(7 / 3, 12);
    expect(a[3]).toBeCloseTo(26 / 9, 12);
  });
  it("Wilder RSI(3): 66.667 then 77.778", () => {
    const r = rsi([1, 2, 3, 2, 3], 3);
    expect(r[2]).toBeNaN();
    expect(r[3]).toBeCloseTo(200 / 3, 9);
    expect(r[4]).toBeCloseTo(100 - 100 / 4.5, 9);
  });
  it("slope50 = (EMA_t - EMA_t-5)/ATR = 2.5", () => {
    expect(slopeNorm([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [2, 2])).toBeCloseTo(2.5, 12);
    expect(slopeNorm([NaN, 1, 2, 3, 4, 5], [2])).toBe(0); // warm-up -> neutral
  });
  it("ATR percentile of last value in 1..5 = 90", () => {
    expect(percentileRank([NaN, 1, 2, 3, 4, 5], 5)).toBe(90);
  });
});

// ---------------- 2 candles ----------------
const tick = (time: number, mid: number, i: Instrument = "XAU_USD"): Tick => ({ instrument: i, time, bid: mid - 0.1, ask: mid + 0.1, mid, spread: 0.2 });
describe("2 candles", () => {
  it("UTC bucket alignment M1/M5/M15", () => {
    const t = Date.parse("2026-10-07T14:03:27Z");
    expect(new Date(bucketStart(t, "M1")).toISOString()).toBe("2026-10-07T14:03:00.000Z");
    expect(new Date(bucketStart(t, "M5")).toISOString()).toBe("2026-10-07T14:00:00.000Z");
    expect(new Date(bucketStart(t, "M15")).toISOString()).toBe("2026-10-07T14:00:00.000Z");
  });
  it("finalizes only on the next bucket's first tick; no duplicates or gaps across a reconnect", () => {
    const store = new CandleStore();
    const closed: Candle[] = [];
    const b = new CandleBuilder((c) => { closed.push(c); store.upsert(c); });
    const t0 = Date.parse("2026-10-07T14:00:00Z");
    for (let s = 0; s < 60 * 4; s += 2) b.push(tick(t0 + s * 1000, 2400 + s / 100));
    expect(closed.filter((c) => c.tf === "M1").length).toBe(3); // 4th minute still open
    // reconnect: partial bar dropped, REST backfill supplies authoritative bars incl. the gap
    b.reset();
    const restBars: Candle[] = [0, 1, 2, 3, 4, 5].map((m) => ({ instrument: "XAU_USD", tf: "M1", t: t0 + m * MIN, o: 1, h: 2, l: 0.5, c: 1.5, ticks: 0, avgSpread: 0, maxSpread: 0, source: "rest" }));
    restBars.forEach((r) => store.upsert(r));
    for (let s = 6 * 60; s < 8 * 60; s += 2) b.push(tick(t0 + s * 1000, 2401));
    const m1 = store.get("XAU_USD", "M1");
    const ts = m1.map((c) => c.t);
    expect(new Set(ts).size).toBe(ts.length); // unique
    for (let k = 1; k < ts.length; k++) expect(ts[k]! - ts[k - 1]!).toBe(MIN); // contiguous
  });
  it("REST overwrites above tolerance only", () => {
    const base: Candle = { instrument: "XAU_USD", tf: "M5", t: 0, o: 2400, h: 2401, l: 2399, c: 2400.5, ticks: 9, avgSpread: 0.2, maxSpread: 0.3, source: "stream" };
    expect(reconcile(base, { ...base, c: 2400.7, source: "rest" }, "XAU_USD").mismatch).toBe(false); // 0.20 <= 0.30
    const r = reconcile(base, { ...base, c: 2401, source: "rest" }, "XAU_USD");
    expect(r.mismatch && r.candle.c === 2401 && r.candle.ticks === 9).toBe(true);
    expect(reconcile(undefined, { ...base, source: "rest" }, "XAU_USD").candle.source).toBe("rest");
  });
});

// ---------------- 3 stale guard ----------------
describe("3 stale-data guard", () => {
  const open = Date.parse("2026-10-07T14:00:00Z"); // Wednesday
  it("6s without ticks -> stale once (alert), dead stream -> reconnect, tick -> resume", () => {
    const g = new FeedGuard(open);
    g.tick(open);
    expect(g.check(open + 4000, true)).toEqual({ reconnect: false, becameStale: false });
    expect(g.check(open + 6000, true)).toEqual({ reconnect: false, becameStale: true });
    expect(g.check(open + 7000, true).becameStale).toBe(false); // alert only once
    expect(g.check(open + 11_000, true).reconnect).toBe(true);
    expect(g.tick(open + 12_000)).toBe("resumed");
    expect(g.stale).toBe(false);
  });
  it("weekend: no stale flag, no reconnect storm", () => {
    const sat = Date.parse("2026-10-10T12:00:00Z");
    expect(marketOpen(sat)).toBe(false);
    const g = new FeedGuard(sat);
    g.heartbeat(sat + 50_000);
    expect(g.check(sat + 55_000, false)).toEqual({ reconnect: false, becameStale: false });
  });
});

// ---------------- 4 time ----------------
const istAt = (hm: string, day = "2026-10-07") => Date.parse(`${day}T${hm}:00+05:30`);
describe("4 time zones", () => {
  it("IST window 18:29 ✗ 18:30 ✓ 22:29 ✓ 22:31 ✗", () => {
    const w = (hm: string) => istWindow(istAt(hm), "18:30", "22:30").inWindow;
    expect([w("18:29"), w("18:30"), w("22:29"), w("22:31")]).toEqual([false, true, true, false]);
  });
  it("London session follows BST/GMT", () => {
    const bars = (day: string) => Array.from({ length: 24 * 4 }, (_, k) => ({ t: Date.parse(`${day}T00:00:00Z`) + k * 15 * MIN, o: 1, h: 1 + k, l: 1, c: 1 }));
    // 2026-03-27 (GMT): 08:00-13:00 London = 08:00-13:00Z -> last bar starts 12:45Z (k=51)
    expect(londonRange(bars("2026-03-27"), Date.parse("2026-03-27T15:00:00Z"), Date.parse("2026-03-27T23:00:00Z"))?.high).toBe(52);
    // 2026-03-30 (BST): 08:00-13:00 London = 07:00-12:00Z -> last bar starts 11:45Z (k=47)
    expect(londonRange(bars("2026-03-30"), Date.parse("2026-03-30T15:00:00Z"), Date.parse("2026-03-30T23:00:00Z"))?.high).toBe(48);
  });
  it("forex day rolls 17:00 New York across DST", () => {
    expect(new Date(forexDayStart(Date.parse("2026-10-07T22:00:00Z"))).toISOString()).toBe("2026-10-07T21:00:00.000Z"); // EDT
    expect(new Date(forexDayStart(Date.parse("2026-11-04T23:00:00Z"))).toISOString()).toBe("2026-11-04T22:00:00.000Z"); // EST
    expect(new Date(forexDayStart(Date.parse("2026-11-04T21:30:00Z"))).toISOString()).toBe("2026-11-03T22:00:00.000Z");
  });
  it("market hours: closed Fri 17:00 -> Sun 17:00 NY", () => {
    expect(marketOpen(Date.parse("2026-10-09T20:59:00Z"))).toBe(true);
    expect(marketOpen(Date.parse("2026-10-09T21:01:00Z"))).toBe(false);
    expect(marketOpen(Date.parse("2026-10-11T20:59:00Z"))).toBe(false);
    expect(marketOpen(Date.parse("2026-10-11T21:01:00Z"))).toBe(true);
  });
});

// ---------------- 5 levels & structure ----------------
describe("5 levels and structure", () => {
  const hourly = (fromIso: string, hours: number, f: (k: number) => number) =>
    Array.from({ length: hours }, (_, k) => { const v = f(k); return { t: Date.parse(fromIso) + k * 60 * MIN, o: v, h: v + 1, l: v - 1, c: v }; });
  it("prev-day high/low (Tue)", () => {
    const bars = hourly("2026-10-05T21:00:00Z", 48, (k) => (k < 24 ? 100 + k : 200 + k)); // Mon fx-day then Tue fx-day
    expect(prevDay(bars, Date.parse("2026-10-07T22:00:00Z"))).toEqual({ high: 248, low: 223 });
  });
  it("prev-day on Monday skips the weekend (defect fixed)", () => {
    const fri = hourly("2026-10-08T21:00:00Z", 24, (k) => 50 + k); // Thu 17:00 -> Fri 17:00 NY
    const mon = Date.parse("2026-10-12T10:00:00Z");
    expect(prevDay(fri, mon)).toEqual({ high: 74, low: 49 });
  });
  it("Asian range 00:00-07:00 UTC and opening range 30 min", () => {
    const bars = hourly("2026-10-07T00:00:00Z", 10, (k) => 10 + k);
    expect(asianRange(bars, Date.parse("2026-10-07T12:00:00Z"))).toEqual({ high: 17, low: 9 });
    const m5 = Array.from({ length: 10 }, (_, k) => ({ t: WOPEN + k * 5 * MIN, o: 1, h: 2400 + k, l: 2390 - k, c: 1 }));
    expect(openingRange(m5, WOPEN)).toEqual({ high: 2405, low: 2385, width: 20 });
  });
  it("fractal swings: positive and negative", () => {
    const hs = [1, 2, 5, 2, 1, 2, 6, 2, 1];
    const bars = hs.map((h, i) => ({ t: i, h, l: h - 0.5, c: h }));
    const sw = swings(bars, 2).filter((s) => s.kind === "high").map((s) => s.price);
    expect(sw).toEqual([5, 6]);
    expect(swings(bars.slice(0, 4), 2).length).toBe(0); // not confirmed yet
    expect(trendFromSwings([])).toBe("none");
  });
});

// ---------------- 6 patterns ----------------
describe("6 patterns (positive + negative)", () => {
  it("engulfing", () => {
    expect(engulfing({ o: 10, h: 10.2, l: 8.8, c: 9 }, { o: 8.9, h: 10.6, l: 8.8, c: 10.5 })).toBe("bull");
    expect(engulfing({ o: 10, h: 10.2, l: 8.8, c: 9 }, { o: 9.2, h: 9.8, l: 9.1, c: 9.6 })).toBeNull();
  });
  it("pin bar", () => {
    expect(pinBar({ o: 9.7, h: 10, l: 7, c: 9.9 })).toBe("bull");
    expect(pinBar({ o: 7.2, h: 10, l: 7, c: 9.8 })).toBeNull();
  });
  it("displacement", () => {
    expect(displacement({ o: 10, h: 13.1, l: 9.9, c: 13 }, 3)).toBe("bull");
    expect(displacement({ o: 10, h: 11.5, l: 9.9, c: 11 }, 3)).toBeNull();
  });
  it("inside-bar breakout", () => {
    const mother = { o: 10, h: 12, l: 8, c: 11 }, inside = { o: 10.5, h: 11, l: 9.5, c: 10 };
    expect(insideBarBreakout(mother, inside, { o: 10, h: 11.6, l: 9.9, c: 11.5 })).toBe("bull");
    expect(insideBarBreakout(mother, inside, { o: 10, h: 10.8, l: 9.7, c: 10.4 })).toBeNull();
    expect(insideBarBreakout(mother, { o: 10, h: 12.5, l: 9, c: 10 }, { o: 10, h: 13, l: 10, c: 13 })).toBeNull();
  });
});

// ---------------- 7 strategies ----------------
function trendBars(cur: { o: number; h: number; l: number; c: number }) {
  const out: { t: number; o: number; h: number; l: number; c: number }[] = [];
  let p = 2400;
  for (let i = 0; i < 62; i++) { const o = p; p += 0.5; out.push({ t: T - (70 - i) * 300_000, o, h: p + 0.2, l: o - 0.2, c: p }); }
  for (let i = 0; i < 7; i++) { const o = p; p -= 0.6; out.push({ t: T - (8 - i) * 300_000, o, h: o + 0.2, l: p - 0.2, c: p }); }
  out.push({ t: T - 300_000, ...cur });
  return out;
}
describe("7 strategies (trigger / no trigger)", () => {
  const trend = (m5: ReturnType<typeof trendBars>) => ctx({ m5, snap: { ...ctx().snap, regime: "TREND_UP" }, bid: m5[m5.length - 1]!.c, ask: m5[m5.length - 1]!.c + 0.2 });
  it("pullback: bull engulf after EMA20 touch -> BUY, SL below swing - 0.2ATR - spread", () => {
    const m5 = trendBars({ o: 2426.5, h: 2429.6, l: 2426.3, c: 2429.4 });
    const s = pullback(trend(m5));
    expect(s?.side).toBe("BUY");
    const lows = m5.slice(-9).map((b) => b.l);
    expect(s?.sl).toBeCloseTo(Math.min(...lows) - 0.6 - 0.2, 6);
  });
  it("pullback: weak trigger bar -> no signal; wrong regime -> no signal", () => {
    expect(pullback(trend(trendBars({ o: 2426.8, h: 2427.3, l: 2426.4, c: 2426.9 })))).toBeNull();
    const m5 = trendBars({ o: 2426.5, h: 2429.6, l: 2426.3, c: 2429.4 });
    expect(pullback({ ...trend(m5), snap: { ...ctx().snap, regime: "RANGE" } })).toBeNull();
  });
  it("sweep: London-high sweep sells; too-deep pierce doesn't", () => {
    const c = ctx(); c.m5.push({ t: T - 300_000, o: 2403.8, h: 2406.5, l: 2403.2, c: 2403.6 });
    const s = sweep(c);
    expect(s?.side).toBe("SELL");
    expect(s!.sl - 2406.5).toBeCloseTo(0.2 * 3 + 0.2, 6); // above extreme by 0.2ATR + spread
    const d = ctx(); d.m5.push({ t: T - 300_000, o: 2403.8, h: 2409, l: 2403.2, c: 2403.6 });
    expect(sweep(d)).toBeNull();
  });
  const orbCtx = (retest: { o: number; h: number; l: number; c: number }) => {
    const m5 = [
      ...Array.from({ length: 6 }, (_, k) => ({ t: WOPEN + k * 5 * MIN, o: 2403, h: 2406, l: 2400, c: 2403 })),
      { t: WOPEN + 30 * MIN, o: 2403, h: 2405, l: 2402, c: 2404 },
      { t: WOPEN + 35 * MIN, o: 2405, h: 2409.2, l: 2404.9, c: 2409 }, // displacement breakout
      { t: WOPEN + 40 * MIN, o: 2409, h: 2409.5, l: 2407.5, c: 2408 },
      { t: WOPEN + 45 * MIN, ...retest },
    ];
    return ctx({ t: WOPEN + 50 * MIN, m5, sessions: { prevDay: null, asian: null, london: null, or: { high: 2406, low: 2400, width: 6 } }, bid: retest.c, ask: retest.c + 0.2 });
  };
  it("ORB: breakout + pin-bar retest -> BUY; SL = retest low - 0.2ATR - spread; one attempt per day", () => {
    const c = orbCtx({ o: 2407.6, h: 2408.0, l: 2406.1, c: 2407.9 });
    const s = orb(c);
    expect(s?.side).toBe("BUY");
    expect(s?.sl).toBeCloseTo(2406.1 - 0.6 - 0.2, 6);
    expect(orb(c)).toBeNull(); // same state: no second attempt
  });
  it("ORB: retest that closes back inside -> no signal", () => {
    expect(orb(orbCtx({ o: 2407.6, h: 2408.0, l: 2405.0, c: 2405.5 }))).toBeNull();
  });
  it("SL/TP rounding, side and distance", () => {
    const x = buildSltp({ instrument: "XAU_USD", side: "SELL", bid: 2403.456, ask: 2403.656, sl: 2407.0, atr: 3, tp1R: 1, tp2R: 2, levels: [], commissionPerLot: 0 });
    expect(x.ok && x.entry === 2403.46 && x.sl > x.entry && x.tp1 < x.entry).toBe(true);
    const e = buildSltp({ instrument: "EUR_USD", side: "BUY", bid: 1.085004, ask: 1.085054, sl: 1.084601, atr: 0.0004, tp1R: 1, tp2R: 2, levels: [], commissionPerLot: 0 });
    expect(e.ok && String(e.tp2).split(".")[1]!.length <= 5).toBe(true);
    expect(roundPrice("EUR_USD", 1.0850849)).toBe(1.08508);
    expect(buildSltp({ instrument: "XAU_USD", side: "BUY", bid: 2400, ask: 2400.2, sl: 2399.5, atr: 3, tp1R: 1, tp2R: 2, levels: [], commissionPerLot: 0 }).ok).toBe(false); // 0.23 ATR
  });
});

// ---------------- 8 filters ----------------
describe("8 hard filters, each with a reason", () => {
  it("global filters", () => {
    expect(globalFilter(ctx({ t: Date.parse("2026-10-07T18:00:00Z") }))).toBe("outside window");
    expect(globalFilter(ctx({ stale: true }))).toBe("stale data");
    expect(globalFilter(ctx({ settings: Settings.parse({ paused: true }) }))).toBe("paused");
    expect(globalFilter(ctx({ snap: { ...ctx().snap, regime: "DEAD" } }))).toMatch(/DEAD/);
    expect(globalFilter(ctx({ snap: { ...ctx().snap, regime: "VOLATILE" } }))).toMatch(/VOLATILE/);
    expect(globalFilter(ctx({ ask: 2404.5 }))).toMatch(/spread/);
    expect(globalFilter(ctx({ news: NewsSource.fromEvents([{ t: T + 5 * MIN, title: "CPI", country: "USD" }]) }))).toMatch(/news/);
    expect(globalFilter(ctx({ openTrades: 2 }))).toMatch(/open trades/);
    expect(globalFilter(ctx({ signalsThisWindow: 6 }))).toMatch(/signals per window/);
    const st = newPairState(); st.lastLossAt = T - 2 * MIN;
    expect(globalFilter(ctx({ state: st }))).toMatch(/cooldown/);
    expect(globalFilter(ctx())).toBeNull();
  });
  it("EUR spread max in pips (app stores 1.2) is converted (defect fixed)", () => {
    expect(maxSpread("EUR_USD", 0.4, 1.2)).toBeCloseTo(0.00012, 10);
    expect(maxSpread("EUR_USD", 0.4, 0.00015)).toBe(0.00015);
    const e = ctx({ instrument: "EUR_USD", bid: 1.085, ask: 1.0852, settings: Settings.parse({ spread_max_eur: 1.2 }) });
    expect(globalFilter(e)).toMatch(/spread/); // 2 pips > 1.2 pips
  });
  it("cost ratio, level in the way, RR minimum, duplicate", () => {
    const b = { instrument: "XAU_USD" as const, side: "BUY" as const, bid: 2400, ask: 2400.2, sl: 2397.2, atr: 3, tp1R: 1, tp2R: 2, levels: [], commissionPerLot: 0 };
    expect(buildSltp({ ...b, ask: 2400.6 })).toMatchObject({ ok: false, reason: expect.stringMatching(/Cost ratio/) });
    expect(buildSltp({ ...b, levels: [{ name: "PDH", price: 2401.5 }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/Key level/) });
    expect(buildSltp({ ...b, tp1R: 0.8 })).toMatchObject({ ok: false, reason: expect.stringMatching(/RR\(TP1\)/) });
    const st = newPairState(); st.recent.push({ side: "BUY", t: T - 10 * MIN });
    expect(duplicateFilter(ctx({ state: st }), "BUY")).toMatch(/15 min/);
  });
});

// ---------------- 9 score ----------------
describe("9 score", () => {
  const x = { instrument: "XAU_USD" as const, side: "BUY" as const, regime: "TREND_UP" as const, eurRegime: "RANGE" as const, pattern: "break" as const, pathR: 1.6, rsi: 55, rsiPrev: 52, slope50: 0.4, atrPct: 50, t: T, costRatio: 0.12, counterTrend: false, newsWithin30: false };
  it("breakdown sums to total", () => {
    const s = score(x);
    const { total, ...parts } = s;
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(total);
    expect(total).toBe(25 + 10 + 8 + 10 + 10 + 10 + 0 + 0);
  });
  it("penalties: counter-trend -15, news -20", () => {
    expect(score({ ...x, counterTrend: true }).total).toBe(score(x).total - 15);
    expect(score({ ...x, newsWithin30: true }).total).toBe(score(x).total - 20);
  });
  it("min_score: profile and app floor both enforced", () => {
    const c = ctx(); c.m5.push({ t: T - 300_000, o: 2403.8, h: 2406.5, l: 2403.2, c: 2403.6 });
    const out = evaluate({ ...c, settings: Settings.parse({ min_score: 99 }) });
    expect(out.some((o) => o.kind === "skip" && /score \d+ < 99/.test(o.skip.reason))).toBe(true);
  });
});

// ---------------- 10 emit ----------------
describe("10 emit", () => {
  const sig = { idempotency_key: "sweep:XAUUSD:2026-10-07T14:30:00.000Z", pair: "XAUUSD" };
  it("idempotency key is stable for the same bar", () => {
    const mk = () => { const c = ctx(); c.m5.push({ t: T - 300_000, o: 2403.8, h: 2406.5, l: 2403.2, c: 2403.6 }); return c; };
    const keys = (o: ReturnType<typeof evaluate>) => o.flatMap((x) => (x.kind === "signal" ? [x.signal.idempotency_key] : [])).join();
    const s = Settings.parse({ min_score: 0, profile: "aggressive" });
    expect(keys(evaluate({ ...mk(), settings: s }))).toBe(keys(evaluate({ ...mk(), settings: s })));
  });
  it("outage -> queued, retried with backoff, delivered once", async () => {
    let now = 0; let calls = 0;
    const box = new SignalOutbox(async () => { calls++; if (calls < 3) throw new HttpError(503, "down"); return {}; }, () => now);
    expect(await box.submit(sig, 300_000)).toBe("queued");
    expect(await box.submit(sig, 300_000)).toBe("queued"); // same key not added twice
    await box.drain(); expect(calls).toBe(1); // backoff not elapsed
    now = 2_000; await box.drain(); now = 6_000; await box.drain();
    expect(calls).toBe(3); expect(box.size).toBe(0);
  });
  it("refused (4xx) dropped; expired never delivered late", async () => {
    let now = 0;
    const refused = new SignalOutbox(async () => { throw new HttpError(400, "bad"); }, () => now);
    expect(await refused.submit(sig, 300_000)).toBe("dropped");
    const send = vi.fn(async () => { throw new Error("network"); });
    const box = new SignalOutbox(send, () => now);
    await box.submit(sig, 10_000);
    now = 11_000; await box.drain();
    expect(send).toHaveBeenCalledTimes(1); expect(box.size).toBe(0);
  });
});

// ---------------- 11 manager ----------------
describe("11 trade manager", () => {
  const trade: OpenTrade = { id: "t1", pair: "XAUUSD", side: "BUY", actual_entry: 2400, actual_lot: 0.1, opened_at: new Date().toISOString(), signal: { id: 1, entry: 2400, sl: 2397, tp1: 2403, tp2: 2406, strategy: "pullback" } };
  const setup = () => {
    const events: string[] = [];
    const api = { openTrades: async () => [trade], event: async (type: string) => { events.push(type); return null; } } as unknown as LovableApi;
    const quotes = new Map<Instrument, Quote>();
    const m = new TradeManager(api, quotes, NewsSource.fromEvents([]), () => 3);
    return { m, quotes, events };
  };
  it("BUY exits on bid: ask at TP1 but bid below -> no alert", async () => {
    const { m, quotes, events } = setup();
    quotes.set("XAU_USD", { bid: 2402.9, ask: 2403.1, t: 0 });
    await m.poll();
    expect(events).not.toContain("tp1_alert");
  });
  it("TP1 and sl_near fire once, not every tick", async () => {
    const { m, quotes, events } = setup();
    quotes.set("XAU_USD", { bid: 2403.2, ask: 2403.4, t: 0 });
    await m.poll(); await m.poll(); await m.poll();
    expect(events.filter((e) => e === "tp1_alert").length).toBe(1);
    quotes.set("XAU_USD", { bid: 2400.3, ask: 2400.5, t: 0 }); // near BE stop
    await m.poll(); await m.poll();
    expect(events.filter((e) => e === "sl_near").length).toBe(1);
  });
  it("trail never loosens", async () => {
    const { m, quotes, events } = setup();
    quotes.set("XAU_USD", { bid: 2403.2, ask: 2403.4, t: 0 });
    await m.poll();
    await m.onM5Close("XAU_USD", 2407); // trail 2404
    await m.onM5Close("XAU_USD", 2405); // would be 2402 -> ignored
    await m.onM5Close("XAU_USD", 2408); // 2405, +1 >= 0.9 -> alert
    const st = m.exportState()["t1"]!;
    expect(st.sl).toBe(2405);
    expect(events.filter((e) => e === "trail_alert").length).toBe(2);
  });
  it("state survives restart (no repeat TP1 alert)", async () => {
    const a = setup();
    a.quotes.set("XAU_USD", { bid: 2403.2, ask: 2403.4, t: 0 });
    await a.m.poll();
    const b = setup();
    b.m.importState(JSON.parse(JSON.stringify(a.m.exportState())));
    b.quotes.set("XAU_USD", { bid: 2403.2, ask: 2403.4, t: 0 });
    await b.m.poll();
    expect(b.events).not.toContain("tp1_alert");
  });
});

// ---------------- 12 backtest ----------------
function walk(n: number, stepMs: number, seed: number, start: number) {
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 2400; const out = [];
  for (let i = 0; i < n; i++) { const o = p; p += (rnd() - 0.5) * 2; out.push({ t: start + i * stepMs, o, h: Math.max(o, p) + rnd(), l: Math.min(o, p) - rnd(), c: p, spread: 0.2 }); }
  return out;
}
describe("12 backtest", () => {
  it("no lookahead: changing future bars never changes a past decision", () => {
    const start = Date.parse("2026-09-28T00:00:00Z");
    const m5 = walk(1500, 5 * MIN, 7, start), m15 = walk(600, 15 * MIN, 11, start);
    const settings = Settings.parse({ min_score: 0 });
    const decide = (b5: typeof m5, b15: typeof m15, i: number) => {
      const closeT = b5[i]!.t + 5 * MIN;
      const s5 = b5.slice(Math.max(0, i - 600), i + 1);
      const s15 = b15.filter((b) => b.t + 15 * MIN <= closeT).slice(-400);
      const snap = analyzeBars("XAU_USD", s5, s15);
      if (!snap) return "none";
      const c = buildCtx({ instrument: "XAU_USD", t: closeT, m5: s5, m15: s15, snap, eurRegime: null, bid: s5[s5.length - 1]!.c - 0.1, ask: s5[s5.length - 1]!.c + 0.1, settings, commissionPerLot: 0, news: NewsSource.fromEvents([]), state: newPairState(), stale: false, openTrades: 0, signalsThisWindow: 0 });
      return JSON.stringify([snap.regime, snap.m5.atr14, evaluate(c).map((o) => (o.kind === "signal" ? o.signal.idempotency_key : o.skip.reason))]);
    };
    const shifted5 = m5.map((b, k) => (k > 1200 ? { ...b, h: b.h + 50, c: b.c + 40 } : b));
    const shifted15 = m15.map((b) => (b.t >= m5[1200]!.t + 5 * MIN ? { ...b, c: b.c + 40, h: b.h + 50 } : b));
    for (const i of [900, 1000, 1100, 1200]) expect(decide(shifted5, shifted15, i)).toBe(decide(m5, m15, i));
  });
  it("SL-first and costs applied", () => {
    const t0 = 0;
    const base = { side: "BUY" as const, entry: 2400, sl: 2397, tp1: 2403, tp2: 2406, atr: 3, spread: 0.2, partialPct: 50, startT: t0 };
    const both = [{ t: t0, o: 2400, h: 2404, l: 2396, c: 2400, spread: 0.2 }];
    expect(simulate({ ...base, commissionPrice: 0 }, both, 0).outcome).toBe("SL");
    const win = [{ t: t0, o: 2400, h: 2407, l: 2399.9, c: 2406.5, spread: 0.2 }];
    const free = simulate({ ...base, commissionPrice: 0 }, win, 0), paid = simulate({ ...base, commissionPrice: 0.3 }, win, 0);
    const diff = free.netR - paid.netR;
    expect(diff).toBeGreaterThan(0.09); expect(diff).toBeLessThan(0.11); // 0.30 commission / ~3.0 risk
  });
  it("live gate computed from out-of-sample stats", () => {
    const tr = Array.from({ length: 120 }, (_, k) => ({ strategy: "s", pair: "XAUUSD", side: "BUY", t: k, exitT: k, hourIst: 20, netR: k % 2 ? 1.2 : -0.8, score: 70, outcome: "x" }));
    const g = liveGate(stats(tr));
    expect(g.pass).toBe(true);
    expect(liveGate(stats(tr.slice(0, 50))).reasons[0]).toMatch(/< 100/);
  });
});

// ---------------- 13 security / ops ----------------
describe("13 security and ops", () => {
  it("secrets redacted from logs", () => {
    registerSecrets("oanda-token-1234567890");
    expect(redact('{"error":"GET failed Bearer oanda-token-1234567890"}')).not.toContain("oanda-token");
  });
  it("env validated at start", () => {
    expect(() => loadConfig({ OANDA_TOKEN: "short" })).toThrow();
    expect(loadConfig({ OANDA_TOKEN: "x".repeat(20), OANDA_ACCOUNT_ID: "101-001", LOVABLE_FN_URL: "https://a.b/api/", WORKER_SECRET: "y".repeat(20) }).LOVABLE_FN_URL).toBe("https://a.b/api");
  });
  it("memory bounded over a simulated 24h of ticks", () => {
    const store = new CandleStore();
    const b = new CandleBuilder((c) => store.upsert(c));
    const t0 = Date.parse("2026-10-07T00:00:00Z");
    for (let s = 0; s < 86_400; s += 1) { b.push(tick(t0 + s * 1000, 2400 + Math.sin(s / 500))); b.push(tick(t0 + s * 1000, 1.08, "EUR_USD")); }
    expect(store.get("XAU_USD", "M1").length).toBeLessThanOrEqual(1500);
    expect(store.get("XAU_USD", "M5").length).toBe(287);
  });
});
