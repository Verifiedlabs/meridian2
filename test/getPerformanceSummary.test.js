// Tests for lessons.getPerformanceSummary and categorizeCloseReason —
// the NaN-safe summary and close-reason histogram that get injected into
// SCREENER and MANAGER prompts.
//
// We chdir into a tmpdir per file and write a minimal lessons.json so
// load() picks it up without touching the repo's real lessons.json.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-perfsum-test-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const LESSONS_FILE = path.join(tmpDir, "lessons.json");

function writeLessons(performance, lessons = []) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify({ lessons, performance }, null, 2));
}

const { getPerformanceSummary, categorizeCloseReason } = await import("../lessons.js");

beforeEach(() => {
  if (fs.existsSync(LESSONS_FILE)) fs.unlinkSync(LESSONS_FILE);
});

describe("categorizeCloseReason", () => {
  it.each([
    ["Stop loss triggered — PnL -7.42% exceeded -6% threshold", "stop_loss"],
    ["Trailing TP: Stop loss triggered", "stop_loss"],
    ["Trailing TP: Low yield: fee/TVL 2.92% < min 7%", "trailing_lowyield"],
    ["Trailing TP: peak 3% → current 0.75% (dropped)", "trailing_drop"],
    ["take profit — PnL +4.18% exceeded 4% threshold", "take_profit"],
    ["OOR - pumped far above range", "oor"],
    ["Rule 3: pumped far above range", "oor"],
    ["realtime: pumped far above range", "oor"],
    ["low yield: fee/TVL 0.98% < min 7% (age: 60m)", "low_yield"],
    ["Emergency price drop", "stop_loss"],
    ["", "unknown"],
    [null, "unknown"],
  ])("classifies %j as %s", (input, expected) => {
    expect(categorizeCloseReason(input)).toBe(expected);
  });
});

