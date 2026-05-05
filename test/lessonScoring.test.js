// Tier 1 lesson scoring tests — verifies composite-score ranking,
// deduplication, sunset, and exploration discount work as designed.
// Pure unit tests; no fs mocking needed.

import { describe, it, expect } from "vitest";
import {
  scoreLesson,
  groupSimilarLessons,
  selectTopLessons,
} from "../lessons.js";

const NOW = new Date("2026-05-01T00:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;

function lesson(opts = {}) {
  return {
    id: opts.id ?? Math.floor(Math.random() * 1e9),
    rule: opts.rule ?? "AVOID: pool with vol=10 strategy=spot",
    tags: opts.tags ?? ["screening"],
    outcome: opts.outcome ?? "bad",
    confidence: opts.confidence ?? 0.7,
    pnl_pct: opts.pnl_pct ?? -10,
    exploration: opts.exploration ?? false,
    pinned: opts.pinned ?? false,
    created_at: opts.created_at ?? new Date(NOW).toISOString(),
  };
}

describe("scoreLesson", () => {
  it("higher magnitude pnl produces higher score", () => {
    const small = lesson({ pnl_pct: -2 });
    const large = lesson({ pnl_pct: -25 });
    expect(scoreLesson(large, 1, NOW)).toBeGreaterThan(scoreLesson(small, 1, NOW));
  });

  it("decays older lessons toward zero", () => {
    const fresh = lesson({ created_at: new Date(NOW).toISOString() });
    const old   = lesson({ created_at: new Date(NOW - 30 * DAY).toISOString() });
    const ancient = lesson({ created_at: new Date(NOW - 60 * DAY).toISOString() });
    expect(scoreLesson(fresh, 1, NOW)).toBeGreaterThan(scoreLesson(old, 1, NOW));
    expect(scoreLesson(old, 1, NOW)).toBeGreaterThan(scoreLesson(ancient, 1, NOW));
  });

  it("frequency boost raises score for repeated patterns", () => {
    const l = lesson();
    expect(scoreLesson(l, 5, NOW)).toBeGreaterThan(scoreLesson(l, 1, NOW));
  });

  it("exploration lessons get a discount", () => {
    const normal      = lesson({ exploration: false });
    const exploration = lesson({ ...normal, exploration: true });
    expect(scoreLesson(exploration, 1, NOW)).toBeLessThan(scoreLesson(normal, 1, NOW));
  });

  it("bad/failed outcomes outrank good outcomes at equal magnitude", () => {
    const bad  = lesson({ outcome: "bad",  pnl_pct: -10 });
    const good = lesson({ outcome: "good", pnl_pct: 10  });
    expect(scoreLesson(bad,  1, NOW)).toBeGreaterThan(scoreLesson(good, 1, NOW));
  });

  it("falls back to default confidence for legacy lessons", () => {
    const noConf = lesson({ confidence: undefined });
    const score  = scoreLesson(noConf, 1, NOW);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });
});

describe("groupSimilarLessons", () => {
  it("groups lessons with identical normalized rule + outcome + primary tag", () => {
    const a = lesson({ id: 1, rule: "AVOID: pool with vol=10",  outcome: "bad", tags: ["screening"] });
    const b = lesson({ id: 2, rule: "AVOID: pool with vol=15",  outcome: "bad", tags: ["screening"] }); // numbers normalized away
    const c = lesson({ id: 3, rule: "PREFER: clean pool",       outcome: "good", tags: ["screening"] });
    const groups = groupSimilarLessons([a, b, c]);
    expect(groups.length).toBe(2);
    const big = groups.find((g) => g.count === 2);
    expect(big).toBeDefined();
    expect(big.members.map((m) => m.id).sort()).toEqual([1, 2]);
  });

  it("does not merge across different outcomes even if rules match", () => {
    const a = lesson({ rule: "X pool kind A", outcome: "bad" });
    const b = lesson({ rule: "X pool kind A", outcome: "good" });
    expect(groupSimilarLessons([a, b]).length).toBe(2);
  });
});

describe("selectTopLessons", () => {
  it("returns empty for empty input or zero limit", () => {
    expect(selectTopLessons([], 5)).toEqual([]);
    expect(selectTopLessons([lesson()], 0)).toEqual([]);
  });

  it("attaches _score, _seen, _memberIds to representatives", () => {
    // Both rules normalize to "avoid pool with vol #" → same group.
    const a = lesson({ id: 1, rule: "AVOID: pool with vol=10", outcome: "bad" });
    const b = lesson({ id: 2, rule: "AVOID: pool with vol=15", outcome: "bad" });
    const out = selectTopLessons([a, b], 5, { now: NOW });
    expect(out.length).toBe(1);
    expect(out[0]._seen).toBe(2);
    expect(out[0]._score).toBeGreaterThan(0);
    expect(out[0]._memberIds.sort()).toEqual([1, 2]);
  });

  it("sunsets lessons older than maxAgeDays (non-pinned)", () => {
    const fresh = lesson({ id: 1, rule: "fresh",   created_at: new Date(NOW - 5 * DAY).toISOString() });
    const old   = lesson({ id: 2, rule: "ancient", created_at: new Date(NOW - 90 * DAY).toISOString() });
    const out = selectTopLessons([fresh, old], 10, { now: NOW });
    expect(out.map((l) => l.id)).toEqual([1]);
  });

  it("preserves pinned lessons even when stale", () => {
    const pinnedOld = lesson({
      id: 1, rule: "ancient pinned", pinned: true,
      created_at: new Date(NOW - 90 * DAY).toISOString(),
    });
    const out = selectTopLessons([pinnedOld], 10, { now: NOW });
    expect(out.length).toBe(1);
    expect(out[0].pinned).toBe(true);
  });

  it("filters lessons below minScore (non-pinned)", () => {
    const lowScore  = lesson({ id: 1, outcome: "neutral", confidence: 0.05, pnl_pct: 0.5 });
    const goodScore = lesson({ id: 2, outcome: "bad",     confidence: 0.85, pnl_pct: -20 });
    const out = selectTopLessons([lowScore, goodScore], 10, { now: NOW, minScore: 0.5 });
    expect(out.map((l) => l.id)).toEqual([2]);
  });

  it("sorts pinned first then by score desc", () => {
    const pin   = lesson({ id: 1, rule: "pinned mid",  outcome: "bad",  pinned: true, pnl_pct: -3 });
    const top   = lesson({ id: 2, rule: "biggest hit", outcome: "bad",  confidence: 0.9, pnl_pct: -25 });
    const small = lesson({ id: 3, rule: "small win",   outcome: "good", confidence: 0.6, pnl_pct: 4 });
    const out = selectTopLessons([top, small, pin], 5, { now: NOW });
    // pinned first, regardless of score
    expect(out[0].id).toBe(1);
    // remaining sorted by score: top (-25%) > small (+4%)
    expect(out[1].id).toBe(2);
    expect(out[2].id).toBe(3);
  });

  it("respects limit", () => {
    // Distinct alpha suffixes so dedup doesn't collapse all into one group.
    const lessons = Array.from({ length: 10 }, (_, i) =>
      lesson({
        id: i,
        rule: `rule kind ${String.fromCharCode(97 + i)}`,
        pnl_pct: -(i + 1),
      })
    );
    expect(selectTopLessons(lessons, 3, { now: NOW }).length).toBe(3);
  });

  it("treats lessons missing created_at as fresh (legacy compat)", () => {
    const legacy = lesson({ id: 1, created_at: undefined });
    const out = selectTopLessons([legacy], 5, { now: NOW });
    expect(out.length).toBe(1);
  });
});
