/**
 * fs-utils — atomic JSON file writes + lock + safe load.
 *
 * Guards against corruption on process crash / SIGKILL / power loss.
 * Pattern: write full contents to <file>.tmp.<pid>.<ts>, then rename()
 * over the target. rename() is atomic on POSIX filesystems, so either:
 *   (a) the rename succeeds and the file contains the complete new data, or
 *   (b) the rename fails / never runs and the original file is untouched.
 *
 * There is never an intermediate "half-written" state on disk.
 *
 * Audit 5/21 — Phase 0 refactor:
 *   - withJsonLock: per-file in-memory mutex untuk read-modify-write race
 *     (BUG-23, 30, 39, 40)
 *   - loadJsonOrThrow: backup corrupt file + throw, jangan silent wipe
 *     (BUG-24, 38, 40)
 *   - fetchWithTimeout: AbortController wrapper (BUG-4, 28, 34)
 */

import fs from "fs";
import path from "path";

/**
 * Atomically write JSON to `filePath`.
 * @param {string} filePath  absolute or relative path to target file.
 * @param {unknown} data     value to serialize (or a pre-serialized string).
 * @param {{indent?: number}} [opts]  JSON.stringify indent (default 2).
 */
export function writeJsonAtomicSync(filePath, data, opts = {}) {
  const { indent = 2 } = opts;
  const serialized = typeof data === "string" ? data : JSON.stringify(data, null, indent);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, serialized);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the tmp file. The original is safe regardless.
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

/**
 * Promise-based atomic write — same semantics as writeJsonAtomicSync.
 */
export async function writeJsonAtomic(filePath, data, opts = {}) {
  const { indent = 2 } = opts;
  const serialized = typeof data === "string" ? data : JSON.stringify(data, null, indent);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.promises.writeFile(tmpPath, serialized);
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Per-file mutex (in-memory). Serializes read-modify-write cycles touching
// the same JSON file so that two callers can't both load(), mutate, and save()
// concurrently and lose the first writer's mutation.
// ---------------------------------------------------------------------------

const _fileLocks = new Map(); // absolutePath -> tail Promise

function _resolveLockKey(filePath) {
  // Resolve so callers using relative paths still serialize correctly.
  try { return path.resolve(filePath); } catch { return String(filePath); }
}

/**
 * Run `fn` while holding an exclusive lock on `filePath`.
 * Use this to wrap any read-modify-write cycle: load() -> mutate -> save().
 * Returns whatever fn() returns.
 */
export async function withJsonLock(filePath, fn) {
  const key = _resolveLockKey(filePath);
  const prev = _fileLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  _fileLocks.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Clear map entry if no waiters chained behind us.
    if (_fileLocks.get(key) === next.then(() => undefined)) {
      // can't reliably compare — let GC handle stale entries via tail ref;
      // map will be overwritten by next acquire anyway
    }
  }
}

/**
 * Synchronous variant: acquires the lock, runs `fn` synchronously, releases.
 * Only use when caller is itself sync. fn must NOT return a promise.
 *
 * NOTE: Because Node is single-threaded, sync work cannot interleave with
 * other JS. Concurrency hazard only exists when there's an `await` mid-cycle.
 * This helper is therefore a no-op except for documentation — provided so
 * call sites can be uniform with async ones.
 */
export function withJsonLockSync(_filePath, fn) {
  return fn();
}

// ---------------------------------------------------------------------------
// Safe load — never silently wipe history on corrupt JSON.
// On parse error: copies the corrupt file aside, then throws.
// ---------------------------------------------------------------------------

/**
 * Load + parse a JSON file.
 *  - missing file: returns `defaultValue` (or {} if not provided).
 *  - parse error: copies file to <path>.corrupt-<ts> and throws.
 *
 * Caller decides how to recover from a thrown corrupt file. Most call sites
 * should let it bubble up — operator must inspect manually before restart.
 *
 * @param {string} filePath
 * @param {unknown} [defaultValue]  used only when file does not exist.
 * @returns {unknown}  parsed JSON value.
 */
export function loadJsonOrThrow(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    return defaultValue === undefined ? {} : defaultValue;
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`fs-utils: read failed for ${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const backup = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backup); } catch {}
    const wrapped = new Error(
      `fs-utils: corrupt JSON at ${filePath} — backed up to ${backup}. ` +
      `Original: ${err.message}`,
    );
    wrapped.code = "CORRUPT_JSON";
    wrapped.backupPath = backup;
    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// fetchWithTimeout — universal AbortController wrapper.
// Replaces raw `fetch()` calls so requests can't hang the bot forever.
// ---------------------------------------------------------------------------

/**
 * fetch() with AbortController-backed timeout.
 * @param {string|URL} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs=15000]  pass 0/Infinity to disable timeout.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const parentSignal = options.signal;
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
  }
}
