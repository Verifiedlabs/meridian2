/**
 * Top-LPer auto-discovery — Tier 3 self-learning.
 *
 * Persists every owner that surfaces from `studyTopLPers` (the Meridian
 * `/top-lp/<pool>` API), aggregates their stats across the pools we've
 * seen them in, and auto-promotes consistently strong LPers into the
 * existing `smart-wallets.json` whitelist so `check_smart_wallets_on_pool`
 * can use them as a real signal during screening.
 *
 * Why this matters: the bot is LP-focused, not trader-focused. The right
 * "smart wallet" axis for an LP bot is people who consistently LP into
 * pools that earn — not GMGN's smart-money traders, who measure swap
 * profitability. This module closes that gap without manual operator
 * curation.
 *
 * State file: top-lpers.json (atomic-write via fs-utils).
 *
 * Auto-promotion thresholds (config.smartLpers, with sane defaults):
 *   - autoPromoteMinPools     ≥ 3   pools the LPer was seen in
 *   - autoPromoteMinWinRate   ≥ 0.6 (60%)
 *   - autoPromoteMinPositions ≥ 10  total tracked positions
 *   - rejected wallets are never re-promoted
 *
 * Scoring (for leaderboard ordering):
 *   composite = pools_seen × win_rate × (1 + roi) × recency_decay
 *   recency_decay → 1.0 today, 0.5 at recencyDecayDays (default 30),
 *                   floor 0.1.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { addSmartWallet as _defaultAddSmartWallet } from "../smart-wallets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "top-lpers.json");

const DEFAULT_STATE = {
  lpers: {},          // address -> LperRecord
  promotions: [],     // [{address, name, promoted_at, reason}]
  rejections: [],     // [{address, rejected_at, reason}]
};

/** @typedef {Object} LperRecord
 *  @property {string} address
 *  @property {string} name
 *  @property {string[]} names_seen           - all distinct names/labels observed
 *  @property {string} first_seen_at          - ISO timestamp
 *  @property {string} last_seen_at           - ISO timestamp
 *  @property {Array<{pool:string,pool_name:string,first_seen:string,last_seen:string,count:number}>} pools_seen
 *  @property {Object} aggregate_stats
 *  @property {boolean} promoted
 *  @property {string|null} promoted_at
 *  @property {boolean} rejected
 *  @property {string|null} rejected_at
 *  @property {string|null} rejection_reason
 */

let _state = null;

function load() {
  if (_state) return _state;
  if (!fs.existsSync(FILE)) {
    _state = { lpers: {}, promotions: [], rejections: [] };
    return _state;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    _state = {
      lpers: parsed.lpers || {},
      promotions: parsed.promotions || [],
      rejections: parsed.rejections || [],
    };
  } catch (err) {
    log("top_lpers_error", `Failed to load ${FILE}: ${err.message} — starting fresh`);
    _state = { lpers: {}, promotions: [], rejections: [] };
  }
  return _state;
}

function save() {
  try {
    writeJsonAtomicSync(FILE, _state);
  } catch (err) {
    log("top_lpers_error", `Failed to save ${FILE}: ${err.message}`);
  }
}

