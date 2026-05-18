import fs from "fs";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";

const FILE = "./zapout-telemetry.json";
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_STATE = {
  windowStart: null,
  counters: {
    native_zapout_success: 0,
    native_zapout_fail: 0,
    native_zapout_fallback_used: 0,
  },
  recent: [],
};

let _state = null;

function load() {
  if (_state) return _state;
  if (!fs.existsSync(FILE)) {
    _state = {
      ...DEFAULT_STATE,
      counters: { ...DEFAULT_STATE.counters },
      recent: [],
    };
    return _state;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    _state = {
      ...DEFAULT_STATE,
      ...parsed,
      counters: { ...DEFAULT_STATE.counters, ...(parsed?.counters || {}) },
      recent: Array.isArray(parsed?.recent) ? parsed.recent : [],
    };
  } catch (error) {
    log("zapout_metrics_warn", `Failed to load ${FILE}: ${error.message} — reset counters`);
    _state = {
      ...DEFAULT_STATE,
      counters: { ...DEFAULT_STATE.counters },
      recent: [],
    };
  }
  return _state;
}

function save() {
  try {
    writeJsonAtomicSync(FILE, _state);
  } catch (error) {
    log("zapout_metrics_warn", `Failed to save ${FILE}: ${error.message}`);
  }
}

function rollWindow(now) {
  const state = load();
  const startedAt = state.windowStart ? new Date(state.windowStart).getTime() : 0;
  if (!startedAt || now - startedAt >= DAY_MS) {
    state.windowStart = new Date(now).toISOString();
    state.counters = { ...DEFAULT_STATE.counters };
    state.recent = [];
  }
}

function record(metric, meta = {}) {
  const now = Date.now();
  rollWindow(now);
  const state = load();
  state.counters[metric] = Number(state.counters[metric] || 0) + 1;
  state.recent.push({
    metric,
    at: new Date(now).toISOString(),
    ...meta,
  });
  if (state.recent.length > 100) state.recent = state.recent.slice(-100);
  save();
}

export function recordNativeZapOutSuccess(meta = {}) {
  record("native_zapout_success", meta);
}

export function recordNativeZapOutFail(meta = {}) {
  record("native_zapout_fail", meta);
}

export function recordNativeZapOutFallbackUsed(meta = {}) {
  record("native_zapout_fallback_used", meta);
}

export function getZapOutTelemetrySummary() {
  rollWindow(Date.now());
  const state = load();
  return {
    windowStart: state.windowStart,
    counters: { ...state.counters },
    recent: state.recent.slice(-20),
  };
}

export function __resetZapOutTelemetryForTests() {
  _state = null;
  try {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  } catch {}
}
