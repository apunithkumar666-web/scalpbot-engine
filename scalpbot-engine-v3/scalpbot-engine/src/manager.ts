import type { Instrument } from "./config.js";
import type { LovableApi, OpenTrade } from "./api/lovable.js";
import type { NewsSource } from "./news.js";
import { log, logError } from "./logger.js";

export interface Quote { bid: number; ask: number; t: number }

interface TState { tp1: boolean; sl: number; lastAlertSl: number; mae: number; mfe: number; slNearSent: boolean; timeStopSent: boolean; newsSent: boolean }

const inst = (pair: string): Instrument => (pair === "XAUUSD" ? "XAU_USD" : "EUR_USD");

/** Watches open trades and sends management alerts. Never places or changes orders. */
export class TradeManager {
  private states = new Map<string, TState>();
  private trades: OpenTrade[] = [];

  constructor(private api: LovableApi, private quotes: Map<Instrument, Quote>, private news: NewsSource, private atrOf: (i: Instrument) => number) {}

  async poll() {
    try { this.trades = await this.api.openTrades(); }
    catch (e) { logError("open_trades_failed", e); return; }
    const ids = new Set(this.trades.map((t) => t.id));
    for (const id of this.states.keys()) if (!ids.has(id)) this.states.delete(id);
    for (const t of this.trades) await this.check(t);
  }

  private async check(t: OpenTrade) {
    if (!t.signal) return;
    const q = this.quotes.get(inst(t.pair));
    if (!q) return;
    const long = t.side === "BUY";
    const entry = t.actual_entry ?? t.signal.entry;
    const risk = Math.abs(entry - t.signal.sl);
    if (!(risk > 0)) return;
    const exit = long ? q.bid : q.ask; // BUY exits at bid, SELL at ask
    const s = this.states.get(t.id) ?? { tp1: false, sl: t.signal.sl, lastAlertSl: t.signal.sl, mae: 0, mfe: 0, slNearSent: false, timeStopSent: false, newsSent: false };
    this.states.set(t.id, s);
    const r = ((exit - entry) * (long ? 1 : -1)) / risk;
    s.mae = Math.min(s.mae, r);
    s.mfe = Math.max(s.mfe, r);
    const mm = { mae: round(s.mae), mfe: round(s.mfe) };
    const spread = q.ask - q.bid;

    if (!s.tp1 && (long ? exit >= t.signal.tp1 : exit <= t.signal.tp1)) {
      s.tp1 = true;
      s.sl = long ? entry + spread : entry - spread;
      s.lastAlertSl = s.sl;
      await this.send("tp1_alert", `Close 50%, move SL to entry + spread (${s.sl.toFixed(t.pair === "XAUUSD" ? 2 : 5)})`, t.id, mm);
    }
    const distToSl = ((exit - s.sl) * (long ? 1 : -1)) / risk;
    if (!s.slNearSent && distToSl <= 0.2 && distToSl > -1) { s.slNearSent = true; await this.send("sl_near", `Within 0.2R of SL ${s.sl.toFixed(t.pair === "XAUUSD" ? 2 : 5)}`, t.id, mm); }
    if (distToSl > 0.5) s.slNearSent = false;

    const ageMin = (Date.now() - Date.parse(t.opened_at)) / 60_000;
    if (!s.timeStopSent && ageMin > 45 && r < 0.5) { s.timeStopSent = true; await this.send("time_stop", `Open ${Math.round(ageMin)} min at ${r.toFixed(2)}R`, t.id, mm); }
    const ev = this.news.soon(Date.now(), 10);
    if (ev && !s.newsSent) { s.newsSent = true; await this.send("news_warn", `${ev.country} ${ev.title}`, t.id, mm); }
  }

  /** At each M5 close after TP1: trail = close ∓ 1.0*ATR, alert when it improves >= 0.3*ATR. */
  async onM5Close(i: Instrument, close: number) {
    const atr = this.atrOf(i);
    if (!(atr > 0)) return;
    for (const t of this.trades) {
      if (inst(t.pair) !== i) continue;
      const s = this.states.get(t.id);
      if (!s?.tp1) continue;
      const long = t.side === "BUY";
      const trail = long ? close - atr : close + atr;
      const better = long ? trail > s.sl : trail < s.sl; // never loosen
      if (!better) continue;
      s.sl = trail;
      if (Math.abs(trail - s.lastAlertSl) >= 0.3 * atr) {
        s.lastAlertSl = trail;
        await this.send("trail_alert", `Trail SL to ${trail.toFixed(i === "XAU_USD" ? 2 : 5)}`, t.id, { mae: round(s.mae), mfe: round(s.mfe) });
      }
    }
  }

  get openCount() { return this.trades.length; }

  /** Alert state survives restarts (written to STATE_FILE by index.ts) so alerts never repeat. */
  exportState(): Record<string, TState> { return Object.fromEntries(this.states); }
  importState(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    for (const [id, v] of Object.entries(raw as Record<string, TState>)) if (v && typeof v.sl === "number") this.states.set(id, v);
  }

  private async send(type: Parameters<LovableApi["event"]>[0], text: string, id: string, mm: { mae: number; mfe: number }) {
    log("trade_alert", { type, trade_id: id, text, ...mm });
    await this.api.event(type, text, id, mm).catch((e) => logError("event_failed", e, { type }));
  }
}

const round = (x: number) => Math.round(x * 100) / 100;
