/**
 * fs-utils — atomic JSON file writes.
 *
 * Guards against corruption on process crash / SIGKILL / power loss.
 * Pattern: write full contents to <file>.tmp.<pid>.<ts>, then rename()
 * over the target. rename() is atomic on POSIX filesystems, so either:
 *   (a) the rename succeeds and the file contains the complete new data, or
 *   (b) the rename fails / never runs and the original file is untouched.
 *
 * There is never an intermediate "half-written" state on disk.
 */

import fs from "fs";

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
