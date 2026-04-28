/**
 * Real-time WS watcher for open DLMM positions.
 *
 * Subscribes to each tracked position's pool (lbPair) account via the
 * Solana WebSocket. When a swap (or any state change) hits the pool, the
 * watcher re-fetches the active bin and checks whether the position has
 * moved out of [lower, upper]. On OOR transition it marks state and fires
 * an `onOor` callback so the app layer can react instantly instead of
 * waiting for the next polling cycle.
 *
 * Design notes:
 * - One WS subscription per pool (positions sharing a pool share a sub).
 * - Debounced active-bin refetch: many swaps in the same slot only trigger
 *   one re-check.
 * - Throttled onOor fires: max one callback per position per
 *   `oorThrottleMs` to avoid hammering closePosition during oscillation.
 * - Reconnect is left to @solana/web3.js Connection (it auto-reconnects
 *   the underlying WebSocket and replays subscriptions). We log gaps but
 *   do not implement custom reconnect logic.
 * - This module is opt-in: `config.management.realtimeMonitoring`. When
 *   off, all public functions are no-ops.
 */

import { PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";
import { markOutOfRange, markInRange, minutesOutOfRange } from "../state.js";

let _connection = null;
let _onOor = null;
let _getActiveBinFn = null;
let _enabled = false;
let _debounceMs = 3_000;
let _oorThrottleMs = 60_000;

// poolAddress -> {
//   subId: number,
//   positions: Map<positionAddress, { lower, upper }>,
//   debounceTimer: NodeJS.Timeout | null,
//   pendingRefetch: boolean,
//   lastOorFire: Map<positionAddress, ms>,
// }
const watchers = new Map();

/**
 * Initialise the realtime watcher. Must be called once at app startup.
 * Safe to call when disabled — public functions become no-ops.
 *
 * @param {object} opts
 * @param {import("@solana/web3.js").Connection} opts.connection — the same Connection used elsewhere; its WS endpoint is auto-derived from the HTTP URL.
 * @param {(arg: { pool_address: string }) => Promise<{ binId: number }>} opts.getActiveBin — function returning the current active bin for a pool. Re-uses the project's existing cache.
 * @param {(event: { positionAddress: string, poolAddress: string, activeBin: number, lower: number, upper: number, minutesOOR: number }) => Promise<void>} opts.onOor — callback fired when a position is detected OOR (subject to throttle).
 * @param {boolean} opts.enabled — gate flag from config.
 * @param {number} [opts.debounceMs] — minimum gap between active-bin refetches per pool.
 * @param {number} [opts.oorThrottleMs] — minimum gap between onOor fires per position.
 */
export function initRealtimeWatcher({
  connection,
  getActiveBin,
  onOor,
  enabled,
  debounceMs = 3_000,
  oorThrottleMs = 60_000,
}) {
  _connection = connection;
  _getActiveBinFn = getActiveBin;
  _onOor = onOor;
  _enabled = !!enabled;
  _debounceMs = Math.max(500, Number(debounceMs) || 3_000);
  _oorThrottleMs = Math.max(5_000, Number(oorThrottleMs) || 60_000);

  if (_enabled) {
    log("realtime", `Initialised — debounce=${_debounceMs}ms throttle=${_oorThrottleMs}ms`);
  }
}

/**
 * Register a position to be watched. Idempotent — calling twice with the
 * same address re-uses the existing pool subscription.
 */
export async function watchPosition({ positionAddress, poolAddress, lowerBin, upperBin }) {
  if (!_enabled || !_connection) return;
  if (positionAddress == null || poolAddress == null) return;
  if (lowerBin == null || upperBin == null) {
    log("realtime_warn", `watchPosition skipped — missing bin range for ${positionAddress.slice(0, 8)}`);
    return;
  }

  let entry = watchers.get(poolAddress);
  if (!entry) {
    entry = {
      subId: null,
      positions: new Map(),
      debounceTimer: null,
      pendingRefetch: false,
      lastOorFire: new Map(),
    };
    watchers.set(poolAddress, entry);
    try {
      entry.subId = _connection.onAccountChange(
        new PublicKey(poolAddress),
        () => scheduleRefetch(poolAddress),
        { commitment: "processed" },
      );
      log("realtime", `WS subscribed pool=${poolAddress.slice(0, 8)} sub=${entry.subId}`);
    } catch (err) {
      watchers.delete(poolAddress);
      log("realtime_error", `subscribe failed pool=${poolAddress.slice(0, 8)}: ${err.message}`);
      return;
    }
  }

  entry.positions.set(positionAddress, { lower: Number(lowerBin), upper: Number(upperBin) });
  log("realtime", `Watching position=${positionAddress.slice(0, 8)} pool=${poolAddress.slice(0, 8)} range=[${lowerBin},${upperBin}]`);
}

/**
 * Stop watching a position. If it was the last position on that pool, the
 * pool subscription is closed.
 */
export async function unwatchPosition({ positionAddress, poolAddress }) {
  if (!poolAddress) return;
  const entry = watchers.get(poolAddress);
  if (!entry) return;
  entry.positions.delete(positionAddress);
  entry.lastOorFire.delete(positionAddress);
  if (entry.positions.size === 0) {
    if (entry.subId != null && _connection) {
      try {
        await _connection.removeAccountChangeListener(entry.subId);
      } catch (err) {
        log("realtime_warn", `removeListener failed: ${err.message}`);
      }
    }
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    watchers.delete(poolAddress);
    log("realtime", `Unsubscribed pool=${poolAddress.slice(0, 8)}`);
  }
}

/**
 * Reconcile watch state with the authoritative position list. Useful at
 * startup (re-subscribe to existing open positions found in state.json)
 * and after a long sleep where we may have missed close events.
 *
 * @param {Array<{ position: string, pool: string, lower_bin: number, upper_bin: number }>} positions
 */
export async function reconcileWatchers(positions) {
  if (!_enabled) return;
  const wanted = new Map();
  for (const p of positions || []) {
    if (!p?.position || !p?.pool) continue;
    if (p.lower_bin == null || p.upper_bin == null) continue;
    wanted.set(p.position, { pool: p.pool, lower: p.lower_bin, upper: p.upper_bin });
  }
  // Remove watchers no longer present.
  for (const [poolAddress, entry] of watchers) {
    for (const positionAddress of Array.from(entry.positions.keys())) {
      if (!wanted.has(positionAddress)) {
        await unwatchPosition({ positionAddress, poolAddress });
      }
    }
  }
  // Add watchers we don't yet have.
  for (const [positionAddress, { pool, lower, upper }] of wanted) {
    const existing = watchers.get(pool);
    if (existing && existing.positions.has(positionAddress)) {
      // Update bin range in case it changed (rebalance).
      existing.positions.set(positionAddress, { lower, upper });
      continue;
    }
    await watchPosition({ positionAddress, poolAddress: pool, lowerBin: lower, upperBin: upper });
  }
}

export function getWatcherStats() {
  let positions = 0;
  for (const entry of watchers.values()) positions += entry.positions.size;
  return { pools: watchers.size, positions };
}

/**
 * Tear down all subscriptions. Call on graceful shutdown.
 */
export async function shutdownRealtimeWatcher() {
  for (const [poolAddress, entry] of watchers) {
    if (entry.subId != null && _connection) {
      try {
        await _connection.removeAccountChangeListener(entry.subId);
      } catch {}
    }
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  }
  watchers.clear();
  log("realtime", "Shutdown — all WS subscriptions closed");
}

// ─── Internals ────────────────────────────────────────────────────

function scheduleRefetch(poolAddress) {
  const entry = watchers.get(poolAddress);
  if (!entry) return;
  if (entry.debounceTimer) {
    entry.pendingRefetch = true;
    return;
  }
  entry.debounceTimer = setTimeout(async () => {
    entry.debounceTimer = null;
    const wasPending = entry.pendingRefetch;
    entry.pendingRefetch = false;
    await refetchAndCheck(poolAddress).catch((err) => {
      log("realtime_error", `refetch loop failed pool=${poolAddress.slice(0, 8)}: ${err.message}`);
    });
    if (wasPending && watchers.has(poolAddress)) {
      // Another change arrived during debounce — chain one more pass.
      scheduleRefetch(poolAddress);
    }
  }, _debounceMs);
}

async function refetchAndCheck(poolAddress) {
  const entry = watchers.get(poolAddress);
  if (!entry || entry.positions.size === 0) return;
  if (!_getActiveBinFn) return;

  let activeBin;
  try {
    const result = await _getActiveBinFn({ pool_address: poolAddress });
    activeBin = Number(result?.binId);
    if (!Number.isFinite(activeBin)) {
      log("realtime_warn", `getActiveBin returned non-numeric binId for ${poolAddress.slice(0, 8)}`);
      return;
    }
  } catch (err) {
    log("realtime_error", `getActiveBin failed pool=${poolAddress.slice(0, 8)}: ${err.message}`);
    return;
  }

  for (const [positionAddress, range] of entry.positions) {
    const isOor = activeBin < range.lower || activeBin > range.upper;
    if (!isOor) {
      markInRange(positionAddress);
      continue;
    }
    markOutOfRange(positionAddress);
    const lastFire = entry.lastOorFire.get(positionAddress) || 0;
    if (Date.now() - lastFire < _oorThrottleMs) continue;
    entry.lastOorFire.set(positionAddress, Date.now());

    const minutesOOR = minutesOutOfRange(positionAddress);
    log(
      "realtime",
      `OOR detected position=${positionAddress.slice(0, 8)} pool=${poolAddress.slice(0, 8)} active=${activeBin} range=[${range.lower},${range.upper}] minutesOOR=${minutesOOR}`,
    );

    if (_onOor) {
      try {
        await _onOor({
          positionAddress,
          poolAddress,
          activeBin,
          lower: range.lower,
          upper: range.upper,
          minutesOOR,
        });
      } catch (err) {
        log("realtime_error", `onOor handler threw: ${err.message}`);
      }
    }
  }
}
