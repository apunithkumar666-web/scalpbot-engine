import { z } from "zod";
import { appPair, type Config } from "../config.js";
import type { Candle } from "../candles/types.js";
import { HttpError } from "../outbox.js";

export const Settings = z.object({
  window_start: z.string().default("18:30"),
  window_end: z.string().default("22:30"),
  strategies_enabled: z.record(z.boolean()).default({}),
  pairs_enabled: z.array(z.string()).default(["XAUUSD", "EURUSD"]),
  min_score: z.number().default(65),
  tp1_r: z.number().default(1),
  tp2_r: z.number().default(2),
  partial_pct: z.number().default(50),
  validity_min: z.number().default(3),
  max_signals_per_window: z.number().default(6),
  max_open: z.number().default(2),
  loss_halt_n: z.number().default(3),
  spread_max_xau: z.number().default(0.5),
  spread_max_eur: z.number().default(0.00015),
  paused: z.boolean().default(false),
  profile: z.enum(["conservative", "standard", "aggressive"]).default("aggressive"),
});
export type Settings = z.infer<typeof Settings>;
export type EventType = "tp1_alert" | "be_alert" | "trail_alert" | "sl_near" | "heartbeat" | "data_gap" | "news_block" | "time_stop" | "news_warn";

export const Stats = z.object({
  signals_this_window: z.number().default(0),
  open_trades: z.number().default(0),
  recent_signals: z.array(z.object({ pair: z.string(), side: z.string(), created_at: z.string() })).default([]),
  last_loss_at: z.record(z.string()).default({}),
  strategy_live: z.record(z.object({ n: z.number(), expectancy_r: z.number() })).default({}),
});
export type Stats = z.infer<typeof Stats>;
export interface WorkerConfig { settings: Settings; commissionPerLot: number; stats: Stats }

export const OpenTrade = z.object({
  id: z.string(),
  pair: z.string(),
  side: z.enum(["BUY", "SELL"]),
  actual_entry: z.number().nullable(),
  actual_lot: z.number().nullable(),
  opened_at: z.string(),
  signal: z.object({ id: z.number(), entry: z.number(), sl: z.number(), tp1: z.number(), tp2: z.number(), strategy: z.string().nullable() }).nullable(),
});
export type OpenTrade = z.infer<typeof OpenTrade>;

export class LovableApi {
  /** Calls actually sent (POSTs); used to prove --dry-run sends nothing. */
  sent = 0;
  constructor(private cfg: Config, private dryRun = false, private fetchImpl: typeof fetch = fetch) {}

  private async call(path: string, init: RequestInit = {}, attempt = 0): Promise<unknown> {
    if (init.method === "POST") this.sent++;
    const res = await this.fetchImpl(`${this.cfg.LOVABLE_FN_URL}/${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "x-worker-secret": this.cfg.WORKER_SECRET, ...(init.headers ?? {}) },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 300));
      return this.call(path, init, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, `${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  async ingestCandles(candles: Candle[]) {
    if (!candles.length || this.dryRun) return;
    for (let i = 0; i < candles.length; i += 1000) {
      const batch = candles.slice(i, i + 1000).map((c) => ({
        pair: appPair(c.instrument), tf: c.tf, ts: new Date(c.t).toISOString(),
        o: c.o, h: c.h, l: c.l, c: c.c, v: c.ticks,
      }));
      await this.call("ingest-candles", { method: "POST", body: JSON.stringify({ candles: batch }) });
    }
  }

  event(type: EventType, text?: string, trade_id?: string, extra: { mae?: number; mfe?: number } = {}) {
    const body = { type, ...(text ? { text } : {}), ...(trade_id ? { trade_id } : {}), ...extra };
    if (this.dryRun) { if (type === "heartbeat") return Promise.resolve(null); console.log(JSON.stringify({ dry_run: "event", ...body })); return Promise.resolve(null); }
    return this.call("ingest-event", { method: "POST", body: JSON.stringify(body) });
  }

  async config(): Promise<WorkerConfig | null> {
    const r = (await this.call("worker-settings")) as { settings: unknown; account?: { commission_per_lot?: number }; stats?: unknown } | null;
    if (!r?.settings) return null;
    return { settings: Settings.parse(r.settings), commissionPerLot: Number(r.account?.commission_per_lot ?? 0), stats: Stats.parse(r.stats ?? {}) };
  }

  async openTrades(): Promise<OpenTrade[]> {
    const r = (await this.call("open-trades")) as { trades?: unknown[] } | null;
    return (r?.trades ?? []).flatMap((t) => { const p = OpenTrade.safeParse(t); return p.success ? [p.data] : []; });
  }

  /** POST ingest-signal; the HTTP layer already retries 3x with backoff on 429/5xx. */
  signal(sig: Record<string, unknown>) {
    if (this.dryRun) { console.log(JSON.stringify({ dry_run: "signal", ...sig })); return Promise.resolve({ ok: true, dry_run: true }); }
    return this.call("ingest-signal", { method: "POST", body: JSON.stringify(sig) });
  }

  skips(skips: Record<string, unknown>[]) {
    if (!skips.length) return Promise.resolve(null);
    if (this.dryRun) return Promise.resolve(null);
    return this.call("ingest-skip", { method: "POST", body: JSON.stringify({ skips: skips.slice(0, 200) }) });
  }

  strategyStatus(strategy: string, enabled: boolean, reason: string) {
    if (this.dryRun) { console.log(JSON.stringify({ dry_run: "strategy_status", strategy, enabled, reason })); return Promise.resolve(null); }
    return this.call("strategy-status", { method: "POST", body: JSON.stringify({ strategy, enabled, reason }) });
  }
}
