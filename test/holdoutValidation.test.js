// Tests for hold-out validation in signal-weights.js — splitTrainHoldout +
// assessTrainHoldoutConsistency. These run as pure functions so we don't
// need to mock the filesystem.

import { describe, it, expect } from "vitest";
import {
  splitTrainHoldout,
  assessTrainHoldoutConsistency,
} from "../signal-weights.js";

// Helper: build a synthetic perf record with a signal_snapshot and PnL.
function rec(opts) {
  return {
    pnl_usd: opts.pnl_usd ?? 0,
    pnl_pct: opts.pnl_pct ?? 0,
    recorded_at: opts.recorded_at || "2026-04-01T00:00:00Z",
    signal_snapshot: opts.signals || {},
  };
}

describe("splitTrainHoldout", () => {
  it("returns empty buckets for empty input", () => {
    const { train, holdout } = splitTrainHoldout([]);
    expect(train).toEqual([]);
    expect(holdout).toEqual([]);
  });

  it("splits 10 records into 8 train + 2 holdout at 20% ratio", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const { train, holdout } = splitTrainHoldout(records, 0.2);
    expect(train.length).toBe(8);
    expect(holdout.length).toBe(2);
    // Stride=5, offset=4 → indices 4 and 9 go to holdout.
    expect(holdout.map((r) => r.id)).toEqual([4, 9]);
  });

  it("is deterministic across calls", () => {
    const records = Array.from({ length: 25 }, (_, i) => ({ id: i }));
    const a = splitTrainHoldout(records, 0.2);
    const b = splitTrainHoldout(records, 0.2);
    expect(a.holdout.map((r) => r.id)).toEqual(b.holdout.map((r) => r.id));
  });

  it("clamps stride to ≥2 to prevent edge cases", () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    // ratio=0.9 would give stride=1 without clamp; clamp to 2.
    const { train, holdout } = splitTrainHoldout(records, 0.9);
    expect(holdout.length).toBeGreaterThan(0);
    expect(train.length).toBeGreaterThan(0);
  });
});

