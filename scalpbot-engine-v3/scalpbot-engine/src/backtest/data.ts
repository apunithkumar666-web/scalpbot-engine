import { z } from "zod";
import type { Config, Instrument, Tf } from "../config.js";
import { TF_SECONDS } from "../config.js";

export interface BtBar { t: number; o: number; h: number; l: number; c: number; spread: number }

const C = z.object({ o: z.string(), h: z.string(), l: z.string(), c: z.string() });
const Resp = z.object({ candles: z.array(z.object({ time: z.string(), complete: z.boolean(), mid: C.optional(), bid: C.optional(), ask: C.optional() })) });

/** Paginated REST download (max 5000 per call), mid + bid/ask close for spread. */
export async function fetchRange(cfg: Config, instrument: Instrument, tf: Tf, from: number, to: number): Promise<BtBar[]> {
  const out: BtBar[] = [];
  let cursor = from;
  const step = TF_SECONDS[tf] * 1000;
  while (cursor < to) {
    const url = `${cfg.restBase}/v3/instruments/${instrument}/candles?granularity=${tf}&price=MBA&count=5000&from=${new Date(cursor).toISOString()}&includeFirst=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.OANDA_TOKEN}` } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (!res.ok) throw new Error(`OANDA ${instrument} ${tf}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const body = Resp.parse(await res.json());
    const bars = body.candles.filter((c) => c.complete && c.mid).map((c) => ({
      t: Date.parse(c.time),
      o: Number(c.mid!.o), h: Number(c.mid!.h), l: Number(c.mid!.l), c: Number(c.mid!.c),
      spread: c.ask && c.bid ? Math.max(0, Number(c.ask.c) - Number(c.bid.c)) : 0,
    })).filter((b) => b.t < to);
    for (const b of bars) if (!out.length || b.t > out[out.length - 1]!.t) out.push(b);
    if (body.candles.length < 2) break;
    const lastT = Date.parse(body.candles[body.candles.length - 1]!.time);
    if (lastT + step <= cursor) break;
    cursor = lastT + step;
    process.stderr.write(`  ${instrument} ${tf}: ${out.length} bars\r`);
  }
  process.stderr.write("\n");
  return out;
}

/** Average spread per UTC hour (0-23) from recorded bid/ask. */
export function spreadByHour(bars: BtBar[]): number[] {
  const sum = new Array<number>(24).fill(0), n = new Array<number>(24).fill(0);
  for (const b of bars) if (b.spread > 0) { const h = new Date(b.t).getUTCHours(); sum[h]! += b.spread; n[h]! += 1; }
  const overall = sum.reduce((a, b) => a + b, 0) / Math.max(1, n.reduce((a, b) => a + b, 0));
  return sum.map((s, h) => (n[h] ? s / n[h]! : overall));
}
