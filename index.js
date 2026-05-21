import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { formatGmgnCandidateForPrompt } from "./tools/gmgn.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import {
  evolveThresholds,
  getPerformanceSummary,
  getPerformanceHistory,
  listLessons,
  getPostMortemSuggestions,
  getPendingRiskProposals,
  acceptRiskProposal,
  rejectRiskProposal,
} from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  deleteMessage,
  answerCallbackQuery,
  notifyOutOfRange,
  notifyClose,
  isEnabled as telegramEnabled,
  isMuted as telegramMuted,
  createLiveMessage,
} from "./telegram.js";
import { generateBriefing, buildPnlCalendarFromDisk } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, setPositionExploration, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recordPositionSnapshots, recallForPool, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { getTwitterSentiment } from "./tools/twitter.js";
import { stageSignals, computeHiveConsensus } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, getSharedLessons, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision, getDecisionsByPosition, getValidationTrendSummary } from "./decision-log.js";
import {
  stripThink,
  sanitizeUntrustedPromptText,
  nextRunIn,
  formatCountdown,
  fmtPct,
  formatCandidates,
  buildGmgnFunnelReport,
  computeBinsBelow,
  formatWalletStatus,
  formatConfigSnapshot,
  formatHelpText,
} from "./src/format.js";
import { getDeterministicCloseRule } from "./src/deterministic.js";
import {
  initRealtimeWatcher,
  reconcileWatchers,
  shutdownRealtimeWatcher,
  getWatcherStats,
} from "./src/realtime-watcher.js";
import {
  isScreeningPaused as isScreeningPausedByBreaker,
  getStatus as getBreakerStatus,
  resume as resumeBreaker,
} from "./src/circuit-breaker.js";
import {
  generateDigest as generateCoachingDigest,
  setPendingProposal as setPendingCoachingProposal,
  approvePendingProposal as approvePendingCoachingProposal,
  rejectPendingProposal as rejectPendingCoachingProposal,
  rollbackMemo as rollbackCoachingMemo,
  getActiveMemos as getActiveCoachingMemos,
  getPendingProposal as getPendingCoachingProposal,
} from "./src/coaching.js";
import { proposeMemoFromDigest } from "./src/coaching-llm.js";
import {
  getLeaderboard as getLpersLeaderboard,
  promoteLper,
  rejectLper,
  getStats as getLpersStats,
  getLperRecord,
} from "./src/top-lpers.js";
import { selectTopLessons } from "./lessons.js";
import { getConnection } from "./rpc.js";
import { PublicKey } from "@solana/web3.js";

// Meteora DLMM program id — used for on-chain ownership checks to guard
// against racing closePosition calls after a position has already been
// closed (which leaves the account owned by the System Program).
const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
ensureAgentId();
bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
startHiveMindBackgroundSync();

const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

// BUG-19 (Audit 5/21): coalesce concurrent confirmation fetches.
// During pump moments multiple peak/trailing-drop timers can fire within
// the same second, each independently calling getMyPositions({force:true})
// → 5+ Meteora/Helius requests at once → rate-limit + partial results
// (which then triggers BUG-1's syncOpenPositions false-close path).
// Single-flight coalescer keeps cache fresh ≤2s and shares one inflight
// fetch across all confirm callers.
let _confirmFetchInflight = null;
let _confirmFetchAt = 0;
const CONFIRM_FETCH_TTL_MS = 2_000;
async function getCoalescedPositionsForConfirm() {
  if (Date.now() - _confirmFetchAt < CONFIRM_FETCH_TTL_MS && !_confirmFetchInflight) {
    // Recent fetch is fresh enough — let getMyPositions's own cache return it
    return getMyPositions({ silent: true }).catch((err) => { log("silent_warn", err.message); return null; });
  }
  if (_confirmFetchInflight) return _confirmFetchInflight;
  _confirmFetchInflight = (async () => {
    try {
      return await getMyPositions({ force: true, silent: true });
    } catch (err) {
      log("silent_warn", err.message);
      return null;
    } finally {
      _confirmFetchAt = Date.now();
      _confirmFetchInflight = null;
    }
  })();
  return _confirmFetchInflight;
}

function shouldUsePnlRecheck() {
  return !config.api.lpAgentRelayEnabled;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getCoalescedPositionsForConfirm();
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getCoalescedPositionsForConfirm();
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled() && !telegramMuted("cycle")) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch((err) => { log("silent_warn", err.message); return null; });
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // BUG-44 (Audit 5/21): batch snapshots into one disk write per cycle
    // instead of N writes (one per position). Cuts pool-memory.json file
    // growth and removes a race window with recordPoolDeploy.
    const snapshotEntries = positions.map((p) => ({ poolAddress: p.pool, snapshot: p }));
    recordPositionSnapshots(snapshotEntries);
    const positionData = positions.map((p) => ({ ...p, recall: recallForPool(p.pool) }));

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (
        !p.pnl_pct_suspicious &&
        queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
        shouldUsePnlRecheck()
      ) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
          // Use the position-specific (potentially adaptive) drop threshold
          // surfaced by updatePnlAndCheckExits; falls back to base config.
          const dropPctForQueue = exit.effective_drop_pct ?? config.management.trailingDropPct;
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, dropPctForQueue)) {
            scheduleTrailingDropConfirmation(p.position);
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = actionPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch((err) => { log("silent_warn", err.message); return null; });
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    drainTelegramQueue().catch((err) => log("silent_warn", err.message));
    if (!silent && telegramEnabled()) {
      if (mgmtReport && !telegramMuted("cycle")) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch((err) => log("silent_warn", err.message));
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch((err) => log("silent_warn", err.message));
      } else if (mgmtReport) {
        log("telegram_mute", `Suppressed cycle report — management: ${stripThink(mgmtReport).slice(0, 120)}…`);
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch((err) => log("silent_warn", err.message));
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  // Exploration mode: a fraction of cycles bypass Darwin weights + relax
  // thresholds so the bot keeps probing pools just outside its learned
  // comfort zone. Decided after pre-checks; readable from the finally
  // block so we can tag any newly-deployed positions accordingly.
  let explorationMode = false;
  let prePositionAddrs = new Set();
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      _screeningBusy = false;
      drainTelegramQueue().catch((err) => log("silent_warn", err.message));
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      _screeningBusy = false;
      drainTelegramQueue().catch((err) => log("silent_warn", err.message));
      return screenReport;
    }
    // Drawdown circuit breaker — auto-pauses screening after a losing streak
    // or after the rolling 24h SOL PnL trips the configured cap. Management
    // cycles still run; only new deploys are blocked. isScreeningPaused()
    // also performs auto-resume when the cooldown has elapsed.
    if (isScreeningPausedByBreaker()) {
      const bs = getBreakerStatus();
      const reasonLine = `${bs.reason || "drawdown"} (resumes ${bs.willResumeAt || "after cooldown"})`;
      log("cron", `Screening skipped — circuit breaker active: ${reasonLine}`);
      screenReport = `Screening skipped — circuit breaker active: ${reasonLine}.`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Circuit breaker: ${bs.reason}`,
      });
      _screeningBusy = false;
      drainTelegramQueue().catch((err) => log("silent_warn", err.message));
      return screenReport;
    }
    // Capture pre-cycle position addresses so we can identify which
    // positions were newly deployed during this cycle (for exploration tagging).
    prePositionAddrs = new Set((prePositions.positions || []).map((p) => p.position));
    // Decide exploration mode for this cycle. Math.random is called once
    // per cycle so behavior is deterministic within the cycle.
    const explorationRate = Number.isFinite(config.darwin?.explorationRate)
      ? Math.max(0, Math.min(1, config.darwin.explorationRate))
      : 0;
    explorationMode = explorationRate > 0 && Math.random() < explorationRate;
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    drainTelegramQueue().catch((err) => log("silent_warn", err.message));
    return screenReport;
  }
  if (!silent && telegramEnabled() && !telegramMuted("cycle")) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use strategy=${config.strategy.strategy}, bins_above=0, SOL only.`;

    // Build relaxed threshold overrides when in exploration mode so the
    // candidate fetch returns pools just outside the normal comfort zone.
    let screeningOverrides = null;
    if (explorationMode) {
      const m = config.darwin?.explorationMultipliers || {};
      const cur = config.screening;
      screeningOverrides = {
        maxVolatility: Number.isFinite(m.maxVolatility) ? cur.maxVolatility * m.maxVolatility : cur.maxVolatility,
        minOrganic:    Number.isFinite(m.minOrganicDelta) ? Math.max(0, cur.minOrganic + m.minOrganicDelta) : cur.minOrganic,
      };
      log("cron", `🔍 EXPLORATION MODE — relaxed thresholds: maxVolatility ${cur.maxVolatility}→${screeningOverrides.maxVolatility}, minOrganic ${cur.minOrganic}→${screeningOverrides.minOrganic}`);
    }
    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10, screeningOverrides, explorationMode }).catch((e) => ({ _error: e.message }));
    if (topCandidates?._error) {
      screenReport = `Screening failed: ${topCandidates._error}`;
      return screenReport;
    }
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];
    const gmgnStageCounts = topCandidates?.stage_counts ?? null;
    const gmgnAllFiltered = topCandidates?.all_filtered ?? [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo, twitterData] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
        pool.base?.symbol ? getTwitterSentiment({ symbol: pool.base.symbol, mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        tw: twitterData.status === "fulfilled" ? twitterData.value : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    // Skipped for GMGN: platforms already filtered upstream; bundler/bot data from GMGN pipeline
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      if (pool.gmgn) return true;
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 5)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      const thresholds = `Thresholds: tvl>$${config.screening.minTvl} | vol>$${config.screening.minVolume} | organic>${config.screening.minOrganic}% | holders>${config.screening.minHolders} | fee/tvl>${config.screening.minFeeActiveTvlRatio}%`;
      screenReport = funnelBlock
        ? `No candidates available.\n\n${funnelBlock}`
        : combinedExamples
          ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
          : `No candidates available (all filtered).\n${thresholds}`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: funnelBlock || combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length <= 1 && gmgnStageCounts) {
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      if (funnelBlock) log("screening", `GMGN funnel (sparse):\n${funnelBlock}`);
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Snapshot the shared HiveMind lessons once per cycle so each candidate
    // can compute its hive_consensus boolean without re-reading the cache.
    // Empty array (not null) when Darwin is off or HiveMind has no lessons,
    // so computeHiveConsensus() short-circuits to false cleanly.
    const sharedHiveLessons = config.darwin?.enabled
      ? getSharedLessons({ agentType: "SCREENER", maxLessons: 50 })
      : [];

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, tw, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      // OKX signals
      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;
      let block;
      if (pool.gmgn) {
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          formatGmgnCandidateForPrompt(pool),
          pvpLine,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          tw?.summary ? `  twitter_untrusted: ${sanitizeUntrustedPromptText(tw.summary, 300)}` : `  twitter: no data`,
          tw?.buzz_level ? `  twitter_buzz: ${tw.buzz_level} (${tw.tweet_count_24h} tweets, ${tw.kol_mentions} KOLs, sentiment=${tw.sentiment})` : null,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      } else {
        const gmgnPriceLine = pool.gmgn_price_action
          ? `  gmgn_price: rsi2=${pool.gmgn_price_action.rsi2 ?? "?"}, supertrend=${pool.gmgn_price_action.supertrend?.direction || "?"}, price_vs_ath=${pool.gmgn_price_action.priceVsAthPct ?? "?"}%, 1h_change=${pool.gmgn_price_action.priceChangePct ?? "?"}%, max_vol_candle=${pool.gmgn_price_action.maxVolumeShare ?? "?"}%`
          : null;
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
          `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
          gmgnPriceLine,
          pvpLine,
          okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
          okxTags  ? `  tags: ${okxTags}` : null,
          pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          tw?.summary ? `  twitter_untrusted: ${sanitizeUntrustedPromptText(tw.summary, 300)}` : `  twitter: no data`,
          tw?.buzz_level ? `  twitter_buzz: ${tw.buzz_level} (${tw.tweet_count_24h} tweets, ${tw.kol_mentions} KOLs, sentiment=${tw.sentiment})` : null,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      }

      // Stage signals for Darwinian weighting — captured before LLM decides.
      // study_win_rate is enriched later in dlmm.deployPosition() (after the
      // executor's hard guard ensures the study cache is warm); hive_consensus
      // is computed here from the always-warm hivemind shared-lessons cache.
      if (config.darwin?.enabled) {
        stageSignals(pool.pool, {
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
          twitter_sentiment:     tw?.sentiment              ?? null,
          hive_consensus:        computeHiveConsensus(pool.name, sharedHiveLessons),
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    const explorationBanner = explorationMode
      ? `\n🔍 EXPLORATION CYCLE — thresholds relaxed; treat learned Darwin weights as advisory only and prioritize candidates that look promising on first principles even if they sit outside the usual comfort zone.\n`
      : "";
    
    // Log exploration mode for GMGN path specifically
    if (explorationMode && config.screening.source === "gmgn") {
      log("cron", `🔍 GMGN EXPLORATION MODE — using relaxed thresholds from gmgn-config.json exploration section`);
    }
    const { content } = await agentLoop(`
SCREENING CYCLE${explorationBanner}
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
2. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   strategy = ${config.strategy.strategy} (always use this, never change it).
   bins_below = round(${config.strategy.minBinsBelow} + (volatility/5)*${config.strategy.maxBinsBelow - config.strategy.minBinsBelow}) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].
   bins_above = 0. Single-side SOL only: set amount_y, keep amount_x = 0.
3. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
4. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });
    const funnelAppend = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
    screenReport = funnelAppend ? `${content}\n\n─────────────\n${funnelAppend}` : content;
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    drainTelegramQueue().catch((err) => log("silent_warn", err.message));
    // Tag any positions deployed during this cycle with the exploration
    // flag so getPerformanceSummary can bucket exploration vs normal
    // outcomes. Best-effort — failures here must not break the cycle.
    try {
      const post = await getMyPositions({ force: true });
      const newAddrs = (post.positions || [])
        .map((p) => p.position)
        .filter((addr) => addr && !prePositionAddrs.has(addr));
      for (const addr of newAddrs) {
        setPositionExploration(addr, explorationMode);
      }
      if (newAddrs.length > 0) {
        log("cron", `Tagged ${newAddrs.length} new position(s) exploration=${explorationMode}`);
      }
    } catch (err) {
      log("silent_warn", `Exploration tagging failed: ${err.message}`);
    }
    if (!silent && telegramEnabled()) {
      if (screenReport && !telegramMuted("cycle")) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch((err) => log("silent_warn", err.message));
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch((err) => log("silent_warn", err.message));
      } else if (screenReport) {
        log("telegram_mute", `Suppressed cycle report — screening: ${stripThink(screenReport).slice(0, 120)}…`);
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
      drainTelegramQueue().catch((err) => log("silent_warn", err.message));
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch((err) => { log("silent_warn", err.message); return null; });
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        if (
          !p.pnl_pct_suspicious &&
          queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
          shouldUsePnlRecheck()
        ) {
          schedulePeakConfirmation(p.position);
        }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
            const dropPctForQueue = exit.effective_drop_pct ?? config.management.trailingDropPct;
            if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, dropPctForQueue)) {
              scheduleTrailingDropConfirmation(p.position);
            }
            continue;
          }
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
        const closeRule = getDeterministicCloseRule(p, config.management);
        if (closeRule) {
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);

  // ── Realtime WS watcher (opt-in via management.realtimeMonitoring) ──
  if (config.management?.realtimeMonitoring) {
    initRealtimeWatcher({
      connection: getConnection(),
      getActiveBin,
      enabled: true,
      debounceMs: config.management.realtimeRefetchDebounceMs ?? 3000,
      oorThrottleMs: (config.management.realtimeOorThrottleSec ?? 60) * 1000,
      onOor: handleRealtimeOor,
    });
    // Reconcile against currently open positions so we re-subscribe
    // after process restart.
    getMyPositions({ force: true, silent: true })
      .then((res) => reconcileWatchers(res?.positions || []))
      .then(() => {
        const stats = getWatcherStats();
        log("realtime", `Reconciled — watching ${stats.positions} position(s) across ${stats.pools} pool(s)`);
      })
      .catch((err) => log("realtime_warn", `Initial reconcile failed: ${err.message}`));
  } else {
    log("realtime", "Realtime monitoring disabled (set management.realtimeMonitoring=true to enable)");
  }
}

