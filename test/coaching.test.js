// Tier 2 coaching memo lifecycle tests.
// fs is fully mocked so no real memos.json is touched. The module's
// in-memory cache (_state) is reset between tests via _resetForTesting.

import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-coaching-test-"));
process.chdir(tmpDir);

vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
vi.spyOn(fs, "renameSync").mockImplementation(() => {});
vi.spyOn(fs, "existsSync").mockImplementation(() => false);
vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});

const {
  generateDigest,
  validateMemoProposal,
  setPendingProposal,
  approvePendingProposal,
  rejectPendingProposal,
  rollbackMemo,
  getActiveMemos,
  getPendingProposal,
  getMemosState,
  formatMemosForPrompt,
  _resetForTesting,
} = await import("../src/coaching.js");

beforeEach(() => {
  _resetForTesting();
});

// ─── generateDigest ───────────────────────────────────────────

describe("generateDigest", () => {
  it("returns ok=false when there is no perf data", () => {
    const out = generateDigest({ perfSummary: null });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("no_perf_data");
    expect(out.text).toBeNull();
  });

  it("returns ok=false when perf has zero closes", () => {
    const out = generateDigest({ perfSummary: { total_positions_closed: 0 } });
    expect(out.ok).toBe(false);
  });

  it("produces structured digest text from a real perf summary", () => {
    const perfSummary = {
      total_positions_closed: 70,
      win_rate_pct: 58,
      winners: 41, losers: 29, flat: 0,
      avg_pnl_pct: 0.12,
      total_pnl_pct: 8.5,
      avg_winner_pnl_pct: 5.2,
      avg_loser_pnl_pct: -3.4,
      by_close_reason: {
        take_profit: { count: 18, sum_pnl_pct: 90, avg_pnl_pct: 5.0 },
        stop_loss:   { count: 12, sum_pnl_pct: -60, avg_pnl_pct: -5.0 },
      },
      by_exploration: {
        normal:      { count: 63, win_rate_pct: 60, avg_pnl_pct: 0.5, total_pnl_pct: 31.5 },
        exploration: { count: 7,  win_rate_pct: 40, avg_pnl_pct: -1.0, total_pnl_pct: -7 },
      },
    };
    const out = generateDigest({ perfSummary, lessons: [], windowDays: 7 });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("PERFORMANCE DIGEST");
    expect(out.text).toContain("70 closes");
    expect(out.text).toContain("Win rate: 58%");
    expect(out.text).toContain("Normal:");
    expect(out.text).toContain("Exploration:");
    expect(out.text).toContain("take_profit");
    expect(out.text).toContain("stop_loss");
    expect(out.snapshot.total_closes).toBe(70);
    expect(out.snapshot.win_rate_pct).toBe(58);
  });

  it("includes top lessons (capped at 10) when provided", () => {
    const perfSummary = { total_positions_closed: 5, win_rate_pct: 60 };
    const lessons = Array.from({ length: 12 }, (_, i) => ({
      rule: `lesson rule number ${i}`,
      outcome: "bad",
      _seen: i + 1,
    }));
    const out = generateDigest({ perfSummary, lessons });
    expect(out.text).toContain("TOP LESSONS (10)");
    // 11th and 12th lessons should not appear
    expect(out.text).not.toContain("rule number 10");
    expect(out.text).not.toContain("rule number 11");
  });

  it("surfaces (seen N×) for repeated lesson representatives", () => {
    const perfSummary = { total_positions_closed: 5, win_rate_pct: 60 };
    const lessons = [{ rule: "AVOID: bad pool", outcome: "bad", _seen: 5 }];
    const out = generateDigest({ perfSummary, lessons });
    expect(out.text).toContain("(seen 5×)");
  });
});

// ─── validateMemoProposal ─────────────────────────────────────

describe("validateMemoProposal", () => {
  it("rejects null/undefined proposal", () => {
    expect(validateMemoProposal(null).ok).toBe(false);
    expect(validateMemoProposal(undefined).ok).toBe(false);
  });

  it("rejects empty rules", () => {
    const v = validateMemoProposal({ rules: [] });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.startsWith("too_few_rules"))).toBe(true);
  });

  it("rejects too many rules", () => {
    const rules = Array.from({ length: 10 }, (_, i) => `rule ${i}`);
    const v = validateMemoProposal({ rules }, { maxRules: 5 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.startsWith("too_many_rules"))).toBe(true);
  });

  it("rejects rules with suspicious patterns (skip all)", () => {
    const v = validateMemoProposal({ rules: ["skip all pools with anything"] });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.startsWith("suspicious_pattern"))).toBe(true);
  });

  it("rejects rules trying to disable the bot", () => {
    const v = validateMemoProposal({ rules: ["disable screening loop completely"] });
    expect(v.ok).toBe(false);
  });

  it("rejects rules that are too long", () => {
    const long = "x".repeat(500);
    const v = validateMemoProposal({ rules: [long] }, { maxRuleLength: 240 });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.startsWith("rule_too_long"))).toBe(true);
  });

  it("accepts well-formed rule strings", () => {
    const v = validateMemoProposal({
      rules: [
        "Boost deploy weight 1.3x for organicScore 75-85 + age 4-12h (WR 78%, n=18)",
        "Skip pools age 1-2h + organicScore 60-70 (WR 28%, n=11)",
      ],
    });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("accepts rule objects with .rule field", () => {
    const v = validateMemoProposal({
      rules: [{ rule: "Boost X for Y", reasoning: "data n=20 WR 70" }],
    });
    expect(v.ok).toBe(true);
  });

  it("rejects empty/blank rule strings", () => {
    const v = validateMemoProposal({ rules: ["valid rule", "  "] });
    expect(v.ok).toBe(false);
    expect(v.errors).toContain("empty_rule");
  });
});

