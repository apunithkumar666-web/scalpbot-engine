import type { Side, StrategyName } from "./types.js";
import type { Settings } from "./api/lovable.js";
import type { Regime } from "./regime.js";

export interface PreArmSettings {
  enabled: boolean;
  arm_lead_sec: number;
  final_lead_sec: number;
  stability_window_sec: number;
  stability_pct: number;
  arm_min_score_delta: number;
  max_chase_atr: number;
  max_tick_age_sec: number;
}

export const PRE_ARM_DEFAULTS: PreArmSettings = {
  enabled: false,
  arm_lead_sec: 60,
  final_lead_sec: 10,
  stability_window_sec: 15,
  stability_pct: 80,
  arm_min_score_delta: 5,
  max_chase_atr: 0.25,
  max_tick_age_sec: 3,
};

export function resolvePreArmSettings(settings?: Partial<Settings> | null): PreArmSettings {
  const s = settings ?? {};
  return {
    enabled: s.pre_arm_enabled ?? PRE_ARM_DEFAULTS.enabled,
    arm_lead_sec: Number.isFinite(s.arm_lead_sec) ? Number(s.arm_lead_sec) : PRE_ARM_DEFAULTS.arm_lead_sec,
    final_lead_sec: Number.isFinite(s.final_lead_sec) ? Number(s.final_lead_sec) : PRE_ARM_DEFAULTS.final_lead_sec,
    stability_window_sec: Number.isFinite(s.stability_window_sec) ? Number(s.stability_window_sec) : PRE_ARM_DEFAULTS.stability_window_sec,
    stability_pct: Number.isFinite(s.stability_pct) ? Number(s.stability_pct) : PRE_ARM_DEFAULTS.stability_pct,
    arm_min_score_delta: Number.isFinite(s.arm_min_score_delta) ? Number(s.arm_min_score_delta) : PRE_ARM_DEFAULTS.arm_min_score_delta,
    max_chase_atr: Number.isFinite(s.max_chase_atr) ? Number(s.max_chase_atr) : PRE_ARM_DEFAULTS.max_chase_atr,
    max_tick_age_sec: Number.isFinite(s.max_tick_age_sec) ? Number(s.max_tick_age_sec) : PRE_ARM_DEFAULTS.max_tick_age_sec,
  };
}

export function isPreArmEnabled(settings?: Partial<Settings> | null): boolean {
  return resolvePreArmSettings(settings).enabled;
}

export function createArmedSetup(input: {
  pair: "XAUUSD" | "EURUSD";
  side: Side;
  strategy: StrategyName;
  E: number;
  score: number;
  invalidation_price: number;
  provisional_entry: number;
  provisional_sl: number;
  provisional_tp: number;
  armed_at?: number;
}): import("./types.js").ArmedSetup {
  return {
    pair: input.pair,
    side: input.side,
    strategy: input.strategy,
    E: input.E,
    invalidation_price: input.invalidation_price,
    provisional_entry: input.provisional_entry,
    provisional_sl: input.provisional_sl,
    provisional_tp: input.provisional_tp,
    score: input.score,
    armed_at: input.armed_at ?? Date.now(),
  };
}

export function planPreArmSignals(input: {
  outcomes: Array<{ kind: "signal"; signal: { pair: "XAUUSD" | "EURUSD"; side: Side; strategy: StrategyName; score: number; entry: number; sl: number; tp1: number; tp2: number; entry_time: string; idempotency_key: string } }>;
  now?: number;
  settings?: Partial<Settings> | null;
}): import("./types.js").ArmedSetup[] {
  const settings = resolvePreArmSettings(input.settings);
  const now = input.now ?? Date.now();
  const out: import("./types.js").ArmedSetup[] = [];
  for (const o of input.outcomes) {
    const base = o.signal;
    const scoreMin = Math.max(0, base.score - settings.arm_min_score_delta);
    if (base.score < scoreMin) continue;
    const E = Date.parse(base.entry_time);
    if (!Number.isFinite(E)) continue;
    const arm = createArmedSetup({
      pair: base.pair,
      side: base.side,
      strategy: base.strategy,
      E,
      score: base.score,
      invalidation_price: base.sl,
      provisional_entry: base.entry,
      provisional_sl: base.sl,
      provisional_tp: Math.max(base.tp1, base.tp2),
      armed_at: now,
    });
    out.push(arm);
  }
  return out;
}

