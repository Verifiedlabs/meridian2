/**
 * Darwinian signal weighting system.
 *
 * Tracks which screening signals actually predict profitable positions
 * and adjusts their weights over time. Signals that consistently appear
 * in winners get boosted; those associated with losers get decayed.
 *
 * Weights are persisted in signal-weights.json and injected into the
 * LLM prompt so the agent can prioritize the right screening criteria.
 */

import fs from "fs";
import { writeJsonAtomicSync, loadJsonOrThrow, withJsonLock } from "./fs-utils.js";
import { log } from "./logger.js";
import { recordValidationTrend } from "./decision-log.js";

const WEIGHTS_FILE = "./signal-weights.json";

// ─── Signal Definitions ─────────────────────────────────────────

const SIGNAL_NAMES = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
  "twitter_sentiment",
];

const DEFAULT_WEIGHTS = Object.fromEntries(SIGNAL_NAMES.map((s) => [s, 1.0]));

// Signals where higher values generally indicate better candidates
const HIGHER_IS_BETTER = new Set([
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "holder_count",
  "study_win_rate",
]);

// Boolean signals — compared by win rate when present vs absent.
// hive_consensus is true iff at least one HiveMind shared lesson
// mentions the candidate's token symbol — see signal-tracker
// computeHiveConsensus(). It's classified as boolean (not numeric)
// because computeNumericLift's extractNumeric() drops booleans;
// computeBooleanLift handles them natively.
const BOOLEAN_SIGNALS = new Set(["smart_wallets_present", "hive_consensus"]);

// Categorical signals — compared by win rate across categories
const CATEGORICAL_SIGNALS = new Set(["narrative_quality", "twitter_sentiment"]);

// ─── Persistence ─────────────────────────────────────────────────

export function loadWeights() {
  if (!fs.existsSync(WEIGHTS_FILE)) {
    const initial = {
      weights: { ...DEFAULT_WEIGHTS },
      last_recalc: null,
      recalc_count: 0,
      history: [],
    };
    saveWeights(initial);
    log("signal_weights", "Created signal-weights.json with default weights");
    return initial;
  }
  try {
    const parsed = loadJsonOrThrow(WEIGHTS_FILE);
    return {
      weights: { ...DEFAULT_WEIGHTS, ...(parsed.weights || {}) },
      last_recalc: parsed.last_recalc || null,
      recalc_count: parsed.recalc_count || 0,
      history: parsed.history || [],
      ...parsed,
    };
  } catch (err) {
    // Corrupt JSON: backup already taken by loadJsonOrThrow. Don't silently
    // wipe Darwin tuning history (BUG-38). Operator must inspect manually.
    log("signal_weights_error", `signal-weights.json corrupt: ${err.message}`);
    throw err;
  }
}

export function saveWeights(data) {
  try {
    writeJsonAtomicSync(WEIGHTS_FILE, data);
  } catch (err) {
    log("signal_weights_error", `Failed to write signal-weights.json: ${err.message}`);
  }
}

// ─── Core Algorithm ──────────────────────────────────────────────

/**
 * Split records into a deterministic 80% train / 20% holdout. Every 5th
 * record (stride=5, offset=4) is held out; the rest are train. This keeps
 * recent and old records distributed across both sets so neither bucket
 * over-fits a particular regime.
 */
export function splitTrainHoldout(records, holdoutRatio = 0.2) {
  if (!Array.isArray(records) || records.length === 0) {
    return { train: [], holdout: [] };
  }
  const stride = Math.max(2, Math.round(1 / holdoutRatio));
  const train = [];
  const holdout = [];
  for (let i = 0; i < records.length; i++) {
    if (i % stride === stride - 1) holdout.push(records[i]);
    else train.push(records[i]);
  }
  return { train, holdout };
}

/**
 * Check whether the lift directions computed on train data are consistent
 * with the lift directions computed on holdout. Returns an object with a
 * `commit` boolean and explanatory metadata.
 *
 * Intuition: if a signal's lift is +0.3 on train but -0.1 on holdout, the
 * train signal is likely noise — applying weight changes from it would
 * amplify a bad pattern. We require ≥50% of validated signals to agree
 * in direction before allowing the recalculation to commit.
 */
