import { z } from "zod";
import { INSTRUMENTS, type Config, type Instrument } from "../config.js";
import type { Tick } from "../candles/types.js";

const Price = z.object({
  type: z.literal("PRICE"),
  instrument: z.enum(INSTRUMENTS),
  time: z.string(),
  bids: z.array(z.object({ price: z.string() })).min(1),
  asks: z.array(z.object({ price: z.string() })).min(1),
});

export interface StreamHandlers {
  onTick: (t: Tick) => void;
  onHeartbeat: () => void;
}

/** Parse one NDJSON line from the pricing stream. */
export function parseLine(line: string): { kind: "tick"; tick: Tick } | { kind: "heartbeat" } | null {
  if (!line.trim()) return null;
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  const type = (raw as { type?: string }).type;
  if (type === "HEARTBEAT") return { kind: "heartbeat" };
  const p = Price.safeParse(raw);
  if (!p.success) return null;
  const bid = Number(p.data.bids[0]!.price);
  const ask = Number(p.data.asks[0]!.price);
  return {
    kind: "tick",
    tick: { instrument: p.data.instrument as Instrument, time: Date.parse(p.data.time), bid, ask, mid: (bid + ask) / 2, spread: ask - bid },
  };
}

/** Opens the stream and resolves when it ends. Throws on HTTP error. */
export async function openStream(cfg: Config, h: StreamHandlers, signal: AbortSignal): Promise<void> {
  const url = `${cfg.streamBase}/v3/accounts/${cfg.OANDA_ACCOUNT_ID}/pricing/stream?instruments=${INSTRUMENTS.join(",")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.OANDA_TOKEN}` }, signal });
  if (!res.ok || !res.body) throw new Error(`OANDA stream HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const r = parseLine(line);
      if (r?.kind === "tick") h.onTick(r.tick);
      else if (r?.kind === "heartbeat") h.onHeartbeat();
    }
  }
}
