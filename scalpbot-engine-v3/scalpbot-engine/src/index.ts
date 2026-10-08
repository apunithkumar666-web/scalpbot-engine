import { BACKFILL_COUNT, HEARTBEAT_MS, INSTRUMENTS, RECONCILE_DELAY_MS, SETTINGS_MS, STALE_MS, TFS, TF_SECONDS, appPair, loadConfig, type Instrument } from "./config.js";
import { CandleBuilder } from "./candles/builder.js";
import { CandleStore } from "./candles/store.js";
import { reconcile } from "./candles/reconcile.js";
import type { Candle } from "./candles/types.js";
import { fetchCandles } from "./oanda/rest.js";
import { openStream } from "./oanda/stream.js";
import { LovableApi, type WorkerConfig } from "./api/lovable.js";
import { analyze } from "./analysis.js";
import { NewsSource } from "./news.js";
import { TradeManager, type Quote } from "./manager.js";
import { buildCtx } from "./context.js";
import { evaluate } from "./evaluate.js";
import { newPairState, type PairState } from "./types.js";
import { log, logError, registerSecrets } from "./logger.js";
import { SignalOutbox } from "./outbox.js";
import { FeedGuard } from "./guard.js";
import { marketOpen } from "./levels/sessions.js";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");
const cfg = loadConfig();
registerSecrets(cfg.OANDA_TOKEN, cfg.WORKER_SECRET);
const STATE_FILE = process.env["STATE_FILE"] ?? "./scalpbot-state.json";
const api = new LovableApi(cfg, DRY);
const store = new CandleStore();
const news = new NewsSource();
const quotes = new Map<Instrument, Quote>();
const pairState = new Map<Instrument, PairState>(INSTRUMENTS.map((i) => [i, newPairState()]));
let wc: WorkerConfig | null = null;
const guard = new FeedGuard(Date.now());
let stale = false;
let signalsSent = 0;
const outbox: Candle[] = [];
const atrOf = (i: Instrument) => analyze(store, i)?.m5.atr14 ?? NaN;
const manager = new TradeManager(api, quotes, news, atrOf);
try { manager.importState(JSON.parse(readFileSync(STATE_FILE, "utf8"))); } catch { /* first run */ }
const saveState = () => { try { writeFileSync(STATE_FILE, JSON.stringify(manager.exportState())); } catch (e) { logError("state_save_failed", e); } };
const outbox2 = new SignalOutbox((b) => api.signal(b));

const builder = new CandleBuilder((c) => {
  store.upsert(c);
  outbox.push(c);
  setTimeout(() => void reconcileLast(c), RECONCILE_DELAY_MS);
  if (c.tf === "M5") {
    void manager.onM5Close(c.instrument, c.c);
    // evaluate after the REST reconcile so the bar is authoritative
    setTimeout(() => void onM5Close(c.instrument, c.t + TF_SECONDS.M5 * 1000), RECONCILE_DELAY_MS + 1500);
  }
});

async function onM5Close(instrument: Instrument, closeT: number) {
  if (!wc) return;
  const snap = analyze(store, instrument, news.soon(closeT, 30) !== null);
  const eur = analyze(store, "EUR_USD");
  const q = quotes.get(instrument);
  if (!snap || !q) return;
  const state = pairState.get(instrument)!;
  const ctx = buildCtx({
    instrument, t: closeT, m5: store.get(instrument, "M5"), m15: store.get(instrument, "M15"), snap, eurRegime: eur?.regime ?? null,
    bid: q.bid, ask: q.ask, settings: wc.settings, commissionPerLot: wc.commissionPerLot, news, state, stale,
    openTrades: Math.max(wc.stats.open_trades, manager.openCount), signalsThisWindow: wc.stats.signals_this_window + signalsSent,
  });
  const outcomes = evaluate(ctx);
  const skips: Record<string, unknown>[] = [];
  for (const o of outcomes) {
    if (o.kind === "skip") {
      log("setup_skipped", { pair: o.skip.pair, strategy: o.skip.strategy, side: o.skip.side, reason: o.skip.reason });
      if (o.post) skips.push({ ...o.skip });
      continue;
    }
    log("setup_passed", { ...o.signal, features: undefined });
    const validMin = wc.settings.validity_min;
    const res = await outbox2.submit({ ...o.signal }, closeT + validMin * 60_000);
    if (res !== "dropped") {
      state.recent.push({ side: o.signal.side, t: closeT });
      state.recent = state.recent.filter((r) => closeT - r.t < 60 * 60_000);
      signalsSent++;
    }
  }
  await api.skips(skips).catch((e) => logError("ingest_skip_failed", e));
}

async function reconcileLast(closed: Candle) {
  try {
    const rest = await fetchCandles(cfg, closed.instrument, closed.tf, 3);
    for (const r of rest) {
      const cur = store.get(r.instrument, r.tf).find((x) => x.t === r.t);
      const res = reconcile(cur, r, r.instrument);
      if (res.mismatch) {
        log("reconcile_mismatch", { instrument: r.instrument, tf: r.tf, t: new Date(r.t).toISOString(), diff: res.diff });
        store.upsert(res.candle); outbox.push(res.candle);
      } else if (!cur) { store.upsert(r); outbox.push(r); }
    }
  } catch (e) { logError("reconcile_failed", e); }
}

