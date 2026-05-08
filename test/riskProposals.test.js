// Tests for B1: TP/SL self-evolve risk proposals (lessons.js).
//
// Coverage:
//   - proposeTpSlAdjustment heuristics for TP and SL
//   - storeRiskProposal: persistence + dedup
//   - getPendingRiskProposals: filters expired and accepted/rejected
//   - acceptRiskProposal: updates user-config + live config
//   - rejectRiskProposal: marks status without applying changes
//
// We mock fs writes globally to avoid clobbering real lessons.json /
// user-config.json, and rely on _resetRiskProposalsForTesting between
// tests for state isolation.

import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-risk-prop-test-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

// In-memory state that simulates lessons.json + user-config.json.
let memLessons = { lessons: [], performance: [], risk_proposals: [] };
let memUserConfig = {};

// Tag matcher — writeJsonAtomicSync writes to `<file>.tmp.<pid>.<ts>` then
// renames. We strip the tmp suffix so reads/writes hit the same in-memory
// store regardless of which path the call site uses.
function classifyPath(target) {
  const file = String(target);
  // Strip .tmp.<pid>.<ts> suffix (atomic write tmp pattern)
  const base = file.replace(/\.tmp\.\d+\.\d+$/, "");
  if (base.endsWith("user-config.json")) return "user_config";
  if (base.endsWith("lessons.json")) return "lessons";
  return null;
}

vi.spyOn(fs, "writeFileSync").mockImplementation((target, contents) => {
  const kind = classifyPath(target);
  if (kind === "user_config") {
    try { memUserConfig = JSON.parse(contents); } catch { /* ignore */ }
  } else if (kind === "lessons") {
    try { memLessons = JSON.parse(contents); } catch { /* ignore */ }
  }
});
vi.spyOn(fs, "renameSync").mockImplementation(() => {});
vi.spyOn(fs, "existsSync").mockImplementation((target) => {
  return classifyPath(target) !== null;
});
vi.spyOn(fs, "readFileSync").mockImplementation((target) => {
  const kind = classifyPath(target);
  if (kind === "user_config") return JSON.stringify(memUserConfig);
  if (kind === "lessons") return JSON.stringify(memLessons);
  return "{}";
});
vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});

const {
  proposeTpSlAdjustment,
  storeRiskProposal,
  getPendingRiskProposals,
  acceptRiskProposal,
  rejectRiskProposal,
  _resetRiskProposalsForTesting,
} = await import("../lessons.js");

const baseMgmt = { takeProfitPct: 5, stopLossPct: -6 };

function makePerf(overrides = {}) {
  return {
    pool: "pool" + Math.random().toString(36).slice(2),
    pool_name: "TEST-SOL",
    strategy: "bid_ask",
    bin_step: 100,
    bin_range: 50,
    volatility: 2.5,
    fee_tvl_ratio: 0.5,
    organic_score: 70,
    amount_sol: 0.5,
    fees_earned_usd: 0.5,
    final_value_usd: 100,
    initial_value_usd: 100,
    minutes_in_range: 50,
    minutes_held: 60,
    pnl_pct: 0,
    close_reason: "agent decision",
    ...overrides,
  };
}

beforeEach(() => {
  memLessons = { lessons: [], performance: [], risk_proposals: [] };
  memUserConfig = {};
});