describe("assessTrainHoldoutConsistency", () => {
  it("returns commit=false when train has no winners", () => {
    const train = [
      rec({ pnl_usd: -1, signals: { organic_score: 50 } }),
      rec({ pnl_usd: -2, signals: { organic_score: 60 } }),
    ];
    const holdout = [rec({ pnl_usd: 1, signals: { organic_score: 70 } })];
    const result = assessTrainHoldoutConsistency(train, holdout, 2);
    expect(result.commit).toBe(false);
    expect(result.reason).toMatch(/train missing/);
  });

  it("returns commit=true (skipped) when holdout missing buckets", () => {
    const train = [
      rec({ pnl_usd: 1, signals: { organic_score: 80 } }),
      rec({ pnl_usd: -1, signals: { organic_score: 40 } }),
    ];
    const holdout = [rec({ pnl_usd: 1, signals: { organic_score: 70 } })]; // only winner
    const result = assessTrainHoldoutConsistency(train, holdout, 2);
    expect(result.commit).toBe(true);
    expect(result.reason).toMatch(/holdout missing/);
  });

  it("returns commit=true when train and holdout signal lifts agree", () => {
    // Build a clear pattern: high organic_score → wins; low → losses.
    // Both train and holdout exhibit the same pattern.
    const train = [
      rec({ pnl_usd: 2, signals: { organic_score: 85, fee_tvl_ratio: 0.9, volume: 50_000 } }),
      rec({ pnl_usd: 3, signals: { organic_score: 90, fee_tvl_ratio: 1.1, volume: 60_000 } }),
      rec({ pnl_usd: 1, signals: { organic_score: 80, fee_tvl_ratio: 0.8, volume: 45_000 } }),
      rec({ pnl_usd: -1, signals: { organic_score: 50, fee_tvl_ratio: 0.3, volume: 10_000 } }),
      rec({ pnl_usd: -2, signals: { organic_score: 45, fee_tvl_ratio: 0.2, volume: 8_000 } }),
      rec({ pnl_usd: -1, signals: { organic_score: 55, fee_tvl_ratio: 0.4, volume: 12_000 } }),
    ];
    const holdout = [
      rec({ pnl_usd: 2, signals: { organic_score: 88, fee_tvl_ratio: 1.0, volume: 55_000 } }),
      rec({ pnl_usd: -1, signals: { organic_score: 48, fee_tvl_ratio: 0.25, volume: 9_000 } }),
      rec({ pnl_usd: 1, signals: { organic_score: 82, fee_tvl_ratio: 0.85, volume: 48_000 } }),
      rec({ pnl_usd: -2, signals: { organic_score: 42, fee_tvl_ratio: 0.15, volume: 7_000 } }),
    ];
    const result = assessTrainHoldoutConsistency(train, holdout, 4);
    expect(result.commit).toBe(true);
    expect(result.signMatches).toBeGreaterThanOrEqual(result.signTotal / 2);
  });

  it("returns commit=false when train and holdout strongly disagree", () => {
    // Train: high organic → wins. Holdout: high organic → losses (flipped).
    const train = [
      rec({ pnl_usd: 2, signals: { organic_score: 85, fee_tvl_ratio: 0.9, volume: 50_000, holder_count: 5_000 } }),
      rec({ pnl_usd: 3, signals: { organic_score: 90, fee_tvl_ratio: 1.1, volume: 60_000, holder_count: 6_000 } }),
      rec({ pnl_usd: 1, signals: { organic_score: 80, fee_tvl_ratio: 0.8, volume: 45_000, holder_count: 4_500 } }),
      rec({ pnl_usd: -1, signals: { organic_score: 50, fee_tvl_ratio: 0.3, volume: 10_000, holder_count: 1_000 } }),
      rec({ pnl_usd: -2, signals: { organic_score: 45, fee_tvl_ratio: 0.2, volume: 8_000, holder_count: 800 } }),
      rec({ pnl_usd: -1, signals: { organic_score: 55, fee_tvl_ratio: 0.4, volume: 12_000, holder_count: 1_500 } }),
    ];
    const holdout = [
      // Inverted pattern: high signals lose, low signals win.
      rec({ pnl_usd: -2, signals: { organic_score: 88, fee_tvl_ratio: 1.0, volume: 55_000, holder_count: 5_500 } }),
      rec({ pnl_usd: 1, signals: { organic_score: 48, fee_tvl_ratio: 0.25, volume: 9_000, holder_count: 900 } }),
      rec({ pnl_usd: -3, signals: { organic_score: 92, fee_tvl_ratio: 1.2, volume: 70_000, holder_count: 7_000 } }),
      rec({ pnl_usd: 2, signals: { organic_score: 42, fee_tvl_ratio: 0.15, volume: 6_000, holder_count: 700 } }),
    ];
    const result = assessTrainHoldoutConsistency(train, holdout, 4);
    expect(result.commit).toBe(false);
    expect(result.reason).toMatch(/disagreement|noise/);
  });

  it("returns commit=true with 'too few signals' when only 1-2 signals validate", () => {
    // Records with only ONE signal populated → only that one is validated.
    const train = [
      rec({ pnl_usd: 2, signals: { organic_score: 85 } }),
      rec({ pnl_usd: -1, signals: { organic_score: 45 } }),
    ];
    const holdout = [
      rec({ pnl_usd: 1, signals: { organic_score: 80 } }),
      rec({ pnl_usd: -1, signals: { organic_score: 40 } }),
    ];
    const result = assessTrainHoldoutConsistency(train, holdout, 2);
    expect(result.commit).toBe(true);
    expect(result.signTotal).toBeLessThan(3);
    expect(result.reason).toMatch(/too few/);
  });
});
