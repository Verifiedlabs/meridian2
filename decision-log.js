import fs from "fs";
import { writeJsonAtomicSync } from "./fs-utils.js";
import { log } from "./logger.js";

const DECISION_LOG_FILE = "./decision-log.json";
const MAX_DECISIONS = 100;
const MAX_TREND_POINTS = 12; // Keep 12 weeks of trend data
const TREND_BREAK_THRESHOLD = 0.15; // 15% drop triggers alert

function load() {
  if (!fs.existsSync(DECISION_LOG_FILE)) {
    return { decisions: [], validation_trends: {}, last_trend_check: null };
  }
  try {
    return JSON.parse(fs.readFileSync(DECISION_LOG_FILE, "utf8"));
  } catch {
    return { decisions: [], validation_trends: {}, last_trend_check: null };
  }
}

function save(data) {
  writeJsonAtomicSync(DECISION_LOG_FILE, data);
}

function sanitize(value, maxLen = 280) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export function appendDecision(entry) {
  const data = load();
  const decision = {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    type: entry.type || "note",
    actor: entry.actor || "GENERAL",
    pool: entry.pool || null,
    pool_name: sanitize(entry.pool_name || entry.pool, 120),
    position: entry.position || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    risks: Array.isArray(entry.risks) ? entry.risks.map((r) => sanitize(r, 140)).filter(Boolean).slice(0, 6) : [],
    metrics: entry.metrics || {},
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map((r) => sanitize(r, 180)).filter(Boolean).slice(0, 8) : [],
  };
  data.decisions.unshift(decision);
  data.decisions = data.decisions.slice(0, MAX_DECISIONS);
  save(data);
  return decision;
}

export function getRecentDecisions(limit = 10) {
  const data = load();
  return (data.decisions || []).slice(0, limit);
}

/**
 * Return decisions tied to a specific position address. Most useful for
 * audit / explainability: given a position, what did the bot decide and
 * why? Caller usually wants the deploy decision (oldest first).
 *
 * @param {string} position_address
 * @param {Object} [opts]
 * @param {string} [opts.type] — filter by decision type (e.g. "deploy", "close")
 * @returns {Array} decisions in chronological order (oldest → newest)
 */
export function getDecisionsByPosition(position_address, opts = {}) {
  if (!position_address) return [];
  const { type = null } = opts;
  const data = load();
  return (data.decisions || [])
    .filter((d) => d.position === position_address)
    .filter((d) => (type ? d.type === type : true))
    .sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
}

