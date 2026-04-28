// Tests for state.js — position registry, trailing TP, OOR tracking.
//
// state.js writes to ./state.json relative to cwd. We chdir into a tmpdir
// per test file so we don't pollute the repo's real state.json or interfere
// with other tests running in parallel.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-state-test-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const {
  trackPosition,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
  getTrackedPosition,
  recordClose,
  queuePeakConfirmation,
  resolvePendingPeak,
  queueTrailingDropConfirmation,
  resolvePendingTrailingDrop,
  updatePnlAndCheckExits,
} = await import("../state.js");

const STATE_FILE = path.join(tmpDir, "state.json");

function resetState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

function deploy(addr, overrides = {}) {
  trackPosition({
    position: addr,
    pool: `pool_${addr}`,
    pool_name: `${addr}-USDC`,
    strategy: "bid_ask",
    bin_range: { min: 0, max: 100 },
    amount_sol: 0.5,
    active_bin: 50,
    bin_step: 100,
    volatility: 2,
    fee_tvl_ratio: 0.1,
    organic_score: 80,
    initial_value_usd: 100,
    ...overrides,
  });
}

describe("trackPosition", () => {
  beforeEach(() => resetState());

  it("creates a new position with default tracking fields", () => {
    deploy("pos1");
    const pos = getTrackedPosition("pos1");
    expect(pos.position).toBe("pos1");
    expect(pos.peak_pnl_pct).toBe(0);
    expect(pos.trailing_active).toBe(false);
    expect(pos.closed).toBe(false);
    expect(pos.out_of_range_since).toBe(null);
    expect(pos.pending_peak_pnl_pct).toBe(null);
  });
});

describe("OOR tracking", () => {
  beforeEach(() => resetState());

  it("markOutOfRange sets a timestamp; markInRange clears it", () => {
    deploy("pos1");
    markOutOfRange("pos1");
    let pos = getTrackedPosition("pos1");
    expect(pos.out_of_range_since).not.toBe(null);

    markInRange("pos1");
    pos = getTrackedPosition("pos1");
    expect(pos.out_of_range_since).toBe(null);
  });

  it("minutesOutOfRange returns 0 when in range", () => {
    deploy("pos1");
    expect(minutesOutOfRange("pos1")).toBe(0);
  });

  it("minutesOutOfRange counts elapsed time when out of range", () => {
    deploy("pos1");
    markOutOfRange("pos1");
    // backdate the timestamp
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state.positions.pos1.out_of_range_since = new Date(Date.now() - 5 * 60_000).toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    expect(minutesOutOfRange("pos1")).toBe(5);
  });
});

describe("queuePeakConfirmation / resolvePendingPeak (trailing TP peak tracking)", () => {
  beforeEach(() => resetState());

  it("queues a candidate peak when above current peak", () => {
    deploy("pos1");
    const queued = queuePeakConfirmation("pos1", 5);
    expect(queued).toBe(true);
    const pos = getTrackedPosition("pos1");
    expect(pos.pending_peak_pnl_pct).toBe(5);
    expect(pos.peak_pnl_pct).toBe(0); // not committed until resolve
  });

  it("ignores a candidate peak below the current peak", () => {
    deploy("pos1");
    queuePeakConfirmation("pos1", 5);
    resolvePendingPeak("pos1", 5);
    expect(getTrackedPosition("pos1").peak_pnl_pct).toBe(5);

    const queued = queuePeakConfirmation("pos1", 3);
    expect(queued).toBe(false);
  });

  it("immediate option commits peak without confirmation", () => {
    deploy("pos1");
    queuePeakConfirmation("pos1", 7, { immediate: true });
    expect(getTrackedPosition("pos1").peak_pnl_pct).toBe(7);
    expect(getTrackedPosition("pos1").pending_peak_pnl_pct).toBe(null);
  });

  it("resolvePendingPeak confirms peak when current PnL is still close to candidate", () => {
    deploy("pos1");
    queuePeakConfirmation("pos1", 10);
    const result = resolvePendingPeak("pos1", 9.5); // within 85% tolerance
    expect(result.confirmed).toBe(true);
    expect(getTrackedPosition("pos1").peak_pnl_pct).toBeGreaterThanOrEqual(10);
  });

  it("resolvePendingPeak rejects spike when current PnL has dropped far below candidate", () => {
    deploy("pos1");
    queuePeakConfirmation("pos1", 10);
    const result = resolvePendingPeak("pos1", 1); // way below 85% of 10 = 8.5
    expect(result.confirmed).toBe(false);
    expect(result.rejected).toBe(true);
    expect(getTrackedPosition("pos1").peak_pnl_pct).toBe(0); // never committed
  });
});

