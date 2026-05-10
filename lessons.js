/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { writeJsonAtomicSync } from "./fs-utils.js";
import { log } from "./logger.js";
import { getSharedLessonsForPrompt, pushHiveLesson, pushHivePerformanceEvent } from "./hivemind.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const LESSONS_FILE = "./lessons.json";
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once
const MAX_MANUAL_LESSON_LENGTH = 400;

function sanitizeLessonText(text, maxLen = MAX_MANUAL_LESSON_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  writeJsonAtomicSync(LESSONS_FILE, data);
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(perf) {
  const data = load();

  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  // Carry the exploration flag from the tracked position state if the
  // caller didn't pass it explicitly. This lets recordPerformance be
  // invoked from any close-path (executor, realtime watcher, manual)
  // without each call site having to thread the flag through.
  let explorationFlag = perf.exploration;
  if (explorationFlag == null && perf.position) {
    try {
      const { getTrackedPosition } = await import("./state.js");
      const tracked = getTrackedPosition(perf.position);
      if (tracked && typeof tracked.exploration === "boolean") {
        explorationFlag = tracked.exploration;
      }
    } catch { /* state lookup is non-critical */ }
  }

  const entry = {
    ...perf,
    exploration: !!explorationFlag,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);

  // Derive and store a lesson — pass live management config so the
  // outcome categorizer respects the user's actual TP/SL thresholds
  // instead of the legacy hardcoded ±5%.
  let mgmtConfig = null;
  try {
    const { config } = await import("./config.js");
    mgmtConfig = config?.management || null;
  } catch { /* ignore — derivLesson falls back to hardcoded thresholds */ }

  const lesson = derivLesson(entry, mgmtConfig);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);
  if (lesson) {
    void pushHiveLesson(lesson);
  }

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      fees_earned_usd: perf.fees_earned_usd,
      fees_earned_sol: perf.fees_earned_sol,
      fee_earned_pct: perf.initial_value_usd > 0 ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100 : null,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
    });
  }

  // Evolve thresholds every 5 closed positions
  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("./config.js");
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }

    // Darwinian signal weight recalculation
    if (config.darwin?.enabled) {
      const { recalculateWeights } = await import("./signal-weights.js");
      const wResult = recalculateWeights(data.performance, config);
      if (wResult.changes.length > 0) {
        log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      } else if (wResult.validation && !wResult.validation.commit) {
        log("evolve", `Darwin: skipped recalc — ${wResult.validation.reason}`);
      }
    }

    // ── B1: Risk parameter (TP/SL) proposals ──
    // Generate-only — never auto-applied. Operator approves via /risk accept.
    if (config?.risk?.autoProposeRiskParams !== false && config?.management) {
      try {
        const proposal = proposeTpSlAdjustment(data.performance, config.management);
        if (proposal) {
          const stored = storeRiskProposal(proposal);
          if (stored && stored.status === "pending") {
            // Telegram alert — operator can review with /risk.
            // Uses sendHTML (not sendMessage) so the <b>/<i> tags actually
            // render. sendMessage discards its second arg, so an earlier
            // call site that passed { parseMode: "HTML" } silently produced
            // raw-tagged messages until this fix.
            try {
              const { sendHTML } = await import("./telegram.js");
              const lines = ["💡 <b>Risk proposal</b> — review with /risk"];
              for (const [k, v] of Object.entries(proposal.proposals)) {
                lines.push(`  • ${k}: ${proposal.current[k]} → <b>${v}</b>`);
              }
              lines.push(`<i>Sample: ${proposal.sample_size} closes (${proposal.winners}W/${proposal.losers}L)</i>`);
              lines.push(`Use /risk accept ${stored.id} or /risk reject ${stored.id}.`);
              const text = lines.join("\n");
              await sendHTML(text).catch((err) =>
                log("silent_warn", `Risk proposal alert failed: ${err.message}`),
              );
            } catch (err) {
              log("silent_warn", `Risk proposal dispatch failed: ${err.message}`);
            }
          }
        }
      } catch (err) {
        log("silent_warn", `proposeTpSlAdjustment failed: ${err.message}`);
      }
    }
  }

  void pushHivePerformanceEvent({
    ...entry,
    base_mint: perf.base_mint || null,
    fees_earned_sol: perf.fees_earned_sol || 0,
    eventId: `close:${perf.position}:${entry.recorded_at}`,
  });

  // Feed the drawdown circuit breaker. Approximate SOL PnL from pnl_pct ×
  // amount_sol — accurate enough for breaker thresholds (a 5% loss on a
  // 0.5 SOL deploy is ~0.025 SOL regardless of SOL/USD).
  try {
    const { recordClose, getStatus } = await import("./src/circuit-breaker.js");
    const amountSol = Number.isFinite(perf.amount_sol) ? perf.amount_sol : 0;
    const pnlSol = (entry.pnl_pct / 100) * amountSol;
    const trip = recordClose({
      pnl_sol: pnlSol,
      pnl_pct: entry.pnl_pct,
      position: perf.position,
      pool_name: perf.pool_name,
    });
    if (trip.justTripped) {
      const status = getStatus();
      const resumeIn = status.willResumeAt
        ? `Auto-resume at ${status.willResumeAt}`
        : `Auto-resume after cooldown`;
      const text =
        `🛑 Drawdown breaker tripped: ${trip.reason}\n\n` +
        `Recent: ${status.recentLosses}/${status.recentTotal} losses\n` +
        `24h PnL: ${status.dailyPnlSol} SOL (cap: -${status.maxDailyLossSol})\n` +
        `Screening paused. ${resumeIn}.\n\n` +
        `/resume to clear immediately.`;
      try {
        const { sendMessage } = await import("./telegram.js");
        await sendMessage(text).catch((err) => log("silent_warn", `Breaker alert failed: ${err.message}`));
      } catch (err) {
        log("silent_warn", `Breaker alert dispatch failed: ${err.message}`);
      }
    }
  } catch (err) {
    log("silent_warn", `Circuit breaker recordClose failed: ${err.message}`);
  }
}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 *
 * @param {Object} perf — performance record
 * @param {Object} [mgmtConfig] — optional live management config. When provided,
 *   the outcome categorizer aligns with the user's actual takeProfitPct /
 *   stopLossPct so a +4% TP exit is correctly tagged "good" even when the
 *   legacy hardcoded threshold (5%) wouldn't catch it.
 */
