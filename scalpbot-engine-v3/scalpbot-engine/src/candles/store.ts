import type { Instrument, Tf } from "../config.js";
import type { Candle } from "./types.js";

const MAX = 1500;

/** Closed candles per instrument/timeframe, sorted by time, unique by t. */
export class CandleStore {
  private data = new Map<string, Candle[]>();
  private key = (i: Instrument, tf: Tf) => `${i}:${tf}`;

  get(i: Instrument, tf: Tf): Candle[] { return this.data.get(this.key(i, tf)) ?? []; }

  /** Insert or replace by bucket time. Returns true if new or changed. */
  upsert(c: Candle): boolean {
    const arr = this.get(c.instrument, c.tf).slice();
    const idx = arr.findIndex((x) => x.t === c.t);
    if (idx >= 0) arr[idx] = c;
    else {
      arr.push(c);
      arr.sort((a, b) => a.t - b.t);
    }
    this.data.set(this.key(c.instrument, c.tf), arr.slice(-MAX));
    return true;
  }

  last(i: Instrument, tf: Tf): Candle | undefined { const a = this.get(i, tf); return a[a.length - 1]; }
}