export function buildPreArmSignal(
  armed: import("./types.js").ArmedSetup,
  now: number,
  atr: number,
  scorePath: number[] = [],
  settings?: Partial<Settings> | null,
): Record<string, unknown> {
  const s = resolvePreArmSettings(settings);
  const entry = armed.provisional_entry;
  const spread = Math.max(0, Math.abs(armed.provisional_entry - armed.provisional_sl) * 0.01);
  const direction = armed.side === "BUY" ? 1 : -1;
  const entryZone = 0.10 * atr;
  const entryZoneLow = Math.min(entry, entry - direction * entryZone);
  const entryZoneHigh = Math.max(entry, entry + direction * entryZone);
  const chase = s.max_chase_atr * atr;
  const maxChasePrice = armed.side === "BUY" ? entry + chase : entry - chase;
  const leadSec = Math.max(0, Math.round((armed.E - now) / 1000));
  return {
    id: `${armed.strategy}:${armed.pair}:${new Date(armed.E).toISOString()}`,
    pair: armed.pair,
    side: armed.side,
    strategy: armed.strategy,
    entry_time: new Date(armed.E).toISOString(),
    entry_zone_low: Number(entryZoneLow.toFixed(6)),
    entry_zone_high: Number(entryZoneHigh.toFixed(6)),
    max_chase_price: Number(maxChasePrice.toFixed(6)),
    lead_sec: Math.min(s.final_lead_sec, leadSec),
    features: {
      armed_at: new Date(armed.armed_at).toISOString(),
      price_at_arm: armed.provisional_entry,
      price_at_confirm: armed.provisional_entry,
      valid_pct: 100,
      score_path: scorePath,
      spread,
    },
  };
}

export function validatePreArmSetup(
  armed: import("./types.js").ArmedSetup,
  sample: { t: number; valid: boolean; score: number; mid: number; spread: number; ageSec: number; regime: Regime | null; newsBlackout: boolean; },
  settings?: Partial<Settings> | null,
): { valid: boolean; validPct: number; reason?: string; score: number; mid: number; spread: number } {
  const s = resolvePreArmSettings(settings);
  const now = Date.now();
  const passed = sample.valid && !sample.newsBlackout && sample.ageSec <= s.max_tick_age_sec && !(sample.regime === "VOLATILE" || sample.regime === "DEAD");
  const reason = !sample.valid ? "invalid provisional condition" : sample.newsBlackout ? "news blackout" : sample.ageSec > s.max_tick_age_sec ? "stale tick" : sample.regime === "VOLATILE" || sample.regime === "DEAD" ? `regime ${sample.regime}` : undefined;
  const validPct = passed ? 100 : 0;
  const chase = sample.mid - armed.provisional_entry;
  const direction = armed.side === "BUY" ? 1 : -1;
  const movedTooFar = Math.abs(chase * direction) > s.max_chase_atr * (Math.max(0.000001, Math.abs(armed.provisional_entry - armed.provisional_sl)) || 1);
  if (movedTooFar) return { valid: false, validPct, reason: "moved too far", score: sample.score, mid: sample.mid, spread: sample.spread };
  return { valid: passed && !movedTooFar, validPct, reason, score: sample.score, mid: sample.mid, spread: sample.spread };
}