export function assessTrainHoldoutConsistency(train, holdout, minSamples = 10) {
  const trainWins   = train.filter((p) => (p.pnl_usd ?? 0) > 0);
  const trainLosses = train.filter((p) => (p.pnl_usd ?? 0) <= 0);
  const holdWins    = holdout.filter((p) => (p.pnl_usd ?? 0) > 0);
  const holdLosses  = holdout.filter((p) => (p.pnl_usd ?? 0) <= 0);

  // If either side lacks bucket coverage, validation cannot run — defer to
  // the existing min-samples gate by signaling commit=true with a reason.
  if (trainWins.length === 0 || trainLosses.length === 0) {
    return { commit: false, reason: "train missing wins or losses", signTotal: 0, signMatches: 0 };
  }
  if (holdWins.length === 0 || holdLosses.length === 0) {
    return { commit: true, reason: "holdout missing buckets — validation skipped", signTotal: 0, signMatches: 0 };
  }

  let signMatches = 0;
  let signTotal = 0;
  for (const signal of SIGNAL_NAMES) {
    // Use a relaxed minSamples for the holdout side since it's smaller.
    const tLift = computeLift(signal, trainWins, trainLosses, Math.min(minSamples, trainWins.length + trainLosses.length));
    const hLift = computeLift(signal, holdWins, holdLosses, Math.min(3, holdWins.length + holdLosses.length));
    if (tLift == null || hLift == null) continue;
    signTotal += 1;
    // Sign match — both positive, both negative, or both ~zero (within 1e-6)
    const tSign = Math.abs(tLift) < 1e-6 ? 0 : Math.sign(tLift);
    const hSign = Math.abs(hLift) < 1e-6 ? 0 : Math.sign(hLift);
    if (tSign === hSign) signMatches += 1;
  }

  // Need at least 3 signals validated to make a reliable judgment. Below
  // that, defer to existing behavior (commit allowed).
  if (signTotal < 3) {
    return { commit: true, reason: `only ${signTotal} signal(s) validated — too few, accepting`, signTotal, signMatches };
  }

  const agreement = signMatches / signTotal;
  if (agreement >= 0.5) {
    return { commit: true, reason: `holdout agreement ${signMatches}/${signTotal} (${Math.round(agreement * 100)}%)`, signTotal, signMatches };
  }
  return { commit: false, reason: `holdout disagreement ${signMatches}/${signTotal} (${Math.round(agreement * 100)}%) — likely noise`, signTotal, signMatches };
}

/**
 * Recalculate signal weights based on actual position performance.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} cfg      - Live config object (reads cfg.darwin for tuning)
 * @returns {{ changes: Array, weights: Object, validation?: Object }}
 */
