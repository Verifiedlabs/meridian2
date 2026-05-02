// Tests for lessons.getPostMortemSuggestions — the diagnostic helper that
// turns a closed-position dataset into actionable {severity, area, summary,
// detail, action_hint} items for surfacing in agent prompts and the daily
// briefing.
//
// We chdir into a tmpdir per file and write a controlled lessons.json so
// load() reads our synthetic data instead of the real repo file.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-postmortem-test-"));
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

function makeRecord(overrides = {}) {
  return {
    pool: "pool-x",
    pool_name: "X-SOL",
    strategy: "bid_ask",
    pnl_usd: 0,
    pnl_pct: 0,
    fees_earned_usd: 0,
    range_efficiency: 50,
    minutes_held: 30,
    close_reason: "OOR",
    recorded_at: new Date().toISOString(),
    ...overrides,
  };
}

const { getPostMortemSuggestions } = await import("../lessons.js");

beforeEach(() => {
  if (fs.existsSync(LESSONS_FILE)) fs.unlinkSync(LESSONS_FILE);
});

describe("getPostMortemSuggestions", () => {
  it("returns null for empty data", () => {
    writeLessons([]);
    expect(getPostMortemSuggestions()).toBeNull();
  });

  it("returns null for tiny samples (<5 records)", () => {
    writeLessons([
      makeRecord({ pnl_pct: -4, close_reason: "Stop loss triggered" }),
      makeRecord({ pnl_pct: -5, close_reason: "Stop loss triggered" }),
      makeRecord({ pnl_pct: 4, close_reason: "take profit" }),
      makeRecord({ pnl_pct: 0.2, close_reason: "OOR" }),
    ]);
    expect(getPostMortemSuggestions()).toBeNull();
  });

  it("flags stop-loss bleeding when SL wipes TP gains", () => {
    // Mirrors the user's real distribution: 4 SL × -4 = -16, 3 TP × +4 = +12,
    // remainder near-flat OOR. Total ~ -4%.
    const records = [
      ...Array(4).fill(0).map(() => makeRecord({ pnl_pct: -4, close_reason: "Stop loss" })),
      ...Array(3).fill(0).map(() => makeRecord({ pnl_pct: 4, close_reason: "take profit" })),
      ...Array(15).fill(0).map(() => makeRecord({ pnl_pct: 0.2, close_reason: "OOR" })),
    ];
    writeLessons(records);

    const result = getPostMortemSuggestions({
      mgmtConfig: { takeProfitPct: 4, stopLossPct: -6 },
    });
    expect(result).not.toBeNull();
    expect(result.sample_size).toBe(22);
    const sl = result.suggestions.find((s) => s.area === "stop_loss");
    expect(sl).toBeDefined();
    expect(sl.severity).toBe("high");
    expect(sl.detail).toContain("TP=4");
    expect(sl.detail).toContain("SL=-6");
  });

  it("flags OOR cluster when >= 30% of closes are OOR-driven", () => {
    const records = [
      ...Array(8).fill(0).map(() => makeRecord({ pnl_pct: 0.1, close_reason: "OOR" })),
      ...Array(2).fill(0).map(() => makeRecord({ pnl_pct: 3, close_reason: "take profit" })),
    ];
    writeLessons(records);

    const result = getPostMortemSuggestions();
    expect(result).not.toBeNull();
    const oor = result.suggestions.find((s) => s.area === "oor");
    expect(oor).toBeDefined();
    expect(oor.summary).toMatch(/OOR-driven/);
  });

  it("does NOT flag OOR when below the 30% threshold", () => {
    const records = [
      ...Array(2).fill(0).map(() => makeRecord({ pnl_pct: 0.1, close_reason: "OOR" })),
      ...Array(8).fill(0).map(() => makeRecord({ pnl_pct: 1, close_reason: "take profit" })),
    ];
    writeLessons(records);

    const result = getPostMortemSuggestions();
    expect(result).not.toBeNull();
    const oor = result.suggestions.find((s) => s.area === "oor");
    expect(oor).toBeUndefined();
  });

  it("flags low TP-hit rate when TP works but rarely fires", () => {
    const records = [
      ...Array(20).fill(0).map(() => makeRecord({ pnl_pct: 0.1, close_reason: "OOR" })),
      makeRecord({ pnl_pct: 4, close_reason: "take profit" }),
    ];
    writeLessons(records);

    const result = getPostMortemSuggestions({
      mgmtConfig: { takeProfitPct: 4, stopLossPct: -6 },
    });
    expect(result).not.toBeNull();
    const tp = result.suggestions.find((s) => s.area === "take_profit");
    expect(tp).toBeDefined();
    expect(tp.action_hint).toContain("takeProfitPct");
  });

  it("flags trailing TP never firing across a 10+ record dataset", () => {
    const records = Array(12).fill(0).map(() =>
      makeRecord({ pnl_pct: 0.5, close_reason: "OOR" })
    );
    writeLessons(records);

    const result = getPostMortemSuggestions();
    expect(result).not.toBeNull();
    const trail = result.suggestions.find((s) => s.area === "strategy");
    expect(trail).toBeDefined();
  });

  it("flags low win-rate vs breakeven expectation", () => {
    // 6 losers, 4 winners → 40% win rate. With TP=4/SL=-4 breakeven ~50%.
    const records = [
      ...Array(6).fill(0).map(() => makeRecord({ pnl_pct: -4, close_reason: "Stop loss" })),
      ...Array(4).fill(0).map(() => makeRecord({ pnl_pct: 4, close_reason: "take profit" })),
    ];
    writeLessons(records);

    const result = getPostMortemSuggestions({
      mgmtConfig: { takeProfitPct: 4, stopLossPct: -4 },
    });
    expect(result).not.toBeNull();
    const wr = result.suggestions.find((s) => s.area === "screening");
    expect(wr).toBeDefined();
    expect(wr.detail).toMatch(/breakeven/);
  });

  it("sorts suggestions high → medium → low severity", () => {
    const records = [
      ...Array(4).fill(0).map(() => makeRecord({ pnl_pct: -4, close_reason: "Stop loss" })),
      ...Array(3).fill(0).map(() => makeRecord({ pnl_pct: 4, close_reason: "take profit" })),
      ...Array(15).fill(0).map(() => makeRecord({ pnl_pct: 0.2, close_reason: "OOR" })),
    ];
    writeLessons(records);

    const result = getPostMortemSuggestions({
      mgmtConfig: { takeProfitPct: 4, stopLossPct: -6 },
    });
    const severities = result.suggestions.map((s) => s.severity);
    const expectedOrder = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(expectedOrder[severities[i]]).toBeGreaterThanOrEqual(expectedOrder[severities[i - 1]]);
    }
  });

  it("respects windowDays filter", () => {
    const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    const records = [
      ...Array(6).fill(0).map(() => makeRecord({ pnl_pct: -5, close_reason: "Stop loss", recorded_at: oldDate })),
      ...Array(4).fill(0).map(() => makeRecord({ pnl_pct: 1, close_reason: "OOR", recorded_at: recent })),
    ];
    writeLessons(records);

    // 7-day window — only the recent flat positions should be visible
    const result = getPostMortemSuggestions({ windowDays: 7 });
    // <5 records in window → null
    expect(result).toBeNull();
  });
});
