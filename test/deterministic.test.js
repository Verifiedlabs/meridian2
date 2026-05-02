// Tests for src/deterministic.js — the close-rule engine that runs BEFORE
// the LLM is invoked. We focus on the new rule 3 age/fees guard while
// also covering the existing rules to lock in expected behaviour.

import { describe, it, expect, vi } from "vitest";

// state.js is imported by deterministic.js for the PnL-suspect check via
// getTrackedPosition. Stub it out so tests don't read a real state.json.
vi.mock("../state.js", () => ({
  getTrackedPosition: () => null,
}));

vi.mock("../logger.js", () => ({
  log: () => {},
}));

const { getDeterministicCloseRule } = await import("../src/deterministic.js");

const baseMgmt = {
  stopLossPct: -6,
  takeProfitPct: 4,
  outOfRangeBinsToClose: 8,
  outOfRangeWaitMinutes: 20,
  minFeePerTvl24h: 7,
  minAgeBeforeOORExit: 5,
  minOORFastExitFeesUsd: 0,
};

function pos(overrides = {}) {
  return {
    position: "pos-x",
    pair: "X-SOL",
    pnl_pct: 1,
    active_bin: 100,
    upper_bin: 100,
    minutes_out_of_range: 0,
    age_minutes: 30,
    fee_per_tvl_24h: 50,
    unclaimed_fees_usd: 0,
    total_value_usd: 25,
    ...overrides,
  };
}

describe("getDeterministicCloseRule", () => {
  it("fires STOP_LOSS when pnl_pct <= stopLossPct", () => {
    const result = getDeterministicCloseRule(pos({ pnl_pct: -7 }), baseMgmt);
    expect(result).toEqual({ action: "CLOSE", rule: 1, reason: "stop loss" });
  });

  it("fires TAKE_PROFIT when pnl_pct >= takeProfitPct", () => {
    const result = getDeterministicCloseRule(pos({ pnl_pct: 5 }), baseMgmt);
    expect(result).toEqual({ action: "CLOSE", rule: 2, reason: "take profit" });
  });

  it("does NOT fire rule 3 when position is too young", () => {
    // active_bin pumped 9 bins above upper_bin → would have fired pre-guard.
    // age_minutes < minAgeBeforeOORExit and no fees earned → guard holds it.
    const result = getDeterministicCloseRule(pos({
      pnl_pct: 0,
      active_bin: 110,
      upper_bin: 100,
      age_minutes: 1,
      unclaimed_fees_usd: 0,
    }), baseMgmt);
    expect(result).toBeNull();
  });

  it("DOES fire rule 3 once position is old enough", () => {
    const result = getDeterministicCloseRule(pos({
      pnl_pct: 0,
      active_bin: 110,
      upper_bin: 100,
      age_minutes: 6, // > 5 min
      unclaimed_fees_usd: 0,
    }), baseMgmt);
    expect(result).toEqual({ action: "CLOSE", rule: 3, reason: "pumped far above range" });
  });

  it("DOES fire rule 3 for young positions when fees-earned override is enabled and met", () => {
    const result = getDeterministicCloseRule(pos({
      pnl_pct: 0,
      active_bin: 110,
      upper_bin: 100,
      age_minutes: 1,
      unclaimed_fees_usd: 0.10,
    }), { ...baseMgmt, minOORFastExitFeesUsd: 0.05 });
    expect(result).toEqual({ action: "CLOSE", rule: 3, reason: "pumped far above range" });
  });

  it("does NOT fire rule 3 when fees-earned override is disabled (default 0) AND too young", () => {
    const result = getDeterministicCloseRule(pos({
      pnl_pct: 0,
      active_bin: 110,
      upper_bin: 100,
      age_minutes: 2,
      unclaimed_fees_usd: 100,
    }), baseMgmt); // minOORFastExitFeesUsd = 0 disables fee-override
    expect(result).toBeNull();
  });

  it("rule 4 (OOR timeout) still fires regardless of age guard", () => {
    // Inside OOR but not yet 8 bins above. minutes_out_of_range >= 20.
    // Even though age_minutes < minAgeBeforeOORExit, rule 4 is age-agnostic
    // and uses its own timer (outOfRangeWaitMinutes).
    const result = getDeterministicCloseRule(pos({
      pnl_pct: 0,
      active_bin: 102,
      upper_bin: 100,
      minutes_out_of_range: 25,
      age_minutes: 2,
    }), baseMgmt);
    expect(result).toEqual({ action: "CLOSE", rule: 4, reason: "OOR" });
  });

  it("rule 5 (low yield) only fires after age threshold", () => {
    const young = getDeterministicCloseRule(pos({
      fee_per_tvl_24h: 1,
      age_minutes: 30,
    }), baseMgmt);
    expect(young).toBeNull();

    const old = getDeterministicCloseRule(pos({
      fee_per_tvl_24h: 1,
      age_minutes: 70,
    }), baseMgmt);
    expect(old).toEqual({ action: "CLOSE", rule: 5, reason: "low yield" });
  });

  it("returns null when no rule matches", () => {
    const result = getDeterministicCloseRule(pos(), baseMgmt);
    expect(result).toBeNull();
  });

  it("falls back to legacy behaviour (always-fire rule 3) when minAgeBeforeOORExit = 0", () => {
    const result = getDeterministicCloseRule(pos({
      pnl_pct: 0,
      active_bin: 110,
      upper_bin: 100,
      age_minutes: 0.5,
      unclaimed_fees_usd: 0,
    }), { ...baseMgmt, minAgeBeforeOORExit: 0 });
    expect(result).toEqual({ action: "CLOSE", rule: 3, reason: "pumped far above range" });
  });

  it("treats unknown age (null) as old-enough so rule 3 still fires", () => {
    // Defensive: if the upstream caller couldn't compute age_minutes, we
    // shouldn't trap the position into the fast-exit branch indefinitely.
    const result = getDeterministicCloseRule(pos({
      pnl_pct: 0,
      active_bin: 110,
      upper_bin: 100,
      age_minutes: null,
      unclaimed_fees_usd: 0,
    }), baseMgmt);
    expect(result).toEqual({ action: "CLOSE", rule: 3, reason: "pumped far above range" });
  });
});
