import type { Instrument } from "./config.js";
import type { CandleStore } from "./candles/store.js";
import { ema } from "./indicators/ema.js";
import { atr } from "./indicators/atr.js";
import { rsi } from "./indicators/rsi.js";
import { percentileRank, slopeNorm } from "./indicators/percentile.js";
import { regime, type Regime } from "./regime.js";
import { bos, swings, trendFromSwings, type Trend } from "./structure/swings.js";

export interface Snapshot {
  instrument: Instrument;
  m5: { ema20: number; ema50: number; atr14: number; rsi14: number; atrPct: number; slope50: number; trend: Trend; bos: boolean };
  m15: { ema20: number; ema50: number; ema200: number; atr14: number; slope50: number };
  regime: Regime;
}

const last = (a: number[]) => a[a.length - 1] ?? NaN;

/** Indicators are recomputed on every close, inside or outside the window. */
export function analyze(store: CandleStore, instrument: Instrument, newsWithin30 = false): Snapshot | null {
  return analyzeBars(instrument, store.get(instrument, "M5"), store.get(instrument, "M15"), newsWithin30);
}

interface OHLCBar { t: number; o: number; h: number; l: number; c: number }

/** Uses only the closed bars passed in (no lookahead). */
export function analyzeBars(instrument: Instrument, m5: OHLCBar[], m15: OHLCBar[], newsWithin30 = false): Snapshot | null {
  if (m5.length < 60 || m15.length < 210) return null;
  const c5 = m5.map((b) => b.c), c15 = m15.map((b) => b.c);
  const e20 = ema(c5, 20), e50 = ema(c5, 50), a5 = atr(m5, 14);
  const f20 = ema(c15, 20), f50 = ema(c15, 50), f200 = ema(c15, 200), a15 = atr(m15, 14);
  const sw = swings(m5, 2);
  const tr = trendFromSwings(sw);
  const snap: Snapshot = {
    instrument,
    m5: { ema20: last(e20), ema50: last(e50), atr14: last(a5), rsi14: last(rsi(c5, 14)), atrPct: percentileRank(a5, 200), slope50: slopeNorm(e50, a5), trend: tr, bos: bos(m5, sw, tr) },
    m15: { ema20: last(f20), ema50: last(f50), ema200: last(f200), atr14: last(a15), slope50: slopeNorm(f50, a15) },
    regime: "RANGE",
  };
  snap.regime = regime({ m15Close: last(c15), ema20: snap.m15.ema20, ema50: snap.m15.ema50, ema200: snap.m15.ema200, slope50: snap.m15.slope50, atrPct: snap.m5.atrPct, newsWithin30 });
  return snap;
}