describe("getPerformanceSummary", () => {
  it("returns null when there are no performance records", () => {
    writeLessons([]);
    expect(getPerformanceSummary()).toBe(null);
  });

  it("computes basic aggregates correctly", () => {
    writeLessons([
      { pnl_usd: 1.0, pnl_pct: 4, range_efficiency: 100, fees_earned_usd: 0.5, close_reason: "take profit", recorded_at: "2026-04-30T00:00:00Z" },
      { pnl_usd: -1.5, pnl_pct: -6, range_efficiency: 80, fees_earned_usd: 0.2, close_reason: "stop loss", recorded_at: "2026-04-30T01:00:00Z" },
      { pnl_usd: 0.05, pnl_pct: 0.2, range_efficiency: 50, fees_earned_usd: 0.05, close_reason: "OOR pumped", recorded_at: "2026-04-30T02:00:00Z" },
    ]);
    const s = getPerformanceSummary();
    expect(s.total_positions_closed).toBe(3);
    expect(s.winners).toBe(2);
    expect(s.losers).toBe(1);
    expect(s.win_rate_pct).toBe(67);
    expect(s.avg_winner_pnl_pct).toBe(2.1); // (4 + 0.2) / 2
    expect(s.avg_loser_pnl_pct).toBe(-6);
    expect(s.by_close_reason).toMatchObject({
      take_profit: { count: 1, sum_pnl_pct: 4 },
      stop_loss:   { count: 1, sum_pnl_pct: -6 },
      oor:         { count: 1, sum_pnl_pct: 0.2 },
    });
  });

  it("is NaN-safe when fields are missing or null", () => {
    writeLessons([
      // pnl_usd null, pnl_pct present, range_efficiency missing, fees_earned_usd missing
      { pnl_usd: null, pnl_pct: 4, close_reason: "take profit", recorded_at: "2026-04-30T00:00:00Z" },
      // everything missing
      { close_reason: "OOR", recorded_at: "2026-04-30T01:00:00Z" },
      { pnl_usd: undefined, pnl_pct: -6, range_efficiency: undefined, close_reason: "stop loss", recorded_at: "2026-04-30T02:00:00Z" },
    ]);
    const s = getPerformanceSummary();
    expect(s).not.toBe(null);
    // No NaN in any numeric field
    expect(Number.isFinite(s.total_pnl_usd)).toBe(true);
    expect(Number.isFinite(s.total_pnl_pct)).toBe(true);
    expect(Number.isFinite(s.avg_pnl_pct)).toBe(true);
    expect(Number.isFinite(s.avg_range_efficiency_pct)).toBe(true);
    expect(Number.isFinite(s.win_rate_pct)).toBe(true);
    expect(Number.isFinite(s.avg_winner_pnl_pct)).toBe(true);
    expect(Number.isFinite(s.avg_loser_pnl_pct)).toBe(true);
  });

  it("respects windowDays filter", () => {
    const now = Date.now();
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1d ago
    const old = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();   // 30d ago
    writeLessons([
      { pnl_usd: 1, pnl_pct: 5, range_efficiency: 100, close_reason: "take profit", recorded_at: old },
      { pnl_usd: 1, pnl_pct: 4, range_efficiency: 100, close_reason: "take profit", recorded_at: recent },
    ]);

    const allTime = getPerformanceSummary();
    expect(allTime.total_positions_closed).toBe(2);

    const lastWeek = getPerformanceSummary({ windowDays: 7 });
    expect(lastWeek.total_positions_closed).toBe(1);
    expect(lastWeek.window_days).toBe(7);
  });

  it("respects maxRecords cap (most recent N)", () => {
    writeLessons([
      { pnl_usd: 1, pnl_pct: 1, range_efficiency: 100, close_reason: "take profit", recorded_at: "2026-04-30T00:00:00Z" },
      { pnl_usd: 1, pnl_pct: 2, range_efficiency: 100, close_reason: "take profit", recorded_at: "2026-04-30T01:00:00Z" },
      { pnl_usd: 1, pnl_pct: 3, range_efficiency: 100, close_reason: "take profit", recorded_at: "2026-04-30T02:00:00Z" },
    ]);
    const s = getPerformanceSummary({ maxRecords: 2 });
    expect(s.total_positions_closed).toBe(2);
    // Should keep the last 2 (pnl 2 and 3), not the first one (pnl 1)
    expect(s.total_pnl_pct).toBe(5);
  });

  it("returns flat=1 when a position closes at exactly 0 PnL", () => {
    writeLessons([
      { pnl_usd: 0, pnl_pct: 0, range_efficiency: 100, close_reason: "OOR", recorded_at: "2026-04-30T00:00:00Z" },
    ]);
    const s = getPerformanceSummary();
    expect(s.winners).toBe(0);
    expect(s.losers).toBe(0);
    expect(s.flat).toBe(1);
    // win_rate doesn't count flat as a win
    expect(s.win_rate_pct).toBe(0);
  });

  it("aggregates by_close_reason across multiple records", () => {
    writeLessons([
      { pnl_usd: 1, pnl_pct: 4, range_efficiency: 100, fees_earned_usd: 0.5, close_reason: "take profit", recorded_at: "2026-04-30T00:00:00Z" },
      { pnl_usd: 1, pnl_pct: 4, range_efficiency: 100, fees_earned_usd: 0.4, close_reason: "take profit", recorded_at: "2026-04-30T01:00:00Z" },
      { pnl_usd: -2, pnl_pct: -6, range_efficiency: 80,  fees_earned_usd: 0.1, close_reason: "stop loss", recorded_at: "2026-04-30T02:00:00Z" },
    ]);
    const s = getPerformanceSummary();
    expect(s.by_close_reason.take_profit.count).toBe(2);
    expect(s.by_close_reason.take_profit.sum_pnl_pct).toBe(8);
    expect(s.by_close_reason.take_profit.avg_pnl_pct).toBe(4);
    expect(s.by_close_reason.stop_loss.count).toBe(1);
    expect(s.by_close_reason.stop_loss.sum_pnl_pct).toBe(-6);
  });

  it("by_exploration is null when no exploration records exist", () => {
    writeLessons([
      { pnl_usd: 1, pnl_pct: 4, range_efficiency: 100, close_reason: "take profit", recorded_at: "2026-04-30T00:00:00Z" },
      { pnl_usd: -1, pnl_pct: -4, range_efficiency: 80, close_reason: "stop loss", recorded_at: "2026-04-30T01:00:00Z" },
    ]);
    const s = getPerformanceSummary();
    expect(s.by_exploration).toBe(null);
  });

  it("by_exploration buckets normal vs exploration when mixed", () => {
    writeLessons([
      // 2 normal: 1 win, 1 loss → 50% WR
      { pnl_usd: 1, pnl_pct: 4, exploration: false, close_reason: "take profit", recorded_at: "2026-04-30T00:00:00Z" },
      { pnl_usd: -1, pnl_pct: -4, exploration: false, close_reason: "stop loss", recorded_at: "2026-04-30T01:00:00Z" },
      // 3 exploration: 2 wins, 1 loss → 67% WR
      { pnl_usd: 1, pnl_pct: 5, exploration: true, close_reason: "take profit", recorded_at: "2026-04-30T02:00:00Z" },
      { pnl_usd: 1, pnl_pct: 6, exploration: true, close_reason: "take profit", recorded_at: "2026-04-30T03:00:00Z" },
      { pnl_usd: -1, pnl_pct: -3, exploration: true, close_reason: "stop loss", recorded_at: "2026-04-30T04:00:00Z" },
    ]);
    const s = getPerformanceSummary();
    expect(s.by_exploration).not.toBe(null);
    expect(s.by_exploration.normal.count).toBe(2);
    expect(s.by_exploration.normal.win_rate_pct).toBe(50);
    expect(s.by_exploration.exploration.count).toBe(3);
    expect(s.by_exploration.exploration.win_rate_pct).toBe(67);
    expect(s.by_exploration.exploration.total_pnl_pct).toBe(8); // 5 + 6 + -3
    expect(s.by_exploration.exploration.avg_pnl_pct).toBeCloseTo(2.67, 1);
  });

  it("by_exploration treats missing exploration field as normal", () => {
    writeLessons([
      // No exploration field — should bucket as normal
      { pnl_usd: 1, pnl_pct: 4, close_reason: "take profit", recorded_at: "2026-04-30T00:00:00Z" },
      // Explicit exploration: true
      { pnl_usd: 1, pnl_pct: 5, exploration: true, close_reason: "take profit", recorded_at: "2026-04-30T01:00:00Z" },
    ]);
    const s = getPerformanceSummary();
    expect(s.by_exploration.normal.count).toBe(1);
    expect(s.by_exploration.exploration.count).toBe(1);
  });
});
