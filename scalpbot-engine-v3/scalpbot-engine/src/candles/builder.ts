import { TF_SECONDS, TFS, type Instrument, type Tf } from "../config.js";
import type { Candle, Tick } from "./types.js";

export const bucketStart = (ms: number, tf: Tf) => {
  const size = TF_SECONDS[tf] * 1000;
  return Math.floor(ms / size) * size;
};

/**
 * Builds M1/M5/M15 candles from mid ticks, aligned to UTC.
 * A candle is finalized on the first tick of the next bucket.
 */
export class CandleBuilder {
  private open = new Map<string, Candle & { spreadSum: number }>();
  constructor(private onClose: (c: Candle) => void) {}

  push(tick: Tick) {
    for (const tf of TFS) {
      const key = `${tick.instrument}:${tf}`;
      const t = bucketStart(tick.time, tf);
      const cur = this.open.get(key);
      if (cur && t > cur.t) {
        this.onClose(finalize(cur));
        this.open.delete(key);
      }
      const live = this.open.get(key);
      if (!live) {
        this.open.set(key, {
          instrument: tick.instrument, tf, t,
          o: tick.mid, h: tick.mid, l: tick.mid, c: tick.mid,
          ticks: 1, spreadSum: tick.spread, avgSpread: tick.spread, maxSpread: tick.spread, source: "stream",
        });
      } else if (t === live.t) {
        live.h = Math.max(live.h, tick.mid);
        live.l = Math.min(live.l, tick.mid);
        live.c = tick.mid;
        live.ticks += 1;
        live.spreadSum += tick.spread;
        live.maxSpread = Math.max(live.maxSpread, tick.spread);
      }
      // ticks older than the open bucket are ignored
    }
  }

  current(instrument: Instrument, tf: Tf): Candle | undefined {
    const c = this.open.get(`${instrument}:${tf}`);
    return c ? finalize(c) : undefined;
  }

  /** Drop partial candles (e.g. after a data gap). */
  reset() { this.open.clear(); }
}

function finalize(c: Candle & { spreadSum: number }): Candle {
  const { spreadSum, ...rest } = c;
  return { ...rest, avgSpread: spreadSum / Math.max(1, c.ticks) };
}