function derivLesson(perf, mgmtConfig = null) {
  const tags = [];
  const feeYieldPct = perf.initial_value_usd > 0
    ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100
    : 0;

  // Threshold-aware outcome categorization. We treat anything that
  // reaches at least 80% of the user's TP target as a clear win, and
  // anything past the user's stop loss as a clear loss. Fee-positive
  // small wins (>= 2% of capital earned in fees) still count as "good".
  const tpPct = Number.isFinite(mgmtConfig?.takeProfitPct) && mgmtConfig.takeProfitPct > 0
    ? mgmtConfig.takeProfitPct
    : 5;
  const slPct = Number.isFinite(mgmtConfig?.stopLossPct) && mgmtConfig.stopLossPct < 0
    ? mgmtConfig.stopLossPct
    : -5;
  const goodCutoff = Math.min(5, tpPct * 0.8);
  // "bad" cutoff: at-or-below stop loss, with a small grace so positions
  // that exit exactly at SL still register as bad. Cap at -5% so we
  // never accidentally raise the bar above the legacy default.
  const badCutoff = Math.min(-5, slPct + 1);

  const outcome = perf.pnl_pct >= goodCutoff ? "good"
    : (perf.pnl_pct >= 0 && feeYieldPct >= 2) ? "good"
    : perf.pnl_pct >= 0 ? "neutral"
    : perf.pnl_pct > badCutoff ? "poor"
    : "bad";

  if (outcome === "neutral") return null; // nothing interesting to learn

  // Build context description
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ].join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const positiveEvidence =
    feeYieldPct >= 1 ||
    (perf.fees_earned_usd || 0) >= 3 ||
    perf.pnl_pct >= 3;
  const negativeEvidence =
    perf.pnl_pct <= -5 ||
    perf.range_efficiency <= 30 ||
    closeReasonText.includes("out of range") ||
    closeReasonText.includes("oor") ||
    closeReasonText.includes("low yield") ||
    closeReasonText.includes("volume");

  let confidence = 0.35;
  if (outcome === "good") {
    confidence = positiveEvidence ? 0.82 : 0.22;
  } else if (outcome === "bad") {
    confidence = negativeEvidence ? 0.88 : 0.45;
  } else if (outcome === "poor") {
    confidence = negativeEvidence ? 0.68 : 0.32;
  }

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    sourceType: "performance",
    confidence: Math.round(confidence * 100) / 100,
    context,
    pnl_pct: perf.pnl_pct,
    fees_earned_usd: perf.fees_earned_usd,
    initial_value_usd: perf.initial_value_usd,
    range_efficiency: perf.range_efficiency,
    close_reason: perf.close_reason,
    pool: perf.pool,
    // Carry exploration flag so Tier 1 scoring can apply the noise discount.
    // Lessons from exploration deploys are weighted 0.6× because the
    // relaxed thresholds make the deploy decision less informative.
    exploration: !!perf.exploration,
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} config   - Live config object (mutated in place)
 * @returns {{ changes: Object, rationale: Object } | null}
 */