export function confirmPreArmSignal(
  armed: import("./types.js").ArmedSetup,
  now: number,
  atr: number,
  validPct: number,
  lastTickAgeSec: number,
  spread: number,
  score: number,
  settings?: Partial<Settings> | null,
): { ok: boolean; reason?: string; payload?: Record<string, unknown> } {
  const s = resolvePreArmSettings(settings);
  const entryTime = new Date(armed.E).toISOString();
  const leadSec = Math.max(0, Math.round((armed.E - now) / 1000));
  const minValidPct = s.stability_pct;
  if (validPct < minValidPct) return { ok: false, reason: "unstable", payload: { idempotency_key: `${armed.strategy}:${armed.pair}:${entryTime}`, entry_time: entryTime, lead_sec: leadSec } };
  if (lastTickAgeSec > s.max_tick_age_sec) return { ok: false, reason: "stale tick", payload: { idempotency_key: `${armed.strategy}:${armed.pair}:${entryTime}`, entry_time: entryTime, lead_sec: leadSec } };
  if (spread > 0.0005) return { ok: false, reason: "spread too high", payload: { idempotency_key: `${armed.strategy}:${armed.pair}:${entryTime}`, entry_time: entryTime, lead_sec: leadSec } };
  if (score < 0) return { ok: false, reason: "score too low", payload: { idempotency_key: `${armed.strategy}:${armed.pair}:${entryTime}`, entry_time: entryTime, lead_sec: leadSec } };
  const direction = armed.side === "BUY" ? 1 : -1;
  const rr1 = Math.abs(armed.provisional_tp - armed.provisional_entry) / Math.abs(armed.provisional_entry - armed.provisional_sl);
  const rr2 = Math.abs(armed.provisional_tp - armed.provisional_entry) / Math.abs(armed.provisional_entry - armed.provisional_sl);
  const arr = Math.abs(armed.provisional_entry - armed.provisional_sl) / atr;
  if (direction * (armed.provisional_entry - armed.provisional_sl) <= 0) return { ok: false, reason: "levels invalid", payload: { idempotency_key: `${armed.strategy}:${armed.pair}:${entryTime}`, entry_time: entryTime, lead_sec: leadSec } };
  if (arr < 0.8 || arr > 2.0) return { ok: false, reason: "levels invalid", payload: { idempotency_key: `${armed.strategy}:${armed.pair}:${entryTime}`, entry_time: entryTime, lead_sec: leadSec } };
  if (rr1 < 1 || rr2 < 1.5) return { ok: false, reason: "levels invalid", payload: { idempotency_key: `${armed.strategy}:${armed.pair}:${entryTime}`, entry_time: entryTime, lead_sec: leadSec } };
  return { ok: true, payload: buildPreArmSignal(armed, now, atr, [score], settings) };
}

export function hasDuplicatePreArmSignal(armed: import("./types.js").ArmedSetup, existing: import("./types.js").ArmedSetup[]): boolean {
  return existing.some((item) => item.pair === armed.pair && item.side === armed.side && item.strategy === armed.strategy && item.E === armed.E);
}

export function shouldCancelPreArmSetup(
  armed: import("./types.js").ArmedSetup,
  sample: { t: number; valid: boolean; score: number; mid: number; spread: number; ageSec: number; regime: Regime | null; newsBlackout: boolean },
  settings?: Partial<Settings> | null,
): { shouldCancel: boolean; reason?: string } {
  const verdict = validatePreArmSetup(armed, sample, settings);
  if (!verdict.valid) return { shouldCancel: true, reason: verdict.reason ?? "invalid" };
  if (sample.ageSec > (resolvePreArmSettings(settings).max_tick_age_sec ?? PRE_ARM_DEFAULTS.max_tick_age_sec)) return { shouldCancel: true, reason: "tick age exceeded" };
  if (sample.spread > 0.0005) return { shouldCancel: true, reason: "spread spike" };
  return { shouldCancel: false };
}

export const preArmSignalAtFinalLead = (armed: import("./types.js").ArmedSetup, now: number, settings?: Partial<Settings> | null) => {
  const s = resolvePreArmSettings(settings);
  const delta = Math.abs(armed.E - now);
  return delta <= (s.final_lead_sec + 1) * 1000;
};

export const preArmEventFor = (armed: import("./types.js").ArmedSetup, kind: "entry_check" | "setup_cancelled") => ({
  type: kind,
  data: {
    pair: armed.pair,
    side: armed.side,
    strategy: armed.strategy,
    E: new Date(armed.E).toISOString(),
    armed_at: new Date(armed.armed_at).toISOString(),
  },
});
