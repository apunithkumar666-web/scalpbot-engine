import { z } from "zod";

const Env = z.object({
  OANDA_TOKEN: z.string().min(10),
  OANDA_ACCOUNT_ID: z.string().min(5),
  OANDA_ENV: z.enum(["practice", "live"]).default("practice"),
  LOVABLE_FN_URL: z.string().url(),
  WORKER_SECRET: z.string().min(16),
});

export type Config = z.infer<typeof Env> & { streamBase: string; restBase: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  const live = e.OANDA_ENV === "live";
  return {
    ...e,
    LOVABLE_FN_URL: e.LOVABLE_FN_URL.replace(/\/+$/, ""),
    streamBase: live ? "https://stream-fxtrade.oanda.com" : "https://stream-fxpractice.oanda.com",
    restBase: live ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com",
  };
}

export const INSTRUMENTS = ["XAU_USD", "EUR_USD"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];
export const TFS = ["M1", "M5", "M15"] as const;
export type Tf = (typeof TFS)[number];
export const TF_SECONDS: Record<Tf, number> = { M1: 60, M5: 300, M15: 900 };

/** App pair code: XAU_USD -> XAUUSD */
export const appPair = (i: Instrument) => (i === "XAU_USD" ? "XAUUSD" : "EURUSD") as "XAUUSD" | "EURUSD";

/** REST-vs-stream OHLC tolerance before REST overwrites. */
export const RECONCILE_TOL: Record<Instrument, number> = { XAU_USD: 0.3, EUR_USD: 0.0002 };
/** Psychological level spacing. */
export const PSYCH_STEP: Record<Instrument, number> = { XAU_USD: 10, EUR_USD: 0.005 };

export type Profile = "conservative" | "standard" | "aggressive";
export interface ProfileRules { minScore: number; maxSignals: number; cooldownMin: number; validityMin?: number; sweepCounterTrend: boolean }
export const PROFILES: Record<Profile, ProfileRules> = {
  conservative: { minScore: 80, maxSignals: 3, cooldownMin: 15, sweepCounterTrend: false },
  standard: { minScore: 72, maxSignals: 4, cooldownMin: 10, sweepCounterTrend: false },
  // "aggressive" = more frequent and faster, never bigger risk (risk is capped by the app).
  aggressive: { minScore: 65, maxSignals: 6, cooldownMin: 5, validityMin: 3, sweepCounterTrend: true },
};

export const STALE_MS = 5_000;
export const HEARTBEAT_MS = 30_000;
export const SETTINGS_MS = 60_000;
export const RECONCILE_DELAY_MS = 2_000;
export const BACKFILL_COUNT = 500;
