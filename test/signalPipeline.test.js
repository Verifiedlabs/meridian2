// Tests for the Darwin signal pipeline: screening signals must flow from
// signal-tracker (staged at screen time) → state.js trackPosition
// (signal_snapshot field) → lessons.js recordPerformance (perf entry).
//
// Without this end-to-end attachment, signal-weights.js can never compute
// win-vs-loss lift per signal (every entry has signal_snapshot=null) and
// the Darwinian weighting system stays dormant — which is exactly what
// happened in production for ~117 closes before this fix.
//
// We isolate filesystem side-effects via process.chdir(tmpdir) and stub
// hivemind so no network call leaks out of CI.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-signal-pipeline-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

// Keep recordPerformance offline — the hivemind module short-circuits on
// !enabled, but mocking is more robust than relying on env state.
vi.mock("../hivemind.js", () => ({
  pushHiveLesson: async () => null,
  pushHivePerformanceEvent: async () => null,
  getSharedLessonsForPrompt: () => [],
  shouldCountInAdjustedWinRate: () => true,
}));

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const {
  stageSignals,
  getAndClearStagedSignals,
  getStagedPools,
} = await import("../signal-tracker.js");
const { trackPosition, getTrackedPosition } = await import("../state.js");
const { recordPerformance } = await import("../lessons.js");

const STATE_FILE = path.join(tmpDir, "state.json");
const LESSONS_FILE = path.join(tmpDir, "lessons.json");