async function backfill() {
  for (const i of INSTRUMENTS) for (const tf of TFS) {
    const bars = await fetchCandles(cfg, i, tf, BACKFILL_COUNT);
    bars.forEach((b) => store.upsert(b));
    outbox.push(...bars);
    log("backfilled", { instrument: i, tf, bars: bars.length });
  }
}

async function flush() {
  if (!outbox.length) return;
  const batch = outbox.splice(0, outbox.length);
  try { await api.ingestCandles(batch); }
  catch (e) { logError("ingest_candles_failed", e); outbox.unshift(...batch.slice(-3000)); }
}

async function refreshConfig() {
  try {
    const next = await api.config();
    if (!next) return;
    wc = next;
    signalsSent = 0; // app counters now include what we sent
    for (const i of INSTRUMENTS) {
      const st = pairState.get(i)!;
      const loss = next.stats.last_loss_at[appPair(i)];
      if (loss) st.lastLossAt = Date.parse(loss);
      for (const r of next.stats.recent_signals) if (r.pair === appPair(i) && (r.side === "BUY" || r.side === "SELL")) {
        const t = Date.parse(r.created_at);
        if (!st.recent.some((x) => x.side === r.side && Math.abs(x.t - t) < 60_000)) st.recent.push({ side: r.side, t });
      }
    }
    log("config", { profile: next.settings.profile, paused: next.settings.paused, window: `${next.settings.window_start}-${next.settings.window_end}`, open: next.stats.open_trades, signals_window: next.stats.signals_this_window });
  } catch (e) { logError("config_failed", e); }
}

/** Live gate: auto-disable a strategy when live expectancy < 0 after 50 signals. */
async function liveGate() {
  if (!wc) return;
  for (const [strategy, s] of Object.entries(wc.stats.strategy_live)) {
    if (!["pullback", "sweep", "orb"].includes(strategy)) continue;
    if (s.n >= 50 && s.expectancy_r < 0 && wc.settings.strategies_enabled[strategy] !== false) {
      log("live_gate_disable", { strategy, ...s });
      await api.strategyStatus(strategy, false, `live expectancy ${s.expectancy_r.toFixed(2)}R after ${s.n} trades`).catch((e) => logError("strategy_status_failed", e));
    }
  }
}

async function runStream() {
  let backoff = 1000;
  for (;;) {
    const ctl = new AbortController();
    const watch = setInterval(() => {
      const now = Date.now();
      const r = guard.check(now, marketOpen(now));
      if (r.becameStale) {
        stale = true;
        log("data_gap", { ms: now - guard.lastTick });
        api.event("data_gap", "No price ticks for 5s. Scanning paused, reconnecting.").catch(() => {});
      }
      if (r.reconnect) ctl.abort();
    }, 1000);
    try {
      await openStream(cfg, {
        onTick: (t) => {
          if (guard.tick(Date.now()) === "resumed") { stale = false; log("data_resumed"); }
          backoff = 1000;
          quotes.set(t.instrument, { bid: t.bid, ask: t.ask, t: t.time });
          builder.push(t);
        },
        onHeartbeat: () => guard.heartbeat(Date.now()),
      }, ctl.signal);
    } catch (e) { if (!ctl.signal.aborted) logError("stream_error", e); }
    finally { clearInterval(watch); }
    builder.reset();
    // closed market: wait calmly instead of hammering OANDA
    const wait = marketOpen(Date.now()) ? backoff : 5 * 60_000;
    await new Promise((r) => setTimeout(r, wait + Math.random() * 250));
    backoff = Math.min(backoff * 2, 60_000);
    guard.heartbeat(Date.now());
    if (marketOpen(Date.now())) await backfill().catch((e) => logError("backfill_failed", e));
  }
}

const timers: ReturnType<typeof setInterval>[] = [];
async function main() {
  log("start", { env: cfg.OANDA_ENV, dry_run: DRY });
  await Promise.all([refreshConfig(), news.refresh(true)]);
  await backfill();
  await flush();
  timers.push(
    setInterval(() => void flush(), 5_000),
    setInterval(() => void outbox2.drain(), 5_000),
    setInterval(saveState, 10_000),
    setInterval(() => void refreshConfig(), SETTINGS_MS),
    setInterval(() => void manager.poll(), 5_000),
    setInterval(() => void news.refresh(), 10 * 60_000),
    setInterval(() => void liveGate(), 7 * 24 * 60 * 60_000),
    setInterval(() => void api.event("heartbeat").catch((e) => logError("heartbeat_failed", e)), HEARTBEAT_MS),
  );
  void liveGate();
  const port = Number(process.env["PORT"] ?? 0);
  if (port) createServer((req, res) => {
    const age = Date.now() - guard.lastTick;
    const ok = !marketOpen(Date.now()) || age < 120_000;
    res.writeHead(req.url === "/health" ? (ok ? 200 : 503) : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok, last_tick_ms: age, stale, queued_signals: outbox2.size, dry_run: DRY }));
  }).listen(port, () => log("health_listening", { port }));
  void api.event("heartbeat").catch(() => {});
  await runStream();
}

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log("shutdown", { signal: sig });
  timers.forEach(clearInterval);
  saveState();
  await outbox2.drain().catch(() => {});
  await flush().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => logError("unhandled_rejection", e));
// crash -> exit non-zero so the host (Railway/Render/Fly) restarts the worker
// wait 30s before exiting so a crash loop can't hammer OANDA or the app
main().catch((e) => { logError("fatal", e); setTimeout(() => process.exit(1), 30_000); });