// ─── Lifecycle: pending → approve / reject ────────────────────

describe("memo lifecycle", () => {
  it("starts with empty state", () => {
    const s = getMemosState();
    expect(s.active).toEqual([]);
    expect(s.pending).toBeNull();
    expect(s.history).toEqual([]);
  });

  it("setPendingProposal stores a pending memo with validation", () => {
    const memo = setPendingProposal({
      rules: ["Boost organicScore 75-85 with WR 78% (n=18)"],
      summary: "tighten on high-organic mid-age",
    });
    expect(memo.id).toMatch(/^\d{4}-W\d{2}-/);
    expect(memo.status).toBe("pending");
    expect(memo.rules.length).toBe(1);
    expect(memo.validation.ok).toBe(true);
    expect(getPendingProposal().id).toBe(memo.id);
  });

  it("approvePendingProposal moves pending → active and clears pending", () => {
    setPendingProposal({ rules: ["Boost X for Y at WR 70 n=20"] });
    const result = approvePendingProposal();
    expect(result.ok).toBe(true);
    expect(result.activeCount).toBe(1);
    expect(getPendingProposal()).toBeNull();
    const active = getActiveMemos();
    expect(active.length).toBe(1);
    expect(active[0].status).toBe("active");
    expect(active[0].approvedAt).toBeDefined();
  });

  it("rejects approval when no pending exists", () => {
    expect(approvePendingProposal().ok).toBe(false);
    expect(approvePendingProposal().reason).toBe("no_pending");
  });

  it("blocks approval of an invalid pending proposal", () => {
    setPendingProposal({ rules: ["skip all bad pools"] }); // suspicious
    const result = approvePendingProposal();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejectPendingProposal moves pending → history with reason", () => {
    setPendingProposal({ rules: ["valid rule with numbers n=20 WR 60"] });
    const result = rejectPendingProposal("operator did not like wording");
    expect(result.ok).toBe(true);
    expect(getPendingProposal()).toBeNull();
    const history = getMemosState().history;
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("rejected");
    expect(history[0].rejectedReason).toContain("operator did not like wording");
  });

  it("FIFO-retires oldest active when activeMemoLimit exceeded", () => {
    // Approve 3 memos with limit 2
    for (let i = 0; i < 3; i++) {
      setPendingProposal({ rules: [`rule v${i} with numbers n=10 WR 60`] });
      approvePendingProposal({ activeMemoLimit: 2 });
    }
    const state = getMemosState();
    expect(state.active.length).toBe(2);
    expect(state.history.length).toBe(1);
    expect(state.history[0].status).toBe("retired");
  });

  it("rollbackMemo moves active → history", () => {
    setPendingProposal({ rules: ["rule A n=10 WR 60"] });
    approvePendingProposal();
    const id = getActiveMemos()[0].id;
    const result = rollbackMemo(id);
    expect(result.ok).toBe(true);
    expect(getActiveMemos().length).toBe(0);
    const history = getMemosState().history;
    expect(history[0].status).toBe("rolled_back");
    expect(history[0].id).toBe(id);
  });

  it("rollbackMemo returns not_found for unknown id", () => {
    const result = rollbackMemo("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
  });
});

// ─── formatMemosForPrompt ─────────────────────────────────────

describe("formatMemosForPrompt", () => {
  it("returns empty string for empty/null input", () => {
    expect(formatMemosForPrompt(null)).toBe("");
    expect(formatMemosForPrompt([])).toBe("");
  });

  it("renders each memo's id, date, and bullets", () => {
    const memos = [
      {
        id: "2026-W19-aaaa",
        approvedAt: "2026-05-05T17:00:00Z",
        rules: ["Boost X for Y", "Skip Z"],
      },
    ];
    const out = formatMemosForPrompt(memos);
    expect(out).toContain("[2026-W19-aaaa @ 2026-05-05]");
    expect(out).toContain("- Boost X for Y");
    expect(out).toContain("- Skip Z");
  });
});
