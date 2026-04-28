// Tests for lessons.evolveThresholds() — adaptive threshold tuning from
// closed-position performance data.
//
// These tests focus on the early-return paths and the structural shape of
// the result object. The function has filesystem side effects (writes to
// user-config.json relative to lessons.js's __dirname, plus lessons.json
// in cwd) so we mock fs.writeFileSync to avoid clobbering real state.
//
// More extensive evolution-path tests for individual threshold keys
// (maxVolatility, minFeeActiveTvlRatio, minOrganic) belong with the P0
// fixes that correct the key references in evolveThresholds — adding
// those is tracked as follow-up work after #1 merges to experimental.

import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-evolve-test-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

// Mock fs.writeFileSync globally so evolveThresholds doesn't clobber the
// real user-config.json or lessons.json. Read paths still go to disk.
const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation(() => false);

const { evolveThresholds } = await import("../lessons.js");

const baseConfig = {
  screening: {
    maxVolatility: 5.0,
    minFeeActiveTvlRatio: 0.05,
    minFeeTvlRatio: 0.05,
    minOrganic: 60,
  },
};

function makeWinner(overrides = {}) {
  return {
    pnl_pct: 10,
    volatility: 2.0,
    fee_tvl_ratio: 0.3,
    organic_score: 80,
    ...overrides,
  };
}

function makeLoser(overrides = {}) {
  return {
    pnl_pct: -10,
    volatility: 8.0,
    fee_tvl_ratio: 0.05,
    organic_score: 50,
    ...overrides,
  };
}

beforeEach(() => {
  writeSpy.mockClear();
});

describe("evolveThresholds — early returns", () => {
  it("returns null when perfData is empty", () => {
    expect(evolveThresholds([], baseConfig)).toBe(null);
  });

  it("returns null when perfData is below MIN_EVOLVE_POSITIONS (5)", () => {
    const data = [makeWinner(), makeWinner(), makeWinner(), makeLoser()];
    expect(evolveThresholds(data, baseConfig)).toBe(null);
  });

  it("returns null when perfData is null/undefined", () => {
    expect(evolveThresholds(null, baseConfig)).toBe(null);
    expect(evolveThresholds(undefined, baseConfig)).toBe(null);
  });

  it("returns null when no winner/loser signal (all break-even)", () => {
    // pnl_pct between -5 and 0 → not a loser, not a winner
    const data = [
      { pnl_pct: -3, volatility: 2, fee_tvl_ratio: 0.1, organic_score: 70 },
      { pnl_pct: -2, volatility: 2, fee_tvl_ratio: 0.1, organic_score: 70 },
      { pnl_pct: -4, volatility: 2, fee_tvl_ratio: 0.1, organic_score: 70 },
      { pnl_pct: -1, volatility: 2, fee_tvl_ratio: 0.1, organic_score: 70 },
      { pnl_pct: -2, volatility: 2, fee_tvl_ratio: 0.1, organic_score: 70 },
    ];
    expect(evolveThresholds(data, baseConfig)).toBe(null);
  });
});

describe("evolveThresholds — structure", () => {
  it("returns { changes, rationale } object when signal present", () => {
    // 3 winners + 3 losers; losers cluster at high volatility, low organic
    const data = [
      makeWinner({ volatility: 1, organic_score: 85 }),
      makeWinner({ volatility: 2, organic_score: 80 }),
      makeWinner({ volatility: 3, organic_score: 90 }),
      makeLoser({ volatility: 7, organic_score: 50 }),
      makeLoser({ volatility: 8, organic_score: 45 }),
      makeLoser({ volatility: 9, organic_score: 40 }),
    ];
    const result = evolveThresholds(data, baseConfig);
    expect(result).not.toBe(null);
    expect(result).toHaveProperty("changes");
    expect(result).toHaveProperty("rationale");
    // every change key should have a matching rationale string
    for (const key of Object.keys(result.changes)) {
      expect(result.rationale[key]).toBeTypeOf("string");
    }
  });

  it("evolves minOrganic when there's a clear winner/loser organic gap", () => {
    const data = [
      makeWinner({ organic_score: 85, pnl_pct: 15 }),
      makeWinner({ organic_score: 90, pnl_pct: 12 }),
      makeWinner({ organic_score: 88, pnl_pct: 8 }),
      makeLoser({ organic_score: 50, pnl_pct: -20 }),
      makeLoser({ organic_score: 55, pnl_pct: -15 }),
      makeLoser({ organic_score: 45, pnl_pct: -10 }),
    ];
    const cfg = { screening: { ...baseConfig.screening, minOrganic: 60 } };
    const result = evolveThresholds(data, cfg);
    // minOrganic raise toward minWinnerOrganic - 3 = 82, capped by max-step
    expect(result.changes.minOrganic).toBeGreaterThan(60);
    expect(result.changes.minOrganic).toBeLessThanOrEqual(90);
  });

  it("does NOT evolve minOrganic when avg gap is too small (< 10)", () => {
    const data = [
      makeWinner({ organic_score: 65 }),
      makeWinner({ organic_score: 70 }),
      makeWinner({ organic_score: 68 }),
      makeLoser({ organic_score: 60 }),
      makeLoser({ organic_score: 62 }),
      makeLoser({ organic_score: 58 }),
    ];
    const cfg = { screening: { ...baseConfig.screening, minOrganic: 60 } };
    const result = evolveThresholds(data, cfg);
    expect(result?.changes?.minOrganic).toBeUndefined();
  });
});

// Cleanup at module unload — vitest runs afterAll once per file
import { afterAll } from "vitest";
afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  writeSpy.mockRestore();
  existsSpy.mockRestore();
});