describe("queueTrailingDropConfirmation / resolvePendingTrailingDrop", () => {
  beforeEach(() => resetState());

  it("does not queue if drop from peak is below trailingDropPct", () => {
    deploy("pos1");
    // peak 10, current 9.5, drop=0.5, trailingDropPct=1.5 → no queue
    const queued = queueTrailingDropConfirmation("pos1", 10, 9.5, 1.5);
    expect(queued).toBe(false);
  });

  it("queues if drop from peak >= trailingDropPct", () => {
    deploy("pos1");
    // peak 10, current 8, drop=2, trailingDropPct=1.5 → queue
    const queued = queueTrailingDropConfirmation("pos1", 10, 8, 1.5);
    expect(queued).toBe(true);
    const pos = getTrackedPosition("pos1");
    expect(pos.pending_trailing_peak_pnl_pct).toBe(10);
    expect(pos.pending_trailing_current_pnl_pct).toBe(8);
  });

  it("resolvePendingTrailingDrop confirms when drop persists", () => {
    deploy("pos1");
    queueTrailingDropConfirmation("pos1", 10, 7, 1.5);
    const result = resolvePendingTrailingDrop("pos1", 7.2, 1.5, 1.0);
    expect(result.confirmed).toBe(true);
    expect(getTrackedPosition("pos1").confirmed_trailing_exit_reason).toMatch(/Trailing TP/);
  });

  it("resolvePendingTrailingDrop rejects when PnL recovered", () => {
    deploy("pos1");
    queueTrailingDropConfirmation("pos1", 10, 7, 1.5);
    // recovered to 9.5 — pendingCurrent was 7, pendingCurrent + tolerance(1.0) = 8 < 9.5 → not stillNearCrash
    const result = resolvePendingTrailingDrop("pos1", 9.5, 1.5, 1.0);
    expect(result.confirmed).toBe(false);
    expect(getTrackedPosition("pos1").confirmed_trailing_exit_reason).toBe(null);
  });
});

describe("updatePnlAndCheckExits", () => {
  beforeEach(() => resetState());

  const mgmt = {
    trailingTakeProfit: true,
    trailingTriggerPct: 3,
    trailingDropPct: 1.5,
    stopLossPct: -50,
    outOfRangeWaitMinutes: 30,
    minAgeBeforeYieldCheck: 60,
    minFeePerTvl24h: 7,
  };

  it("returns null when no exit condition met", () => {
    deploy("pos1");
    const result = updatePnlAndCheckExits("pos1", { pnl_pct: 1, in_range: true, age_minutes: 5 }, mgmt);
    expect(result).toBe(null);
  });

  it("activates trailing TP when peak crosses trigger threshold", () => {
    deploy("pos1");
    // Set peak above trigger
    queuePeakConfirmation("pos1", 4, { immediate: true });
    updatePnlAndCheckExits("pos1", { pnl_pct: 4, in_range: true }, mgmt);
    expect(getTrackedPosition("pos1").trailing_active).toBe(true);
  });

  it("returns STOP_LOSS when PnL crashes below stopLossPct", () => {
    deploy("pos1");
    const result = updatePnlAndCheckExits(
      "pos1",
      { pnl_pct: -60, in_range: true, age_minutes: 5 },
      mgmt,
    );
    expect(result?.action).toBe("STOP_LOSS");
  });

  it("does NOT trigger STOP_LOSS when pnl is suspicious", () => {
    deploy("pos1");
    const result = updatePnlAndCheckExits(
      "pos1",
      { pnl_pct: -60, pnl_pct_suspicious: true, in_range: true, age_minutes: 5 },
      mgmt,
    );
    expect(result).toBe(null);
  });

  it("returns OUT_OF_RANGE only after waitMinutes elapses", () => {
    deploy("pos1");
    // Trigger OOR via state mutation
    const state1 = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state1.positions.pos1.out_of_range_since = new Date(Date.now() - 60 * 60_000).toISOString(); // 60 minutes ago
    fs.writeFileSync(STATE_FILE, JSON.stringify(state1));

    const result = updatePnlAndCheckExits(
      "pos1",
      { pnl_pct: 0, in_range: false, age_minutes: 60 },
      mgmt,
    );
    expect(result?.action).toBe("OUT_OF_RANGE");
  });

  it("returns LOW_YIELD only after minAgeBeforeYieldCheck", () => {
    deploy("pos1");
    // age below threshold → no LOW_YIELD
    let result = updatePnlAndCheckExits(
      "pos1",
      { pnl_pct: 0, in_range: true, fee_per_tvl_24h: 1, age_minutes: 30 },
      mgmt,
    );
    expect(result).toBe(null);

    // age above threshold → LOW_YIELD
    result = updatePnlAndCheckExits(
      "pos1",
      { pnl_pct: 0, in_range: true, fee_per_tvl_24h: 1, age_minutes: 90 },
      mgmt,
    );
    expect(result?.action).toBe("LOW_YIELD");
  });
});
