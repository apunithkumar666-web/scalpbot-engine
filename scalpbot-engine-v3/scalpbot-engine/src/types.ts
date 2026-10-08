import type { Instrument } from "./config.js";
import type { Settings } from "./api/lovable.js";
import type { Regime } from "./regime.js";
import type { Snapshot } from "./analysis.js";
import type { Level, Range } from "./levels/sessions.js";
import type { NewsSource } from "./news.js";

export type Side = "BUY" | "SELL";
export type StrategyName = "pullback" | "sweep" | "orb";
export type PatternKind = "engulf" | "pin" | "displacement" | "break";

export interface Bar { t: number; o: number; h: number; l: number; c: number }

export interface PairState {
  recent: { side: Side; t: number }[];
  lastLossAt?: number;
  orbAttempts: Set<string>;
  fakeoutAt?: number;
}
export const newPairState = (): PairState => ({ recent: [], orbAttempts: new Set() });

export interface Sessions { prevDay: Range | null; asian: Range | null; london: Range | null; or: (Range & { width: number }) | null }

export interface EvalCtx {
  instrument: Instrument;
  /** close time of the bar just closed (ms) */
  t: number;
  m5: Bar[];
  m15: Bar[];
  snap: Snapshot;
  eurRegime: Regime | null;
  sessions: Sessions;
  levels: Level[];
  windowOpen: number;
  bid: number;
  ask: number;
  settings: Settings;
  commissionPerLot: number;
  news: NewsSource;
  state: PairState;
  stale: boolean;
  openTrades: number;
  signalsThisWindow: number;
}

export interface Setup {
  strategy: StrategyName;
  side: Side;
  pattern: PatternKind;
  /** raw SL before spread buffer is applied by the strategy (final SL price) */
  sl: number;
  counterTrend: boolean;
  /** optional alternative TP2 target price */
  tp2Alt?: number;
  levelUsed?: string;
  notes: Record<string, unknown>;
}

export interface ArmedSetup {
  pair: "XAUUSD" | "EURUSD";
  side: Side;
  strategy: StrategyName;
  E: number;
  invalidation_price: number;
  provisional_entry: number;
  provisional_sl: number;
  provisional_tp: number;
  score: number;
  armed_at: number;
}
