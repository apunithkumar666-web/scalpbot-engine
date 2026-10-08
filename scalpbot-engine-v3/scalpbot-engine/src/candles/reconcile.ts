import { RECONCILE_TOL, type Instrument } from "../config.js";
import type { Candle } from "./types.js";

/** REST is authoritative. Returns the REST candle when any OHLC field differs beyond tolerance. */
export function reconcile(stream: Candle | undefined, rest: Candle, instrument: Instrument): { candle: Candle; mismatch: boolean; diff: number } {
  if (!stream) return { candle: rest, mismatch: false, diff: 0 };
  const diff = Math.max(Math.abs(stream.o - rest.o), Math.abs(stream.h - rest.h), Math.abs(stream.l - rest.l), Math.abs(stream.c - rest.c));
  if (diff > RECONCILE_TOL[instrument]) {
    return { candle: { ...rest, ticks: stream.ticks, avgSpread: stream.avgSpread, maxSpread: stream.maxSpread }, mismatch: true, diff };
  }
  return { candle: stream, mismatch: false, diff };
}
