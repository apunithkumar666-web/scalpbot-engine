import type { Side } from "../types.js";
import type { BtBar } from "./data.js";

export interface SimTrade {
  side: Side; entry: number; sl: number; tp1: number; tp2: number; atr: number;
  spread: number; commissionPrice: number; partialPct: number; startT: number;
}
export interface SimResult { exitT: number; netR: number; grossR: number; outcome: "SL" | "BE" | "TP1_TRAIL" | "TP1_TP2" | "TIMEOUT"; mae: number; mfe: number }

const MAX_HOLD = 8 * 60 * 60_000;

/**
 * Walk M1 bars after entry. BUY exits on bid (mid - spread/2), SELL on ask.
 * If SL and a TP are both inside one bar, SL is assumed first.
 * Slippage = 0.1*spread on entry and each exit; commission deducted once.
 */
export function simulate(x: SimTrade, m1: BtBar[], startIdx: number): SimResult {
  const d = x.side === "BUY" ? 1 : -1;
  const slip = 0.1 * x.spread;
  const fill = x.entry + d * slip;
  const risk = Math.abs(fill - x.sl);
  const half = x.spread / 2;
  let sl = x.sl;
  let remaining = 1;
  let realized = 0;
  let tp1Done = false;
  let mae = 0, mfe = 0;
  let lastT = x.startT;
  const exitPx = (p: number) => p - d * slip;
  const pnlR = (px: number) => ((exitPx(px) - fill) * d) / risk;

  for (let i = startIdx; i < m1.length; i++) {
    const b = m1[i]!;
    if (b.t < x.startT) continue;
    lastT = b.t + 60_000;
    // exit-side prices
    const lo = x.side === "BUY" ? b.l - half : b.l + half;
    const hi = x.side === "BUY" ? b.h - half : b.h + half;
    const adverse = x.side === "BUY" ? lo : hi;
    const favorable = x.side === "BUY" ? hi : lo;
    mae = Math.min(mae, ((adverse - fill) * d) / risk);
    mfe = Math.max(mfe, ((favorable - fill) * d) / risk);

    const slHit = (adverse - sl) * d <= 0;
    if (slHit) {
      realized += remaining * pnlR(sl);
      return done(tp1Done ? (sl === x.sl ? "SL" : (sl - fill) * d > 0.05 * risk ? "TP1_TRAIL" : "BE") : "SL");
    }
    if (!tp1Done && (favorable - x.tp1) * d >= 0) {
      const part = x.partialPct / 100;
      realized += part * pnlR(x.tp1);
      remaining -= part;
      tp1Done = true;
      sl = fill + d * x.spread; // SL to entry + spread
    }
    if (tp1Done && (favorable - x.tp2) * d >= 0) {
      realized += remaining * pnlR(x.tp2);
      return done("TP1_TP2");
    }
    // trail after TP1 on each M5 close: close ∓ 1.0*ATR, never loosen
    if (tp1Done && (b.t + 60_000) % 300_000 === 0) {
      const mid = b.c;
      const trail = mid - d * x.atr;
      if ((trail - sl) * d > 0) sl = trail;
    }
    if (b.t - x.startT > MAX_HOLD) {
      realized += remaining * pnlR(b.c - d * half);
      return done("TIMEOUT");
    }
  }
  const last = m1[m1.length - 1];
  realized += remaining * (last ? pnlR(last.c - d * half) : 0);
  return done("TIMEOUT");

  function done(outcome: SimResult["outcome"]): SimResult {
    const comm = x.commissionPrice / risk;
    return { exitT: lastT, grossR: realized, netR: realized - comm, outcome, mae, mfe };
  }
}