function resetWorld() {
  for (const f of [STATE_FILE, LESSONS_FILE, path.join(tmpDir, "pool-memory.json"), path.join(tmpDir, "signal-weights.json"), path.join(tmpDir, "circuit-breaker.json")]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  // Drain any leftover staged signals between tests
  for (const pool of getStagedPools()) getAndClearStagedSignals(pool);
}

describe("signal-tracker stage / clear round-trip", () => {
  beforeEach(resetWorld);

  it("returns null when nothing was staged for the pool", () => {
    expect(getAndClearStagedSignals("never_staged_pool")).toBe(null);
  });

  it("returns the staged signals on first call and null thereafter (destructive read)", () => {
    const sig = { organic_score: 80, fee_tvl_ratio: 1.2, smart_wallets_present: true };
    stageSignals("poolA", sig);
    const first = getAndClearStagedSignals("poolA");
    expect(first).toMatchObject(sig);
    // The staged_at marker is internal — should be stripped from the returned signals.
    expect(first).not.toHaveProperty("staged_at");
    // Second call returns null — staging is one-shot.
    expect(getAndClearStagedSignals("poolA")).toBe(null);
  });

  it("isolates signals per pool", () => {
    stageSignals("poolA", { organic_score: 80 });
    stageSignals("poolB", { organic_score: 40 });
    expect(getAndClearStagedSignals("poolA").organic_score).toBe(80);
    expect(getAndClearStagedSignals("poolB").organic_score).toBe(40);
  });
});

describe("state.trackPosition preserves signal_snapshot", () => {
  beforeEach(resetWorld);

  it("stores signal_snapshot when explicitly passed", () => {
    const snap = { organic_score: 75, fee_tvl_ratio: 0.9, smart_wallets_present: true };
    trackPosition({
      position: "pos_with_signals",
      pool: "poolA",
      pool_name: "TEST-SOL",
      strategy: "bid_ask",
      bin_range: { min: 0, max: 30 },
      amount_sol: 0.5,
      active_bin: 15,
      bin_step: 100,
      volatility: 2,
      fee_tvl_ratio: 0.9,
      organic_score: 75,
      initial_value_usd: 100,
      signal_snapshot: snap,
    });
    const tracked = getTrackedPosition("pos_with_signals");
    expect(tracked.signal_snapshot).toEqual(snap);
  });

  it("defaults signal_snapshot to null when omitted (back-compat)", () => {
    trackPosition({
      position: "pos_no_signals",
      pool: "poolB",
      pool_name: "PLAIN-SOL",
      strategy: "spot",
      bin_range: { min: 0, max: 30 },
      amount_sol: 0.5,
      active_bin: 15,
      bin_step: 100,
      volatility: 2,
      fee_tvl_ratio: 0.5,
      organic_score: 60,
      initial_value_usd: 100,
    });
    expect(getTrackedPosition("pos_no_signals").signal_snapshot).toBe(null);
  });
});

describe("integration: signal-tracker → state → lessons", () => {
  beforeEach(resetWorld);

  it("stages signals, attaches via getAndClearStagedSignals + trackPosition, then recordPerformance persists them", async () => {
    const stagedSig = {
      organic_score: 82,
      fee_tvl_ratio: 1.1,
      volume: 55_000,
      mcap: 850_000,
      holder_count: 3_400,
      smart_wallets_present: true,
      narrative_quality: "present",
      volatility: 2.4,
      twitter_sentiment: "positive",
    };

    // 1. Screening stages signals (this happens in index.js before deploy)
    stageSignals("integ_pool", stagedSig);

    // 2. Deploy retrieves and clears them (this is the new line in dlmm.js)
    const retrieved = getAndClearStagedSignals("integ_pool");
    expect(retrieved).toMatchObject(stagedSig);

    // 3. trackPosition stores them on the tracked position record
    trackPosition({
      position: "integ_pos",
      pool: "integ_pool",
      pool_name: "INTEG-SOL",
      strategy: "bid_ask",
      bin_range: { min: 0, max: 30 },
      amount_sol: 0.5,
      active_bin: 15,
      bin_step: 100,
      volatility: stagedSig.volatility,
      fee_tvl_ratio: stagedSig.fee_tvl_ratio,
      organic_score: stagedSig.organic_score,
      initial_value_usd: 100,
      signal_snapshot: retrieved,
    });

    const tracked = getTrackedPosition("integ_pos");
    expect(tracked.signal_snapshot).toEqual(stagedSig);

    // 4. On close, recordPerformance copies signal_snapshot from tracked
    //    into the perf entry written to lessons.json
    await recordPerformance({
      position: "integ_pos",
      pool: "integ_pool",
      pool_name: "INTEG-SOL",
      base_mint: "mintXYZ",
      strategy: tracked.strategy,
      bin_range: tracked.bin_range,
      bin_step: tracked.bin_step,
      volatility: tracked.volatility,
      fee_tvl_ratio: tracked.fee_tvl_ratio,
      organic_score: tracked.organic_score,
      amount_sol: tracked.amount_sol,
      fees_earned_usd: 5,
      final_value_usd: 110,
      initial_value_usd: 100,
      minutes_in_range: 90,
      minutes_held: 100,
      close_reason: "Take profit",
      signal_snapshot: tracked.signal_snapshot,
    });

    // 5. Verify the written lessons.json carries the signal_snapshot end-to-end
    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    expect(data.performance.length).toBe(1);
    const entry = data.performance[0];
    expect(entry.position).toBe("integ_pos");
    expect(entry.signal_snapshot).toEqual(stagedSig);
    // PnL should be positive (final 110 + fees 5 - initial 100 = +15)
    expect(entry.pnl_usd).toBeGreaterThan(0);
  });

  it("recordPerformance writes signal_snapshot=null when caller omits it (back-compat regression guard)", async () => {
    await recordPerformance({
      position: "no_sig_pos",
      pool: "no_sig_pool",
      pool_name: "NOSIG-SOL",
      base_mint: "mintABC",
      strategy: "spot",
      bin_range: { min: 0, max: 30 },
      bin_step: 100,
      volatility: 2,
      fee_tvl_ratio: 0.5,
      organic_score: 60,
      amount_sol: 0.5,
      fees_earned_usd: 1,
      final_value_usd: 95,
      initial_value_usd: 100,
      minutes_in_range: 50,
      minutes_held: 60,
      close_reason: "Out of range",
    });

    const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    expect(data.performance.length).toBe(1);
    // signal_snapshot is absent OR null — both are acceptable for a record
    // that pre-dates the Darwin pipeline fix
    const entry = data.performance[0];
    expect(entry.signal_snapshot ?? null).toBe(null);
  });
});