function getCfg() {
  const c = config?.smartLpers || {};
  return {
    autoPromoteMinPools:     Number.isFinite(c.autoPromoteMinPools)     ? c.autoPromoteMinPools     : 3,
    autoPromoteMinWinRate:   Number.isFinite(c.autoPromoteMinWinRate)   ? c.autoPromoteMinWinRate   : 0.6,
    autoPromoteMinPositions: Number.isFinite(c.autoPromoteMinPositions) ? c.autoPromoteMinPositions : 10,
    recencyDecayDays:        Number.isFinite(c.recencyDecayDays)        ? c.recencyDecayDays        : 30,
    autoPromoteEnabled:      c.autoPromoteEnabled !== false, // default true
  };
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidAddress(addr) {
  return typeof addr === "string" && SOLANA_PUBKEY_RE.test(addr);
}

function nowIso(now) {
  return new Date(now ?? Date.now()).toISOString();
}

/**
 * Update a per-pool entry inside an LPer's `pools_seen` list. Mutates
 * `record.pools_seen` in place. Used by `recordTopLPers`.
 */
function upsertPoolSeen(record, pool, poolName, isoNow) {
  const existing = record.pools_seen.find((p) => p.pool === pool);
  if (existing) {
    existing.last_seen = isoNow;
    existing.count = (existing.count || 0) + 1;
    if (poolName && !existing.pool_name) existing.pool_name = poolName;
    return;
  }
  record.pools_seen.push({
    pool,
    pool_name: poolName || null,
    first_seen: isoNow,
    last_seen: isoNow,
    count: 1,
  });
}

function mergeAggregateStats(record, lperSummary) {
  // The Meridian study endpoint already returns aggregate stats per LPer
  // (across ALL their positions, not just this pool). We trust the latest
  // values it returns rather than trying to recompute from local samples.
  const s = lperSummary || {};
  record.aggregate_stats = {
    total_positions:        Number.isFinite(s.total_positions)        ? s.total_positions        : (record.aggregate_stats?.total_positions ?? 0),
    win_rate:               Number.isFinite(s.win_rate)               ? s.win_rate               : (record.aggregate_stats?.win_rate ?? 0),
    roi:                    Number.isFinite(s.roi)                    ? s.roi                    : (record.aggregate_stats?.roi ?? 0),
    avg_pnl_pct:            Number.isFinite(s.avg_open_pnl_pct)       ? s.avg_open_pnl_pct       : (record.aggregate_stats?.avg_pnl_pct ?? 0),
    avg_hold_hours:         Number.isFinite(s.avg_hold_hours)         ? s.avg_hold_hours         : (record.aggregate_stats?.avg_hold_hours ?? 0),
    avg_fee_per_tvl_24h:    Number.isFinite(s.avg_fee_per_tvl_24h_pct) ? s.avg_fee_per_tvl_24h_pct : (record.aggregate_stats?.avg_fee_per_tvl_24h ?? 0),
    total_pnl_usd:          Number.isFinite(s.total_pnl_usd)          ? s.total_pnl_usd          : (record.aggregate_stats?.total_pnl_usd ?? 0),
    preferred_strategy:     s.preferred_strategy || (record.aggregate_stats?.preferred_strategy ?? "unknown"),
    preferred_range_style:  s.preferred_range_style || (record.aggregate_stats?.preferred_range_style ?? "unknown"),
  };
}

/**
 * Persist the result of a `studyTopLPers` call.
 *
 * @param {Object} params
 * @param {string} params.pool
 * @param {string} [params.pool_name]
 * @param {Array<{owner:string, owner_short?:string, summary:Object}>} params.lpers
 * @param {number} [now=Date.now()]
 * @returns {{recorded: number, autoPromoted: Array<{address:string, reason:string}>}}
 */
export function recordTopLPers({ pool, pool_name, lpers }, now = Date.now()) {
  if (!isValidAddress(pool) || !Array.isArray(lpers) || lpers.length === 0) {
    return { recorded: 0, autoPromoted: [] };
  }
  const s = load();
  const isoNow = nowIso(now);
  let recorded = 0;
  const autoPromoted = [];

  for (const lper of lpers) {
    const address = lper?.owner;
    if (!isValidAddress(address)) continue;

    let record = s.lpers[address];
    if (!record) {
      record = {
        address,
        name: lper.owner_short || `${address.slice(0, 8)}...`,
        names_seen: [],
        first_seen_at: isoNow,
        last_seen_at: isoNow,
        pools_seen: [],
        aggregate_stats: {},
        promoted: false,
        promoted_at: null,
        rejected: false,
        rejected_at: null,
        rejection_reason: null,
      };
      s.lpers[address] = record;
    }

    record.last_seen_at = isoNow;
    if (lper.owner_short && !record.names_seen.includes(lper.owner_short)) {
      record.names_seen.push(lper.owner_short);
    }
    upsertPoolSeen(record, pool, pool_name || null, isoNow);
    mergeAggregateStats(record, lper.summary);
    recorded++;

    // Auto-promote evaluation — only fires for non-promoted, non-rejected
    // wallets that crossed the threshold during this update.
    const promotion = maybeAutoPromote(record, isoNow);
    if (promotion) {
      autoPromoted.push(promotion);
      s.promotions.push(promotion);
    }
  }

  if (recorded > 0) save();
  return { recorded, autoPromoted };
}

function maybeAutoPromote(record, isoNow) {
  if (record.promoted || record.rejected) return null;
  const cfg = getCfg();
  if (!cfg.autoPromoteEnabled) return null;
  const stats = record.aggregate_stats || {};
  if ((record.pools_seen?.length || 0) < cfg.autoPromoteMinPools) return null;
  if ((stats.win_rate ?? 0) < cfg.autoPromoteMinWinRate) return null;
  if ((stats.total_positions ?? 0) < cfg.autoPromoteMinPositions) return null;

  record.promoted = true;
  record.promoted_at = isoNow;
  const reason = `auto: ${record.pools_seen.length} pools, WR ${(stats.win_rate * 100).toFixed(0)}%, ${stats.total_positions} positions`;

  // Side-effect: also add to smart_wallets.json so existing
  // `check_smart_wallets_on_pool` immediately benefits without restart.
  try {
    // Lazy import — circular-safe and keeps top-lpers.js standalone-testable.
    // Using dynamic import would make this async; sync require via Node's
    // ESM interop is not straightforward, so we route through a small
    // helper that fails open (just logs) when smart-wallets isn't present.
    syncToSmartWallets(record, reason);
  } catch (err) {
    log("top_lpers_warn", `Promoted ${record.address.slice(0, 8)} but failed to sync to smart-wallets: ${err.message}`);
  }

  log("top_lpers", `🤝 Auto-promoted ${record.name} (${record.address.slice(0, 8)}) — ${reason}`);
  return { address: record.address, name: record.name, promoted_at: isoNow, reason };
}

// Pluggable for tests via _setSmartWalletsMockForTesting.
let _addSmartWalletImpl = _defaultAddSmartWallet;

function syncToSmartWallets(record /*, reason */) {
  // Best-effort: ignore "already tracked" errors. Promotion state inside
  // top-lpers.json remains source of truth even if smart-wallets sync
  // fails for any reason.
  if (typeof _addSmartWalletImpl !== "function") return;
  let result;
  try {
    result = _addSmartWalletImpl({
      name: `lpers-${record.address.slice(0, 6)}`,
      address: record.address,
      category: "smart",
      type: "lp",
    });
  } catch (err) {
    log("top_lpers_warn", `addSmartWallet threw for ${record.address.slice(0, 8)}: ${err.message}`);
    return;
  }
  if (result && result.success === false && result.error && !/already tracked/i.test(result.error)) {
    log("top_lpers_warn", `addSmartWallet error for ${record.address.slice(0, 8)}: ${result.error}`);
  }
}

/**
 * Compute composite leaderboard score for one LPer record.
 */
export function scoreLper(record, now = Date.now()) {
  const cfg = getCfg();
  const stats = record.aggregate_stats || {};
  const pools = record.pools_seen?.length || 0;
  const wr = stats.win_rate ?? 0;
  const roi = stats.roi ?? 0;

  // Recency decay: linear from 1.0 (today) → 0.5 (recencyDecayDays) → 0.1 floor.
  const lastSeen = record.last_seen_at ? new Date(record.last_seen_at).getTime() : now;
  const daysSince = Math.max(0, (now - lastSeen) / (24 * 60 * 60 * 1000));
  const decayDays = Math.max(1, cfg.recencyDecayDays);
  const recency = Math.max(0.1, 1 - 0.5 * (daysSince / decayDays));

  return Number((pools * wr * (1 + roi) * recency).toFixed(4));
}

/**
 * Return ranked leaderboard of LPers.
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit=20]
 * @param {boolean} [opts.includeRejected=false]
 * @param {boolean} [opts.onlyPromoted=false]
 * @param {number}  [opts.now]
 */
export function getLeaderboard({ limit = 20, includeRejected = false, onlyPromoted = false, now = Date.now() } = {}) {
  const s = load();
  let entries = Object.values(s.lpers);
  if (!includeRejected) entries = entries.filter((r) => !r.rejected);
  if (onlyPromoted) entries = entries.filter((r) => r.promoted);
  return entries
    .map((r) => ({
      address: r.address,
      name: r.name,
      pools_seen: r.pools_seen?.length || 0,
      total_positions: r.aggregate_stats?.total_positions || 0,
      win_rate: r.aggregate_stats?.win_rate || 0,
      roi: r.aggregate_stats?.roi || 0,
      avg_pnl_pct: r.aggregate_stats?.avg_pnl_pct || 0,
      preferred_strategy: r.aggregate_stats?.preferred_strategy || "unknown",
      promoted: r.promoted,
      last_seen_at: r.last_seen_at,
      score: scoreLper(r, now),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

/**
 * Manually promote an LPer (operator override). Skips the automatic
 * threshold check.
 *
 * @returns {{ok:boolean, reason?:string, record?:LperRecord}}
 */
export function promoteLper({ address, reason = "manual" }, now = Date.now()) {
  if (!isValidAddress(address)) return { ok: false, reason: "invalid_address" };
  const s = load();
  const record = s.lpers[address];
  if (!record) return { ok: false, reason: "not_found" };
  if (record.rejected) return { ok: false, reason: "rejected" };
  if (record.promoted) return { ok: true, reason: "already_promoted", record };

  const isoNow = nowIso(now);
  record.promoted = true;
  record.promoted_at = isoNow;
  s.promotions.push({ address, name: record.name, promoted_at: isoNow, reason: `manual: ${reason}` });
  try {
    syncToSmartWallets(record, reason);
  } catch (err) {
    log("top_lpers_warn", `Promoted ${address.slice(0, 8)} but smart-wallets sync failed: ${err.message}`);
  }
  save();
  log("top_lpers", `👤 Manually promoted ${record.name} (${address.slice(0, 8)}) — ${reason}`);
  return { ok: true, record };
}

/**
 * Mark an LPer as rejected — they'll never auto-promote and are
 * filtered from default leaderboard output.
 */
export function rejectLper({ address, reason = "operator" }, now = Date.now()) {
  if (!isValidAddress(address)) return { ok: false, reason: "invalid_address" };
  const s = load();
  const record = s.lpers[address];
  if (!record) {
    // Allow proactive rejection of an address we haven't seen yet — useful
    // for blocking known-bad LPers ahead of time.
    s.lpers[address] = {
      address,
      name: `rejected-${address.slice(0, 6)}`,
      names_seen: [],
      first_seen_at: nowIso(now),
      last_seen_at: nowIso(now),
      pools_seen: [],
      aggregate_stats: {},
      promoted: false,
      promoted_at: null,
      rejected: true,
      rejected_at: nowIso(now),
      rejection_reason: reason,
    };
    s.rejections.push({ address, rejected_at: nowIso(now), reason });
    save();
    log("top_lpers", `🚫 Pre-emptively rejected ${address.slice(0, 8)} — ${reason}`);
    return { ok: true, record: s.lpers[address], proactive: true };
  }
  record.rejected = true;
  record.rejected_at = nowIso(now);
  record.rejection_reason = reason;
  // If they had been promoted, demote — but DO NOT remove from
  // smart-wallets.json automatically; the operator can run
  // remove_smart_wallet manually if they want a hard removal.
  s.rejections.push({ address, rejected_at: nowIso(now), reason });
  save();
  log("top_lpers", `🚫 Rejected ${record.name} (${address.slice(0, 8)}) — ${reason}`);
  return { ok: true, record };
}

/**
 * Snapshot of corpus stats for /lpers stats command.
 */
export function getStats() {
  const s = load();
  const all = Object.values(s.lpers);
  const promoted = all.filter((r) => r.promoted && !r.rejected).length;
  const rejected = all.filter((r) => r.rejected).length;
  const pending = all.length - promoted - rejected;
  const cfg = getCfg();

  // How many are within one threshold of qualifying — useful operator
  // signal ("you have N candidates almost ready").
  const nearQualifying = all.filter((r) => {
    if (r.promoted || r.rejected) return false;
    const stats = r.aggregate_stats || {};
    const checks = [
      (r.pools_seen?.length || 0) >= cfg.autoPromoteMinPools - 1,
      (stats.win_rate ?? 0) >= cfg.autoPromoteMinWinRate - 0.1,
      (stats.total_positions ?? 0) >= cfg.autoPromoteMinPositions - 3,
    ];
    return checks.filter(Boolean).length >= 2;
  }).length;

  return {
    total_tracked: all.length,
    promoted,
    rejected,
    pending,
    near_qualifying: nearQualifying,
    promotions_log: s.promotions.length,
    rejections_log: s.rejections.length,
    thresholds: cfg,
  };
}

/**
 * Return raw record for one LPer (useful for /lpers info <addr>).
 */
export function getLperRecord(address) {
  const s = load();
  return s.lpers[address] || null;
}

/**
 * Test helper — drops in-memory and on-disk state.
 */
export function _resetForTesting() {
  _state = { lpers: {}, promotions: [], rejections: [] };
  if (fs.existsSync(FILE)) {
    try { fs.unlinkSync(FILE); } catch { /* ignore */ }
  }
  _addSmartWalletImpl = _defaultAddSmartWallet;
}

/**
 * Test helper — substitute the smart-wallets sync function so tests can
 * assert auto-promotion without touching the real smart-wallets.json.
 * Pass `null` to disable syncing.
 *
 * @param {Function|null} fn  - replacement implementation, or null to no-op.
 */
export function _setSmartWalletsMockForTesting(fn) {
  _addSmartWalletImpl = fn || (() => ({ success: true }));
}