// Throttle map: positionAddress -> lastCloseAttemptMs
const _realtimeCloseAttempts = new Map();

async function handleRealtimeOor({ positionAddress, poolAddress, activeBin, lower, upper, minutesOOR }) {
  // Avoid double-firing close while a previous attempt is in-flight.
  const last = _realtimeCloseAttempts.get(positionAddress) || 0;
  if (Date.now() - last < 90_000) return;

  // Re-fetch positions to get fresh PnL/fee data for deterministic rule eval.
  const fresh = await getMyPositions({ force: true, silent: true }).catch((err) => { log("silent_warn", err.message); return null; });
  const pos = fresh?.positions?.find((p) => p.position === positionAddress);
  if (!pos) return; // Already closed by another path.

  const rule = getDeterministicCloseRule(pos, config.management);
  if (!rule || rule.action !== "CLOSE") {
    // Not yet eligible — likely waiting for outOfRangeWaitMinutes to elapse.
    // The next WS event (or polling cycle) will re-evaluate.
    return;
  }

  // Guard against race with management cron: a parallel close may have already
  // closed this position on-chain. In that case the account gets rent-reclaimed
  // and becomes owned by the System Program — any further closePosition call
  // will fail tx simulation with AnchorError 3007 (AccountOwnedByWrongProgram).
  try {
    const accInfo = await getConnection().getAccountInfo(new PublicKey(positionAddress), "confirmed");
    if (!accInfo || accInfo.owner.toString() !== DLMM_PROGRAM_ID) {
      log("realtime", `Position ${positionAddress.slice(0, 8)} already closed on-chain — skipping`);
      return;
    }
  } catch (err) {
    // Non-fatal: if ownership check fails, proceed and rely on the safety catch below.
    log("realtime_warn", `Ownership check failed for ${positionAddress.slice(0, 8)}: ${err.message}`);
  }

  _realtimeCloseAttempts.set(positionAddress, Date.now());
  log(
    "realtime",
    `Fast-close ${positionAddress.slice(0, 8)} pool=${poolAddress.slice(0, 8)} reason=${rule.reason} active=${activeBin} range=[${lower},${upper}]`,
  );
  try {
    const result = await closePosition({ position_address: positionAddress, reason: `realtime: ${rule.reason}` });
    // Fast-close bypasses the executor, so notifyClose was never called for
    // this path — that's why profit closes triggered by price pumping above
    // range never showed up in Telegram. Emit the same notification the
    // executor would have fired for an LLM-initiated close.
    if (result?.success) {
      notifyClose({
        pair: result.pool_name || positionAddress.slice(0, 8),
        pnlUsd: result.pnl_usd ?? 0,
        pnlPct: result.pnl_pct ?? 0,
        reason: rule.reason,
      }).catch((err) => log("notify_warn", err.message));
    } else if (result?.skipped) {
      // Another caller (management cron or /close) already holds the close
      // mutex for this position — expected dedupe, not a failure.
      log("realtime", `Fast-close deduped for ${positionAddress.slice(0, 8)} — another attempt in flight`);
    } else if (result?.error) {
      log("realtime_warn", `Fast-close returned failure for ${positionAddress.slice(0, 8)}: ${result.error}`);
    }
  } catch (err) {
    const msg = String(err?.message || err);
    // Error 3007 (AccountOwnedByWrongProgram / 0xbbf) = position already closed by another flow.
    // Treat as a no-op instead of a crash — stale realtime events are expected when a manager
    // cron or manual /close beats the WS watcher to the punch.
    if (/AccountOwnedByWrongProgram|"Custom":\s*3007|0xbbf/.test(msg)) {
      log("realtime", `Position ${positionAddress.slice(0, 8)} was already closed (safety catch) — no-op`);
    } else {
      log("realtime_error", `closePosition failed for ${positionAddress.slice(0, 8)}: ${msg}`);
    }
  } finally {
    // Don't clear the throttle until next minute — protects against retry storm.
    setTimeout(() => _realtimeCloseAttempts.delete(positionAddress), 90_000);
  }
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  await shutdownRealtimeWatcher().catch((err) => log("silent_warn", err.message));
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Fatal error handlers — ensure crashes get logged AND Telegram-alerted
// before the process dies. Node 20+ crashes by default on unhandled rejection;
// without a handler the process just exits and pm2 restarts it with no
// breadcrumb of what went wrong.
let _fatalExitInProgress = false;

async function emitFatalAlert(kind, err) {
  const brief = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : "";
  const full = stack ? `${brief}\n${stack}` : brief;
  log(`fatal_${kind}`, full);
  // Don't re-enter if a second fatal fires while we're already exiting.
  if (_fatalExitInProgress) return;
  _fatalExitInProgress = true;
  // Best-effort Telegram alert, bounded so a broken endpoint cannot block
  // the process from exiting and letting pm2 restart it.
  const alertText =
    `🚨 FATAL (${kind}): Bot crashed and is restarting\n\n` +
    brief.slice(0, 600) +
    `\n\nCheck pm2 logs for the full stack.`;
  try {
    await Promise.race([
      sendMessage(alertText).catch((e) => log("silent_warn", `Fatal alert send failed: ${e.message}`)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch (e) {
    log("silent_warn", `Fatal alert race failed: ${e.message}`);
  }
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  emitFatalAlert("rejection", reason);
});

process.on("uncaughtException", (err) => {
  emitFatalAlert("exception", err);
});

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;
let _pendingInput = null; // { key, page, menuMsgId }

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) {
    return "<i>No cached candidates yet. Tap 🔍 Screen Now or run /screen.</i>";
  }
  const cards = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio;
    const fee24h = pool.fee_per_tvl_24h;
    const volRaw = pool.volume_window ?? pool.volume_24h;
    const vol = (volRaw != null && Number.isFinite(Number(volRaw)))
      ? `$${Number(volRaw).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : "—";
    const active = pool.active_pct;
    const organic = pool.organic_score;
    const tvl = pool.active_tvl;
    const tvlStr = (tvl != null && Number.isFinite(Number(tvl)))
      ? `$${Number(tvl).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : "—";
    const yieldLine = fee24h != null
      ? `Yield 24h: <b>${Number(fee24h).toFixed(2)}%</b>  ·  5m: ${feeTvl != null ? Number(feeTvl).toFixed(2) + "%" : "—"}`
      : `Yield 5m: <b>${feeTvl != null ? Number(feeTvl).toFixed(2) + "%" : "—"}</b>`;
    const inRangeStr = active != null ? `${active}%` : "—";
    const organicStr = organic != null ? `${organic}/100` : "—";

    // Pre-deploy backtest line — shown only when backtest.enabled and result
    // is present. Uses an emoji badge so the operator can scan quickly:
    //   ✅ proj >= minProj && range >= minRange (would pass gate)
    //   ⚠️ partial (passes one but not both, OR projected < min)
    //   ❌ would fail gate
    let backtestLine = "";
    const bt = pool.backtest;
    if (bt) {
      if (bt.ok === true) {
        const btCfg = config.screening?.backtest || {};
        const minProj  = Number.isFinite(btCfg.minProjectedYield) ? btCfg.minProjectedYield : 0;
        const minRange = Number.isFinite(btCfg.minInRangeFraction) ? btCfg.minInRangeFraction : 0;
        const projOK   = bt.projected_24h_yield >= minProj;
        const rangeOK  = bt.in_range_pct >= minRange;
        const badge = projOK && rangeOK ? "✅" : (!projOK && !rangeOK ? "❌" : "⚠️");
        backtestLine = `   📊 Backtest ${bt.window_hours}h: <b>${Number(bt.projected_24h_yield).toFixed(1)}%</b> proj  ·  in-range <b>${(bt.in_range_pct * 100).toFixed(0)}%</b> ${badge}`;
      } else {
        backtestLine = `   📊 Backtest: <i>n/a (${escapeHtml(bt.reason || "error")})</i>`;
      }
    }

    return [
      `${i + 1}. <b>${escapeHtml(pool.name || "?")}</b>`,
      `   ${yieldLine}`,
      `   TVL: <b>${tvlStr}</b>  ·  Vol: <b>${vol}</b>`,
      `   In-range: <b>${inRangeStr}</b>  ·  Organic: <b>${organicStr}</b>`,
      backtestLine || null,
    ].filter(Boolean).join("\n");
  });
  const updated = _latestCandidatesAt
    ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })
    : "unknown";
  return [
    `<i>${_latestCandidates.length} found · updated ${escapeHtml(updated)}</i>`,
    "━━━━━━━━━━━━━━━━━━━━━━━",
    cards.join("\n\n"),
    "━━━━━━━━━━━━━━━━━━━━━━━",
    "<i>/screen to refresh now</i>",
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    autoSwapAfterClose: config.management.autoSwapAfterClose,
    autoSwapMinUsd: config.management.autoSwapMinUsd,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    screeningSource: config.screening.source,
    gmgnRequireKol: config.gmgn.requireKol,
    gmgnInterval: config.gmgn.interval,
    gmgnIndicatorFilter: config.gmgn.indicatorFilter,
    gmgnMinVolume: config.gmgn.minVolume,
    gmgnMinTokenAgeHours: config.gmgn.minTokenAgeHours,
    gmgnMaxTokenAgeHours: config.gmgn.maxTokenAgeHours,
    gmgnMaxBundlerRate: config.gmgn.maxBundlerRate,
    gmgnPreferredKolNames: config.gmgn.preferredKolNames,
    gmgnPreferredKolMinHoldPct: config.gmgn.preferredKolMinHoldPct,
    gmgnDumpKolNames: config.gmgn.dumpKolNames,
    gmgnDumpKolMinHoldPct: config.gmgn.dumpKolMinHoldPct,
    gmgnIndicatorInterval: config.gmgn.indicatorInterval,
    gmgnRequireBullishSt: config.gmgn.indicatorRules?.requireBullishSupertrend,
    gmgnRejectAtBottom: config.gmgn.indicatorRules?.rejectAlreadyAtBottom,
    gmgnRequireAboveSt: config.gmgn.indicatorRules?.requireAboveSupertrend,
    gmgnMinRsi: config.gmgn.indicatorRules?.minRsi,
    gmgnMaxRsi: config.gmgn.indicatorRules?.maxRsi,
    gmgnMinKolCount: config.gmgn.minKolCount,
    gmgnMinTotalFeeSol: config.gmgn.minTotalFeeSol,
    gmgnMinHolders: config.gmgn.minHolders,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    // Meteora screening filters
    minTvl: config.screening.minTvl,
    maxTvl: config.screening.maxTvl,
    minVolume: config.screening.minVolume,
    minOrganic: config.screening.minOrganic,
    minHolders: config.screening.minHolders,
    minMcap: config.screening.minMcap,
    minFeeActiveTvlRatio: config.screening.minFeeActiveTvlRatio,
    minFeePer24h: config.screening.minFeePer24h,
    minTokenFeesSol: config.screening.minTokenFeesSol,
    minBinStep: config.screening.minBinStep,
    maxBinStep: config.screening.maxBinStep,
    // Pre-deploy yield backtest (see config.screening.backtest)
    backtestEnabled:           config.screening.backtest?.enabled,
    backtestGateEnabled:       config.screening.backtest?.gateEnabled,
    backtestWindowHours:       config.screening.backtest?.windowHours,
    backtestMinProjectedYield: config.screening.backtest?.minProjectedYield,
    backtestMinInRangeFraction:config.screening.backtest?.minInRangeFraction,
    // Twitter
    twitterEnabled: config.twitter?.enabled,
    twitterMode: config.twitter?.mode,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
    // telegram notification mute toggles
    telegramMuteAll:    config.telegram?.muteAll,
    telegramMuteDeploy: config.telegram?.muteDeploy,
    telegramMuteClose:  config.telegram?.muteClose,
    telegramMuteSwap:   config.telegram?.muteSwap,
    telegramMuteOor:    config.telegram?.muteOor,
    telegramMuteCycle:  config.telegram?.muteCycle,
    telegramMuteClaim:  config.telegram?.muteClaim,
    // hivemind on/off (read-only deps: hiveMindUrl + hiveMindApiKey must be set
    // for the toggle to actually do anything; UI just flips the flag)
    hiveMindEnabled:    !!config.hiveMind?.enabled,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function formatNotifSummary() {
  const t = config.telegram || {};
  if (t.muteAll) return "ALL muted";
  const muted = [];
  if (t.muteDeploy) muted.push("deploy");
  if (t.muteClose)  muted.push("close");
  if (t.muteSwap)   muted.push("swap");
  if (t.muteOor)    muted.push("oor");
  if (t.muteCycle)  muted.push("cycle");
  if (t.muteClaim)  muted.push("claim");
  return muted.length ? `muted ${muted.join(",")}` : "all on";
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function inputButton(key, label, { digits = 0 } = {}) {
  const value = settingValue(key);
  const shown = value == null ? "off" : Number.isFinite(Number(value)) ? String(parseFloat(Number(value).toFixed(digits))) : String(value);
  return [settingButton(`${label}: ${shown} ✏`, `cfg:input:${key}`)];
}

function renderSettingsMenu(page = "main") {
  const src = String(config.screening?.source || "meteora").toLowerCase();
  const isGmgn = src === "gmgn";

  // ─── Page titles ───
  const pageTitles = {
    main: "⚙️ General",
    risk: "💰 Risk & Deploy",
    filter: isGmgn ? "🔍 GMGN Filters" : "🔍 Meteora Filters",
    indicators: isGmgn ? "📊 GMGN Indicators" : "📊 Chart Indicators",
    kol: "👥 KOL Settings",
    notif: "🔔 Notifications",
  };

  const summary = [
    `<b>${pageTitles[page] || "⚙️ Settings"}</b>`,
    "━━━━━━━━━━━━━━━━━━━━━━━",
    `🔎 Source: <b>${src.toUpperCase()}</b>  ·  📐 Strategy: <b>${config.strategy.strategy}</b>`,
    `💰 Deploy: <b>${config.management.deployAmountSol} SOL</b>  ·  📊 Max: <b>${config.risk.maxPositions}</b>`,
    `📈 TP: <b>${config.management.takeProfitPct}%</b>  ·  📉 SL: <b>${config.management.stopLossPct}%</b>  ·  🎯 Trail: <b>${config.management.trailingTakeProfit ? "ON" : "OFF"}</b>`,
    `🐦 Twitter: <b>${config.twitter?.enabled ? "ON" : "OFF"}</b> <i>(${config.twitter?.mode || "local"})</i>  ·  📊 Indicators: <b>${config.indicators.enabled ? "ON" : "OFF"}</b>`,
    "━━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n");

  // ─── Nav bar ───
  const isP = (p) => page === p;
  const nav = [
    [
      settingButton("↩ Panel", "panel:refresh"),
      settingButton(isP("main") ? "• General" : "General", "cfg:page:main"),
      settingButton(isP("risk") ? "• Risk" : "Risk", "cfg:page:risk"),
    ],
    [
      settingButton(isP("filter") ? "• Filters" : "Filters", "cfg:page:filter"),
      settingButton(isP("indicators") ? "• Indicators" : "Indicators", "cfg:page:indicators"),
      settingButton(isP("kol") ? "• KOL" : "KOL", "cfg:page:kol"),
      settingButton(isP("notif") ? "• Notif" : "Notif", "cfg:page:notif"),
    ],
  ];

  const footer = page === "main"
    ? [[
        settingButton("🔄 Refresh", `cfg:page:${page}`),
        settingButton("❌ Close", "cfg:close"),
      ]]
    : [[
        settingButton("↩ Back", "cfg:page:main"),
        settingButton("🔄 Refresh", `cfg:page:${page}`),
        settingButton("❌ Close", "cfg:close"),
      ]];

  let rows;

  if (page === "risk") {
    // ─── 💰 Risk & Deploy ───
    rows = [
      [inputButton("deployAmountSol", "💰 Deploy SOL", { digits: 2 })[0]],
      [inputButton("gasReserve", "⛽ Gas Reserve", { digits: 2 })[0]],
      [inputButton("maxPositions", "📊 Max Positions")[0]],
      [inputButton("maxDeployAmount", "🔒 Max SOL per Deploy")[0]],
      [inputButton("takeProfitPct", "📈 Take Profit %")[0], inputButton("stopLossPct", "📉 Stop Loss %")[0]],
      [toggleButton("trailingTakeProfit", "🎯 Trailing TP")],
      [inputButton("trailingTriggerPct", "Trigger %", { digits: 1 })[0], inputButton("trailingDropPct", "Drop %", { digits: 1 })[0]],
      [inputButton("minBinsBelow", "📏 Min Range Bins")[0], inputButton("maxBinsBelow", "📏 Max Range Bins")[0]],
      [toggleButton("autoSwapAfterClose", "🔄 Auto-Swap After Close")],
      [inputButton("autoSwapMinUsd", "Min USD for Swap", { digits: 2 })[0]],
    ];

  } else if (page === "filter" && isGmgn) {
    // ─── 🔍 GMGN Filters (from gmgn-config.json) ───
    const gmgnInt = config.gmgn?.interval || "1h";
    rows = [
      [
        settingButton(gmgnInt === "5m" ? "✅ 5m" : "5m", "cfg:set:gmgnInterval:5m"),
        settingButton(gmgnInt === "1h" ? "✅ 1h" : "1h", "cfg:set:gmgnInterval:1h"),
        settingButton(gmgnInt === "6h" ? "✅ 6h" : "6h", "cfg:set:gmgnInterval:6h"),
        settingButton(gmgnInt === "24h" ? "✅ 24h" : "24h", "cfg:set:gmgnInterval:24h"),
      ],
      [inputButton("gmgnMinVolume", "Min Volume")[0], inputButton("gmgnMinHolders", "Min Holders")[0]],
      [inputButton("gmgnMinTokenAgeHours", "Min Age (hrs)")[0], inputButton("gmgnMaxTokenAgeHours", "Max Age (hrs)")[0]],
      [inputButton("gmgnMaxBundlerRate", "Max Bundler %")[0], inputButton("gmgnMinTotalFeeSol", "Min Fee SOL")[0]],
      [
        settingButton(config.strategy.strategy === "spot" ? "✅ Spot" : "Spot", "cfg:set:strategy:spot"),
        settingButton(config.strategy.strategy === "bid_ask" ? "✅ Bid/Ask" : "Bid/Ask", "cfg:set:strategy:bid_ask"),
      ],
      [toggleButton("blockPvpSymbols", "🛡 Block PVP")],
      [inputButton("managementIntervalMin", "⏱ Manage (min)")[0], inputButton("screeningIntervalMin", "⏱ Screen (min)")[0]],
      // ── Pre-Deploy Yield Backtest ──
      [toggleButton("backtestEnabled", "📊 Backtest"), toggleButton("backtestGateEnabled", "🚪 Gate")],
      [inputButton("backtestWindowHours", "⏳ Window (h)")[0], inputButton("backtestMinProjectedYield", "Min Proj %", { digits: 1 })[0]],
      [inputButton("backtestMinInRangeFraction", "Min In-Range", { digits: 2 })[0], inputButton("minFeePer24h", "Min 24h Yield", { digits: 1 })[0]],
    ];

  } else if (page === "filter") {
    // ─── 🔍 Meteora Filters (from user-config.json) ───
    rows = [
      [inputButton("minTvl", "Min TVL")[0], inputButton("maxTvl", "Max TVL")[0]],
      [inputButton("minVolume", "Min Volume")[0], inputButton("minOrganic", "Min Organic %")[0]],
      [inputButton("minHolders", "Min Holders")[0], inputButton("minMcap", "Min Mcap")[0]],
      [inputButton("minFeeActiveTvlRatio", "Min Fee/TVL", { digits: 2 })[0], inputButton("minTokenFeesSol", "Min Fee SOL")[0]],
      [inputButton("minBinStep", "Min Bin Step")[0], inputButton("maxBinStep", "Max Bin Step")[0]],
      [
        settingButton(config.strategy.strategy === "spot" ? "✅ Spot" : "Spot", "cfg:set:strategy:spot"),
        settingButton(config.strategy.strategy === "bid_ask" ? "✅ Bid/Ask" : "Bid/Ask", "cfg:set:strategy:bid_ask"),
      ],
      [toggleButton("useDiscordSignals", "📡 Discord Signals"), toggleButton("blockPvpSymbols", "🛡 Block PVP")],
      [inputButton("managementIntervalMin", "⏱ Manage (min)")[0], inputButton("screeningIntervalMin", "⏱ Screen (min)")[0]],
      // ── Pre-Deploy Yield Backtest ──
      [toggleButton("backtestEnabled", "📊 Backtest"), toggleButton("backtestGateEnabled", "🚪 Gate")],
      [inputButton("backtestWindowHours", "⏳ Window (h)")[0], inputButton("backtestMinProjectedYield", "Min Proj %", { digits: 1 })[0]],
      [inputButton("backtestMinInRangeFraction", "Min In-Range", { digits: 2 })[0], inputButton("minFeePer24h", "Min 24h Yield", { digits: 1 })[0]],
    ];

  } else if (page === "indicators" && isGmgn) {
    // ─── 📊 GMGN Indicators ───
    const gtf = String(config.gmgn?.indicatorInterval || "15_MINUTE");
    rows = [
      [toggleButton("gmgnIndicatorFilter", "🔍 GMGN Indicator Filter")],
      [
        settingButton(gtf === "5_MINUTE" ? "✅ 5min" : "5min", "cfg:set:gmgnIndicatorInterval:5_MINUTE"),
        settingButton(gtf === "15_MINUTE" ? "✅ 15min" : "15min", "cfg:set:gmgnIndicatorInterval:15_MINUTE"),
        settingButton(gtf === "1h" ? "✅ 1h" : "1h", "cfg:set:gmgnIndicatorInterval:1h"),
      ],
      [toggleButton("gmgnRequireBullishSt", "📈 Bullish Supertrend")],
      [toggleButton("gmgnRejectAtBottom", "⛔ Reject at Bottom")],
      [toggleButton("gmgnRequireAboveSt", "📊 Above Supertrend")],
      [inputButton("gmgnMinRsi", "Min RSI")[0], inputButton("gmgnMaxRsi", "Max RSI")[0]],
    ];

  } else if (page === "indicators") {
    // ─── 📊 Meteora Chart Indicators ───
    const intervals = Array.isArray(config.indicators?.intervals) ? config.indicators.intervals : [];
    const tfIs = (v) => intervals.length === 1 && intervals[0] === v;
    const tfBoth = intervals.length >= 2;
    const entry = String(config.indicators?.entryPreset || "");
    const exit = String(config.indicators?.exitPreset || "");
    rows = [
      [toggleButton("chartIndicatorsEnabled", "📊 Chart Indicators")],
      [
        settingButton(tfIs("5_MINUTE") ? "✅ 5min" : "5min", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton(tfIs("15_MINUTE") ? "✅ 15min" : "15min", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton(tfBoth ? "✅ Both" : "Both", "cfg:set:indicatorIntervals:both"),
      ],
      [toggleButton("requireAllIntervals", "Require All Timeframes")],
      [
        settingButton(entry === "supertrend_break" ? "✅ ST" : "ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton(entry === "rsi_reversal" ? "✅ RSI" : "RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton(entry === "supertrend_or_rsi" ? "✅ ST+RSI" : "ST+RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton(exit === "supertrend_break" ? "✅ ST" : "ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton(exit === "rsi_reversal" ? "✅ RSI" : "RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton(exit === "bb_plus_rsi" ? "✅ BB+RSI" : "BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      inputButton("rsiLength", "RSI Length"),
    ];

  } else if (page === "kol") {
    // ─── 👥 KOL Settings ───
    rows = [
      [toggleButton("gmgnRequireKol", "🔒 Require KOL")],
      [inputButton("gmgnMinKolCount", "Min KOL Count")[0]],
      [inputButton("gmgnPreferredKolNames", "⭐ Preferred KOLs")[0]],
      [inputButton("gmgnPreferredKolMinHoldPct", "Preferred Min Hold %")[0]],
      [inputButton("gmgnDumpKolNames", "🚫 Dump KOLs")[0]],
      [inputButton("gmgnDumpKolMinHoldPct", "Dump Min Hold %")[0]],
    ];

  } else if (page === "notif") {
    // ─── 🔔 Notifications ───
    rows = [
      [toggleButton("telegramMuteAll", "🔇 Mute Everything")],
      [toggleButton("telegramMuteDeploy", "🟢 Deploy"), toggleButton("telegramMuteClose", "🔴 Close")],
      [toggleButton("telegramMuteSwap", "🔄 Swap"), toggleButton("telegramMuteOor", "⚠️ Out of Range")],
      [toggleButton("telegramMuteCycle", "📊 Cycle Report"), toggleButton("telegramMuteClaim", "💰 Claim")],
    ];

  } else {
    // ─── ⚙ Main — General Settings ───
    rows = [
      [
        settingButton(isGmgn ? "Meteora" : "✅ Meteora", "cfg:set:screeningSource:meteora"),
        settingButton(isGmgn ? "✅ GMGN" : "GMGN", "cfg:set:screeningSource:gmgn"),
      ],
      [toggleButton("solMode", "SOL Mode"), toggleButton("lpAgentRelayEnabled", "LP Agent Relay")],
      [toggleButton("hiveMindEnabled", "🧠 HiveMind"), toggleButton("twitterEnabled", "🐦 Twitter")],
      [
        settingButton((config.twitter?.mode || "local") === "local" ? "✅ 🐦 Local" : "🐦 Local", "cfg:set:twitterMode:local"),
        settingButton((config.twitter?.mode || "local") === "api" ? "✅ 🐦 API" : "🐦 API", "cfg:set:twitterMode:api"),
      ],
      [toggleButton("chartIndicatorsEnabled", "📊 Indicators"), toggleButton("trailingTakeProfit", "🎯 Trailing TP")],
      [settingButton("📄 Show Full Config", "cfg:show")],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}
async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard, { parseMode: "HTML" });
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard, { parseMode: "HTML" });
  }
}

// ─── Control Panel ─────────────────────────────────────────────
// "MERIDIAN CONTROL PANEL" — main entry point with quick-action buttons.
// Each button either runs a self-contained action (sends a separate reply)
// or refreshes the panel after toggling state.
async function renderControlPanel() {
  const cur = config.management.solMode ? "◎" : "$";
  let walletSol = null;
  let openCount = 0;
  let oorCount = 0;
  let totalPnl = null;
  try {
    const [wallet, posResult] = await Promise.all([
      getWalletBalances().catch((err) => { log("silent_warn", err.message); return null; }),
      getMyPositions({ force: false, silent: true }).catch((err) => { log("silent_warn", err.message); return null; }),
    ]);
    if (wallet) walletSol = wallet.sol ?? 0;
    if (posResult) {
      const positions = posResult.positions || [];
      openCount = positions.length;
      oorCount = positions.filter((p) => !p.in_range).length;
      if (positions.length > 0) {
        totalPnl = positions.reduce((s, p) => s + (Number(p.pnl_usd) || 0), 0);
      }
    }
  } catch { /* best-effort, panel still renders */ }

  const cyclesOn = cronStarted;
  const muteAll = !!config.telegram?.muteAll;
  const notifLabel = muteAll ? "ALL muted"
    : formatNotifSummary() === "all on" ? "all on"
    : formatNotifSummary();

  // Status indicators
  const cycleDot = cyclesOn ? "🟢" : "🔴";
  const cycleText = cyclesOn ? "active" : "paused";
  const notifDot = muteAll ? "🔕" : "🔔";

  const walletStr = walletSol != null ? `<b>${walletSol.toFixed(2)}</b> SOL` : "<i>?</i>";
  const posStr = `<b>${openCount}</b> open` + (oorCount ? ` <i>(⚠️ ${oorCount} OOR)</i>` : "");
  const pnlStr = totalPnl != null
    ? `<b>${totalPnl >= 0 ? "+" : ""}${cur}${totalPnl.toFixed(2)}</b>`
    : "<i>—</i>";

  const updated = new Date().toLocaleString("en-US", { hour12: false, timeStyle: "short" });

  // Card-style header. Telegram supports HTML <b><i><code>; we use ─ separators
  // to give it a panel/dashboard feel without breaking on small screens.
  const text = [
    "🎛  <b>MERIDIAN CONTROL PANEL</b>",
    "━━━━━━━━━━━━━━━━━━━━━━━",
    `💼  Wallet     ${walletStr}`,
    `📁  Positions  ${posStr}`,
    `📊  Open PnL   ${pnlStr}`,
    "━━━━━━━━━━━━━━━━━━━━━━━",
    `${cycleDot}  🤖 Bot      <b>${cycleText}</b>`,
    `${notifDot}  Notif      <i>${notifLabel}</i>`,
    `💱  Mode       <b>${config.management.solMode ? "SOL" : "USD"}</b>`,
    `🔎  Source     <b>${(config.screening?.source || "meteora").toUpperCase()}</b>`,
    `⏱  Updated    <i>${updated}</i>`,
  ].join("\n");

  const muteLabel = config.telegram?.muteAll ? "🔔 Unmute" : "🔇 Mute";
  const pauseLabel = cronStarted ? "⏸ Pause" : "▶️ Resume";

  const keyboard = [
    [
      { text: "📊 Dashboard",  callback_data: "panel:dashboard" },
      { text: "📁 Positions",  callback_data: "panel:positions" },
    ],
    [
      { text: "📜 History",    callback_data: "panel:history" },
      { text: "📋 Candidates", callback_data: "panel:candidates" },
    ],
    [
      { text: "📚 Lessons",    callback_data: "panel:lessons" },
      { text: "🔍 Screen Now", callback_data: "panel:screen" },
    ],
    [
      { text: "📈 Performance", callback_data: "panel:perf" },
      { text: "🩺 Postmortem",  callback_data: "panel:postmortem" },
    ],
    [
      { text: "⚠️ Risk",        callback_data: "panel:risk" },
      { text: "📅 Calendar",    callback_data: "panel:calendar" },
    ],
    [
      { text: "💼 Wallet",     callback_data: "panel:wallet" },
      { text: "☀️ Briefing",   callback_data: "panel:briefing" },
    ],
    [
      { text: "⚙ Settings",    callback_data: "panel:settings" },
    ],
    [
      { text: muteLabel,        callback_data: "panel:mute_toggle" },
      { text: "❌ Close All",   callback_data: "panel:closeall_confirm" },
    ],
    [
      { text: pauseLabel,       callback_data: "panel:pause_toggle" },
      { text: "🔄 Refresh",     callback_data: "panel:refresh" },
    ],
  ];

  return { text, keyboard };
}

async function showControlPanel({ messageId = null } = {}) {
  const panel = await renderControlPanel();
  if (messageId) {
    await editMessageWithButtons(panel.text, messageId, panel.keyboard, { parseMode: "HTML" })
      .catch(async () => { await sendMessageWithButtons(panel.text, panel.keyboard, { parseMode: "HTML" }); });
  } else {
    await sendMessageWithButtons(panel.text, panel.keyboard, { parseMode: "HTML" });
  }
}

// Strip noisy parentheticals like "(active bin -427, position upper -436)"
// and shorten common verbose phrases so reasons fit on one line.
function cleanCloseReason(raw) {
  if (!raw) return "";
  let r = String(raw)
    .replace(/\([^)]*active bin[^)]*\)/gi, "") // drop "(active bin ...)" blocks
    .replace(/\([^)]*OOR[^)]*\)/gi, "")        // drop "(... OOR)" blocks
    .replace(/\bRule\s*\d+:\s*/gi, "")          // drop "Rule 3:" prefix
    .replace(/\s{2,}/g, " ")
    .trim();
  // common rewrites
  r = r.replace(/pumped far above range/gi, "pumped above range")
       .replace(/pumped far below range/gi, "dumped below range")
       .replace(/^realtime:\s*/i, "RT: ")
       .replace(/^OOR\s*[-–]\s*/i, "OOR: ")
       .replace(/^trailing TP:\s*/i, "trail-TP: ")
       .replace(/fee\/TVL\s*([\d.]+)%\s*<\s*min\s*([\d.]+)%/i, "fee/TVL $1% < $2%")
       .replace(/\(position age \d+m\)/i, "")
       .replace(/\(age:\s*\d+m\)/i, "")
       .trim();
  if (r.length > 48) r = r.slice(0, 45) + "…";
  return r;
}

function fmtSigned(n, decimals = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = Math.abs(n) < 1e-9 ? 0 : n; // collapse -0 to 0
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${sign}${Math.abs(v).toFixed(decimals)}`;
}

function fmtPnl(usd, cur) {
  if (usd == null || !Number.isFinite(usd)) return "—";
  const v = Math.abs(usd) < 0.005 ? 0 : usd;
  if (v === 0) return `${cur}0.00`;
  const sign = v > 0 ? "+" : "-";
  return `${sign}${cur}${Math.abs(v).toFixed(2)}`;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function buildHistoryMessage(limit = 10) {
  const cur = config.management.solMode ? "◎" : "$";
  try {
    const hist = getPerformanceHistory({ hours: 24 * 7, limit });
    if (!hist.count) return "📜 No closed positions in the last 7 days.";

    // Re-derive wins/losses from filtered positions (lessons.js doesn't expose `wins`)
    const positions = hist.positions || [];
    const wins = positions.filter((r) => (r.pnl_usd ?? 0) > 0.005).length;
    const losses = positions.filter((r) => (r.pnl_usd ?? 0) < -0.005).length;
    const flat = positions.length - wins - losses;
    const winRate = positions.length ? Math.round((wins / positions.length) * 100) : 0;

    const best = [...positions].sort((a, b) => (b.pnl_usd ?? 0) - (a.pnl_usd ?? 0))[0];
    const worst = [...positions].sort((a, b) => (a.pnl_usd ?? 0) - (b.pnl_usd ?? 0))[0];

    const totalLine = `Total PnL: <b>${escapeHtml(fmtPnl(hist.total_pnl_usd, cur))}</b>`;
    const wrLine = `Win rate: <b>${winRate}%</b> <i>(${wins}W · ${losses}L${flat ? ` · ${flat}flat` : ""})</i>`;
    const bestLine = best ? `🏆 Best:  <b>${escapeHtml(best.pool_name || "?")}</b> ${escapeHtml(fmtPnl(best.pnl_usd, cur))}` : "";
    const worstLine = worst && worst !== best ? `📉 Worst: <b>${escapeHtml(worst.pool_name || "?")}</b> ${escapeHtml(fmtPnl(worst.pnl_usd, cur))}` : "";

    const rows = positions.slice(-limit).reverse().map((r, i) => {
      const pnl = r.pnl_usd ?? 0;
      const icon = pnl > 0.005 ? "✅" : pnl < -0.005 ? "❌" : "➖";
      const pnlStr = escapeHtml(fmtPnl(pnl, cur));
      const pctStr = escapeHtml(`${fmtSigned(r.pnl_pct, 1)}%`);
      const age = r.minutes_held != null ? `${r.minutes_held}m` : "?";
      const date = r.closed_at
        ? new Date(r.closed_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
        : "?";
      const reason = escapeHtml(cleanCloseReason(r.close_reason));
      const pair = escapeHtml(r.pool_name || "?");
      return [
        `${i + 1}. ${icon} <b>${pair}</b>  <b>${pnlStr}</b> <i>(${pctStr})</i>`,
        `   <i>⏱ ${age} · ${escapeHtml(date)}${reason ? ` · ${reason}` : ""}</i>`,
      ].join("\n");
    });

    return [
      "📜 <b>Closed positions</b> · last 7 days",
      "━━━━━━━━━━━━━━━━━━━━━━━",
      totalLine,
      wrLine,
      bestLine,
      worstLine,
      "━━━━━━━━━━━━━━━━━━━━━━━",
      ...rows,
    ].filter(Boolean).join("\n");
  } catch (e) {
    return `History error: ${e.message}`;
  }
}

// Build a calendar view of daily PnL for one month. Reused by both the
// /calendar slash command and the panel:calendar callback. Reads
// performance records from lessons.json (no on-chain RPC) so it's cheap
// to render — the operator can flip months without a per-click cost.
//
// `target` accepts:
//   - null/undefined        → current UTC month
//   - "YYYY-MM" string      → that specific month
//   - { year, month0 }      → explicit (month0 is 0-indexed)
function buildCalendarView(target = null) {
  let year = null;
  let month = null;
  if (typeof target === "string") {
    const m = target.match(/^(\d{4})-(\d{1,2})$/);
    if (m) {
      year = parseInt(m[1], 10);
      month = parseInt(m[2], 10) - 1;
    }
  } else if (target && typeof target === "object") {
    if (Number.isFinite(target.year) && Number.isFinite(target.month0)) {
      year = target.year;
      month = target.month0;
    }
  }
  const cal = buildPnlCalendarFromDisk(
    year != null && month != null ? { year, month } : {},
  );
  // Hide the Today button when the user is already viewing the current
  // UTC month — otherwise pressing it triggers an editMessage with
  // identical content, which Telegram rejects with "message is not
  // modified" and the UI looks unresponsive.
  const nowUtc = new Date();
  const isOnCurrentMonth =
    cal.year === nowUtc.getUTCFullYear() && cal.month === nowUtc.getUTCMonth();
  const navRow = [];
  if (cal.hasPrev) navRow.push({ text: "◀ Prev",   callback_data: `panel:calendar_nav:${cal.prevYM}` });
  if (!isOnCurrentMonth) navRow.push({ text: "📅 Today", callback_data: "panel:calendar" });
  if (cal.hasNext) navRow.push({ text: "Next ▶",   callback_data: `panel:calendar_nav:${cal.nextYM}` });
  const keyboard = [
    navRow,
    [{ text: "↩ Back to Panel", callback_data: "panel:refresh" }],
  ];
  return { ...cal, keyboard };
}

// Build the Lessons panel view: pinned + recent + close-reason breakdown.
// Pulls from listLessons() and getPerformanceSummary() in lessons.js.
// Group close reasons by a normalized key (e.g. "OOR pumped above range",
// "low yield", "stop loss") so the breakdown isn't fragmented by tiny
// wording differences.
function bucketCloseReason(raw) {
  if (!raw) return "unknown";
  const r = String(raw).toLowerCase();
  if (r.includes("low yield") || r.includes("fee/tvl")) return "low yield (fee/TVL)";
  if (r.includes("stop loss") || r.includes("stop-loss") || r.includes("stoploss")) return "stop loss";
  if (r.includes("take profit") || r.includes("trailing tp") || r.includes("trail-tp")) return "take profit / trailing TP";
  if (r.includes("pumped") || r.includes("above range")) return "OOR pumped above range";
  if (r.includes("dumped") || r.includes("below range")) return "OOR dumped below range";
  if (r.includes("oor") || r.includes("out of range")) return "OOR (other)";
  if (r.includes("manual")) return "manual close";
  return raw.slice(0, 36);
}

// Card-style wallet view for the panel. Returns HTML with all
// user-controlled values pre-escaped — callers must NOT re-escape.
function buildWalletPanelMessage(wallet, positions) {
  const cur = config.management.solMode ? "◎" : "$";
  const sol = Number(wallet?.sol ?? 0).toFixed(3);
  const solUsd = wallet?.sol_usd != null ? `$${Number(wallet.sol_usd).toFixed(2)}` : "—";
  const solPrice = wallet?.sol_price != null ? `$${Number(wallet.sol_price).toFixed(2)}` : "—";
  const open = positions?.total_positions ?? 0;
  const max = config.risk?.maxPositions ?? 0;
  const slotPct = max > 0 ? Math.round((open / max) * 100) : 0;
  const slotBar = (() => {
    const filled = Math.round((slotPct / 100) * 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
  })();
  const deployAmount = computeDeployAmount(wallet?.sol ?? 0);
  const deployStr = config.management.solMode
    ? `◎${Number(deployAmount).toFixed(3)} SOL`
    : `${Number(deployAmount).toFixed(3)} SOL`;
  const dryRun = process.env.DRY_RUN === "true";
  const hiveOn = isHiveMindEnabled();
  const hiveDot = hiveOn ? "🟢" : "⚪️";
  const hiveText = hiveOn ? "on" : "off";
  const dryDot = dryRun ? "🟡" : "🟢";
  const dryText = dryRun ? "DRY RUN" : "live";

  return [
    "💼  <b>Wallet</b>",
    "━━━━━━━━━━━━━━━━━━━━━━━",
    `💰  Balance    <b>${escapeHtml(sol)} SOL</b>  <i>(${escapeHtml(solUsd)})</i>`,
    `📈  SOL price  <b>${escapeHtml(solPrice)}</b>`,
    "━━━━━━━━━━━━━━━━━━━━━━━",
    `📁  Slots      <b>${open}/${max}</b>  <code>${slotBar}</code>  ${slotPct}%`,
    `🚀  Next deploy <b>${escapeHtml(deployStr)}</b>`,
    "━━━━━━━━━━━━━━━━━━━━━━━",
    `${dryDot}  Mode       <b>${escapeHtml(dryText)}</b>`,
    `${hiveDot}  HiveMind   <b>${escapeHtml(hiveText)}</b>`,
    `💱  Currency   <b>${config.management.solMode ? "SOL" : "USD"}</b>`,
  ].join("\n");
}

function buildLessonsMessage(limit = 8) {
  try {
    const cur = config.management.solMode ? "◎" : "$";
    const pinned = listLessons({ pinned: true, limit: 5 }).lessons || [];
    // Pull more than `limit` then drop UI-toggle pollution from the existing
    // lessons.json (telegramMute / screeningSource flips that were recorded
    // before we added the executor-side filter). User-facing Lessons view
    // should only show genuinely actionable knowledge.
    const isUiPollution = (l) => {
      const r = String(l.rule || "");
      if (/telegramMute/i.test(r)) return true;
      if (/screeningSource=/i.test(r) && /Telegram/i.test(r)) return true;
      return false;
    };
    // listLessons returns the newest `limit*4` items but in oldest-first order
    // (it slices the array's tail). After filtering UI pollution we want the
    // newest `limit` of what remains, so take the tail again — not the head.
    // Using .slice(0, limit) here was the source of the /lessons display
    // showing stale 5-day-old lessons even though briefing's Highlights
    // section was reading fresh ones from the same file.
    const recent = (listLessons({ pinned: false, limit: limit * 4 }).lessons || [])
      .filter(l => !isUiPollution(l))
      .slice(-limit);
    const summary = getPerformanceSummary();
    const hist = getPerformanceHistory({ hours: 24 * 30, limit: 500 }); // last 30d, up to 500

    const sections = ["📚 <b>Lessons</b> · auto-learned + pinned"];
    sections.push("━━━━━━━━━━━━━━━━━━━━━━━");

    if (summary) {
      const tp = summary.total_pnl_usd ?? 0;
      const sign = tp >= 0 ? "+" : "-";
      const totalPnl = `${sign}${cur}${Math.abs(tp).toFixed(2)}`;
      sections.push(`<b>Performance</b>  ·  ${summary.total_positions_closed} closed`);
      sections.push(`Total PnL: <b>${totalPnl}</b>  ·  Win rate: <b>${summary.win_rate_pct}%</b>  ·  Avg PnL: <b>${(summary.avg_pnl_pct ?? 0).toFixed(2)}%</b>`);
      sections.push(`Avg range efficiency: <b>${summary.avg_range_efficiency_pct ?? 0}%</b>`);
    } else {
      sections.push("<i>No closed positions yet.</i>");
    }

    // Build per-bucket breakdown from history (last 30d)
    if (hist?.count) {
      const buckets = new Map();
      for (const r of hist.positions || []) {
        const key = bucketCloseReason(r.close_reason);
        const b = buckets.get(key) || { count: 0, wins: 0, totalPnl: 0 };
        b.count += 1;
        if ((r.pnl_usd ?? 0) > 0.005) b.wins += 1;
        b.totalPnl += r.pnl_usd ?? 0;
        buckets.set(key, b);
      }
      const sorted = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6);
      if (sorted.length) {
        sections.push("");
        sections.push("<i>Top close reasons (last 30d):</i>");
        for (const [reason, stats] of sorted) {
          const pct = Math.round((stats.count / hist.count) * 100);
          const wr = Math.round((stats.wins / stats.count) * 100);
          const pnlSign = stats.totalPnl >= 0 ? "+" : "-";
          const pnlStr = `${pnlSign}${cur}${Math.abs(stats.totalPnl).toFixed(2)}`;
          sections.push(`  • <b>${stats.count}×</b> <i>(${pct}%)</i> ${escapeHtml(reason)} · WR ${wr}% · ${escapeHtml(pnlStr)}`);
        }
      }
    }
    sections.push("━━━━━━━━━━━━━━━━━━━━━━━");

    if (pinned.length) {
      sections.push("📌 <b>Pinned</b>");
      for (const l of pinned) {
        sections.push(`  • <i>${escapeHtml(l.rule)}</i>`);
      }
      sections.push("");
    }

    if (recent.length) {
      sections.push(`💡 <b>Recent</b>  <i>(${recent.length})</i>`);
      const recentSorted = [...recent].reverse(); // newest first
      for (const l of recentSorted) {
        const tagPrefix = l.tags?.length ? `[${l.tags.slice(0, 2).join(",")}] ` : "";
        const date = l.created_at || "";
        sections.push(`  • <i>${escapeHtml(date)}</i> <code>${escapeHtml(tagPrefix)}</code>${escapeHtml(l.rule)}`);
      }
    } else if (!pinned.length) {
      sections.push("<i>No lessons yet. Bot will auto-derive lessons after closing positions.</i>");
    }

    return sections.join("\n");
  } catch (e) {
    return `Lessons error: ${e.message}`;
  }
}

// ─── Performance + Postmortem (Telegram-friendly formatters) ────
function buildPerformanceMessage({ windowDays = null } = {}) {
  try {
    const cur = config.management.solMode ? "◎" : "$";
    const summary = getPerformanceSummary({ windowDays });
    const sections = [];
    sections.push(`📈 <b>Performance</b>${windowDays ? ` · last ${windowDays}d` : ""}`);
    sections.push("━━━━━━━━━━━━━━━━━━━━━━━");
    if (!summary) {
      sections.push("<i>No closed positions yet.</i>");
      sections.push("<i>Bot will accumulate stats after first /close.</i>");
      return sections.join("\n");
    }
    const tp = summary.total_pnl_usd ?? 0;
    const totalPnl = `${tp >= 0 ? "+" : "-"}${cur}${Math.abs(tp).toFixed(2)}`;
    sections.push(`Closed: <b>${summary.total_positions_closed}</b>  ·  WR: <b>${summary.win_rate_pct}%</b>  ·  Total PnL: <b>${totalPnl}</b>`);
    sections.push(`Avg PnL: <b>${(summary.avg_pnl_pct ?? 0).toFixed(2)}%</b>  ·  Avg winner: <b>${(summary.avg_winner_pnl_pct ?? 0).toFixed(2)}%</b>  ·  Avg loser: <b>${(summary.avg_loser_pnl_pct ?? 0).toFixed(2)}%</b>`);
    sections.push(`Range eff: <b>${summary.avg_range_efficiency_pct ?? 0}%</b>  ·  W/L/Flat: <b>${summary.winners}/${summary.losers}/${summary.flat}</b>`);
    sections.push("");

    const byReason = summary.by_close_reason || {};
    const reasonEntries = Object.entries(byReason)
      .sort((a, b) => Math.abs(b[1].sum_pnl_pct) - Math.abs(a[1].sum_pnl_pct));
    if (reasonEntries.length) {
      sections.push("<b>By close reason</b>");
      for (const [reason, e] of reasonEntries) {
        const pnlSign = e.sum_pnl_pct >= 0 ? "+" : "-";
        const feeSign = e.sum_fees_usd >= 0 ? "+" : "-";
        sections.push(
          `  • <b>${escapeHtml(reason)}</b> ×${e.count}  ·  ` +
          `sum <b>${pnlSign}${Math.abs(e.sum_pnl_pct).toFixed(2)}%</b>  ·  ` +
          `avg ${e.avg_pnl_pct >= 0 ? "+" : "-"}${Math.abs(e.avg_pnl_pct).toFixed(2)}%  ·  ` +
          `fees ${feeSign}${cur}${Math.abs(e.sum_fees_usd).toFixed(2)}`
        );
      }
    }
    return sections.join("\n");
  } catch (e) {
    return `📈 Performance error: ${e.message}`;
  }
}

function buildPostmortemMessage() {
  try {
    const pm = getPostMortemSuggestions({ mgmtConfig: config.management });
    const sections = [];
    sections.push("🩺 <b>Postmortem</b> · diagnostic suggestions");
    sections.push("━━━━━━━━━━━━━━━━━━━━━━━");
    if (!pm) {
      sections.push("<i>Need at least 5 closed positions to generate suggestions.</i>");
      const summary = getPerformanceSummary();
      if (summary) {
        sections.push(`<i>Currently: ${summary.total_positions_closed} closed.</i>`);
      }
      return sections.join("\n");
    }
    sections.push(`Sample: <b>${pm.sample_size}</b>${pm.window_days ? ` · last ${pm.window_days}d` : ""}`);
    if (pm.summary) {
      const tp = pm.summary.total_pnl_pct ?? 0;
      sections.push(`Total: <b>${tp >= 0 ? "+" : "-"}${Math.abs(tp).toFixed(2)}%</b>  ·  WR: <b>${pm.summary.win_rate_pct}%</b>`);
    }
    sections.push("");
    if (!pm.suggestions || pm.suggestions.length === 0) {
      sections.push("✅ <i>No issues flagged. Strategy looks balanced for this sample.</i>");
      return sections.join("\n");
    }
    const sevIcon = (s) => s === "high" ? "🔴" : s === "medium" ? "🟡" : "🟢";
    for (const s of pm.suggestions) {
      sections.push(`${sevIcon(s.severity)} <b>[${(s.severity || "low").toUpperCase()}]</b> ${escapeHtml(s.summary || "")}`);
      if (s.detail)      sections.push(`   <i>${escapeHtml(s.detail)}</i>`);
      if (s.action_hint) sections.push(`   💡 ${escapeHtml(s.action_hint)}`);
      sections.push("");
    }
    sections.push("<i>Diagnostic only — bot does NOT auto-apply these.</i>");
    return sections.join("\n");
  } catch (e) {
    return `🩺 Postmortem error: ${e.message}`;
  }
}

// ─── Risk snapshot ──────────────────────────────────────────────
// Aggregates current open positions into a worst-case risk view: total
// deployed, exposure per token, and what would happen if every position
// hit its stop-loss simultaneously. Helps the operator understand
// downside before adding more deploys.
function buildRiskMessage(walletInfo, posResult) {
  try {
    const cur = config.management.solMode ? "◎" : "$";
    const positions = posResult?.positions || [];
    const sections = [];
    sections.push("⚠️ <b>Risk Snapshot</b>");
    sections.push("━━━━━━━━━━━━━━━━━━━━━━━");
    if (positions.length === 0) {
      sections.push("<i>No open positions — zero portfolio risk.</i>");
      if (walletInfo?.sol != null) {
        sections.push(`Wallet: <b>${walletInfo.sol.toFixed(3)}</b> SOL idle.`);
      }
      return sections.join("\n");
    }

    // Aggregate values from live positions + fall back to tracked deploy
    // amount when current value is unavailable (avoids zeroed totals on
    // freshly deployed positions before first PnL update).
    let totalValueUsd = 0;
    let totalDeployedSol = 0;
    let totalUnclaimedFees = 0;
    const tokenExposure = new Map(); // base_mint → { value, count, names: [] }
    for (const p of positions) {
      const value = Number(p.total_value_usd) || 0;
      totalValueUsd += value;
      const tracked = getTrackedPosition(p.position);
      const deployedSol = Number(tracked?.amount_sol) || 0;
      totalDeployedSol += deployedSol;
      totalUnclaimedFees += Number(p.unclaimed_fees_usd) || 0;
      const key = p.base_mint || p.pair || "unknown";
      const slot = tokenExposure.get(key) || { value: 0, count: 0, name: p.pair || "?", deployed_sol: 0 };
      slot.value += value;
      slot.count += 1;
      slot.deployed_sol += deployedSol;
      tokenExposure.set(key, slot);
    }

    const stopLossPct = Math.abs(Number(config.management.stopLossPct) || 0);
    // Worst-case loss: every position hits stop-loss at the configured %.
    // Computed against current value (not deployed cost) since SL is
    // pnl_pct based on initial deploy value — close enough for the
    // operator-facing summary.
    const worstCaseLossUsd = (totalValueUsd * stopLossPct) / 100;
    const walletSol = walletInfo?.sol;

    sections.push(`Open positions: <b>${positions.length}</b> / max ${config.risk?.maxPositions ?? "?"}`);
    if (totalDeployedSol > 0) {
      sections.push(`Deployed:        <b>◎${totalDeployedSol.toFixed(3)}</b> SOL across positions`);
    }
    sections.push(`Current value:   <b>${cur}${totalValueUsd.toFixed(2)}</b>`);
    sections.push(`Unclaimed fees:  <b>${cur}${totalUnclaimedFees.toFixed(2)}</b>`);
    if (walletSol != null) {
      const walletUsd = walletSol; // SOL units when solMode; we report SOL anyway
      sections.push(`Wallet idle:     <b>◎${walletSol.toFixed(3)}</b>`);
    }
    sections.push("");
    sections.push(`Stop loss: <b>-${stopLossPct.toFixed(1)}%</b>  ·  if ALL positions hit SL:`);
    sections.push(`  💀 Worst-case loss: <b>-${cur}${worstCaseLossUsd.toFixed(2)}</b>`);

    if (tokenExposure.size > 0) {
      sections.push("");
      sections.push("<b>Per-token exposure</b>");
      const sorted = [...tokenExposure.entries()].sort((a, b) => b[1].value - a[1].value);
      for (const [, slot] of sorted) {
        const pctOfPort = totalValueUsd > 0 ? Math.round((slot.value / totalValueUsd) * 100) : 0;
        const concern = pctOfPort >= 70 ? "  ⚠️ heavy concentration" : "";
        sections.push(
          `  • <b>${escapeHtml(slot.name)}</b>  ·  ` +
          `${cur}${slot.value.toFixed(2)} <i>(${pctOfPort}%)</i>  ·  ` +
          `${slot.count} pos${concern}`
        );
      }
    }

    sections.push("");
    sections.push("<i>Worst-case assumes simultaneous SL hit at exact SL%; actual losses can vary with slippage and gas.</i>");

    // ─── Circuit breaker state ───
    try {
      const bs = getBreakerStatus();
      sections.push("");
      sections.push("<b>Drawdown circuit breaker</b>");
      if (bs.paused) {
        sections.push(`  🛑 <b>PAUSED</b>  ·  ${escapeHtml(bs.reason || "drawdown")}`);
        if (bs.willResumeAt) {
          sections.push(`  Auto-resume: ${escapeHtml(bs.willResumeAt)}`);
        }
        sections.push(`  Use /resume to clear immediately.`);
      } else {
        sections.push(`  ✅ Active  ·  ${bs.recentLosses}/${bs.recentTotal} recent losses (trip at ${bs.streakThreshold}/${bs.streakWindow})`);
        sections.push(`  24h PnL: <b>◎${bs.dailyPnlSol.toFixed(3)}</b> (cap: -${bs.maxDailyLossSol})`);
      }
    } catch { /* breaker is non-critical for /risk display */ }

    // ─── Pending risk proposals (B1) ───
    try {
      const proposals = getPendingRiskProposals();
      if (proposals.length > 0) {
        sections.push("");
        sections.push(`<b>💡 Pending TP/SL proposals (${proposals.length})</b>`);
        for (const p of proposals.slice(0, 3)) {
          const changes = Object.entries(p.proposals)
            .map(([k, v]) => `${k}: ${p.current[k]} → <b>${v}</b>`)
            .join("  ·  ");
          sections.push(`  <code>#${p.id}</code>  ${changes}`);
        }
        sections.push(`  <i>Review with /risk proposals · accept with /risk accept &lt;id&gt;</i>`);
      }
    } catch { /* proposals are non-critical */ }

    return sections.join("\n");
  } catch (e) {
    return `⚠️ Risk error: ${e.message}`;
  }
}

