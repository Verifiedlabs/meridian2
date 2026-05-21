/**
 * Drawdown Circuit Breaker.
 *
 * Watches recent closed-position outcomes and auto-pauses the screening
 * cycle when performance deteriorates beyond configured limits. Management
 * cycles continue running so existing positions are still managed; only
 * NEW deploys are blocked.
 *
 * Trip conditions (any of):
 *   1. Losing streak — at least `risk.drawdownStreakThreshold` losses
 *      among the last `risk.drawdownStreakWindow` closes.
 *   2. Daily loss cap — cumulative SOL PnL in the rolling 24h window
 *      drops to or below `-risk.maxDailyLossSol`.
 *
 * Auto-resume: after `risk.drawdownCooldownMinutes` from trip time the
 * breaker clears itself. A manual `/resume` from Telegram clears it
 * immediately. State is persisted to circuit-breaker.json so that pm2
 * restarts do not silently re-enable screening during a drawdown.
 */

import fs from "fs";
import { writeJsonAtomicSync, loadJsonOrThrow } from "../fs-utils.js";
import { log } from "../logger.js";
import { config } from "../config.js";

const FILE = "./circuit-breaker.json";
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_STATE = {
  tripped: false,
  trippedAt: null,           // ISO timestamp
  reason: null,              // human-readable trip reason
  recentCloses: [],          // [{ pnl_sol, pnl_pct, position, pool_name, recorded_at }]
  dailyPnlSol: 0,            // cumulative SOL PnL in current 24h window
  dailyWindowStart: null,    // ISO timestamp of current window start
};

let _state = null;

function load() {
  if (_state) return _state;
  if (!fs.existsSync(FILE)) {
    _state = { ...DEFAULT_STATE, recentCloses: [] };
    return _state;
  }
  try {
    const parsed = loadJsonOrThrow(FILE);
    _state = { ...DEFAULT_STATE, ...parsed, recentCloses: parsed.recentCloses || [] };
  } catch (err) {
    // Corrupt JSON: backup created. Don't silently wipe breaker history.
    log("circuit_breaker_error", `${FILE} corrupt: ${err.message}`);
    throw err;
  }
  return _state;
}

function save() {
  try {
    writeJsonAtomicSync(FILE, _state);
  } catch (err) {
    log("circuit_breaker_error", `Failed to save ${FILE}: ${err.message}`);
  }
}

function rollDailyWindow(now) {
  const s = load();
  const start = s.dailyWindowStart ? new Date(s.dailyWindowStart).getTime() : 0;
  if (!start || now - start >= DAY_MS) {
    s.dailyPnlSol = 0;
    s.dailyWindowStart = new Date(now).toISOString();
  }
}

function getCfg() {
  const r = config?.risk || {};
  return {
    streakThreshold:    Number.isFinite(r.drawdownStreakThreshold) ? r.drawdownStreakThreshold : 7,
    streakWindow:       Number.isFinite(r.drawdownStreakWindow)    ? r.drawdownStreakWindow    : 10,
    maxDailyLossSol:    Number.isFinite(r.maxDailyLossSol)         ? r.maxDailyLossSol         : 0.5,
    cooldownMinutes:    Number.isFinite(r.drawdownCooldownMinutes) ? r.drawdownCooldownMinutes : 120,
  };
}

/**
 * Record a closed position outcome and (re-)evaluate trip conditions.
 *
 * @param {Object} entry
 * @param {number} entry.pnl_sol     - Realized PnL in SOL (signed). Required.
 * @param {number} [entry.pnl_pct]   - Realized PnL %. Optional, kept for context.
 * @param {string} [entry.position]  - Position address.
 * @param {string} [entry.pool_name] - Pool display name.
 * @param {number} [now=Date.now()]  - Injected clock for testing.
 * @returns {{ tripped: boolean, justTripped: boolean, reason: string|null }}
 */
