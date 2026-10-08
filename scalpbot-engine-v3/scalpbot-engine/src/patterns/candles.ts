export interface OHLC { o: number; h: number; l: number; c: number }
export type Dir = "bull" | "bear";

export function geometry(b: OHLC) {
  const range = b.h - b.l;
  const body = Math.abs(b.c - b.o);
  return {
    range, body,
    upperWick: b.h - Math.max(b.o, b.c),
    lowerWick: Math.min(b.o, b.c) - b.l,
    closePos: range > 0 ? (b.c - b.l) / range : 0.5,
  };
}

const bull = (b: OHLC) => b.c > b.o;
const bear = (b: OHLC) => b.c < b.o;

export function engulfing(prev: OHLC, cur: OHLC): Dir | null {
  const pb = Math.abs(prev.c - prev.o), cb = Math.abs(cur.c - cur.o);
  if (cb < 1.1 * pb || cb === 0) return null;
  if (bear(prev) && bull(cur) && cur.o <= prev.c && cur.c >= prev.o) return "bull";
  if (bull(prev) && bear(cur) && cur.o >= prev.c && cur.c <= prev.o) return "bear";
  return null;
}

export function pinBar(b: OHLC): Dir | null {
  const g = geometry(b);
  if (g.range <= 0) return null;
  if (g.lowerWick >= 2 * g.body && g.lowerWick >= 0.55 * g.range && g.closePos >= 0.6) return "bull";
  if (g.upperWick >= 2 * g.body && g.upperWick >= 0.55 * g.range && g.closePos <= 0.4) return "bear";
  return null;
}

export function displacement(b: OHLC, atr: number): Dir | null {
  const g = geometry(b);
  if (!(atr > 0) || g.body < 0.8 * atr) return null;
  if (bull(b) && g.closePos >= 0.7) return "bull";
  if (bear(b) && g.closePos <= 0.3) return "bear";
  return null;
}

/** mother = bar[-3], inside = bar[-2], cur = bar[-1] */
export function insideBarBreakout(mother: OHLC, inside: OHLC, cur: OHLC): Dir | null {
  if (!(inside.h <= mother.h && inside.l >= mother.l)) return null;
  if (cur.c > inside.h) return "bull";
  if (cur.c < inside.l) return "bear";
  return null;
}