export function getDecisionSummary(limit = 6) {
  const decisions = getRecentDecisions(limit);
  if (!decisions.length) return "No recent structured decisions yet.";
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.pool_name || d.pool || "unknown pool"}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason ? `reason: ${d.reason}` : null,
      d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
      d.rejected?.length ? `rejected: ${d.rejected.join(" | ")}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}

// ─── Validation Trend Tracking (D3) ─────────────────────────────

/**
 * Record validation data for Darwin signal weights.
 * Called after each Darwin recalculation.
 * 
 * @param {Object} validation - validation result from signal-weights.js
 * @param {string} validation.signTotal - total signals validated
 * @param {string} validation.signMatches - signals with matching direction
 * @param {Object} signalWeights - current signal weights
 */
export function recordValidationTrend(validation, signalWeights) {
  const data = load();
  
  if (!data.validation_trends) {
    data.validation_trends = {};
  }
  
  // Initialize overall validation trend
  if (!data.validation_trends.overall) {
    data.validation_trends.overall = [];
  }
  
  const overallRate = validation.signTotal > 0 ? validation.signMatches / validation.signTotal : 0;
  
  const trendPoint = {
    date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
    signMatches: validation.signMatches || 0,
    signTotal: validation.signTotal || 0,
    rate: Math.round(overallRate * 1000) / 1000,
    timestamp: new Date().toISOString()
  };
  
  // Add new point (only one per day)
  const existingIndex = data.validation_trends.overall.findIndex(
    t => t.date === trendPoint.date
  );
  
  if (existingIndex >= 0) {
    data.validation_trends.overall[existingIndex] = trendPoint; // Update today's entry
  } else {
    data.validation_trends.overall.push(trendPoint);
  }
  
  // Keep only last MAX_TREND_POINTS
  if (data.validation_trends.overall.length > MAX_TREND_POINTS) {
    data.validation_trends.overall = data.validation_trends.overall.slice(-MAX_TREND_POINTS);
  }
  
  data.last_trend_check = new Date().toISOString();
  save(data);
  
  log("validation_trend", `Recorded validation trend: ${validation.signMatches}/${validation.signTotal} (${(overallRate * 100).toFixed(1)}%)`);
  
  // Check for trend breaks
  checkTrendBreaks(data.validation_trends.overall);
}

/**
 * Check for significant trend breaks in validation data.
 * Alerts if validation rate drops by more than TREND_BREAK_THRESHOLD.
 */
function checkTrendBreaks(trends) {
  if (!trends || trends.length < 3) return; // Need at least 3 points
  
  const latest = trends[trends.length - 1];
  const previous = trends[trends.length - 3]; // Compare with 3 points ago (~3 weeks)
  
  if (!latest || !previous) return;
  
  const drop = previous.rate - latest.rate;
  
  if (drop > TREND_BREAK_THRESHOLD) {
    const dropPct = (drop * 100).toFixed(1);
    log("validation_alert", `[ALERT] Darwin validation trend break detected`);
    log("validation_alert", `Validation rate dropped from ${(previous.rate * 100).toFixed(1)}% → ${(latest.rate * 100).toFixed(1)}% (${dropPct}% drop)`);
    log("validation_alert", `Recommendation: Consider recalibrating signal weights`);
    
    // Return alert data for Telegram notification
    return {
      type: "validation_trend_break",
      severity: drop > 0.25 ? "high" : "medium",
      message: `Darwin validation dropped ${(previous.rate * 100).toFixed(1)}% → ${(latest.rate * 100).toFixed(1)}% (${dropPct}% drop)`,
      recommendation: "Consider recalibrating signal weights"
    };
  }
  
  return null;
}

/**
 * Get validation trend summary for display.
 * Used by /trends Telegram command.
 */
export function getValidationTrendSummary() {
  const data = load();
  const trends = data.validation_trends?.overall || [];
  
  if (trends.length === 0) {
    return "No validation trend data yet. Trends will appear after Darwin recalculations.";
  }
  
  const lines = ["Darwin Validation Trends (last 4 weeks):"];
  lines.push("");
  
  // Show last 4 weeks (or all if less)
  const recentTrends = trends.slice(-4);
  
  for (const trend of recentTrends) {
    const ratePct = (trend.rate * 100).toFixed(1);
    const bar = validationBar(trend.rate);
    const date = trend.date.slice(5); // MM-DD format
    
    // Check if this is a significant drop
    const prevIdx = trends.indexOf(trend) - 1;
    let status = "";
    if (prevIdx >= 0) {
      const prevRate = trends[prevIdx].rate;
      const drop = prevRate - trend.rate;
      if (drop > 0.10) status = drop > 0.20 ? " ⚠ CRITICAL" : " ⚠ DROPPING";
      else if (drop < -0.05) status = " ↑ IMPROVING";
      else status = " STABLE";
    }
    
    lines.push(`${ratePct.padStart(6)}% ${bar} ${date}${status}`);
  }
  
  // Check for overall trend
  if (trends.length >= 2) {
    const firstRate = trends[0].rate;
    const lastRate = trends[trends.length - 1].rate;
    const overallChange = ((lastRate - firstRate) * 100).toFixed(1);
    
    lines.push("");
    if (parseFloat(overallChange) < -10) {
      lines.push(`[ALERT] Overall trend: ${overallChange}% → consider recalibration`);
    } else if (parseFloat(overallChange) > 5) {
      lines.push(`[INFO] Overall trend: ${overallChange}% → improving`);
    } else {
      lines.push(`[INFO] Overall trend: ${overallChange}% → stable`);
    }
  }
  
  return lines.join("\n");
}

function validationBar(rate) {
  // Scale 0-1 to 0-10 bars
  const filled = Math.round(rate * 10);
  const clamped = Math.max(0, Math.min(10, filled));
  return "#".repeat(clamped) + ".".repeat(10 - clamped);
}