// ─── Why <n> — explain a deploy decision ────────────────────────
// Surfaces the structured deploy decision recorded by appendDecision()
// at deploy time, plus any subsequent decisions on the same position.
// Goal: let the operator audit "why did the bot pick this pool?".
async function buildWhyMessage(idx) {
  try {
    const cur = config.management.solMode ? "◎" : "$";
    const { positions, total_positions } = await getMyPositions({ force: true });
    if (!total_positions) return "No open positions.";
    if (idx < 0 || idx >= positions.length) return `Invalid number. Use /positions first (1..${total_positions}).`;

    const p = positions[idx];
    const tracked = getTrackedPosition(p.position);
    const decisions = getDecisionsByPosition(p.position);
    const deploy = decisions.find((d) => d.type === "deploy") || null;

    const sections = [];
    sections.push(`🤔 <b>Why ${escapeHtml(p.pair)}?</b>`);
    sections.push("━━━━━━━━━━━━━━━━━━━━━━━");
    const ageMin = p.age_minutes != null ? `${p.age_minutes}m` : "?";
    const pnl = (p.pnl_usd ?? 0) >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
    const oor = !p.in_range ? " ⚠️OOR" : "";
    sections.push(`Position #${idx + 1}  ·  age ${ageMin}  ·  PnL ${pnl}${oor}`);

    if (tracked) {
      const bits = [];
      if (tracked.strategy)        bits.push(`strategy <b>${escapeHtml(tracked.strategy)}</b>`);
      if (tracked.amount_sol != null) bits.push(`deploy <b>◎${Number(tracked.amount_sol).toFixed(3)}</b>`);
      if (tracked.bin_step)        bits.push(`binstep <b>${tracked.bin_step}</b>`);
      if (tracked.volatility != null) bits.push(`vol <b>${tracked.volatility}</b>`);
      if (tracked.fee_tvl_ratio != null) bits.push(`fee/TVL <b>${tracked.fee_tvl_ratio}%</b>`);
      if (tracked.organic_score != null) bits.push(`organic <b>${tracked.organic_score}</b>`);
      if (bits.length) sections.push(bits.join(" · "));
    }
    sections.push("");

    if (!deploy) {
      sections.push("<i>No structured deploy decision recorded. This usually means the position was deployed before the decision-log was wired up, or via a manual deploy outside the SCREENER agent.</i>");
      if (decisions.length === 0) return sections.join("\n");
    }

    if (deploy) {
      sections.push("<b>📥 Deploy decision</b>");
      if (deploy.summary) sections.push(`  • <i>summary:</i> ${escapeHtml(deploy.summary)}`);
      if (deploy.reason)  sections.push(`  • <i>reason:</i> ${escapeHtml(deploy.reason)}`);
      if (Array.isArray(deploy.risks) && deploy.risks.length) {
        sections.push(`  • <i>risks flagged:</i> ${deploy.risks.map(escapeHtml).join(", ")}`);
      }
      if (Array.isArray(deploy.rejected) && deploy.rejected.length) {
        sections.push(`  • <i>rejected alternatives:</i>`);
        for (const r of deploy.rejected.slice(0, 5)) {
          sections.push(`     – ${escapeHtml(r)}`);
        }
      }
      if (deploy.metrics && Object.keys(deploy.metrics).length) {
        const metricBits = Object.entries(deploy.metrics)
          .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
          .join(", ");
        sections.push(`  • <i>metrics:</i> <code>${metricBits}</code>`);
      }
    }

    const subsequent = decisions.filter((d) => d.type !== "deploy");
    if (subsequent.length > 0) {
      sections.push("");
      sections.push(`<b>📜 Subsequent decisions</b> <i>(${subsequent.length})</i>`);
      for (const d of subsequent.slice(0, 5)) {
        const when = (d.ts || "").slice(0, 16).replace("T", " ");
        sections.push(`  • <i>[${escapeHtml(when)}] ${escapeHtml(d.type || "?")}</i>: ${escapeHtml(d.summary || d.reason || "(no detail)")}`);
      }
    }
    return sections.join("\n");
  } catch (e) {
    return `🤔 Why error: ${e.message}`;
  }
}

