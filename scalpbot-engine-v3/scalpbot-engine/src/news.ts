import { z } from "zod";
import { log, logError } from "./logger.js";

const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const Item = z.object({ title: z.string(), country: z.string(), date: z.string(), impact: z.string() });

export interface NewsEvent { t: number; title: string; country: string }

/** High-impact USD/EUR events from Forex Factory (faireconomy) with a manual fallback list. */
export class NewsSource {
  private events: NewsEvent[] = [];
  private fetchedAt = 0;

  constructor(private manual: NewsEvent[] = parseManual(process.env["NEWS_BLACKOUT"] ?? "")) {}

  static fromEvents(events: NewsEvent[]) { const n = new NewsSource([]); n.events = events; n.fetchedAt = Date.now(); return n; }

  async refresh(force = false) {
    if (!force && Date.now() - this.fetchedAt < 60 * 60_000) return;
    try {
      const res = await fetch(FF_URL, { headers: { "User-Agent": "scalpbot-engine" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = z.array(Item).parse(await res.json());
      this.events = items
        .filter((i) => i.impact === "High" && (i.country === "USD" || i.country === "EUR"))
        .map((i) => ({ t: Date.parse(i.date), title: i.title, country: i.country }))
        .filter((e) => Number.isFinite(e.t));
      this.fetchedAt = Date.now();
      log("news_refreshed", { count: this.events.length });
    } catch (e) {
      logError("news_refresh_failed", e, { fallback: this.manual.length });
      this.fetchedAt = Date.now() - 50 * 60_000; // retry in ~10 min
    }
  }

  all(): NewsEvent[] { return [...this.events, ...this.manual]; }

  /** Next event within [t - beforeMin.. t + afterMin] window of the given time. */
  within(t: number, beforeMin: number, afterMin: number): NewsEvent | null {
    return this.all().find((e) => t >= e.t - beforeMin * 60_000 && t <= e.t + afterMin * 60_000) ?? null;
  }

  /** Blackout: 10 min before to 10 min after a high-impact event. */
  blackout(t: number) { return this.within(t, 10, 10); }
  /** Event in the next `min` minutes (or just happened). */
  soon(t: number, min: number) { return this.all().find((e) => e.t >= t - 10 * 60_000 && e.t - t <= min * 60_000) ?? null; }
}

/** NEWS_BLACKOUT="2026-10-08T12:30:00Z|US CPI,2026-10-09T12:30:00Z" */
export function parseManual(raw: string): NewsEvent[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [d, title] = s.split("|");
    return { t: Date.parse(d ?? ""), title: title ?? "Manual blackout", country: "MANUAL" };
  }).filter((e) => Number.isFinite(e.t));
}