describe("proposeTpSlAdjustment — TP heuristics", () => {
  it("returns null when sample too small (<10)", () => {
    const perf = Array.from({ length: 8 }, () => makePerf({ pnl_pct: 1 }));
    expect(proposeTpSlAdjustment(perf, baseMgmt)).toBeNull();
  });

  it("proposes lower TP when winners cluster well below current TP", () => {
    // 12 winners at 1-2% (well below TP=5), no TP/trailing close reasons
    const perf = Array.from({ length: 12 }, (_, i) => makePerf({
      pnl_pct: 1 + (i % 2) * 0.5,  // alternates 1.0 and 1.5
      close_reason: "out of range",
    }));
    const result = proposeTpSlAdjustment(perf, baseMgmt);
    expect(result).not.toBeNull();
    expect(result.proposals.takeProfitPct).toBeDefined();
    expect(result.proposals.takeProfitPct).toBeLessThan(baseMgmt.takeProfitPct);
    expect(result.proposals.takeProfitPct).toBeGreaterThanOrEqual(1.5); // floor
    expect(result.rationale.takeProfitPct).toContain("TP hits");
  });

  it("does NOT propose TP change when TP already fires often", () => {
    // 10 closes, 5 of them are take-profit hits at +5%
    const perf = Array.from({ length: 10 }, (_, i) => makePerf({
      pnl_pct: i < 5 ? 5.1 : 1.0,
      close_reason: i < 5 ? "take profit hit" : "out of range",
    }));
    const result = proposeTpSlAdjustment(perf, baseMgmt);
    if (result) {
      // If anything is proposed, it should not lower TP
      expect(result.proposals.takeProfitPct).toBeUndefined();
    } else {
      expect(result).toBeNull();
    }
  });

  it("does NOT propose change smaller than 15%", () => {
    // Winners at 4.5% (just below TP=5) — change would be tiny, skip.
    const perf = Array.from({ length: 12 }, () => makePerf({
      pnl_pct: 4.5,
      close_reason: "out of range",
    }));
    const result = proposeTpSlAdjustment(perf, baseMgmt);
    // Either null or no TP change
    if (result) {
      expect(result.proposals.takeProfitPct).toBeUndefined();
    }
  });

  // Regression for the production case where 95 closes had only 7 hard
  // TP hits but 24 trailing exits. The original heuristic counted both
  // and saw 32% > 20% threshold so it never proposed lowering, even
  // though winners' max barely crossed TP. The fix excludes trailing
  // from tpRate so this scenario produces a proposal.
  it("proposes lower TP when hard TP rarely fires even with many trailing exits", () => {
    const perf = [
      // 5 hard TP hits at 4.1% (just above TP=5 — wait, baseMgmt.takeProfitPct=5)
      ...Array.from({ length: 5 }, () => makePerf({
        pnl_pct: 1.5,
        close_reason: "take profit hit",
      })),
      // 30 trailing exits clustered at 1-1.5% — they are NOT TP hits
      ...Array.from({ length: 30 }, (_, i) => makePerf({
        pnl_pct: 1 + (i % 2) * 0.4,
        close_reason: "trailing exit",
      })),
      // 10 OOR closes around 1%
      ...Array.from({ length: 10 }, () => makePerf({
        pnl_pct: 1.1,
        close_reason: "out of range",
      })),
    ];
    // tpRate = 5/45 = 11% < 20% → fires.
    const result = proposeTpSlAdjustment(perf, baseMgmt);
    expect(result).not.toBeNull();
    expect(result.proposals.takeProfitPct).toBeDefined();
    expect(result.proposals.takeProfitPct).toBeLessThan(baseMgmt.takeProfitPct);
    expect(result.rationale.takeProfitPct).toMatch(/Hard TP hits/);
  });
});

describe("proposeTpSlAdjustment — SL heuristics", () => {
  it("proposes tighter SL when SL events overshoot threshold", () => {
    // 10 closes, 4 are SL events that overshot to -8% (SL=-6, overshoot=-2)
    const perf = [
      ...Array.from({ length: 6 }, () => makePerf({ pnl_pct: 2, close_reason: "out of range" })),
      ...Array.from({ length: 4 }, () => makePerf({ pnl_pct: -8, close_reason: "stop loss" })),
    ];
    const result = proposeTpSlAdjustment(perf, baseMgmt);
    expect(result).not.toBeNull();
    expect(result.proposals.stopLossPct).toBeDefined();
    expect(result.proposals.stopLossPct).toBeGreaterThan(baseMgmt.stopLossPct); // less negative = tighter
    expect(result.rationale.stopLossPct).toContain("SL events overshoot");
  });

  it("does NOT propose SL change when SL events sit at threshold", () => {
    // 10 closes, 3 SL events at exactly -6%
    const perf = [
      ...Array.from({ length: 7 }, () => makePerf({ pnl_pct: 1, close_reason: "out of range" })),
      ...Array.from({ length: 3 }, () => makePerf({ pnl_pct: -6, close_reason: "stop loss" })),
    ];
    const result = proposeTpSlAdjustment(perf, baseMgmt);
    if (result) {
      expect(result.proposals.stopLossPct).toBeUndefined();
    }
  });

  it("requires ≥3 SL events specifically before proposing SL change", () => {
    // 10 closes, only 2 SL events (other losers are non-SL reasons)
    const perf = [
      ...Array.from({ length: 6 }, () => makePerf({ pnl_pct: 1, close_reason: "out of range" })),
      ...Array.from({ length: 2 }, () => makePerf({ pnl_pct: -8, close_reason: "stop loss" })),
      ...Array.from({ length: 2 }, () => makePerf({ pnl_pct: -3, close_reason: "out of range" })),
    ];
    const result = proposeTpSlAdjustment(perf, baseMgmt);
    if (result) {
      expect(result.proposals.stopLossPct).toBeUndefined();
    }
  });
});

