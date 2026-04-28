// Solana priority-fee + compute-budget helpers.
//
// Solana transactions can include `ComputeBudgetProgram` instructions to:
//   1. Reserve a higher compute-unit limit (avoid silent CU exhaustion).
//   2. Pay a priority fee (in micro-lamports per CU) that incentivizes
//      validators to include the tx during congestion.
//
// Without these, txs frequently drop during congested periods. Meteora
// SDK builds the bare LB-pair instructions, so we prepend the budget
// instructions before sending.
//
// Config (config.priorityFee):
//   enabled                — master toggle, default true
//   computeUnitLimit       — CU limit per tx (default 600_000)
//   minMicroLamports       — floor for priority fee (default 1_000)
//   maxMicroLamports       — ceiling for priority fee (default 1_000_000)
//   percentile             — RPC percentile (1-100) for getRecentPrioritizationFees (default 75)
//
// We sample the RPC's recent prioritization fees, take the chosen
// percentile, clamp to [min, max], and use that for the next tx.

import { ComputeBudgetProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { config } from "./config.js";
import { getConnection } from "./rpc.js";
import { log } from "./logger.js";

const DEFAULTS = {
  enabled: true,
  computeUnitLimit: 600_000,
  minMicroLamports: 1_000,
  maxMicroLamports: 1_000_000,
  percentile: 75,
  cacheTtlMs: 15_000,
};

let _cache = { value: null, fetchedAt: 0 };

function cfg() {
  const c = config.priorityFee || {};
  return {
    enabled:          c.enabled          ?? DEFAULTS.enabled,
    computeUnitLimit: c.computeUnitLimit ?? DEFAULTS.computeUnitLimit,
    minMicroLamports: c.minMicroLamports ?? DEFAULTS.minMicroLamports,
    maxMicroLamports: c.maxMicroLamports ?? DEFAULTS.maxMicroLamports,
    percentile:       c.percentile       ?? DEFAULTS.percentile,
    cacheTtlMs:       c.cacheTtlMs       ?? DEFAULTS.cacheTtlMs,
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function pickPercentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx];
}

/**
 * Fetch a priority fee suggestion in micro-lamports per CU. Caches for
 * `cacheTtlMs` to avoid hammering the RPC.
 */
export async function suggestPriorityFeeMicroLamports() {
  const c = cfg();
  if (!c.enabled) return 0;
  if (_cache.value != null && Date.now() - _cache.fetchedAt < c.cacheTtlMs) {
    return _cache.value;
  }
  let suggested = c.minMicroLamports;
  try {
    const conn = getConnection();
    const samples = await conn.getRecentPrioritizationFees();
    const fees = (samples || [])
      .map((s) => Number(s?.prioritizationFee ?? 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    const pick = pickPercentile(fees, c.percentile);
    if (pick != null) suggested = pick;
  } catch (err) {
    log("priority_fee", `getRecentPrioritizationFees failed (${err.message}); using min ${c.minMicroLamports}`);
  }
  const final = clamp(Math.round(suggested), c.minMicroLamports, c.maxMicroLamports);
  _cache = { value: final, fetchedAt: Date.now() };
  return final;
}

/**
 * Prepend ComputeBudget setComputeUnitLimit + setComputeUnitPrice
 * instructions to a legacy `Transaction`. Returns the same object.
 *
 * Skips if the tx already has a setComputeUnitPrice instruction (SDK or
 * caller already added one) — prevents double-paying.
 */
export async function prependPriorityInstructions(tx) {
  const c = cfg();
  if (!c.enabled) return tx;
  if (!(tx instanceof Transaction)) return tx; // VersionedTransactions are handled separately
  const existing = tx.instructions.find((ix) =>
    ix.programId && ix.programId.equals(ComputeBudgetProgram.programId)
  );
  if (existing) return tx;

  const microLamports = await suggestPriorityFeeMicroLamports();
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: c.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
  // Use unshift to prepend — order matters: limit before price is conventional.
  tx.instructions.unshift(...ixs);
  return tx;
}

/**
 * Apply priority instructions to one tx or an array of txs (legacy or
 * versioned). VersionedTransactions are passed through unchanged with a
 * one-time warning, since their messages are pre-compiled and prepending
 * instructions requires re-deriving the message.
 */
export async function applyPriorityInstructions(txOrTxs) {
  if (Array.isArray(txOrTxs)) {
    for (const tx of txOrTxs) {
      await prependPriorityInstructions(tx);
    }
    return txOrTxs;
  }
  return prependPriorityInstructions(txOrTxs);
}
