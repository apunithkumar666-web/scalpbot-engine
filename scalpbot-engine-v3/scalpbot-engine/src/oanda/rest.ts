import { z } from "zod";
import type { Config, Instrument, Tf } from "../config.js";
import type { Candle } from "../candles/types.js";

const Resp = z.object({
  candles: z.array(z.object({
    time: z.string(),
    complete: z.boolean(),
    volume: z.number().optional(),
    mid: z.object({ o: z.string(), h: z.string(), l: z.string(), c: z.string() }),
  })),
});

/** Fetch the last `count` COMPLETE mid candles. */
export async function fetchCandles(cfg: Config, instrument: Instrument, tf: Tf, count: number): Promise<Candle[]> {
  const url = `${cfg.restBase}/v3/instruments/${instrument}/candles?granularity=${tf}&price=M&count=${count}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.OANDA_TOKEN}`, "Accept-Datetime-Format": "RFC3339" } });
  if (!res.ok) throw new Error(`OANDA candles ${instrument} ${tf}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  const body = Resp.parse(await res.json());
  return body.candles.filter((c) => c.complete).map((c) => ({
    instrument, tf,
    t: Date.parse(c.time),
    o: Number(c.mid.o), h: Number(c.mid.h), l: Number(c.mid.l), c: Number(c.mid.c),
    ticks: c.volume ?? 0, avgSpread: 0, maxSpread: 0, source: "rest" as const,
  }));
}
