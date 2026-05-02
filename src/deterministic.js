/**
 * Deterministic close-rule evaluator extracted from index.js.
 *
 * This is the rules engine that runs on every management cycle BEFORE the
 * LLM is invoked. If any rule fires, the position is closed without asking
 * the model — saves an API call and removes a class of "model failed to
 * close in time" failures.
 *
 * Rules evaluated, in order:
 *   1. Stop loss      — pnl_pct <= managementConfig.stopLossPct
 *   2. Take profit    — pnl_pct >= managementConfig.takeProfitPct
 *   3. Pumped above   — active_bin > upper_bin + outOfRangeBinsToClose,
 *                       AND (age_minutes >= minAgeBeforeOORExit
 *                            OR unclaimed_fees_usd >= minOORFastExitFeesUsd)
 *   4. OOR timeout    — active_bin > upper_bin and minutes_out_of_range >= outOfRangeWaitMinutes
 *   5. Low yield      — fee_per_tvl_24h < minFeePerTvl24h and age_minutes >= 60
 *
 * PnL-suspect protection: when pnl_pct is < -90% but the position still has
 * non-trivial value, we treat the PnL number as an oracle glitch and skip
 * the PnL-based rules (1, 2). The OOR/yield rules still apply.
 *
 * Rule 3 age guard: too-young pumped positions stall the fast-exit because
 * a fresh deploy that pumps within seconds rarely accumulates meaningful
 * fees, and the close costs gas. With the age guard, positions get a
 * grace window (minAgeBeforeOORExit) for fees to accumulate or for the
 * price to retrace into range. The slower OOR-timeout (rule 4) still
 * fires unaffected once the position has been OOR for outOfRangeWaitMinutes.
 */

import { log } from "../logger.js";
import { getTrackedPosition } from "../state.js";

export function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    // Age / fees guard: don't fast-exit a freshly-pumped position before
    // it has had a chance to either (a) survive the spike and earn fees,
    // or (b) actually accumulate enough fees to justify the gas cost of
    // exiting now. Defaults are conservative: 5 min OR $0 fees (== age
    // alone). Either condition is sufficient.
    const minAge = managementConfig.minAgeBeforeOORExit ?? 5;
    const minFees = managementConfig.minOORFastExitFeesUsd ?? 0;
    const age = position.age_minutes ?? Number.POSITIVE_INFINITY; // unknown age = treat as old enough
    const fees = position.unclaimed_fees_usd ?? 0;
    const ageOK = age >= minAge;
    const feesOK = minFees > 0 && fees >= minFees;
    if (ageOK || feesOK) {
      return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
    }
    // Hold — too young, not enough fees yet. Rule 4 (timer-based OOR)
    // will still fire once the position has been OOR for outOfRangeWaitMinutes.
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}
