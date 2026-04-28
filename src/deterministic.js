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
 *   3. Pumped above   — active_bin > upper_bin + outOfRangeBinsToClose
 *   4. OOR timeout    — active_bin > upper_bin and minutes_out_of_range >= outOfRangeWaitMinutes
 *   5. Low yield      — fee_per_tvl_24h < minFeePerTvl24h and age_minutes >= 60
 *
 * PnL-suspect protection: when pnl_pct is < -90% but the position still has
 * non-trivial value, we treat the PnL number as an oracle glitch and skip
 * the PnL-based rules (1, 2). The OOR/yield rules still apply.
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
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
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