export async function recalculateWeights(perfData, cfg = {}) {
  return withJsonLock(WEIGHTS_FILE, async () => {
  const darwin = cfg.darwin || {};
  const windowDays    = darwin.windowDays    ?? 60;
  const minSamples    = darwin.minSamples    ?? 10;
  const boostFactor   = darwin.boostFactor   ?? 1.05;
  const decayFactor   = darwin.decayFactor   ?? 0.95;
  const weightFloor   = darwin.weightFloor   ?? 0.3;
  const weightCeiling = darwin.weightCeiling ?? 2.5;

  const data = loadWeights();
  const weights = data.weights || { ...DEFAULT_WEIGHTS };

  // Ensure all signals exist (handles new signals added after initial creation)
  for (const name of SIGNAL_NAMES) {
    if (weights[name] == null) weights[name] = 1.0;
  }

  // Filter to rolling window
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffISO = cutoff.toISOString();

  const recent = perfData.filter((p) => {
    const ts = p.recorded_at || p.closed_at || p.deployed_at;
    return ts && ts >= cutoffISO;
  });

  if (recent.length < minSamples) {
    log("signal_weights", `Only ${recent.length} records in ${windowDays}d window (need ${minSamples}), skipping recalc`);
    return { changes: [], weights };
  }

  // Hold-out validation — split records 80/20 and check whether train
  // and holdout agree on the direction of each signal's lift. If the
  // pattern looks noise-driven, skip the recalc rather than commit
  // changes that won't generalize.
  const { train, holdout } = splitTrainHoldout(recent, 0.2);
  const validation = assessTrainHoldoutConsistency(train, holdout, minSamples);
  if (!validation.commit) {
    log("signal_weights", `Skipped recalc: ${validation.reason}`);
    return { changes: [], weights, validation };
  }

  // Classify wins and losses (use TRAIN only for weight computation so the
  // holdout truly is held out from the fit). Falls back to recent when
  // train is too small to be useful.
  const fitData = train.length >= Math.max(5, minSamples - 2) ? train : recent;
  const wins   = fitData.filter((p) => (p.pnl_usd ?? 0) > 0);
  const losses = fitData.filter((p) => (p.pnl_usd ?? 0) <= 0);

  if (wins.length === 0 || losses.length === 0) {
    log("signal_weights", `Need both wins (${wins.length}) and losses (${losses.length}) to compute lift, skipping`);
    return { changes: [], weights, validation };
  }

  // Compute predictive lift for each signal
  const lifts = {};
  for (const signal of SIGNAL_NAMES) {
    const lift = computeLift(signal, wins, losses, minSamples);
    if (lift !== null) lifts[signal] = lift;
  }

  const ranked = Object.entries(lifts).sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    log("signal_weights", "No signals had enough samples for lift calculation");
    return { changes: [], weights };
  }

  // Split into quartiles
  const q1End    = Math.ceil(ranked.length * 0.25);
  const q3Start  = Math.floor(ranked.length * 0.75);
  const topQuartile    = new Set(ranked.slice(0, q1End).map(([name]) => name));
  const bottomQuartile = new Set(ranked.slice(q3Start).map(([name]) => name));

  // Apply boosts and decays
  const changes = [];
  for (const [signal, lift] of ranked) {
    const prev = weights[signal];
    let next = prev;

    if (topQuartile.has(signal)) {
      next = Math.min(prev * boostFactor, weightCeiling);
    } else if (bottomQuartile.has(signal)) {
      next = Math.max(prev * decayFactor, weightFloor);
    }

    next = Math.round(next * 1000) / 1000;

    if (next !== prev) {
      const dir = next > prev ? "boosted" : "decayed";
      changes.push({ signal, from: prev, to: next, lift: Math.round(lift * 1000) / 1000, action: dir });
      weights[signal] = next;
      log("signal_weights", `${signal}: ${prev} -> ${next} (${dir}, lift=${lift.toFixed(3)})`);
    }
  }

  // Persist
  data.weights = weights;
  data.last_recalc = new Date().toISOString();
  // BUG-42 (Audit 5/21): only count recalc when something actually changed.
  // Previously incremented on every call so recalc_count overstated activity
  // and made it impossible to tell from logs whether Darwin was learning.
  if (changes.length > 0) {
    data.recalc_count = (data.recalc_count || 0) + 1;
  }
  if (!data.history) data.history = [];
  if (changes.length > 0) {
    data.history.push({
      timestamp: data.last_recalc,
      changes,
      window_size: recent.length,
      win_count: wins.length,
      loss_count: losses.length,
    });
    if (data.history.length > 20) data.history = data.history.slice(-20);
  }
  saveWeights(data);

  log("signal_weights", changes.length > 0
    ? `Recalculated: ${changes.length} weight(s) adjusted from ${recent.length} records`
    : `Recalculated: no changes needed (${recent.length} records, ${ranked.length} signals evaluated)`);

  // Record validation trend for D3 trend tracking
  try {
    recordValidationTrend(validation, weights);
  } catch (err) {
    log("signal_weights_warn", `Failed to record validation trend: ${err.message}`);
  }

  return { changes, weights, validation };
  });
}

// ─── Lift Computation ────────────────────────────────────────────

function computeLift(signal, wins, losses, minSamples) {
  if (BOOLEAN_SIGNALS.has(signal))      return computeBooleanLift(signal, wins, losses, minSamples);
  if (CATEGORICAL_SIGNALS.has(signal))  return computeCategoricalLift(signal, wins, losses, minSamples);
  return computeNumericLift(signal, wins, losses, minSamples);
}