export function recordClose(entry, now = Date.now()) {
  const s = load();
  const cfg = getCfg();
  const wasTripped = s.tripped;

  rollDailyWindow(now);

  const pnlSol = Number.isFinite(entry?.pnl_sol) ? entry.pnl_sol : 0;
  s.recentCloses.push({
    pnl_sol: pnlSol,
    pnl_pct: Number.isFinite(entry?.pnl_pct) ? entry.pnl_pct : null,
    position: entry?.position || null,
    pool_name: entry?.pool_name || null,
    recorded_at: new Date(now).toISOString(),
  });
  if (s.recentCloses.length > cfg.streakWindow) {
    s.recentCloses = s.recentCloses.slice(-cfg.streakWindow);
  }

  s.dailyPnlSol = Math.round((s.dailyPnlSol + pnlSol) * 1e6) / 1e6;

  if (!s.tripped) {
    const losses = s.recentCloses.filter((c) => (c.pnl_sol ?? 0) < 0).length;
    if (s.recentCloses.length >= cfg.streakWindow && losses >= cfg.streakThreshold) {
      s.tripped = true;
      s.trippedAt = new Date(now).toISOString();
      s.reason = `losing streak ${losses}/${s.recentCloses.length} recent closes`;
      log("circuit_breaker", `🛑 TRIPPED: ${s.reason}`);
    } else if (s.dailyPnlSol <= -cfg.maxDailyLossSol) {
      s.tripped = true;
      s.trippedAt = new Date(now).toISOString();
      s.reason = `daily loss ${s.dailyPnlSol.toFixed(3)} SOL ≤ -${cfg.maxDailyLossSol}`;
      log("circuit_breaker", `🛑 TRIPPED: ${s.reason}`);
    }
  }

  save();
  return {
    tripped: s.tripped,
    justTripped: !wasTripped && s.tripped,
    reason: s.reason,
  };
}

/**
 * Returns true if the screening cycle should be skipped right now. Also
 * performs auto-resume side-effect when the cooldown has elapsed.
 */
export function isScreeningPaused(now = Date.now()) {
  const s = load();
  if (!s.tripped) return false;
  const cfg = getCfg();
  const trippedTime = s.trippedAt ? new Date(s.trippedAt).getTime() : 0;
  if (trippedTime && now - trippedTime >= cfg.cooldownMinutes * 60 * 1000) {
    s.tripped = false;
    s.trippedAt = null;
    s.reason = null;
    save();
    log("circuit_breaker", `▶️ Auto-resumed after cooldown`);
    return false;
  }
  return true;
}

/**
 * Snapshot of breaker state for status displays / Telegram commands.
 */
export function getStatus(now = Date.now()) {
  const s = load();
  const cfg = getCfg();
  rollDailyWindow(now);
  const losses = s.recentCloses.filter((c) => (c.pnl_sol ?? 0) < 0).length;
  let willResumeAt = null;
  if (s.tripped && s.trippedAt) {
    const trippedTime = new Date(s.trippedAt).getTime();
    willResumeAt = new Date(trippedTime + cfg.cooldownMinutes * 60 * 1000).toISOString();
  }
  return {
    paused: s.tripped,
    reason: s.reason,
    trippedAt: s.trippedAt,
    willResumeAt,
    recentLosses: losses,
    recentTotal: s.recentCloses.length,
    streakThreshold: cfg.streakThreshold,
    streakWindow: cfg.streakWindow,
    dailyPnlSol: Math.round(s.dailyPnlSol * 1000) / 1000,
    maxDailyLossSol: cfg.maxDailyLossSol,
    dailyWindowStart: s.dailyWindowStart,
    cooldownMinutes: cfg.cooldownMinutes,
  };
}

/**
 * Clear the breaker. Returns whether a trip was actually cleared.
 */
export function resume({ manual = false } = {}) {
  const s = load();
  if (!s.tripped) return { wasResumed: false };
  s.tripped = false;
  s.trippedAt = null;
  s.reason = null;
  save();
  log("circuit_breaker", manual ? `▶️ Manually resumed` : `▶️ Resumed`);
  return { wasResumed: true };
}

/**
 * Test helper — drops in-memory and on-disk state.
 */
export function _resetForTesting() {
  _state = { ...DEFAULT_STATE, recentCloses: [] };
  if (fs.existsSync(FILE)) {
    try { fs.unlinkSync(FILE); } catch { /* ignore */ }
  }
}
