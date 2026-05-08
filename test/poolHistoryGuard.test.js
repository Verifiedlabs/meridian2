// Tests for B2: pool concentration guard.
//
// Verifies the read-only stats lookup in pool-memory.js. The guard logic
// itself lives inline in tools/screening.js (as a filter predicate) and
// is exercised end-to-end via discoverPools integration tests; here we
// focus on the data primitive that drives the guard.

import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-pool-guard-test-"));
process.chdir(tmpDir);

// In-memory pool-memory store
let memPoolMemory = {};

function classifyPath(target) {
  const file = String(target);
  const base = file.replace(/\.tmp\.\d+\.\d+$/, "");
  if (base.endsWith("pool-memory.json")) return "pool_memory";
  return null;
}

vi.spyOn(fs, "writeFileSync").mockImplementation((target, contents) => {
  if (classifyPath(target) === "pool_memory") {
    try { memPoolMemory = JSON.parse(contents); } catch { /* ignore */ }
  }
});
vi.spyOn(fs, "renameSync").mockImplementation(() => {});
vi.spyOn(fs, "existsSync").mockImplementation((target) => classifyPath(target) !== null);
vi.spyOn(fs, "readFileSync").mockImplementation((target) => {
  if (classifyPath(target) === "pool_memory") return JSON.stringify(memPoolMemory);
  return "{}";
});
vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});

const { getPoolHistoryStats } = await import("../pool-memory.js");

beforeEach(() => {
  memPoolMemory = {};
});

describe("getPoolHistoryStats", () => {
  it("returns null for unknown pool", () => {
    expect(getPoolHistoryStats("UnknownPool111")).toBeNull();
  });

  it("returns null for pools without recorded deploys", () => {
    memPoolMemory["Pool1"] = {
      name: "TEST-SOL",
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
    };
    expect(getPoolHistoryStats("Pool1")).toBeNull();
  });

  it("returns stats snapshot for a pool with deploy history", () => {
    memPoolMemory["Pool1"] = {
      name: "TEST-SOL",
      total_deploys: 3,
      avg_pnl_pct: -2.5,
      win_rate: 0.33,
      last_outcome: "loss",
      deploys: [],
    };
    const stats = getPoolHistoryStats("Pool1");
    expect(stats).toEqual({
      name: "TEST-SOL",
      total_deploys: 3,
      avg_pnl_pct: -2.5,
      win_rate: 0.33,
      last_outcome: "loss",
    });
  });

  it("returns null for empty/missing pool address", () => {
    expect(getPoolHistoryStats(null)).toBeNull();
    expect(getPoolHistoryStats("")).toBeNull();
    expect(getPoolHistoryStats(undefined)).toBeNull();
  });
});

// ── Guard predicate: replicate the screening filter logic so we
// catch regressions if it ever gets refactored ────────────────────────
describe("Guard filter predicate (matches screening.js inline guard)", () => {
  function shouldFilter(pool, cfg) {
    if (cfg.poolHistoryGuardEnabled === false) return null;
    const stats = getPoolHistoryStats(pool);
    const minSamples = Number.isFinite(cfg.poolHistoryMinSamples)
      ? cfg.poolHistoryMinSamples
      : 3;
    const maxAvgPnl = Number.isFinite(cfg.poolHistoryMaxAvgPnl)
      ? cfg.poolHistoryMaxAvgPnl
      : -1;
    if (stats && stats.total_deploys >= minSamples && stats.avg_pnl_pct <= maxAvgPnl) {
      return { reason: "bad pool history", stats };
    }
    return null;
  }

  const defaultCfg = {
    poolHistoryGuardEnabled: true,
    poolHistoryMinSamples: 3,
    poolHistoryMaxAvgPnl: -1,
  };

  it("filters pools with ≥3 deploys and avg PnL ≤ -1%", () => {
    memPoolMemory["BadPool"] = { name: "BAD-SOL", total_deploys: 3, avg_pnl_pct: -2.11, win_rate: 0.33 };
    expect(shouldFilter("BadPool", defaultCfg)).not.toBeNull();
  });

  it("does NOT filter pools with insufficient samples (<3)", () => {
    memPoolMemory["NewPool"] = { name: "NEW-SOL", total_deploys: 2, avg_pnl_pct: -5, win_rate: 0 };
    expect(shouldFilter("NewPool", defaultCfg)).toBeNull();
  });

  it("does NOT filter pools above PnL threshold", () => {
    memPoolMemory["OkPool"] = { name: "OK-SOL", total_deploys: 5, avg_pnl_pct: 1.5, win_rate: 0.6 };
    expect(shouldFilter("OkPool", defaultCfg)).toBeNull();
  });

  it("does NOT filter pools at exactly the boundary (avg = 0)", () => {
    memPoolMemory["BreakEven"] = { name: "BE-SOL", total_deploys: 4, avg_pnl_pct: 0, win_rate: 0.5 };
    expect(shouldFilter("BreakEven", defaultCfg)).toBeNull();
  });

  it("filters at exact maxAvgPnl boundary (-1%)", () => {
    memPoolMemory["EdgePool"] = { name: "EDGE-SOL", total_deploys: 3, avg_pnl_pct: -1, win_rate: 0.33 };
    expect(shouldFilter("EdgePool", defaultCfg)).not.toBeNull();
  });

  it("can be disabled via config flag", () => {
    memPoolMemory["BadPool"] = { name: "BAD-SOL", total_deploys: 5, avg_pnl_pct: -3, win_rate: 0.2 };
    const disabled = { ...defaultCfg, poolHistoryGuardEnabled: false };
    expect(shouldFilter("BadPool", disabled)).toBeNull();
  });

  it("respects custom thresholds", () => {
    memPoolMemory["BorderPool"] = { name: "BORDER-SOL", total_deploys: 3, avg_pnl_pct: -0.5, win_rate: 0.5 };
    // Default: -1 threshold → -0.5 passes
    expect(shouldFilter("BorderPool", defaultCfg)).toBeNull();
    // Tighter: 0 threshold → -0.5 fails
    const tighter = { ...defaultCfg, poolHistoryMaxAvgPnl: 0 };
    expect(shouldFilter("BorderPool", tighter)).not.toBeNull();
  });
});