function computeNumericLift(signal, wins, losses, minSamples) {
  const winVals  = extractNumeric(signal, wins);
  const lossVals = extractNumeric(signal, losses);
  if (winVals.length + lossVals.length < minSamples) return null;
  if (winVals.length === 0 || lossVals.length === 0) return null;

  const all = [...winVals, ...lossVals];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min;
  // BUG-41 (Audit 5/21): zero-range means signal has no variation in this
  // sample, return null instead of 0 so the consistency checker skips it
  // rather than counting it as agreement and inflating signMatches.
  if (range === 0) return null;

  const normalize = (v) => (v - min) / range;
  const winMean  = mean(winVals.map(normalize));
  const lossMean = mean(lossVals.map(normalize));

  return HIGHER_IS_BETTER.has(signal) ? winMean - lossMean : Math.abs(winMean - lossMean);
}

function computeBooleanLift(signal, wins, losses, minSamples) {
  const allEntries = [...wins.map((w) => ({ w: true, snap: w })), ...losses.map((l) => ({ w: false, snap: l }))];
  let trueWins = 0, trueTotal = 0, falseWins = 0, falseTotal = 0;

  for (const { w, snap } of allEntries) {
    const val = snap.signal_snapshot?.[signal];
    if (val === undefined || val === null) continue;
    if (val) { trueTotal++; if (w) trueWins++; }
    else      { falseTotal++; if (w) falseWins++; }
  }

  if (trueTotal + falseTotal < minSamples) return null;
  if (trueTotal === 0 || falseTotal === 0) return null;
  return (trueWins / trueTotal) - (falseWins / falseTotal);
}

function computeCategoricalLift(signal, wins, losses, minSamples) {
  const allEntries = [...wins.map((w) => ({ w: true, snap: w })), ...losses.map((l) => ({ w: false, snap: l }))];
  const buckets = {};

  for (const { w, snap } of allEntries) {
    const val = snap.signal_snapshot?.[signal];
    if (val === undefined || val === null) continue;
    if (!buckets[val]) buckets[val] = { wins: 0, total: 0 };
    buckets[val].total++;
    if (w) buckets[val].wins++;
  }

  const totalSamples = Object.values(buckets).reduce((s, b) => s + b.total, 0);
  if (totalSamples < minSamples) return null;

  const rates = Object.values(buckets).filter((b) => b.total >= 2).map((b) => b.wins / b.total);
  if (rates.length < 2) return null;
  return Math.max(...rates) - Math.min(...rates);
}

// ─── Helpers ─────────────────────────────────────────────────────

function extractNumeric(signal, entries) {
  const vals = [];
  for (const entry of entries) {
    const snap = entry.signal_snapshot;
    if (!snap) continue;
    const v = snap[signal];
    if (v != null && typeof v === "number" && isFinite(v)) vals.push(v);
  }
  return vals;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ─── Summary for LLM Prompt Injection ────────────────────────────

export function getWeightsSummary() {
  const data = loadWeights();
  const w = data.weights || {};

  const lines = ["Signal Weights (Darwinian — learned from past positions):"];
  const sorted = SIGNAL_NAMES
    .filter((s) => w[s] != null)
    .sort((a, b) => (w[b] ?? 1) - (w[a] ?? 1));

  for (const signal of sorted) {
    const val = w[signal] ?? 1.0;
    const label = interpretWeight(val);
    const bar   = weightBar(val);
    lines.push(`  ${signal.padEnd(24)} ${val.toFixed(2)}  ${bar}  ${label}`);
  }

  if (data.last_recalc) {
    lines.push(`\nLast recalculated: ${data.last_recalc} (${data.recalc_count || 0} total)`);
  } else {
    lines.push("\nWeights have not been recalculated yet (using defaults).");
  }

  return lines.join("\n");
}

function interpretWeight(val) {
  if (val >= 1.8) return "[STRONG]";
  if (val >= 1.2) return "[above avg]";
  if (val >= 0.8) return "[neutral]";
  if (val >= 0.5) return "[below avg]";
  return "[weak]";
}

function weightBar(val) {
  const filled  = Math.round(((val - 0.3) / (2.5 - 0.3)) * 10);
  const clamped = Math.max(0, Math.min(10, filled));
  return "#".repeat(clamped) + ".".repeat(10 - clamped);
}
