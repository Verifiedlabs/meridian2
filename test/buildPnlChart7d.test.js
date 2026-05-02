import { describe, it, expect } from "vitest";
import { buildPnlChart7d } from "../briefing.js";

const ANCHOR = new Date("2026-05-01T12:00:00Z");

function perfAt(daysAgo, pnlUsd) {
  const t = new Date(ANCHOR.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return { recorded_at: t.toISOString(), pnl_usd: pnlUsd };
}

describe("buildPnlChart7d", () => {
  it("returns null on empty input", () => {
    expect(buildPnlChart7d([], { now: ANCHOR })).toBeNull();
  });

  it("returns null on non-array input", () => {
    expect(buildPnlChart7d(null, { now: ANCHOR })).toBeNull();
    expect(buildPnlChart7d(undefined, { now: ANCHOR })).toBeNull();
  });

  it("returns null when all days have zero PnL", () => {
    expect(buildPnlChart7d([perfAt(1, 0), perfAt(2, 0)], { now: ANCHOR })).toBeNull();
  });

  it("renders 7 lines (one per day) when there is signal", () => {
    const chart = buildPnlChart7d([perfAt(0, 1.5), perfAt(3, -0.5)], { now: ANCHOR });
    expect(chart).not.toBeNull();
    expect(chart.split("\n")).toHaveLength(7);
  });

  it("scales bars to maxAbs (largest day fills width)", () => {
    const chart = buildPnlChart7d([perfAt(0, 5), perfAt(1, 1)], { now: ANCHOR, barWidth: 10 });
    const lines = chart.split("\n");
    // Most recent day (index 6) had +$5 and should be a full-width bar
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toMatch(/██████████/);
    expect(lastLine).toContain("+$5.00");
  });

  it("uses sign markers (+/-) and color dots correctly", () => {
    const chart = buildPnlChart7d([perfAt(0, 2.5), perfAt(1, -1)], { now: ANCHOR });
    expect(chart).toContain("🟢");
    expect(chart).toContain("🔴");
    expect(chart).toMatch(/\+\$2\.50/);
    expect(chart).toMatch(/-\$1\.00/);
  });

  it("aggregates multiple closes within the same day", () => {
    // 3 closes today summing to +$1.50
    const chart = buildPnlChart7d(
      [perfAt(0, 0.5), perfAt(0, 0.7), perfAt(0, 0.3)],
      { now: ANCHOR }
    );
    const lines = chart.split("\n");
    const today = lines[lines.length - 1];
    expect(today).toContain("+$1.50");
    expect(today).toContain("3×");
  });

  it("respects custom barWidth", () => {
    const chart = buildPnlChart7d([perfAt(0, 1)], { now: ANCHOR, barWidth: 4 });
    const today = chart.split("\n").pop();
    // bar slot must be exactly 4 chars wide (4 blocks for max day)
    expect(today).toMatch(/████\s/);
  });

  it("produces a usable chart even with closed_at fallback", () => {
    const chart = buildPnlChart7d([{ closed_at: ANCHOR.toISOString(), pnl_usd: 2 }], { now: ANCHOR });
    expect(chart).not.toBeNull();
    expect(chart).toContain("+$2.00");
  });
});
