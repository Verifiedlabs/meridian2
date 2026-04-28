// Centralized Solana RPC connection management with multi-endpoint failover.
//
// Reads `RPC_URL` from env (comma-separated list) and additional
// `RPC_URL_FALLBACK_1..N` for legacy compatibility. Maintains a current
// primary index and rotates on failure when callers wrap their RPC calls
// in `withRpcRetry()`.
//
// Usage:
//   import { getConnection, withRpcRetry } from "./rpc.js";
//   const sig = await withRpcRetry(() => getConnection().sendRawTransaction(tx));

import { Connection } from "@solana/web3.js";
import { log } from "./logger.js";

let _urls = null;
let _index = 0;
let _connection = null;

function parseUrls() {
  if (_urls) return _urls;
  const out = [];
  const primary = process.env.RPC_URL || "";
  for (const part of primary.split(",")) {
    const trimmed = part.trim();
    if (trimmed) out.push(trimmed);
  }
  for (let i = 1; i <= 8; i++) {
    const fallback = process.env[`RPC_URL_FALLBACK_${i}`];
    if (fallback && typeof fallback === "string" && fallback.trim()) {
      out.push(fallback.trim());
    }
  }
  if (out.length === 0) {
    throw new Error("RPC_URL is not set. Provide at least one Solana RPC endpoint.");
  }
  _urls = out;
  return _urls;
}

export function getRpcUrls() {
  return [...parseUrls()];
}

export function getCurrentRpcUrl() {
  const urls = parseUrls();
  return urls[_index % urls.length];
}

export function getConnection() {
  if (!_connection) {
    _connection = new Connection(getCurrentRpcUrl(), "confirmed");
  }
  return _connection;
}

export function rotateRpc(reason = "") {
  const urls = parseUrls();
  if (urls.length <= 1) return false;
  _index = (_index + 1) % urls.length;
  _connection = null;
  log("rpc", `Rotated to ${getCurrentRpcUrl()}${reason ? ` — ${reason}` : ""}`);
  return true;
}

const TRANSIENT_PATTERNS = [
  /429/,
  /503/,
  /502/,
  /504/,
  /timeout/i,
  /timed out/i,
  /ECONNRESET/,
  /EAI_AGAIN/,
  /ENOTFOUND/,
  /fetch failed/i,
  /socket hang up/i,
  /rate.?limit/i,
  /too many requests/i,
  /node is behind/i,
  /unable to fetch/i,
];

function isTransientError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return TRANSIENT_PATTERNS.some((p) => p.test(msg));
}

/**
 * Wrap an RPC call in retry-with-rotation logic. The callable receives no
 * arguments — fetch the connection inside via `getConnection()` so each retry
 * uses the rotated endpoint.
 *
 * @param {() => Promise<T>} op
 * @param {{ tries?: number, delayMs?: number, label?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function withRpcRetry(op, { tries = null, delayMs = 250, label = "rpc" } = {}) {
  const urls = parseUrls();
  const maxTries = tries ?? urls.length;
  let lastErr = null;
  for (let i = 0; i < maxTries; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || i === maxTries - 1) {
        throw err;
      }
      log("rpc_retry", `${label} attempt ${i + 1}/${maxTries} failed: ${err.message}`);
      const rotated = rotateRpc(err.message);
      if (!rotated && delayMs > 0) {
        // single endpoint — back off before retry
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      } else if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}