export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  // Loser cutoff: respect the user's actual stop-loss threshold so we
  // count true SL events (and worse) as losers. Falls back to -5% for
  // legacy configs without management.stopLossPct. We add a small +1
  // grace so positions exiting just inside the SL band are still
  // counted (e.g. SL=-6, cutoff=-5 captures pnl_pct in (-6, -5]).
  const slPct = Number.isFinite(config?.management?.stopLossPct) && config.management.stopLossPct < 0
    ? config.management.stopLossPct
    : -5;
  const loserCutoff = Math.min(-5, slPct + 1);

  const winners = perfData.filter((p) => p.pnl_pct > 0);
  const losers  = perfData.filter((p) => p.pnl_pct < loserCutoff);

  // Need at least some signal in both directions before adjusting
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal) return null;

  const changes   = {};
  const rationale = {};

  // ── 1. maxVolatility ─────────────────────────────────────────
  // If losers tend to cluster at higher volatility → tighten the ceiling.
  // If winners span higher volatility safely → we can loosen a bit.
  {
    const winnerVols = winners.map((p) => p.volatility).filter(isFiniteNum);
    const loserVols  = losers.map((p) => p.volatility).filter(isFiniteNum);
    const current    = config.screening.maxVolatility;

    if (loserVols.length >= 2) {
      // 25th percentile of loser volatilities — this is where things start going wrong
      const loserP25 = percentile(loserVols, 25);
      if (loserP25 < current) {
        // Tighten: new ceiling = loserP25 + a small buffer
        const target  = loserP25 * 1.15;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded < current) {
          changes.maxVolatility = rounded;
          rationale.maxVolatility = `Losers clustered at volatility ~${loserP25.toFixed(1)} — tightened from ${current} → ${rounded}`;
        }
      }
    } else if (winnerVols.length >= 3 && losers.length === 0) {
      // All winners so far — loosen conservatively so we don't miss good pools
      const winnerP75 = percentile(winnerVols, 75);
      if (winnerP75 > current * 1.1) {
        const target  = winnerP75 * 1.1;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded > current) {
          changes.maxVolatility = rounded;
          rationale.maxVolatility = `All ${winners.length} positions profitable — loosened from ${current} → ${rounded}`;
        }
      }
    }
  }

  // ── 2. minFeeActiveTvlRatio ─────────────────────────────────────────
  // Raise the floor if low-fee pools consistently underperform.
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = config.screening.minFeeActiveTvlRatio;

    if (winnerFees.length >= 2) {
      // Minimum fee/TVL among winners — we know pools below this don't work for us
      const minWinnerFee = Math.min(...winnerFees);
      if (minWinnerFee > current * 1.2) {
        const target  = minWinnerFee * 0.85; // stay slightly below min winner
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2) {
      // If losers all had high fee/TVL, that's noise (pumps then crash) — don't raise min
      // But if losers had low fee/TVL, raise min
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target  = maxLoserFee * 1.2;
          const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
          const rounded = Number(newVal.toFixed(2));
          if (rounded > current && !changes.minFeeActiveTvlRatio) {
            changes.minFeeActiveTvlRatio = rounded;
            rationale.minFeeActiveTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  // ── 3. minOrganic ─────────────────────────────────────────────
  // Raise organic floor if low-organic tokens consistently failed.
  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = config.screening.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic  = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      // Only raise if there's a clear gap (winners consistently more organic)
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        // Set floor just below worst winner
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // ── Persist changes to user-config.json ───────────────────────
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;

  writeJsonAtomicSync(USER_CONFIG_PATH, userConfig);

  // Apply to live config object immediately
  const s = config.screening;
  if (changes.maxVolatility    != null) s.maxVolatility    = changes.maxVolatility;
  if (changes.minFeeActiveTvlRatio   != null) s.minFeeActiveTvlRatio   = changes.minFeeActiveTvlRatio;
  if (changes.minOrganic       != null) s.minOrganic       = changes.minOrganic;

  // Log a lesson summarizing the evolution
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(data);

  return { changes, rationale };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Risk Parameter Proposals (B1: TP/SL self-evolve) ──────────
//
// Risk params (takeProfitPct / stopLossPct) are PROPOSED, not auto-applied.
// Operator approval via /risk accept|reject is required because mis-tuned
// risk params can amplify drawdown. Proposals expire after 7 days.

const RISK_PROPOSAL_EXPIRY_DAYS = 7;
const RISK_MIN_SAMPLE = 10;          // need ≥10 closes to propose
const RISK_MIN_CHANGE_PCT = 0.15;    // ≥15% change vs current to surface
const TP_FLOOR = 1.5;
const TP_CEILING = 12;
const SL_FLOOR = -15; // most negative we'll propose
const SL_CEILING = -2; // least negative we'll propose

function classifyCloseReason(reason) {
  const text = String(reason || "").toLowerCase();
  if (text.includes("stop loss") || text.includes("stop_loss")) return "stop_loss";
  if (text.includes("take profit") || text.includes("take_profit")) return "take_profit";
  if (text.includes("trailing")) return "trailing";
  return "other";
}

/**
 * Analyze closed-position distribution and propose TP/SL adjustments.
 * Returns { proposals: { takeProfitPct?, stopLossPct? }, rationale } or null.
 *
 * Heuristics:
 *  TP — if TP+trailing rarely fires AND most winners stop well below current
 *       TP, lower TP toward the 60th percentile of winners.
 *  SL — if SL events overshoot the threshold by ≥1.5% on average (slow
 *       close slippage), tighten SL by the average overshoot. Conversely,
 *       if no losses are reaching SL after enough samples, can loosen.
 *
 * The function never mutates config. Caller is responsible for persisting
 * the proposal via storeRiskProposal.
 *
 * @param {Array}  perfData    Performance records (lessons.json `performance`)
 * @param {Object} mgmtConfig  Live config.management object (for current TP/SL)
 * @param {Object} [opts]
 * @param {number} [opts.minSample] override RISK_MIN_SAMPLE
 */
export function proposeTpSlAdjustment(perfData, mgmtConfig, opts = {}) {
  if (!perfData || !mgmtConfig) return null;
  const minSample = Number.isFinite(opts.minSample) && opts.minSample > 0
    ? opts.minSample
    : RISK_MIN_SAMPLE;
  if (perfData.length < minSample) return null;

  const currentTp = Number.isFinite(mgmtConfig.takeProfitPct) ? mgmtConfig.takeProfitPct : null;
  const currentSl = Number.isFinite(mgmtConfig.stopLossPct) ? mgmtConfig.stopLossPct : null;
  if (currentTp == null || currentSl == null) return null;

  const winners = perfData.filter((p) => Number.isFinite(p.pnl_pct) && p.pnl_pct > 0);
  const losers  = perfData.filter((p) => Number.isFinite(p.pnl_pct) && p.pnl_pct < 0);

  const proposals = {};
  const rationale = {};

  // ── 1. takeProfitPct ─────────────────────────────────────────
  if (winners.length >= 5) {
    const winnerPnls = winners.map((p) => p.pnl_pct);
    // Only HARD take-profit hits count toward "is the TP target ever
    // reached". Trailing exits are a different mechanism (close on
    // pullback from peak), so including them masks an under-firing
    // hard TP — which is the exact case where a lowering proposal is
    // most valuable. Real-world example from this codebase: 7 hard TP
    // hits + 24 trailing exits in 95 closes. Counting both gives 32%
    // (rule blocked) when the truth is hard TP fires only 7%.
    const tpHits = perfData.filter(
      (p) => classifyCloseReason(p.close_reason) === "take_profit",
    ).length;
    const tpRate = tpHits / perfData.length;
    const p60 = percentile(winnerPnls, 60);
    const avgWinner = avg(winnerPnls);

    // Lower TP if it rarely fires AND winners cluster well below it.
    if (tpRate < 0.20 && p60 < currentTp * 0.85) {
      const target = clamp(Math.max(p60 * 1.05, avgWinner * 0.9), TP_FLOOR, TP_CEILING);
      const newTp = Number(target.toFixed(1));
      const changePct = Math.abs(newTp - currentTp) / Math.max(currentTp, 0.5);
      if (newTp < currentTp && changePct >= RISK_MIN_CHANGE_PCT) {
        proposals.takeProfitPct = newTp;
        rationale.takeProfitPct =
          `Hard TP hits ${(tpRate * 100).toFixed(0)}% (${tpHits}/${perfData.length}). ` +
          `Winners avg ${avgWinner.toFixed(2)}%, p60=${p60.toFixed(2)}%. ` +
          `Lower TP ${currentTp} → ${newTp} to capture more winners.`;
      }
    }
  }

  // ── 2. stopLossPct ───────────────────────────────────────────
  if (losers.length >= 3) {
    const slLosers = losers.filter((p) => classifyCloseReason(p.close_reason) === "stop_loss");
    if (slLosers.length >= 3) {
      const overshoots = slLosers.map((p) => p.pnl_pct - currentSl); // negative = past SL
      const avgOvershoot = avg(overshoots);

      // SL overshoots threshold by >1.5% on average — tighten by that amount
      if (avgOvershoot < -1.5) {
        const target = clamp(currentSl - avgOvershoot, SL_FLOOR, SL_CEILING);
        // Cap tightening at 50% of current — never propose tightening too aggressively
        const minSl = currentSl * 1.5;
        const safeTarget = Math.max(target, minSl);
        const newSl = Number(safeTarget.toFixed(1));
        const changePct = Math.abs(newSl - currentSl) / Math.max(Math.abs(currentSl), 0.5);
        if (newSl > currentSl && changePct >= RISK_MIN_CHANGE_PCT) {
          proposals.stopLossPct = newSl;
          rationale.stopLossPct =
            `${slLosers.length} SL events overshoot by avg ${avgOvershoot.toFixed(2)}% ` +
            `(slow close slippage). Tighten SL ${currentSl} → ${newSl} to compensate.`;
        }
      }
    }
  }

  if (Object.keys(proposals).length === 0) return null;

  return {
    proposals,
    rationale,
    sample_size: perfData.length,
    winners: winners.length,
    losers: losers.length,
    current: { takeProfitPct: currentTp, stopLossPct: currentSl },
  };
}

/**
 * Persist a risk-proposal record into lessons.json under `risk_proposals`.
 * Returns the stored proposal with assigned id and status="pending".
 * Skips when an identical pending proposal already exists (dedup).
 */
export function storeRiskProposal(proposalData) {
  if (!proposalData?.proposals) return null;
  const data = load();
  data.risk_proposals = Array.isArray(data.risk_proposals) ? data.risk_proposals : [];

  // Dedup: if a pending proposal with identical numeric proposals exists,
  // refresh its timestamp instead of creating a duplicate.
  const existing = data.risk_proposals.find(
    (rp) =>
      rp.status === "pending" &&
      rp.proposals?.takeProfitPct === proposalData.proposals.takeProfitPct &&
      rp.proposals?.stopLossPct === proposalData.proposals.stopLossPct,
  );
  if (existing) {
    existing.refreshed_at = new Date().toISOString();
    existing.sample_size = proposalData.sample_size ?? existing.sample_size;
    save(data);
    return existing;
  }

  const proposal = {
    id: Date.now(),
    proposals: proposalData.proposals,
    rationale: proposalData.rationale,
    sample_size: proposalData.sample_size,
    winners: proposalData.winners,
    losers: proposalData.losers,
    current: proposalData.current,
    status: "pending",
    created_at: new Date().toISOString(),
  };
  data.risk_proposals.push(proposal);
  // Cap at last 50 — protects against unbounded growth
  if (data.risk_proposals.length > 50) {
    data.risk_proposals = data.risk_proposals.slice(-50);
  }
  save(data);
  log("evolve", `Risk proposal queued: ${JSON.stringify(proposalData.proposals)}`);
  return proposal;
}

/**
 * List pending risk proposals (newest first), filtering out expired ones.
 */
export function getPendingRiskProposals() {
  const data = load();
  const all = Array.isArray(data.risk_proposals) ? data.risk_proposals : [];
  const cutoff = Date.now() - RISK_PROPOSAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  return all
    .filter((rp) => rp.status === "pending" && new Date(rp.created_at).getTime() >= cutoff)
    .slice()
    .reverse();
}

/**
 * Accept a pending proposal — applies it to user-config.json + live config.
 * Returns { success, applied, rejected_reason? }.
 */
export function acceptRiskProposal(id, liveConfig) {
  const data = load();
  data.risk_proposals = Array.isArray(data.risk_proposals) ? data.risk_proposals : [];
  const proposal = data.risk_proposals.find((rp) => rp.id === id);
  if (!proposal) return { success: false, error: "proposal not found" };
  if (proposal.status !== "pending") {
    return { success: false, error: `proposal already ${proposal.status}` };
  }

  // Persist to user-config.json
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }
  const applied = {};
  if (proposal.proposals.takeProfitPct != null) {
    userConfig.takeProfitPct = proposal.proposals.takeProfitPct;
    applied.takeProfitPct = proposal.proposals.takeProfitPct;
  }
  if (proposal.proposals.stopLossPct != null) {
    userConfig.stopLossPct = proposal.proposals.stopLossPct;
    applied.stopLossPct = proposal.proposals.stopLossPct;
  }
  userConfig._lastRiskAccepted = new Date().toISOString();
  writeJsonAtomicSync(USER_CONFIG_PATH, userConfig);

  // Apply to live config if provided
  if (liveConfig?.management) {
    if (applied.takeProfitPct != null) liveConfig.management.takeProfitPct = applied.takeProfitPct;
    if (applied.stopLossPct != null) liveConfig.management.stopLossPct = applied.stopLossPct;
  }

  proposal.status = "accepted";
  proposal.accepted_at = new Date().toISOString();

  // Audit lesson so the change appears in lesson timeline
  data.lessons.push({
    id: Date.now(),
    rule: `[RISK ACCEPTED #${id}] Applied ${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(proposal.rationale).join("; ")}`,
    tags: ["risk_change", "config_change", "accepted"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });

  save(data);
  log("evolve", `Risk proposal #${id} accepted: ${JSON.stringify(applied)}`);
  return { success: true, applied };
}

/**
 * Reject a pending proposal — leaves config untouched.
 */
export function rejectRiskProposal(id) {
  const data = load();
  data.risk_proposals = Array.isArray(data.risk_proposals) ? data.risk_proposals : [];
  const proposal = data.risk_proposals.find((rp) => rp.id === id);
  if (!proposal) return { success: false, error: "proposal not found" };
  if (proposal.status !== "pending") {
    return { success: false, error: `proposal already ${proposal.status}` };
  }
  proposal.status = "rejected";
  proposal.rejected_at = new Date().toISOString();
  save(data);
  log("evolve", `Risk proposal #${id} rejected`);
  return { success: true };
}

// Test helper — never call from production code
export function _resetRiskProposalsForTesting() {
  const data = load();
  data.risk_proposals = [];
  save(data);
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const safeRule = sanitizeLessonText(rule);
  if (!safeRule) return;
  const data = load();
  const lesson = {
    id: Date.now(),
    rule: safeRule,
    tags,
    outcome: "manual",
    sourceType: tags.includes("self_tune") || tags.includes("config_change") ? "config_change" : "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  };
  data.lessons.push(lesson);
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`);
  void pushHiveLesson(lesson);
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  let lessons = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

/**
 * Remove a lesson by ID.
 */
export function removeLesson(id) {
  const data = load();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter((l) => l.id !== id);
  save(data);
  return before - data.lessons.length;
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

// ─── Tier 1: Lesson Scoring & Selection ─────────────────────────
// Composite-score-based lesson ranking so the prompt budget surfaces
// the most informative, recent, and frequent patterns instead of just
// "most recent". Pinned lessons bypass scoring (operator override).

const LESSON_HALF_LIFE_DAYS = 14;     // recency decay half-life
const LESSON_MAX_AGE_DAYS   = 60;     // sunset cutoff (non-pinned)
const LESSON_MIN_SCORE      = 0.05;   // injection floor (non-pinned)
const EXPLORATION_DISCOUNT  = 0.6;    // exploration lessons are noisier

const OUTCOME_WEIGHTS = {
  bad: 1.0, failed: 1.0,
  poor: 0.7,
  good: 0.6, worked: 0.6,
  evolution: 0.5,
  manual: 0.4,
  neutral: 0.0,
};

function lessonAgeDays(lesson, now = Date.now()) {
  if (!lesson?.created_at) return 0;
  const t = new Date(lesson.created_at).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now - t) / (24 * 60 * 60 * 1000));
}

function outcomeWeight(outcome) {
  return OUTCOME_WEIGHTS[outcome] ?? 0.3;
}

function magnitudeBoost(lesson) {
  const pnl = Math.abs(Number(lesson?.pnl_pct) || 0);
  // 1.0 base + up to +1.5 bonus for large magnitude (clamped at 30%)
  return 1 + Math.min(pnl / 20, 1.5);
}

function recencyDecay(ageDays, halfLife = LESSON_HALF_LIFE_DAYS) {
  return Math.exp(-ageDays * Math.LN2 / halfLife);
}

function frequencyBoost(count) {
  return 1 + Math.log2(Math.max(1, count));
}

function isExplorationLesson(lesson) {
  if (!lesson) return false;
  if (lesson.exploration === true) return true;
  return Array.isArray(lesson.tags) && lesson.tags.includes("exploration");
}

/** Normalize rule for similarity grouping: lowercase, strip numbers, collapse spaces. */
function normalizeRuleHash(rule) {
  if (!rule) return "";
  return String(rule)
    .toLowerCase()
    .replace(/[0-9]+(\.[0-9]+)?/g, "#")
    .replace(/[^a-z#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function lessonGroupKey(lesson) {
  const outcome    = lesson.outcome || "x";
  const primaryTag = (lesson.tags || [])[0] || "x";
  return `${outcome}|${primaryTag}|${normalizeRuleHash(lesson.rule)}`;
}

/** Group lessons that look like the same insight repeated. */
export function groupSimilarLessons(lessons) {
  const groups = new Map();
  for (const lesson of lessons) {
    const key = lessonGroupKey(lesson);
    let group = groups.get(key);
    if (!group) {
      group = { key, members: [], count: 0 };
      groups.set(key, group);
    }
    group.members.push(lesson);
    group.count++;
  }
  return Array.from(groups.values());
}

/** Composite score: outcome × confidence × magnitude × recency × frequency × exploration. */
export function scoreLesson(lesson, count = 1, now = Date.now()) {
  const age      = lessonAgeDays(lesson, now);
  const baseConf = Number.isFinite(Number(lesson?.confidence)) ? Number(lesson.confidence) : 0.4;
  const score =
    outcomeWeight(lesson?.outcome) *
    baseConf *
    magnitudeBoost(lesson) *
    recencyDecay(age) *
    frequencyBoost(count) *
    (isExplorationLesson(lesson) ? EXPLORATION_DISCOUNT : 1.0);
  return Math.round(score * 1000) / 1000;
}

/**
 * Select top-N lessons by composite score with sunset + dedup applied.
 * Pinned lessons bypass sunset and the min-score floor.
 *
 * @param {Array}  lessons     - candidate lessons (post-filter)
 * @param {number} limit       - max representatives to return
 * @param {Object} [opts]
 * @param {number} [opts.now]                     - clock override for tests
 * @param {number} [opts.maxAgeDays]              - override sunset cutoff
 * @param {number} [opts.minScore]                - override score floor
 * @returns {Array} representatives with _score and _seen attached
 */
export function selectTopLessons(lessons, limit, opts = {}) {
  const {
    now = Date.now(),
    maxAgeDays = LESSON_MAX_AGE_DAYS,
    minScore   = LESSON_MIN_SCORE,
  } = opts;
  if (!Array.isArray(lessons) || !lessons.length || limit <= 0) return [];

  // 1. Sunset stale (non-pinned)
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const fresh  = lessons.filter((l) => {
    if (l.pinned) return true;
    if (!l.created_at) return true;
    return new Date(l.created_at).getTime() >= cutoff;
  });

  // 2. Group similar
  const groups = groupSimilarLessons(fresh);

  // 3. Score each group, pick best representative; track all member ids
  //    so callers can dedup across tiers without leaking duplicates.
  const scored = groups.map((g) => {
    let best = null;
    let bestScore = -Infinity;
    for (const member of g.members) {
      const s = scoreLesson(member, g.count, now);
      if (s > bestScore) {
        bestScore = s;
        best = member;
      }
    }
    return {
      lesson: best,
      score: bestScore,
      seen: g.count,
      memberIds: g.members.map((m) => m.id).filter((id) => id != null),
    };
  });

  // 4. Min score floor (non-pinned)
  const passed = scored.filter((s) => s.lesson.pinned || s.score >= minScore);

  // 5. Sort: pinned first, then by score desc
  passed.sort((a, b) => {
    if (!!b.lesson.pinned !== !!a.lesson.pinned) return b.lesson.pinned ? 1 : -1;
    return b.score - a.score;
  });

  return passed.slice(0, limit).map((t) => ({
    ...t.lesson,
    _score: t.score,
    _seen: t.seen,
    _memberIds: t.memberIds,
  }));
}

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export function getLessonsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const data = load();
  if (data.lessons.length === 0) return null;

  // Smaller caps for automated cycles — they don't need the full lesson history
  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP  = isAutoCycle ? 5  : 10;
  const ROLE_CAP    = isAutoCycle ? 6  : 15;
  const RECENT_CAP  = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = data.lessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  // Score-ranked: composite (outcome × confidence × magnitude × recency ×
  // frequency × exploration discount). Sunsets >60d, dedupes similar rules.
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleCandidates = data.lessons.filter((l) => {
    if (usedIds.has(l.id)) return false;
    const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
    const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
    return roleOk && tagOk;
  });
  const roleMatched = selectTopLessons(roleCandidates, ROLE_CAP);

  roleMatched.forEach((l) => {
    usedIds.add(l.id);
    (l._memberIds || []).forEach((id) => usedIds.add(id));
  });

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  // Same score-ranked selection; usedIds excludes Tier 1+2 lessons AND
  // their group members so we never re-surface a duplicate insight.
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recentCandidates = data.lessons.filter((l) => !usedIds.has(l.id));
  const recent = remainingBudget > 0
    ? selectTopLessons(recentCandidates, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  const shared = getSharedLessonsForPrompt({
    agentType,
    maxLessons: isAutoCycle ? 4 : 6,
  });
  if (selected.length === 0 && !shared) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));
  if (shared)             sections.push(`── HIVEMIND ──\n${shared}`);

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    const seen = (l._seen && l._seen > 1) ? ` (seen ${l._seen}×)` : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}${seen}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

/**
 * Categorize a close_reason string into a short category label so summaries
 * can attribute PnL to the actual exit driver. Centralised so callers
 * (briefing, MANAGER prompt, performance tools) all use identical buckets.
 */
export function categorizeCloseReason(closeReason) {
  const r = String(closeReason || "").toLowerCase();
  if (!r) return "unknown";
  if (r.includes("stop loss")) return "stop_loss";
  if (r.includes("trailing") && r.includes("low yield")) return "trailing_lowyield";
  if (r.includes("trailing")) return "trailing_drop";
  if (r.includes("take profit")) return "take_profit";
  if (r.includes("oor") || r.includes("pumped") || r.includes("out of range") || r.includes("range")) return "oor";
  if (r.includes("low yield")) return "low_yield";
  if (r.includes("realtime")) return "oor";
  if (r.includes("emergency")) return "stop_loss";
  return "other";
}

/** Numeric value with NaN/null guard. */
function num(x, fallback = 0) {
  return Number.isFinite(x) ? x : fallback;
}

/**
 * Get performance stats summary.
 *
 * @param {Object} [opts]
 * @param {number} [opts.windowDays] — only include records from the last N days. Omit for all-time.
 * @param {number} [opts.maxRecords] — only include the most recent N records. Omit for all.
 */
export function getPerformanceSummary(opts = {}) {
  const { windowDays = null, maxRecords = null } = opts;
  const data = load();
  let p = data.performance;

  if (windowDays != null && Number.isFinite(windowDays) && windowDays > 0) {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    p = p.filter((r) => (r.recorded_at || "") >= cutoff);
  }
  if (maxRecords != null && Number.isFinite(maxRecords) && maxRecords > 0) {
    p = p.slice(-maxRecords);
  }

  if (p.length === 0) return null;

  // NaN-safe aggregates — guard each numeric field so a single null
  // performance record can't pollute the whole summary.
  const totalPnlUsd = p.reduce((s, x) => s + num(x.pnl_usd), 0);
  const totalPnlPct = p.reduce((s, x) => s + num(x.pnl_pct), 0);
  const avgPnlPct   = totalPnlPct / p.length;
  const avgRangeEff = p.reduce((s, x) => s + num(x.range_efficiency), 0) / p.length;

  const winners = p.filter((x) => num(x.pnl_pct) > 0);
  const losers  = p.filter((x) => num(x.pnl_pct) < 0);
  const flat    = p.filter((x) => num(x.pnl_pct) === 0);

  const avgWinnerPnl = winners.length > 0
    ? winners.reduce((s, x) => s + num(x.pnl_pct), 0) / winners.length
    : 0;
  const avgLoserPnl = losers.length > 0
    ? losers.reduce((s, x) => s + num(x.pnl_pct), 0) / losers.length
    : 0;

  // Per close-reason breakdown — shows which exit drivers contribute the
  // most aggregate PnL (positive or negative). High-leverage signal for
  // the agent: it can see e.g. "stop_loss is bleeding -16% across 4 pos"
  // and weight subsequent decisions accordingly.
  const byReason = new Map();
  for (const x of p) {
    const cat = categorizeCloseReason(x.close_reason);
    const e = byReason.get(cat) || { count: 0, sum_pnl_pct: 0, sum_fees_usd: 0 };
    e.count += 1;
    e.sum_pnl_pct += num(x.pnl_pct);
    e.sum_fees_usd += num(x.fees_earned_usd);
    byReason.set(cat, e);
  }
  const by_close_reason = {};
  for (const [cat, e] of byReason) {
    by_close_reason[cat] = {
      count: e.count,
      sum_pnl_pct: Math.round(e.sum_pnl_pct * 100) / 100,
      avg_pnl_pct: Math.round((e.sum_pnl_pct / e.count) * 100) / 100,
      sum_fees_usd: Math.round(e.sum_fees_usd * 100) / 100,
    };
  }

  // Bucket by exploration flag so we can empirically check whether
  // exploration cycles are pulling in profitable pools that the normal
  // (Darwin-weighted) cycles would have rejected. Skipped entirely
  // until we have at least one exploration record.
  const explorationRecords = p.filter((x) => x.exploration === true);
  const normalRecords = p.filter((x) => x.exploration !== true);
  function bucketStats(records) {
    if (records.length === 0) return null;
    const wins = records.filter((x) => num(x.pnl_pct) > 0);
    const sumPct = records.reduce((s, x) => s + num(x.pnl_pct), 0);
    return {
      count:        records.length,
      win_rate_pct: Math.round((wins.length / records.length) * 100),
      avg_pnl_pct:  Math.round((sumPct / records.length) * 100) / 100,
      total_pnl_pct: Math.round(sumPct * 100) / 100,
    };
  }
  const by_exploration = explorationRecords.length > 0
    ? { exploration: bucketStats(explorationRecords), normal: bucketStats(normalRecords) }
    : null;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnlUsd * 100) / 100,
    total_pnl_pct: Math.round(totalPnlPct * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEff * 10) / 10,
    win_rate_pct: Math.round((winners.length / p.length) * 100),
    winners: winners.length,
    losers: losers.length,
    flat: flat.length,
    avg_winner_pnl_pct: Math.round(avgWinnerPnl * 100) / 100,
    avg_loser_pnl_pct: Math.round(avgLoserPnl * 100) / 100,
    by_close_reason,
    by_exploration,
    window_days: windowDays ?? null,
    total_lessons: data.lessons.length,
  };
}

/**
 * Generate concrete post-mortem suggestions from closed-position data.
 * These are diagnostic hints — NOT auto-applied — meant to surface in
 * agent prompts and operator-facing reports so a human can act on them.
 *
 * Each suggestion is shaped as:
 *   { severity: "high" | "medium" | "low",
 *     area: <stop_loss | oor | take_profit | low_yield | strategy | screening>,
 *     summary: <short headline>,
 *     detail: <longer explanation grounded in actual numbers>,
 *     action_hint: <suggested next step the operator can take> }
 *
 * Returns null when there is not enough data (< 5 closed positions) since
 * suggestions on tiny samples are noise. Caller should null-check.
 *
 * @param {Object} [opts]
 * @param {number} [opts.windowDays] — only consider records from the last N days
 * @param {Object} [opts.mgmtConfig] — live management config (for TP/SL refs)
 */
export function getPostMortemSuggestions(opts = {}) {
  const { windowDays = null, mgmtConfig = null } = opts;
  const summary = getPerformanceSummary({ windowDays });
  if (!summary || summary.total_positions_closed < 5) return null;

  const suggestions = [];
  const byReason = summary.by_close_reason || {};

  // ── 1. Stop loss bleeding ─────────────────────────────────────
  const sl = byReason.stop_loss;
  if (sl && sl.count >= 2 && sl.sum_pnl_pct < 0) {
    const tpSum = byReason.take_profit?.sum_pnl_pct || 0;
    const wipesTp = tpSum > 0 && Math.abs(sl.sum_pnl_pct) >= tpSum * 0.7;
    suggestions.push({
      severity: wipesTp ? "high" : "medium",
      area: "stop_loss",
      summary: `Stop loss bleeding ${sl.sum_pnl_pct.toFixed(2)}% across ${sl.count} positions (avg ${sl.avg_pnl_pct.toFixed(2)}%)`,
      detail: wipesTp
        ? `Take-profit gains (+${tpSum.toFixed(2)}%) are nearly cancelled by stop-loss losses. The asymmetric R/R (TP=${mgmtConfig?.takeProfitPct ?? "?"}, SL=${mgmtConfig?.stopLossPct ?? "?"}) requires a high win-rate to net profit; current win rate is ${summary.win_rate_pct}%.`
        : `${sl.count} stop-loss exits are dragging on aggregate PnL. Look for common patterns (high volatility, low organic, specific strategies) in the losers.`,
      action_hint: wipesTp
        ? "Tighten screening filters (lower maxVolatility, raise minOrganic) OR adjust R/R toward symmetric (e.g. TP=5/SL=-5). Review losers via get_performance_history."
        : "Review stop_loss positions in get_performance_history and look for shared traits (volatility, bin_step, strategy).",
    });
  }

  // ── 2. OOR fast exits with low fee yield ──────────────────────
  const oor = byReason.oor;
  if (oor && oor.count >= summary.total_positions_closed * 0.3) {
    const oorPct = Math.round((oor.count / summary.total_positions_closed) * 100);
    const avgFeeYield = oor.count > 0
      ? Math.round((oor.sum_fees_usd / oor.count) * 100) / 100
      : 0;
    suggestions.push({
      severity: oor.avg_pnl_pct < 0.5 ? "medium" : "low",
      area: "oor",
      summary: `${oorPct}% of closes are OOR-driven (${oor.count}/${summary.total_positions_closed}, avg PnL ${oor.avg_pnl_pct.toFixed(2)}%, avg fees $${avgFeeYield})`,
      detail: `OOR exits dominate the close-reason distribution and average near-zero PnL — positions are leaving range before fees can accumulate. Likely deploys are landing into pools that are already pumping.`,
      action_hint: "Tighten screening: add minTokenAgeHours, raise minHolders, lower maxVolatility. Consider widening bins_below for high-volatility setups so positions stay in range longer.",
    });
  }

  // ── 3. Take profit working but few hits ───────────────────────
  const tp = byReason.take_profit;
  if (tp && tp.count >= 1 && tp.avg_pnl_pct > 0 && tp.count < summary.total_positions_closed * 0.15) {
    suggestions.push({
      severity: "low",
      area: "take_profit",
      summary: `Take-profit hits only ${tp.count}/${summary.total_positions_closed} positions (${Math.round((tp.count / summary.total_positions_closed) * 100)}%) — your only consistent profit driver`,
      detail: `When TP fires it averages +${tp.avg_pnl_pct.toFixed(2)}%, but it only fires on a small fraction of positions. Most positions exit via OOR or trailing before reaching TP.`,
      action_hint: `Consider lowering takeProfitPct slightly (e.g. ${mgmtConfig?.takeProfitPct != null ? Math.max(2, mgmtConfig.takeProfitPct - 1) : 3}) so more positions clear the TP bar, or tighten trailing TP (lower trailingTriggerPct) to lock in mid-range gains.`,
    });
  }

  // ── 4. Trailing TP rarely fires ───────────────────────────────
  const trail = (byReason.trailing_drop?.count || 0) + (byReason.trailing_lowyield?.count || 0);
  if (trail === 0 && summary.total_positions_closed >= 10) {
    suggestions.push({
      severity: "low",
      area: "strategy",
      summary: "Trailing take-profit never fired in the dataset",
      detail: "Either the trailingTriggerPct is too high for actual position trajectories, or trailing TP is disabled. With current data the bot relies almost entirely on TP/SL/OOR for exits.",
      action_hint: "Consider lowering trailingTriggerPct to capture mid-range winners that don't reach full TP.",
    });
  }

  // ── 5. Low yield exits — positions going stale ────────────────
  const ly = byReason.low_yield;
  if (ly && ly.count >= 3 && ly.avg_pnl_pct < 1) {
    suggestions.push({
      severity: "low",
      area: "low_yield",
      summary: `${ly.count} low-yield exits averaging ${ly.avg_pnl_pct.toFixed(2)}%`,
      detail: "Bot held positions long enough to hit the low-yield exit, suggesting pool fees collapsed or never accumulated.",
      action_hint: "Tighten minFeeActiveTvlRatio or raise minFeePerTvl24h so the screener filters out pools that don't sustain fees.",
    });
  }

  // ── 6. Win rate sanity check ──────────────────────────────────
  if (summary.win_rate_pct < 50 && summary.total_positions_closed >= 10) {
    const expectedWinRateForBreakeven = mgmtConfig?.takeProfitPct && mgmtConfig?.stopLossPct
      ? Math.round((Math.abs(mgmtConfig.stopLossPct) / (mgmtConfig.takeProfitPct + Math.abs(mgmtConfig.stopLossPct))) * 100)
      : null;
    suggestions.push({
      severity: "medium",
      area: "screening",
      summary: `Win rate ${summary.win_rate_pct}% — losers outnumber winners (${summary.losers} vs ${summary.winners})`,
      detail: expectedWinRateForBreakeven != null
        ? `With TP=${mgmtConfig.takeProfitPct} and SL=${mgmtConfig.stopLossPct}, breakeven needs ~${expectedWinRateForBreakeven}% win rate. Current ${summary.win_rate_pct}% is below that.`
        : "Sub-50% win rate across the sample. Screening signals may need tightening.",
      action_hint: "Raise minOrganic / minHolders / minVolume in screening; review evolveThresholds output for already-suggested adjustments.",
    });
  }

  if (suggestions.length === 0) return null;

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays ?? null,
    sample_size: summary.total_positions_closed,
    summary: {
      total_pnl_pct: summary.total_pnl_pct,
      win_rate_pct: summary.win_rate_pct,
      by_close_reason: summary.by_close_reason,
    },
    suggestions: suggestions.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
    }),
  };
}
