import type { Instrument, Tf } from "../config.js";

export interface Candle {
  instrument: Instrument;
  tf: Tf;
  /** Bucket start, epoch ms UTC */
  t: number;
  o: number; h: number; l: number; c: number;
  ticks: number;
  avgSpread: number;
  maxSpread: number;
  source: "stream" | "rest";
}

export interface Tick { instrument: Instrument; time: number; bid: number; ask: number; mid: number; spread: number }