describe("storeRiskProposal", () => {
  beforeEach(() => _resetRiskProposalsForTesting());

  it("persists a new pending proposal", () => {
    const stored = storeRiskProposal({
      proposals: { takeProfitPct: 3 },
      rationale: { takeProfitPct: "test" },
      sample_size: 10,
      winners: 6,
      losers: 4,
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    expect(stored).toBeDefined();
    expect(stored.id).toBeDefined();
    expect(stored.status).toBe("pending");
    expect(stored.proposals.takeProfitPct).toBe(3);
    expect(memLessons.risk_proposals).toHaveLength(1);
  });

  it("dedupes identical pending proposals (refreshes timestamp instead)", () => {
    const a = storeRiskProposal({
      proposals: { takeProfitPct: 3 },
      rationale: { takeProfitPct: "test" },
      sample_size: 10,
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    const b = storeRiskProposal({
      proposals: { takeProfitPct: 3 },  // identical
      rationale: { takeProfitPct: "test (refreshed)" },
      sample_size: 11,
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    expect(b.id).toBe(a.id); // same record
    expect(b.refreshed_at).toBeDefined();
    expect(memLessons.risk_proposals).toHaveLength(1);
  });

  it("creates separate records for different proposal values", () => {
    storeRiskProposal({
      proposals: { takeProfitPct: 3 },
      rationale: {},
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    storeRiskProposal({
      proposals: { takeProfitPct: 2.5 },  // different
      rationale: {},
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    expect(memLessons.risk_proposals).toHaveLength(2);
  });
});

describe("getPendingRiskProposals", () => {
  beforeEach(() => _resetRiskProposalsForTesting());

  it("returns only pending proposals (newest first)", () => {
    const a = storeRiskProposal({
      proposals: { takeProfitPct: 3 },
      rationale: {},
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    // Sleep 1ms so id differs
    const b = storeRiskProposal({
      proposals: { takeProfitPct: 2.5 },
      rationale: {},
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    rejectRiskProposal(a.id);
    const pending = getPendingRiskProposals();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(b.id);
  });

  it("filters out expired proposals (>7 days old)", () => {
    storeRiskProposal({
      proposals: { takeProfitPct: 3 },
      rationale: {},
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    // Manually backdate
    memLessons.risk_proposals[0].created_at = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const pending = getPendingRiskProposals();
    expect(pending).toHaveLength(0);
  });
});

describe("acceptRiskProposal", () => {
  beforeEach(() => _resetRiskProposalsForTesting());

  it("applies proposal to user-config + live config", () => {
    const stored = storeRiskProposal({
      proposals: { takeProfitPct: 3, stopLossPct: -4 },
      rationale: { takeProfitPct: "test", stopLossPct: "test" },
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    const live = { management: { takeProfitPct: 5, stopLossPct: -6 } };
    const result = acceptRiskProposal(stored.id, live);
    expect(result.success).toBe(true);
    expect(result.applied.takeProfitPct).toBe(3);
    expect(result.applied.stopLossPct).toBe(-4);
    expect(live.management.takeProfitPct).toBe(3);
    expect(live.management.stopLossPct).toBe(-4);
    expect(memUserConfig.takeProfitPct).toBe(3);
    expect(memUserConfig.stopLossPct).toBe(-4);
    expect(memLessons.risk_proposals[0].status).toBe("accepted");
  });

  it("appends an audit lesson when accepted", () => {
    const stored = storeRiskProposal({
      proposals: { takeProfitPct: 3 },
      rationale: { takeProfitPct: "lower TP" },
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    acceptRiskProposal(stored.id, { management: {} });
    const lesson = memLessons.lessons.find((l) => l.tags?.includes("risk_change"));
    expect(lesson).toBeDefined();
    expect(lesson.rule).toContain("RISK ACCEPTED");
    expect(lesson.tags).toContain("accepted");
  });

  it("refuses to re-accept already-accepted proposal", () => {
    const stored = storeRiskProposal({
      proposals: { takeProfitPct: 3 },
      rationale: {},
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    acceptRiskProposal(stored.id, { management: {} });
    const second = acceptRiskProposal(stored.id, { management: {} });
    expect(second.success).toBe(false);
    expect(second.error).toContain("accepted");
  });

  it("returns error for unknown id", () => {
    const result = acceptRiskProposal(999999, { management: {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("rejectRiskProposal", () => {
  beforeEach(() => _resetRiskProposalsForTesting());

  it("marks proposal rejected without applying changes", () => {
    const stored = storeRiskProposal({
      proposals: { takeProfitPct: 3 },
      rationale: {},
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    const result = rejectRiskProposal(stored.id);
    expect(result.success).toBe(true);
    expect(memLessons.risk_proposals[0].status).toBe("rejected");
    expect(memUserConfig.takeProfitPct).toBeUndefined();
  });

  it("refuses to reject already-rejected proposal", () => {
    const stored = storeRiskProposal({
      proposals: { takeProfitPct: 3 },
      rationale: {},
      current: { takeProfitPct: 5, stopLossPct: -6 },
    });
    rejectRiskProposal(stored.id);
    const second = rejectRiskProposal(stored.id);
    expect(second.success).toBe(false);
    expect(second.error).toContain("rejected");
  });
});
