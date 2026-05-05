// Tests for src/circuit-breaker.js — drawdown auto-pause module.
//
// We isolate state per test by mocking fs (so the module never reads or
// writes a real circuit-breaker.json) and by calling _resetForTesting()
// at the top of each test. Config is mocked so we control thresholds.

import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

// Direct the module to a tmp cwd so any save attempt cannot corrupt repo state.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-breaker-test-"));
const originalCwd = process.cwd();
process.chdir(tmpDir);

// Mock fs.writeFileSync + renameSync — writeJsonAtomicSync uses tmp + rename.
vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
vi.spyOn(fs, "renameSync").mockImplementation(() => {});
vi.spyOn(fs, "existsSync").mockImplementation(() => false);
vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});

// Mock config with controllable thresholds. We re-import the breaker after
// the mock so the module's lazy `getCfg()` reads the mocked values.
vi.mock("../config.js", () => ({
  config: {
    risk: {
      drawdownStreakThreshold:   3,    // small for tests: 3 losses out of 4
      drawdownStreakWindow:      4,
      maxDailyLossSol:           0.10, // 0.1 SOL daily cap
      drawdownCooldownMinutes:   60,   // 1h cooldown
    },
  },
}));

const { recordClose, isScreeningPaused, getStatus, resume, _resetForTesting } =
  await import("../src/circuit-breaker.js");

beforeEach(() => {
  _resetForTesting();
});

describe("circuit-breaker", () => {
  it("does not trip on profitable closes", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    for (let i = 0; i < 5; i++) {
      const result = recordClose({ pnl_sol: 0.05, pnl_pct: 5 }, t0 + i * 60_000);
      expect(result.tripped).toBe(false);
    }
    expect(isScreeningPaused()).toBe(false);
  });

  it("trips on losing streak (3/4 losses with threshold=3, window=4)", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    // 4 closes: 3 losses + 1 small profit. With threshold=3, this trips.
    recordClose({ pnl_sol: -0.02, pnl_pct: -2 }, t0);
    recordClose({ pnl_sol:  0.01, pnl_pct:  1 }, t0 + 60_000);
    recordClose({ pnl_sol: -0.02, pnl_pct: -2 }, t0 + 120_000);
    const last = recordClose({ pnl_sol: -0.02, pnl_pct: -2 }, t0 + 180_000);
    expect(last.tripped).toBe(true);
    expect(last.justTripped).toBe(true);
    expect(last.reason).toMatch(/losing streak/);
  });

  it("does not trip when fewer than streakThreshold losses in window", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    // 4 closes: 2 losses + 2 wins → 2/4 < threshold=3 → no trip.
    recordClose({ pnl_sol: -0.02 }, t0);
    recordClose({ pnl_sol:  0.03 }, t0 + 60_000);
    recordClose({ pnl_sol: -0.02 }, t0 + 120_000);
    const last = recordClose({ pnl_sol: 0.03 }, t0 + 180_000);
    expect(last.tripped).toBe(false);
  });

  it("trips when daily SOL loss exceeds cap", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    // Single big loss exceeding the 0.10 SOL cap.
    const result = recordClose({ pnl_sol: -0.15, pnl_pct: -30 }, t0);
    expect(result.tripped).toBe(true);
    expect(result.reason).toMatch(/daily loss/);
  });

  it("trips on cumulative daily loss across multiple closes", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    recordClose({ pnl_sol: -0.04 }, t0);
    recordClose({ pnl_sol: -0.04 }, t0 + 60_000);
    const last = recordClose({ pnl_sol: -0.04 }, t0 + 120_000); // cum = -0.12 ≤ -0.10
    expect(last.tripped).toBe(true);
    expect(last.reason).toMatch(/daily loss/);
  });

  it("auto-resumes after cooldown elapses", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    // Trip via daily loss
    recordClose({ pnl_sol: -0.20 }, t0);
    expect(isScreeningPaused(t0 + 60_000)).toBe(true);
    // Just before cooldown end → still paused.
    expect(isScreeningPaused(t0 + 59 * 60_000)).toBe(true);
    // After cooldown (60min default) → resumed.
    expect(isScreeningPaused(t0 + 61 * 60_000)).toBe(false);
  });

  it("manual resume clears the trip immediately", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    recordClose({ pnl_sol: -0.20 }, t0);
    expect(isScreeningPaused(t0)).toBe(true);
    const result = resume({ manual: true });
    expect(result.wasResumed).toBe(true);
    expect(isScreeningPaused(t0)).toBe(false);
  });

  it("resume returns wasResumed=false when not tripped", () => {
    const result = resume({ manual: true });
    expect(result.wasResumed).toBe(false);
  });

  it("recentCloses window is capped at streakWindow size", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    for (let i = 0; i < 10; i++) {
      recordClose({ pnl_sol: 0.01 }, t0 + i * 60_000);
    }
    const status = getStatus(t0 + 600_000);
    expect(status.recentTotal).toBe(4); // streakWindow=4, capped
  });

  it("daily window rolls over after 24h", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    recordClose({ pnl_sol: -0.05 }, t0);
    let status = getStatus(t0 + 60_000);
    expect(status.dailyPnlSol).toBe(-0.05);
    // 25h later → window rolls, dailyPnl resets.
    status = getStatus(t0 + 25 * 60 * 60 * 1000);
    expect(status.dailyPnlSol).toBe(0);
  });

  it("once tripped, additional closes do not re-set justTripped", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    const first = recordClose({ pnl_sol: -0.20 }, t0);
    expect(first.justTripped).toBe(true);
    const second = recordClose({ pnl_sol: -0.05 }, t0 + 60_000);
    expect(second.tripped).toBe(true);
    expect(second.justTripped).toBe(false); // already tripped — not "just"
  });

  it("getStatus reports willResumeAt when tripped", () => {
    const t0 = new Date("2026-05-04T00:00:00Z").getTime();
    recordClose({ pnl_sol: -0.20 }, t0);
    const status = getStatus(t0 + 60_000);
    expect(status.paused).toBe(true);
    expect(status.willResumeAt).toBeTruthy();
    // Cooldown is 60min in this test; willResumeAt should equal trippedAt + 60min.
    const trippedTime = new Date(status.trippedAt).getTime();
    const resumeTime = new Date(status.willResumeAt).getTime();
    expect(resumeTime - trippedTime).toBe(60 * 60 * 1000);
  });
});

// Restore cwd at end so other test files run from the correct directory.
process.chdir(originalCwd);
