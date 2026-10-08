import { DateTime } from "luxon";
import { PSYCH_STEP, type Instrument } from "../config.js";

export interface Bar { t: number; o: number; h: number; l: number; c: number }
export interface Range { high: number; low: number }
export interface Level { name: string; price: number }

function rangeOf(bars: Bar[], from: number, to: number): Range | null {
  const sel = bars.filter((b) => b.t >= from && b.t < to);
  if (!sel.length) return null;
  return { high: Math.max(...sel.map((b) => b.h)), low: Math.min(...sel.map((b) => b.l)) };
}

/** Forex day rolls at 17:00 America/New_York. Returns start of the current forex day (ms). */
export function forexDayStart(now: number): number {
  const ny = DateTime.fromMillis(now, { zone: "America/New_York" });
  let start = ny.set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
  if (ny < start) start = start.minus({ days: 1 });
  return start.toMillis();
}

/** Previous forex day with data; skips the weekend (Fri 17:00 → Sun 17:00 NY) and holidays with no bars. */
export function prevDay(bars: Bar[], now: number): Range | null {
  let end = forexDayStart(now);
  for (let k = 0; k < 5; k++) {
    const start = DateTime.fromMillis(end, { zone: "America/New_York" }).minus({ days: 1 }).toMillis();
    const r = rangeOf(bars, start, end);
    if (r) return r;
    end = start;
  }
  return null;
}

/** FX market hours: closed from Friday 17:00 to Sunday 17:00 America/New_York. */
export function marketOpen(t: number): boolean {
  const ny = DateTime.fromMillis(t, { zone: "America/New_York" });
  const wd = ny.weekday; // 1=Mon .. 7=Sun
  if (wd === 6) return false;
  if (wd === 5 && ny.hour >= 17) return false;
  if (wd === 7 && ny.hour < 17) return false;
  return true;
}

/** Asian range 00:00-07:00 UTC of the current UTC day. */
export function asianRange(bars: Bar[], now: number): Range | null {
  const d = DateTime.fromMillis(now, { zone: "utc" }).startOf("day");
  return rangeOf(bars, d.toMillis(), d.plus({ hours: 7 }).toMillis());
}

/** London 08:00-13:00 Europe/London; frozen once the IST window opens (bars after windowOpen are ignored). */
export function londonRange(bars: Bar[], now: number, windowOpen: number): Range | null {
  const d = DateTime.fromMillis(now, { zone: "Europe/London" }).startOf("day");
  const end = Math.min(d.set({ hour: 13 }).toMillis(), windowOpen);
  return rangeOf(bars, d.set({ hour: 8 }).toMillis(), end);
}

/** Window start in ms for today's IST window, e.g. "18:30". */
export function istWindow(now: number, start: string, end: string): { open: number; close: number; inWindow: boolean } {
  const ist = DateTime.fromMillis(now, { zone: "Asia/Kolkata" });
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let open = ist.set({ hour: sh ?? 18, minute: sm ?? 30, second: 0, millisecond: 0 });
  let close = ist.set({ hour: eh ?? 22, minute: em ?? 30, second: 0, millisecond: 0 });
  if (close <= open) close = close.plus({ days: 1 });
  if (ist < open) {
    const yOpen = open.minus({ days: 1 }), yClose = close.minus({ days: 1 });
    if (ist < yClose) { open = yOpen; close = yClose; }
  }
  return { open: open.toMillis(), close: close.toMillis(), inWindow: ist >= open && ist < close };
}

/** Opening range: M5 bars from window start to +30 min. */
export function openingRange(m5: Bar[], windowOpen: number): (Range & { width: number }) | null {
  const r = rangeOf(m5, windowOpen, windowOpen + 30 * 60_000);
  return r ? { ...r, width: r.high - r.low } : null;
}

export function psychLevels(instrument: Instrument, price: number, count = 3): Level[] {
  const step = PSYCH_STEP[instrument];
  const base = Math.floor(price / step) * step;
  const out: Level[] = [];
  for (let k = -count + 1; k <= count; k++) {
    const p = Number((base + k * step).toFixed(5));
    out.push({ name: `psych ${p}`, price: p });
  }
  return out;
}

export function buildLevels(parts: { prevDay?: Range | null; asian?: Range | null; london?: Range | null; or?: Range | null; psych: Level[] }): Level[] {
  const out: Level[] = [...parts.psych];
  const add = (name: string, r?: Range | null) => { if (r) out.push({ name: `${name} high`, price: r.high }, { name: `${name} low`, price: r.low }); };
  add("PDH/PDL", parts.prevDay); add("Asian", parts.asian); add("London", parts.london); add("OR", parts.or);
  return out;
}

export function sortByDistance(levels: Level[], price: number): Level[] {
  return [...levels].sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
}

/** Nearest level strictly above (up) or below (down) price. */
export function nextLevel(levels: Level[], price: number, direction: "up" | "down"): Level | null {
  const c = levels.filter((l) => (direction === "up" ? l.price > price : l.price < price));
  return sortByDistance(c, price)[0] ?? null;
}
