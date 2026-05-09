import { describe, it, expect } from "vitest";
import { buildPnlCalendar } from "../briefing.js";

// Anchor in mid-month so future-day truncation, prev/next availability, and
// month-transition logic can all be exercised deterministically.
const ANCHOR = new Date("2026-05-15T12:00:00Z");

function perfOn(year, month1, day, pnlUsd, hour = 12) {
  const ts = new Date(Date.UTC(year, month1 - 1, day, hour, 0, 0)).toISOString();
  return { recorded_at: ts, pnl_usd: pnlUsd };
}

describe("buildPnlCalendar", () => {
  it("returns a valid empty calendar when there are no records", () => {
    const cal = buildPnlCalendar([], { now: ANCHOR });
    expect(cal.year).toBe(2026);
    expect(cal.month).toBe(4); // May = 0-indexed 4
    expect(cal.empty).toBe(true);
    expect(cal.totals).toEqual({ pnl_usd: 0, count: 0, wins: 0, losses: 0 });
    expect(cal.text).toContain("Daily PnL");
    expect(cal.text).toContain("May 2026");
    expect(cal.text).toContain("No closed positions this month");
  });

  it("aggregates same-day closes and reports daily totals", () => {
    const perf = [
      perfOn(2026, 5, 3, 1.5),
      perfOn(2026, 5, 3, 2.0),
      perfOn(2026, 5, 3, -0.5),
      perfOn(2026, 5, 7, -3.0),
    ];
    const cal = buildPnlCalendar(perf, { now: ANCHOR });
    expect(cal.totals.pnl_usd).toBe(0); // 1.5+2.0-0.5-3.0 = 0
    expect(cal.totals.count).toBe(4);
    // Day 3 net = +3.00 (1.5+2.0-0.5), 3 closes
    expect(cal.text).toMatch(/<code>03 Sun<\/code>\s+🟢 <b>\+\$3\.00<\/b>\s+\(3\)/);
    // Day 7 net = -3.00, 1 close
    expect(cal.text).toMatch(/<code>07 Thu<\/code>\s+🔴 <b>-\$3\.00<\/b>\s+\(1\)/);
    // Quiet day in-between marked with em dash
    expect(cal.text).toMatch(/<code>04 Mon<\/code>\s+·\s+—/);
  });

  it("hides future days within the current month", () => {
    // ANCHOR is May 15. Future days (May 16-31) must NOT appear.
    const cal = buildPnlCalendar([perfOn(2026, 5, 1, 1.0)], { now: ANCHOR });
    // Day 15 (today) is allowed
    expect(cal.text).toContain("15 Fri");
    // Day 16+ should NOT appear in any form
    expect(cal.text).not.toContain("16 Sat");
    expect(cal.text).not.toContain("31 Sun");
  });

  it("shows full month for past months", () => {
    const cal = buildPnlCalendar([], { now: ANCHOR, year: 2026, month: 3 }); // April
    // April has 30 days — last one must appear regardless of where ANCHOR is
    expect(cal.text).toContain("30 Thu");
    // April day 1 must also appear
    expect(cal.text).toContain("01 Wed");
  });

  it("computes monthly totals correctly with mixed wins/losses", () => {
    const perf = [
      perfOn(2026, 5, 1, 5),
      perfOn(2026, 5, 2, 3),
      perfOn(2026, 5, 3, -2),
      perfOn(2026, 5, 4, -1),
      perfOn(2026, 5, 5, 0.001), // counts as flat (below 0.005 threshold)
    ];
    const cal = buildPnlCalendar(perf, { now: ANCHOR });
    expect(cal.totals.count).toBe(5);
    expect(cal.totals.wins).toBe(2);
    expect(cal.totals.losses).toBe(2);
    expect(cal.totals.pnl_usd).toBe(5.0);
    expect(cal.text).toMatch(/Month:.*\+\$5\.00.*WR 40%.*2W\/2L.*5 closes/);
  });

  it("scopes records strictly to the target month", () => {
    // Record on April 30 must NOT leak into May calendar
    const perf = [
      perfOn(2026, 4, 30, 999),
      perfOn(2026, 6, 1, 999),
      perfOn(2026, 5, 10, 1.25),
    ];
    const cal = buildPnlCalendar(perf, { now: ANCHOR });
    expect(cal.totals.pnl_usd).toBe(1.25);
    expect(cal.totals.count).toBe(1);
  });

  it("hasNext is false when target month is the current month", () => {
    const cal = buildPnlCalendar([], { now: ANCHOR }); // current = May 2026
    expect(cal.hasNext).toBe(false);
  });

  it("hasNext is true when looking at a past month", () => {
    const cal = buildPnlCalendar([], { now: ANCHOR, year: 2026, month: 3 }); // April
    expect(cal.hasNext).toBe(true);
  });

  it("hasPrev is false with no records, true when records exist before target", () => {
    // No records — no point allowing infinite back-navigation
    expect(buildPnlCalendar([], { now: ANCHOR }).hasPrev).toBe(false);
    // Records exist in March → April calendar should allow Prev
    const aprilCal = buildPnlCalendar(
      [perfOn(2026, 3, 15, 1)],
      { now: ANCHOR, year: 2026, month: 3 },
    );
    expect(aprilCal.hasPrev).toBe(true);
    // March calendar with only March records → no earlier records → no Prev
    const marchCal = buildPnlCalendar(
      [perfOn(2026, 3, 15, 1)],
      { now: ANCHOR, year: 2026, month: 2 }, // March = 0-indexed 2
    );
    expect(marchCal.hasPrev).toBe(false);
  });

  it("formats prevYM and nextYM with correct year wrap-around", () => {
    // January 2026 → prev should be 2025-12, next should be 2026-02
    const jan = buildPnlCalendar([], { now: ANCHOR, year: 2026, month: 0 });
    expect(jan.prevYM).toBe("2025-12");
    expect(jan.nextYM).toBe("2026-02");
    // December 2025 → prev should be 2025-11, next should be 2026-01
    const dec = buildPnlCalendar([], { now: ANCHOR, year: 2025, month: 11 });
    expect(dec.prevYM).toBe("2025-11");
    expect(dec.nextYM).toBe("2026-01");
  });

  it("uses closed_at as fallback when recorded_at is missing", () => {
    const perf = [{ closed_at: new Date("2026-05-08T10:00:00Z").toISOString(), pnl_usd: 4.2 }];
    const cal = buildPnlCalendar(perf, { now: ANCHOR });
    expect(cal.totals.count).toBe(1);
    expect(cal.totals.pnl_usd).toBe(4.2);
    expect(cal.text).toMatch(/<code>08 Fri<\/code>\s+🟢 <b>\+\$4\.20<\/b>/);
  });

  it("ignores records with invalid timestamps without throwing", () => {
    const perf = [
      { recorded_at: "not-a-date", pnl_usd: 100 },
      { recorded_at: null, pnl_usd: 100 },
      perfOn(2026, 5, 4, 2.0),
    ];
    const cal = buildPnlCalendar(perf, { now: ANCHOR });
    expect(cal.totals.count).toBe(1);
    expect(cal.totals.pnl_usd).toBe(2.0);
  });

  it("skips entries that aren't an array", () => {
    const cal = buildPnlCalendar(null, { now: ANCHOR });
    expect(cal.empty).toBe(true);
    expect(cal.totals.count).toBe(0);
  });

  it("includes navigation keys (prevYM/nextYM/hasPrev/hasNext) in output", () => {
    const cal = buildPnlCalendar([perfOn(2026, 1, 1, 1)], { now: ANCHOR });
    expect(cal).toHaveProperty("prevYM");
    expect(cal).toHaveProperty("nextYM");
    expect(cal).toHaveProperty("hasPrev");
    expect(cal).toHaveProperty("hasNext");
    expect(cal.prevYM).toBe("2026-04");
    expect(cal.nextYM).toBe("2026-06");
  });
});