// Plain-text fallback for /history when HTML parse fails (e.g. weird chars
// in pool names that escapeHtml didn't anticipate).
function buildHistoryMessagePlain(limit = 10) {
  const cur = config.management.solMode ? "◎" : "$";
  try {
    const hist = getPerformanceHistory({ hours: 24 * 7, limit });
    if (!hist.count) return "📜 No closed positions in the last 7 days.";
    const positions = hist.positions || [];
    const wins = positions.filter((r) => (r.pnl_usd ?? 0) > 0.005).length;
    const losses = positions.filter((r) => (r.pnl_usd ?? 0) < -0.005).length;
    const winRate = positions.length ? Math.round((wins / positions.length) * 100) : 0;
    const rows = positions.slice(-limit).reverse().map((r, i) => {
      const pnl = r.pnl_usd ?? 0;
      const icon = pnl > 0.005 ? "✅" : pnl < -0.005 ? "❌" : "➖";
      const age = r.minutes_held != null ? `${r.minutes_held}m` : "?";
      const date = r.closed_at
        ? new Date(r.closed_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
        : "?";
      const reason = cleanCloseReason(r.close_reason);
      return `${i + 1}. ${icon} ${r.pool_name || "?"}  ${fmtPnl(pnl, cur)} (${fmtSigned(r.pnl_pct, 1)}%)\n   ${age} · ${date}${reason ? ` · ${reason}` : ""}`;
    });
    return [
      `📜 Closed positions · last 7 days`,
      `Total PnL: ${fmtPnl(hist.total_pnl_usd, cur)} · Win rate: ${winRate}% (${wins}W / ${losses}L)`,
      "",
      ...rows,
    ].join("\n");
  } catch (e) {
    return `History error: ${e.message}`;
  }
}

// Send history with HTML; if Telegram rejects it, retry as plain text.
async function sendHistoryMessage(limit = 10) {
  const html = await buildHistoryMessage(limit);
  const result = await sendHTML(html).catch((err) => { log("silent_warn", err.message); return null; });
  if (result && result.ok !== false) return;
  // HTML parse failed — fallback to plain text so user always sees something
  await sendMessage(buildHistoryMessagePlain(limit)).catch((err) => log("silent_warn", err.message));
}

// Render a sub-view (Positions / History / Wallet / etc.) in place of the
// control panel. Always includes a [↩ Back to Panel] button so the user can
// return without spawning a second message.
async function showPanelView({ messageId, title, body, parseMode = null, extraButtons = [] }) {
  const text = title ? `${title}\n\n${body}` : body;
  const backRow = [{ text: "↩ Back to Panel", callback_data: "panel:refresh" }];
  const keyboard = [...extraButtons, backRow];
  await editMessageWithButtons(text, messageId, keyboard, parseMode ? { parseMode } : {})
    .catch(async () => {
      // edit failed (e.g. message too old) — send a fresh one with the buttons
      await sendMessageWithButtons(text, keyboard, parseMode ? { parseMode } : {});
    });
}

async function applyControlPanelCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  const cur = config.management.solMode ? "◎" : "$";
  const messageId = msg.messageId;

  // ack first so Telegram doesn't show the spinner forever
  const ack = (note) => answerCallbackQuery(msg.callbackQueryId, note).catch((err) => log("silent_warn", err.message));

  if (action === "refresh" || action === "dashboard") {
    await ack();
    await showControlPanel({ messageId });
    return;
  }
  if (action === "positions") {
    await ack();
    let body;
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (!total_positions) {
        body = "<i>No open positions.</i>";
      } else {
        // Aggregate totals while building per-card rows so the operator can
        // glance the bottom summary instead of mental-summing every line.
        let totValue = 0;
        let totPnl = 0;
        let totFees = 0;
        let oorCount = 0;
        const cards = positions.map((p, i) => {
          const value = Number(p.total_value_usd) || 0;
          const pnlNum = Number(p.pnl_usd) || 0;
          const feesNum = Number(p.unclaimed_fees_usd) || 0;
          totValue += value;
          totPnl += pnlNum;
          totFees += feesNum;
          if (!p.in_range) oorCount += 1;
          const pnlSign = pnlNum >= 0 ? "+" : "-";
          const pnlStr = `${pnlSign}${cur}${Math.abs(pnlNum).toFixed(2)}`;
          const pnlPctStr = p.pnl_pct != null
            ? ` <i>(${pnlNum >= 0 ? "+" : "-"}${Math.abs(Number(p.pnl_pct)).toFixed(2)}%)</i>`
            : "";
          const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
          const status = p.in_range ? "🟢 IN" : "⚠️ OOR";
          const yld = p.fee_per_tvl_24h != null ? `${Number(p.fee_per_tvl_24h).toFixed(2)}%` : "—";
          return [
            `${i + 1}. <b>${escapeHtml(p.pair || "?")}</b>  ${status}`,
            `   Value: <b>${cur}${value.toFixed(2)}</b>  ·  PnL: <b>${pnlStr}</b>${pnlPctStr}`,
            `   Yield: <b>${yld}</b>  ·  Fees: <b>${cur}${feesNum.toFixed(2)}</b>  ·  age ${age}`,
          ].join("\n");
        });
        const totPnlSign = totPnl >= 0 ? "+" : "-";
        const totPnlStr = `${totPnlSign}${cur}${Math.abs(totPnl).toFixed(2)}`;
        const oorBadge = oorCount > 0 ? `  ·  <i>${oorCount} OOR</i>` : "";
        body = [
          `<i>${total_positions} active</i>${oorBadge}`,
          "━━━━━━━━━━━━━━━━━━━━━━━",
          cards.join("\n\n"),
          "━━━━━━━━━━━━━━━━━━━━━━━",
          `Total: <b>${cur}${totValue.toFixed(2)}</b>  ·  PnL: <b>${totPnlStr}</b>  ·  Fees: <b>${cur}${totFees.toFixed(2)}</b>`,
          "",
          "<i>/close &lt;n&gt; to close · /why &lt;n&gt; for details</i>",
        ].join("\n");
      }
    } catch (e) { body = `Error: ${escapeHtml(e.message)}`; }
    await showPanelView({
      messageId,
      title: "📁 <b>Open Positions</b>",
      body,
      parseMode: "HTML",
    });
    return;
  }
  if (action === "history") {
    await ack();
    let body;
    try {
      body = await buildHistoryMessage(10);
    } catch (e) { body = `Error: ${e.message}`; }
    // buildHistoryMessage already includes the title; pass body only
    await editMessageWithButtons(body, messageId,
      [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      { parseMode: "HTML" },
    ).catch(async () => {
      // HTML rejected — fallback to plain text
      const plain = buildHistoryMessagePlain(10);
      await editMessageWithButtons(plain, messageId,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ).catch(() => sendMessageWithButtons(plain,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ));
    });
    return;
  }
  if (action === "lessons") {
    await ack();
    let body;
    try { body = buildLessonsMessage(8); }
    catch (e) { body = `Error: ${e.message}`; }
    await editMessageWithButtons(body, messageId,
      [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      { parseMode: "HTML" },
    ).catch(async () => {
      // HTML rejected — strip tags
      const plain = body.replace(/<[^>]+>/g, "");
      await editMessageWithButtons(plain, messageId,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ).catch(() => sendMessageWithButtons(plain,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ));
    });
    return;
  }
  if (action === "candidates") {
    await ack();
    let body;
    try { body = describeLatestCandidates(5); }
    catch (e) { body = `Error: ${escapeHtml(e.message)}`; }
    // describeLatestCandidates now returns HTML directly (escapes user-provided
    // strings like pool names internally) — pass through without re-escaping.
    await showPanelView({
      messageId,
      title: "📋 <b>Latest Candidates</b>",
      body,
      parseMode: "HTML",
    });
    return;
  }
  if (action === "perf") {
    await ack();
    const body = buildPerformanceMessage();
    await editMessageWithButtons(body, messageId,
      [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      { parseMode: "HTML" },
    ).catch(async () => {
      const plain = body.replace(/<[^>]+>/g, "");
      await editMessageWithButtons(plain, messageId,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ).catch(() => sendMessageWithButtons(plain,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ));
    });
    return;
  }
  if (action === "postmortem") {
    await ack();
    const body = buildPostmortemMessage();
    await editMessageWithButtons(body, messageId,
      [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      { parseMode: "HTML" },
    ).catch(async () => {
      const plain = body.replace(/<[^>]+>/g, "");
      await editMessageWithButtons(plain, messageId,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ).catch(() => sendMessageWithButtons(plain,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ));
    });
    return;
  }
  if (action === "risk") {
    await ack();
    let body;
    try {
      const [wallet, posResult] = await Promise.all([
        getWalletBalances().catch((err) => { log("silent_warn", err.message); return null; }),
        getMyPositions({ force: true }).catch((err) => { log("silent_warn", err.message); return null; }),
      ]);
      body = buildRiskMessage(wallet, posResult);
    } catch (e) { body = `Error: ${escapeHtml(e.message)}`; }
    await editMessageWithButtons(body, messageId,
      [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      { parseMode: "HTML" },
    ).catch(async () => {
      const plain = body.replace(/<[^>]+>/g, "");
      await editMessageWithButtons(plain, messageId,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ).catch(() => sendMessageWithButtons(plain,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ));
    });
    return;
  }
  if (action === "screen") {
    await ack("Running screening cycle…");
    // show "running" placeholder so user sees something while screening runs
    await editMessageWithButtons("🔍 <b>Running screening cycle…</b>\n<i>This may take 10–30 seconds.</i>", messageId, [], { parseMode: "HTML" }).catch((err) => log("silent_warn", err.message));
    let body;
    try { body = await runDeterministicScreen(5); }
    catch (e) { body = `Error: ${e.message}`; }
    await showPanelView({
      messageId,
      title: "🔍 <b>Screening Result</b>",
      body: escapeHtml(body),
      parseMode: "HTML",
    });
    return;
  }
  if (action === "wallet") {
    await ack();
    let body;
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      body = buildWalletPanelMessage(wallet, positions);
    } catch (e) { body = `Error: ${escapeHtml(e.message)}`; }
    // body is already HTML-formatted with escaped values — do NOT re-escape
    await editMessageWithButtons(body, messageId,
      [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      { parseMode: "HTML" },
    ).catch(async () => {
      const plain = body.replace(/<[^>]+>/g, "");
      await editMessageWithButtons(plain, messageId,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ).catch(() => sendMessageWithButtons(plain,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ));
    });
    return;
  }
  if (action === "briefing") {
    await ack("Generating briefing…");
    await editMessageWithButtons("☀️ <b>Generating briefing…</b>", messageId, [], { parseMode: "HTML" }).catch((err) => log("silent_warn", err.message));
    let html;
    try { html = await generateBriefing(); }
    catch (e) { html = `Error: ${e.message}`; }
    // briefing is already HTML — append back button row
    await editMessageWithButtons(html, messageId,
      [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      { parseMode: "HTML" },
    ).catch(async () => {
      // fallback if HTML rejected
      await editMessageWithButtons(html.replace(/<[^>]+>/g, ""), messageId,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ).catch((err) => log("silent_warn", err.message));
    });
    return;
  }
  // panel:calendar           → current month
  // panel:calendar_nav:YYYY-MM → specific month (from prev/next nav button)
  if (action === "calendar" || action === "calendar_nav") {
    await ack();
    const target = action === "calendar_nav" ? (parts[2] || null) : null;
    let cal;
    try {
      cal = buildCalendarView(target);
    } catch (e) {
      await editMessageWithButtons(`Error: ${escapeHtml(e.message)}`, messageId,
        [[{ text: "↩ Back to Panel", callback_data: "panel:refresh" }]],
      ).catch((err) => log("silent_warn", err.message));
      return;
    }
    await editMessageWithButtons(cal.text, messageId, cal.keyboard, { parseMode: "HTML" })
      .catch(async () => {
        // HTML rejected — strip tags
        const plain = cal.text.replace(/<[^>]+>/g, "");
        await editMessageWithButtons(plain, messageId, cal.keyboard)
          .catch(() => sendMessageWithButtons(plain, cal.keyboard));
      });
    return;
  }
  if (action === "settings") {
    await ack();
    await showSettingsMenu({ messageId });
    return;
  }
  if (action === "mute_toggle") {
    const current = !!config.telegram?.muteAll;
    const next = !current;
    const result = await executeTool("update_config", {
      changes: { telegramMuteAll: next },
      reason: "Telegram control panel mute toggle",
    });
    if (!result?.success) {
      await ack("Toggle failed");
      return;
    }
    await ack(next ? "Muted ALL notifications" : "Unmuted — notifications back on");
    await showControlPanel({ messageId: msg.messageId });
    return;
  }
  if (action === "pause_toggle") {
    if (cronStarted) {
      stopCronJobs();
      cronStarted = false;
      await ack("Cycles paused");
    } else {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await ack("Cycles resumed");
    }
    await showControlPanel({ messageId: msg.messageId });
    return;
  }
  if (action === "closeall_confirm") {
    await ack();
    const confirmKb = [
      [
        { text: "✅ Yes, close all", callback_data: "panel:closeall_do" },
        { text: "↩ Cancel",          callback_data: "panel:refresh" },
      ],
    ];
    await editMessageWithButtons(
      "⚠️ <b>Close ALL open positions?</b>\nThis cannot be undone.",
      msg.messageId,
      confirmKb,
      { parseMode: "HTML" },
    ).catch(() => sendMessageWithButtons("⚠️ Close ALL? Cannot be undone.", confirmKb));
    return;
  }
  if (action === "closeall_do") {
    await ack("Closing all positions…");
    let body;
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) {
        body = "No open positions to close.";
      } else {
        await editMessageWithButtons(
          `🔒 <b>Closing ${positions.length} position(s)…</b>\n<i>Please wait, do not click anything.</i>`,
          messageId, [], { parseMode: "HTML" },
        ).catch((err) => log("silent_warn", err.message));
        const results = [];
        for (const pos of positions) {
          try {
            const r = await closePosition({ position_address: pos.position });
            results.push(r.success
              ? `✅ ${escapeHtml(pos.pair)} · PnL ${escapeHtml(`${cur}${r.pnl_usd ?? "?"}`)}`
              : `❌ ${escapeHtml(pos.pair)}`);
          } catch (e) {
            results.push(`❌ ${escapeHtml(pos.pair)}: ${escapeHtml(e.message)}`);
          }
        }
        body = `<b>Close-all finished.</b>\n\n${results.join("\n")}`;
      }
    } catch (e) { body = `Error: ${escapeHtml(e.message)}`; }
    await showPanelView({
      messageId,
      title: "🔒 <b>Close All</b>",
      body,
      parseMode: "HTML",
    });
    return;
  }

  await ack("Unknown action");
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  if (key === "gmgnPreferredKolNames" || key === "gmgnDumpKolNames") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "input") {
    const inputKey = parts[2];
    const currentVal = settingValue(inputKey);
    const inputPage = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(inputKey) ? "kol"
      : ["gmgnMinVolume", "gmgnMaxBundlerRate", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours", "minBinsBelow", "maxBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(inputKey) ? "filter"
      : ["useDiscordSignals", "blockPvpSymbols", "screeningSource", "gmgnRequireKol"].includes(inputKey) ? "filter"
      : inputKey.startsWith("backtest") || inputKey === "minFeePer24h" ? "filter"
      : inputKey.startsWith("indicator") || inputKey === "chartIndicatorsEnabled" || inputKey === "rsiLength" || inputKey === "requireAllIntervals" ? "indicators"
      : inputKey.startsWith("gmgn") && !["gmgnMinVolume", "gmgnMaxBundlerRate", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(inputKey) ? "indicators"
      : ["solMode", "lpAgentRelayEnabled", "hiveMindEnabled", "twitterEnabled", "twitterMode"].includes(inputKey) ? "main"
      : "risk";
    await answerCallbackQuery(msg.callbackQueryId);
    const promptText = [
      `✏️ <b>Edit ${inputKey}</b>`,
      `Current: <code>${currentVal ?? "off"}</code>`,
      "",
      `Send a number as the next message, or "<code>off</code>" to clear.`,
      `Press <b>↩ Cancel</b> below to abort.`,
    ].join("\n");
    const cancelKb = [[{ text: "↩ Cancel", callback_data: "cfg:cancel_input" }]];
    const sent = await sendMessageWithButtons(promptText, cancelKb, { parseMode: "HTML" });
    const promptMsgId = sent?.result?.message_id ?? null;
    _pendingInput = { key: inputKey, page: inputPage, menuMsgId: msg.messageId, promptMsgId };
    return;
  }
  if (action === "cancel_input") {
    const promptMsgId = _pendingInput?.promptMsgId ?? msg.messageId;
    const menuMsgId = _pendingInput?.menuMsgId ?? null;
    const restorePage = _pendingInput?.page ?? "main";
    _pendingInput = null;
    await answerCallbackQuery(msg.callbackQueryId, "Cancelled");
    if (promptMsgId) await deleteMessage(promptMsgId).catch((err) => log("silent_warn", err.message));
    if (menuMsgId) await showSettingsMenu({ messageId: menuMsgId, page: restorePage }).catch((err) => log("silent_warn", err.message));
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    // Redirect old page names to new merged pages
    if (page === "strategy" || page === "screen" || page === "gmgn") page = "filter";
    if (page === "indicators_old") page = "indicators";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = key.startsWith("telegramMute") ? "notif"
    : ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct", "gmgnRequireKol", "gmgnMinKolCount"].includes(key) ? "kol"
    : ["gmgnMinVolume", "gmgnMaxBundlerRate", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours", "gmgnMinTotalFeeSol", "gmgnMinHolders", "gmgnInterval"].includes(key) ? "filter"
    : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "strategy"].includes(key) ? "filter"
    : ["minTvl", "maxTvl", "minVolume", "minOrganic", "minHolders", "minMcap", "minFeeActiveTvlRatio", "minFeePer24h", "minTokenFeesSol", "minBinStep", "maxBinStep"].includes(key) ? "filter"
    : key.startsWith("backtest") ? "filter"
    : ["gmgnIndicatorFilter", "gmgnIndicatorInterval", "gmgnRequireBullishSt", "gmgnRejectAtBottom", "gmgnRequireAboveSt", "gmgnMinRsi", "gmgnMaxRsi"].includes(key) ? "indicators"
    : key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals" ? "indicators"
    : ["solMode", "lpAgentRelayEnabled", "hiveMindEnabled", "twitterEnabled", "twitterMode", "screeningSource", "chartIndicatorsEnabled", "trailingTakeProfit"].includes(key) ? "main"
    : ["minBinsBelow", "maxBinsBelow"].includes(key) ? "risk"
    : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      const source = pool.gmgn ? ` | GMGN smart ${pool.gmgn_smart_wallets ?? "?"}, KOL ${pool.gmgn_kol_wallets ?? "?"}, total fee ${pool.gmgn_total_fee_sol ?? "?"} SOL` : ` | organic ${pool.organic_score ?? "?"}`;
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol}${source}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow = computeBinsBelow(candidate.volatility);
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.active_tvl ?? candidate.tvl ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;

  if (_pendingInput && !msg.isCallback && !text.startsWith("/")) {
    const { key, page, menuMsgId, promptMsgId } = _pendingInput;
    _pendingInput = null;
    let value;
    if (text.toLowerCase() === "off" || text.toLowerCase() === "null") {
      value = null;
    } else {
      value = Number(text);
      if (!Number.isFinite(value)) {
        // re-arm for another attempt; keep prompt visible so user can retry or cancel
        _pendingInput = { key, page, menuMsgId, promptMsgId };
        await sendMessage(`Invalid value "${text}" — must be a number or "off".`);
        return;
      }
    }
    const result = await executeTool("update_config", { changes: { [key]: value }, reason: "Telegram input field" });
    if (promptMsgId) await deleteMessage(promptMsgId).catch((err) => log("silent_warn", err.message));
    if (!result?.success) {
      await sendMessage(`Failed to update ${key}.`);
      return;
    }
    await showSettingsMenu({ messageId: menuMsgId, page });
    return;
  }
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch((err) => log("silent_warn", err.message));
    }
    return;
  }
  if (msg?.isCallback && text.startsWith("panel:")) {
    try {
      await applyControlPanelCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch((err) => log("silent_warn", err.message));
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (text === "/panel" || text === "/dashboard" || text === "/start" || text === "/control") {
    await showControlPanel().catch((e) => sendMessage(`Panel error: ${e.message}`).catch(() => {}));
    return;
  }
  if (text === "/history") {
    await sendHistoryMessage(10);
    return;
  }
  if (text === "/lessons") {
    const html = buildLessonsMessage(8);
    const ok = await sendHTML(html).catch((err) => { log("silent_warn", err.message); return null; });
    if (!ok) await sendMessage(html.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
    return;
  }
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch((err) => log("silent_warn", err.message));
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  if (text === "/perf" || text === "/performance") {
    const body = buildPerformanceMessage();
    const ok = await sendHTML(body).catch((err) => { log("silent_warn", err.message); return null; });
    if (!ok) await sendMessage(body.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
    return;
  }

  // /calendar [YYYY-MM] — daily PnL calendar with prev/next nav.
  // No arg = current month. Uses callback nav buttons so the operator
  // can flip months without retyping commands.
  const calendarMatch = text.match(/^\/calendar(?:\s+(\d{4}-\d{1,2}))?$/i);
  if (calendarMatch) {
    try {
      const cal = buildCalendarView(calendarMatch[1] || null);
      const ok = await sendMessageWithButtons(cal.text, cal.keyboard, { parseMode: "HTML" })
        .catch((err) => { log("silent_warn", err.message); return null; });
      if (!ok) {
        // HTML rejected — strip tags and retry without parse_mode
        await sendMessageWithButtons(cal.text.replace(/<[^>]+>/g, ""), cal.keyboard)
          .catch((err) => log("silent_warn", err.message));
      }
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  if (text === "/postmortem" || text === "/pm") {
    const body = buildPostmortemMessage();
    const ok = await sendHTML(body).catch((err) => { log("silent_warn", err.message); return null; });
    if (!ok) await sendMessage(body.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
    return;
  }

  if (text === "/trends") {
    const body = getValidationTrendSummary();
    await sendMessage(body).catch((err) => log("silent_warn", err.message));
    return;
  }

  if (text === "/risk" || text.startsWith("/risk ")) {
    const parts = text.split(/\s+/).slice(1);
    const sub = parts[0]?.toLowerCase();

    // ── /risk proposals — list pending TP/SL proposals
    if (sub === "proposals" || sub === "list") {
      try {
        const proposals = getPendingRiskProposals();
        if (proposals.length === 0) {
          await sendMessage("No pending risk proposals.").catch((err) => log("silent_warn", err.message));
          return;
        }
        const lines = [`💡 <b>Pending risk proposals (${proposals.length})</b>`, ""];
        for (const p of proposals) {
          const changes = Object.entries(p.proposals)
            .map(([k, v]) => `${k}: ${p.current[k]} → <b>${v}</b>`)
            .join("\n  ");
          const why = Object.values(p.rationale || {}).join(" · ");
          lines.push(`<b>#${p.id}</b>`);
          lines.push(`  ${changes}`);
          lines.push(`  <i>${escapeHtml(why)}</i>`);
          lines.push(`  <i>n=${p.sample_size} (${p.winners}W/${p.losers}L)</i>`);
          lines.push("");
        }
        lines.push("Use <code>/risk accept &lt;id&gt;</code> or <code>/risk reject &lt;id&gt;</code>.");
        const body = lines.join("\n");
        const ok = await sendHTML(body).catch((err) => { log("silent_warn", err.message); return null; });
        if (!ok) await sendMessage(body.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
      }
      return;
    }

    // ── /risk accept <id> | /risk reject <id>
    if (sub === "accept" || sub === "reject") {
      const id = parseInt(parts[1], 10);
      if (!Number.isFinite(id)) {
        await sendMessage(`Usage: /risk ${sub} <id>\n\nList pending with /risk proposals.`).catch((err) => log("silent_warn", err.message));
        return;
      }
      try {
        const result = sub === "accept"
          ? acceptRiskProposal(id, config)
          : rejectRiskProposal(id);
        if (!result.success) {
          await sendMessage(`❌ ${result.error}`).catch((err) => log("silent_warn", err.message));
          return;
        }
        if (sub === "accept") {
          const applied = result.applied || {};
          const lines = [`✅ <b>Risk proposal #${id} accepted</b>`];
          for (const [k, v] of Object.entries(applied)) {
            lines.push(`  ${k} = <b>${v}</b>`);
          }
          lines.push("<i>Live config updated. Next cycle uses the new value.</i>");
          await sendHTML(lines.join("\n")).catch((err) => log("silent_warn", err.message));
        } else {
          await sendMessage(`Rejected proposal #${id}.`).catch((err) => log("silent_warn", err.message));
        }
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
      }
      return;
    }

    // ── /risk (default snapshot)
    try {
      const [wallet, posResult] = await Promise.all([
        getWalletBalances().catch((err) => { log("silent_warn", err.message); return null; }),
        getMyPositions({ force: true }).catch((err) => { log("silent_warn", err.message); return null; }),
      ]);
      const body = buildRiskMessage(wallet, posResult);
      const ok = await sendHTML(body).catch((err) => { log("silent_warn", err.message); return null; });
      if (!ok) await sendMessage(body.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  const whyMatch = text.match(/^\/why\s+(\d+)$/i);
  if (whyMatch) {
    try {
      const idx = parseInt(whyMatch[1]) - 1;
      const body = await buildWhyMessage(idx);
      const ok = await sendHTML(body).catch((err) => { log("silent_warn", err.message); return null; });
      if (!ok) await sendMessage(body.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch((err) => log("silent_warn", err.message));
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the numbered list.`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions)}${suffix}`).catch((err) => log("silent_warn", err.message));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch((err) => log("silent_warn", err.message));
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        const yld = p.fee_per_tvl_24h != null ? ` | yield: ${p.fee_per_tvl_24h}%` : "";
        return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd}${yld} | ${age}${oor}`;
      });
      await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message)); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        await sendMessage(`✅ Closed ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`);
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message)); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          const result = await closePosition({ position_address: pos.position });
          results.push(`${pos.pair}: ${result.success ? "closed" : `failed (${result.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch((err) => log("silent_warn", err.message));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message)); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch((err) => log("silent_warn", err.message));
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch((err) => log("silent_warn", err.message));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch((err) => log("silent_warn", err.message));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  if (text === "/candidates") {
    // describeLatestCandidates returns HTML — send via sendHTML so the
    // formatting actually renders (sendMessage is plain-text only).
    await sendHTML(describeLatestCandidates(5)).catch((err) => log("silent_warn", err.message));
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch((err) => log("silent_warn", err.message));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  // ── /memo : Tier 2 coaching memo lifecycle ─────────────────
  // Subcommands: list (default) | propose | approve | reject [reason] | rollback <id> | pending
  const memoMatch = text.match(/^\/memo(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/i);
  if (memoMatch) {
    const sub = (memoMatch[1] || "list").toLowerCase();
    const arg = memoMatch[2] ? memoMatch[2].trim() : null;
    try {
      if (sub === "list") {
        const active = getActiveCoachingMemos();
        const pending = getPendingCoachingProposal();
        const lines = [`📋 <b>Coaching Memos</b> — ${active.length} active`];
        if (active.length === 0) {
          lines.push("  (none active)");
        } else {
          for (const m of active) {
            const date = String(m.approvedAt || m.createdAt || "").slice(0, 10);
            lines.push(`\n<code>${m.id}</code> @ ${date}`);
            for (const r of (m.rules || [])) lines.push(`  • ${escapeHtml(r)}`);
          }
        }
        if (pending) {
          lines.push(`\n⏳ <b>Pending</b>: <code>${pending.id}</code> (${pending.rules.length} rules, valid=${pending.validation?.ok ? "yes" : "no"})`);
          lines.push("Use /memo approve or /memo reject");
        } else {
          lines.push("\nUse /memo propose to draft a new memo from recent perf.");
        }
        const html = lines.join("\n");
        const ok = await sendHTML(html).catch((err) => { log("silent_warn", err.message); return null; });
        if (!ok) await sendMessage(html.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
        return;
      }

      if (sub === "pending") {
        const p = getPendingCoachingProposal();
        if (!p) { await sendMessage("No pending proposal. Use /memo propose to draft one."); return; }
        const lines = [
          `⏳ <b>Pending memo</b> <code>${p.id}</code>`,
          p.summary ? `\n<i>${escapeHtml(p.summary)}</i>` : "",
          "\nRules:",
          ...p.rules.map((r, i) => `${i + 1}. ${escapeHtml(r)}`),
          `\nValidation: ${p.validation?.ok ? "✅ ok" : "⚠️ " + (p.validation?.errors || []).join(", ")}`,
          "\nUse /memo approve or /memo reject [reason]",
        ];
        const html = lines.filter(Boolean).join("\n");
        const ok = await sendHTML(html).catch((err) => { log("silent_warn", err.message); return null; });
        if (!ok) await sendMessage(html.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
        return;
      }

      if (sub === "propose") {
        const windowDays = config.coaching?.digestWindowDays ?? 7;
        const minCloses  = config.coaching?.minClosesForProposal ?? 10;
        const perfSummary = getPerformanceSummary({ windowDays });
        if (!perfSummary || perfSummary.total_positions_closed < minCloses) {
          const have = perfSummary?.total_positions_closed || 0;
          await sendMessage(`Need ≥ ${minCloses} closes in last ${windowDays}d to propose. Have ${have}.`);
          return;
        }

        // Load raw lessons + rank with Tier 1 scorer for digest context.
        let rankedLessons = [];
        try {
          const fs = await import("fs");
          const data = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
          rankedLessons = selectTopLessons(data.lessons || [], 10, { now: Date.now() });
        } catch (e) {
          log("coaching_warn", `Failed to load lessons for digest: ${e.message}`);
        }

        const digest = generateCoachingDigest({ perfSummary, lessons: rankedLessons, windowDays });
        if (!digest.ok) { await sendMessage(`Digest generation failed: ${digest.reason}`); return; }

        await sendMessage(`🧠 Calling LLM to draft memo from ${perfSummary.total_positions_closed} closes (${windowDays}d)...`).catch(() => {});

        let proposal;
        try {
          proposal = await proposeMemoFromDigest(digest.text, {
            model: config.llm.generalModel,
            maxTokens: config.coaching?.proposalMaxTokens ?? 1500,
          });
        } catch (e) {
          await sendMessage(`❌ LLM proposal failed: ${e.message}`).catch((err) => log("silent_warn", err.message));
          return;
        }

        const memo = setPendingCoachingProposal({
          rules: proposal.rules,
          summary: proposal.summary,
          snapshot: digest.snapshot,
        });

        const lines = [
          `✅ <b>Proposal staged</b>: <code>${memo.id}</code>`,
          memo.summary ? `\n<i>${escapeHtml(memo.summary)}</i>` : "",
          "\nRules:",
          ...memo.rules.map((r, i) => `${i + 1}. ${escapeHtml(r)}`),
          `\nValidation: ${memo.validation.ok ? "✅ ok" : "⚠️ " + memo.validation.errors.join(", ")}`,
          "\nUse /memo approve to activate, /memo reject [reason] to discard.",
        ];
        const html = lines.filter(Boolean).join("\n");
        const ok = await sendHTML(html).catch((err) => { log("silent_warn", err.message); return null; });
        if (!ok) await sendMessage(html.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
        return;
      }

      if (sub === "approve") {
        const limit = config.coaching?.activeMemoLimit ?? 10;
        const result = approvePendingCoachingProposal({ activeMemoLimit: limit });
        if (!result.ok) {
          if (result.reason === "no_pending") { await sendMessage("No pending proposal to approve."); return; }
          if (result.reason === "invalid")    { await sendMessage(`Cannot approve invalid proposal: ${(result.errors || []).join(", ")}\nUse /memo reject and /memo propose again.`); return; }
          await sendMessage(`Approve failed: ${result.reason}`); return;
        }
        const okHtml = await sendHTML(
          `✅ Approved <code>${result.memo.id}</code> → ${result.activeCount} active memo(s).\nNow injecting into SCREENER + GENERAL prompts.`
        ).catch((err) => { log("silent_warn", err.message); return null; });
        if (!okHtml) {
          await sendMessage(`Approved ${result.memo.id} → ${result.activeCount} active memo(s).`).catch((err) => log("silent_warn", err.message));
        }
        return;
      }

      if (sub === "reject") {
        const reason = arg || "operator";
        const result = rejectPendingCoachingProposal(reason);
        if (!result.ok) { await sendMessage("No pending proposal to reject."); return; }
        await sendMessage(`❌ Rejected ${result.memo.id} (${reason}).`);
        return;
      }

      if (sub === "rollback") {
        if (!arg) { await sendMessage("Usage: /memo rollback <memo-id>"); return; }
        const result = rollbackCoachingMemo(arg);
        if (!result.ok) {
          if (result.reason === "not_found") { await sendMessage(`Memo ${arg} not in active list. Use /memo to see ids.`); return; }
          await sendMessage(`Rollback failed: ${result.reason}`); return;
        }
        const remaining = getActiveCoachingMemos().length;
        await sendMessage(`↩️ Rolled back ${result.memo.id}. ${remaining} active memo(s) remaining.`);
        return;
      }

      await sendMessage(
        "Unknown /memo subcommand. Try: /memo | /memo propose | /memo approve | /memo reject [reason] | /memo rollback <id> | /memo pending",
      );
    } catch (e) {
      await sendMessage(`/memo error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  // ── /lpers : Tier 3 self-learning — top-LPer auto-discovery ────
  // Subcommands: leaderboard (default) | stats | promote <addr> | reject <addr> [reason] | info <addr>
  const lpersMatch = text.match(/^\/lpers(?:\s+(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?)?$/i);
  if (lpersMatch) {
    const sub = (lpersMatch[1] || "leaderboard").toLowerCase();
    const arg1 = lpersMatch[2] || null;
    const arg2 = lpersMatch[3] ? lpersMatch[3].trim() : null;
    try {
      if (sub === "leaderboard" || sub === "list" || sub === "top") {
        const board = getLpersLeaderboard({ limit: 15 });
        if (board.length === 0) {
          await sendMessage("📊 <b>Top LPers</b> — no data yet. Bot will populate this as it screens pools.").catch(() => {});
          return;
        }
        const lines = [`📊 <b>Top LPer Leaderboard</b> — ${board.length} tracked`];
        for (let i = 0; i < board.length; i++) {
          const e = board[i];
          const flag = e.promoted ? "✅" : "  ";
          lines.push(
            `${flag} ${i + 1}. <code>${e.address.slice(0, 8)}…</code> ${escapeHtml(e.name)}` +
            ` | pools=${e.pools_seen} pos=${e.total_positions} WR=${(e.win_rate * 100).toFixed(0)}% ROI=${(e.roi * 100).toFixed(1)}%` +
            ` | score=${e.score}`,
          );
        }
        lines.push("\n✅ = already promoted to smart-wallets");
        lines.push("Use /lpers promote &lt;addr&gt; or /lpers reject &lt;addr&gt;");
        const html = lines.join("\n");
        const ok = await sendHTML(html).catch((err) => { log("silent_warn", err.message); return null; });
        if (!ok) await sendMessage(html.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
        return;
      }

      if (sub === "stats") {
        const s = getLpersStats();
        const t = s.thresholds;
        const lines = [
          "📈 <b>Top LPer Tracker — Stats</b>",
          `Total tracked: <b>${s.total_tracked}</b>`,
          `  Promoted: ${s.promoted}`,
          `  Pending: ${s.pending}`,
          `  Near-qualifying: ${s.near_qualifying}`,
          `  Rejected: ${s.rejected}`,
          "",
          "Auto-promote thresholds:",
          `  pools_seen ≥ ${t.autoPromoteMinPools}`,
          `  win_rate ≥ ${(t.autoPromoteMinWinRate * 100).toFixed(0)}%`,
          `  total_positions ≥ ${t.autoPromoteMinPositions}`,
          `  enabled: ${t.autoPromoteEnabled ? "yes" : "no"}`,
          "",
          `History: ${s.promotions_log} promotions, ${s.rejections_log} rejections logged`,
        ];
        const html = lines.join("\n");
        const ok = await sendHTML(html).catch((err) => { log("silent_warn", err.message); return null; });
        if (!ok) await sendMessage(html.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
        return;
      }

      if (sub === "promote") {
        if (!arg1) { await sendMessage("Usage: /lpers promote <address> [reason]"); return; }
        const result = promoteLper({ address: arg1, reason: arg2 || "manual" });
        if (!result.ok) {
          if (result.reason === "invalid_address") { await sendMessage(`Invalid address: ${arg1}`); return; }
          if (result.reason === "not_found")       { await sendMessage(`Address not in tracker yet: ${arg1.slice(0, 12)}…`); return; }
          if (result.reason === "rejected")        { await sendMessage(`Address is in the rejected list. Use /lpers unreject first.`); return; }
          await sendMessage(`Promote failed: ${result.reason}`); return;
        }
        if (result.reason === "already_promoted") {
          await sendMessage(`Already promoted: ${arg1.slice(0, 12)}…`).catch(() => {});
          return;
        }
        await sendMessage(`✅ Promoted ${arg1.slice(0, 12)}… → added to smart-wallets.`).catch(() => {});
        return;
      }

      if (sub === "reject") {
        if (!arg1) { await sendMessage("Usage: /lpers reject <address> [reason]"); return; }
        const reason = arg2 || "operator";
        const result = rejectLper({ address: arg1, reason });
        if (!result.ok) { await sendMessage(`Reject failed: ${result.reason}`); return; }
        const tag = result.proactive ? " (pre-emptive)" : "";
        await sendMessage(`🚫 Rejected ${arg1.slice(0, 12)}…${tag} — ${reason}`).catch(() => {});
        return;
      }

      if (sub === "info") {
        if (!arg1) { await sendMessage("Usage: /lpers info <address>"); return; }
        const r = getLperRecord(arg1);
        if (!r) { await sendMessage(`Not tracked: ${arg1.slice(0, 12)}…`); return; }
        const stats = r.aggregate_stats || {};
        const lines = [
          `🔍 <b>${escapeHtml(r.name)}</b>`,
          `<code>${r.address}</code>`,
          `Status: ${r.promoted ? "✅ promoted" : r.rejected ? "🚫 rejected" : "⏳ pending"}`,
          r.rejected && r.rejection_reason ? `Rejection reason: ${escapeHtml(r.rejection_reason)}` : "",
          "",
          `pools_seen: ${r.pools_seen?.length || 0}`,
          `total_positions: ${stats.total_positions ?? 0}`,
          `win_rate: ${((stats.win_rate ?? 0) * 100).toFixed(1)}%`,
          `roi: ${((stats.roi ?? 0) * 100).toFixed(1)}%`,
          `avg_pnl_pct: ${(stats.avg_pnl_pct ?? 0).toFixed(2)}%`,
          `preferred: ${stats.preferred_strategy || "?"} / ${stats.preferred_range_style || "?"}`,
          "",
          `first_seen: ${(r.first_seen_at || "").slice(0, 19)}`,
          `last_seen: ${(r.last_seen_at || "").slice(0, 19)}`,
        ].filter(Boolean);
        if (r.pools_seen?.length) {
          lines.push("\nPools:");
          for (const p of r.pools_seen.slice(0, 6)) {
            lines.push(`  • ${escapeHtml(p.pool_name || p.pool.slice(0, 10))} ×${p.count}`);
          }
        }
        const html = lines.join("\n");
        const ok = await sendHTML(html).catch((err) => { log("silent_warn", err.message); return null; });
        if (!ok) await sendMessage(html.replace(/<[^>]+>/g, "")).catch((err) => log("silent_warn", err.message));
        return;
      }

      await sendMessage(
        "Unknown /lpers subcommand. Try: /lpers | /lpers stats | /lpers promote <addr> | /lpers reject <addr> [reason] | /lpers info <addr>",
      );
    } catch (e) {
      await sendMessage(`/lpers error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch((err) => log("silent_warn", err.message));
    return;
  }

  if (text === "/resume") {
    const breakerCleared = resumeBreaker({ manual: true });
    const lines = [];
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      lines.push("▶️ Autonomous cycles resumed.");
    } else if (!breakerCleared.wasResumed) {
      lines.push("Autonomous cycles are already running.");
    }
    if (breakerCleared.wasResumed) {
      lines.push("✅ Drawdown circuit breaker cleared — screening will resume next cycle.");
    }
    await sendMessage(lines.join("\n")).catch((err) => log("silent_warn", err.message));
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch((err) => log("silent_warn", err.message));
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch((err) => log("silent_warn", err.message));
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch((err) => log("silent_warn", err.message));
    }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch((err) => log("silent_warn", err.message));
    else await sendMessage(`Error: ${e.message}`).catch((err) => log("silent_warn", err.message));
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch((err) => log("silent_warn", err.message));
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch((err) => log("silent_warn", err.message));

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately. Must mirror launchCron() in TTY mode, i.e.
  // set the cronStarted flag and seed timers — otherwise Telegram control
  // panel reports the bot as paused (showing "▶️ Resume") and the
  // update_config restarter callback becomes a no-op until manual /resume.
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  cronStarted = true;
  timers.managementLastRun = Date.now();
  timers.screeningLastRun = Date.now();
  startCronJobs();
  maybeRunMissedBriefing().catch((err) => log("silent_warn", err.message));
  startPolling(telegramHandler);
  (async () => {
    try {
      const startupStep3 = process.env.DRY_RUN === "true"
        ? `3. Ignore wallet SOL threshold in dry run: get_top_candidates then simulate deploy ${DEPLOY} SOL.`
        : `3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL.`;
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. ${startupStep3} 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
