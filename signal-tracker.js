/**
 * signal-tracker.js — Captures screening signals at deploy time for Darwinian weighting.
 *
 * During screening, signals are "staged" for each candidate pool.
 * When deploy_position fires, the staged signals are retrieved and stored
 * in state.json alongside the position, so we know exactly what signals
 * were present when the decision was made.
 *
 * This enables post-hoc analysis: which signals actually predicted wins?
 */

import { log } from "./logger.js";

// In-memory staging area — cleared after retrieval or after 10 minutes
const _staged = new Map();
const STAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Stage signals for a pool during screening.
 * Called after candidate data is loaded, before the LLM decides.
 * @param {string} poolAddress
 * @param {object} signals — { organic_score, fee_tvl_ratio, volume, mcap, holder_count, smart_wallets_present, narrative_quality, study_win_rate, hive_consensus, volatility, twitter_sentiment }
 */
export function stageSignals(poolAddress, signals) {
  _staged.set(poolAddress, {
    ...signals,
    staged_at: Date.now(),
  });
  // Clean up stale entries
  for (const [addr, data] of _staged) {
    if (Date.now() - data.staged_at > STAGE_TTL_MS) {
      _staged.delete(addr);
    }
  }
}

/**
 * Retrieve and clear staged signals for a pool.
 * Called from deployPosition after the position is created.
 * @param {string} poolAddress
 * @returns {object|null} Signal snapshot or null if not staged
 */
export function getAndClearStagedSignals(poolAddress) {
  const data = _staged.get(poolAddress);
  if (!data) return null;
  _staged.delete(poolAddress);
  const { staged_at, ...signals } = data;
  log("signals", `Retrieved staged signals for ${poolAddress.slice(0, 8)}: ${Object.keys(signals).filter(k => signals[k] != null).length} signals`);
  return signals;
}

/**
 * Get all currently staged pool addresses (for debugging).
 */
export function getStagedPools() {
  return [..._staged.keys()];
}

// ─── D5 helpers: derive the two missing Darwin signals ───────────
// hive_consensus + study_win_rate are both declared in SIGNAL_NAMES
// (signal-weights.js) but were never populated by the staging call.
// These pure helpers extract them from data the bot already has, so
// the wiring is a one-liner in index.js / dlmm.js and the math is
// independently testable.

/**
 * Boolean: true iff at least one HiveMind shared lesson mentions the
 * candidate's primary token symbol (the part of pool_name before "-" or "/").
 *
 * Match is case-insensitive substring on lesson.rule. Symbols shorter
 * than 2 chars are skipped to avoid false positives on tickers like "X".
 *
 * Used as a per-pool boolean signal — Darwin learns whether "hive has
 * an opinion about this token" predicts winners or losers.
 *
 * @param {string} poolName  e.g. "Mustard-SOL"
 * @param {Array<{rule: string}>} sharedLessons  from hivemind.getSharedLessons()
 * @returns {boolean}
 */
export function computeHiveConsensus(poolName, sharedLessons) {
  if (!Array.isArray(sharedLessons) || sharedLessons.length === 0) return false;
  const symbol = String(poolName || "")
    .split(/[-/]/)[0]
    ?.trim()
    .toLowerCase();
  if (!symbol || symbol.length < 2) return false;
  return sharedLessons.some((lesson) => {
    const rule = String(lesson?.rule || "").toLowerCase();
    return rule.includes(symbol);
  });
}

/**
 * Mean win_rate across the top LPers returned by studyTopLPers().
 *
 * Returns null if the study cache is empty/unavailable for this pool —
 * Darwin's extractNumeric() drops null values automatically so a missing
 * snapshot for cold pools doesn't pollute the lift calculation.
 *
 * Win rates are already 0..1 in the study schema (see tools/study.js:114).
 *
 * @param {Object|null} studyResult  cached output of studyTopLPers
 * @returns {number|null} mean win rate in [0, 1], or null if unavailable
 */
export function computeStudyWinRate(studyResult) {
  if (!studyResult || !Array.isArray(studyResult.lpers)) return null;
  const winRates = studyResult.lpers
    .map((lper) => lper?.summary?.win_rate)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  if (winRates.length === 0) return null;
  return winRates.reduce((sum, v) => sum + v, 0) / winRates.length;
}
