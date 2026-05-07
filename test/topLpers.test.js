// Tests for src/top-lpers.js — Tier 3 self-learning auto-discovery.
//
// Isolates state per test via _resetForTesting() and mocks the disk fs
// and the smart-wallets sync function so we can assert auto-promotion
// behaviour without touching real files.

import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "os";
import fs from "fs";
import path from "path";

// Direct the module to a tmp cwd so any save attempt cannot corrupt repo state.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-top-lpers-test-"));
process.chdir(tmpDir);

// Mock disk writes — writeJsonAtomicSync uses tmp + rename under the hood.
vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
vi.spyOn(fs, "renameSync").mockImplementation(() => {});
vi.spyOn(fs, "existsSync").mockImplementation(() => false);
vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});

// Mock config with controllable thresholds.
vi.mock("../config.js", () => ({
  config: {
    smartLpers: {
      autoPromoteEnabled:      true,
      autoPromoteMinPools:     3,
      autoPromoteMinWinRate:   0.6,
      autoPromoteMinPositions: 10,
      recencyDecayDays:        30,
    },
  },
}));

// Mock smart-wallets.js so the static `import { addSmartWallet }` at the
// top of top-lpers.js binds to a spy. We swap to a per-test capture via
// _setSmartWalletsMockForTesting once the module is loaded.
vi.mock("../smart-wallets.js", () => ({
  addSmartWallet: vi.fn(() => ({ success: true })),
}));

const {
  recordTopLPers,
  promoteLper,
  rejectLper,
  scoreLper,
  getLeaderboard,
  getStats,
  getLperRecord,
  _resetForTesting,
  _setSmartWalletsMockForTesting,
} = await import("../src/top-lpers.js");

// Test addresses must satisfy /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ — base58
// without 0, capital I/O, or lowercase l. We build deterministic 38-char
// strings where the first 2 chars are a unique tag.
function fakeAddr(tag) {
  if (tag.length > 38) throw new Error("tag too long");
  return (tag + "A".repeat(38 - tag.length));
}
const ADDRS = {
  alpha: fakeAddr("1A"),
  beta:  fakeAddr("2B"),
  gamma: fakeAddr("3G"),
  pool1: fakeAddr("P1"),
  pool2: fakeAddr("P2"),
  pool3: fakeAddr("P3"),
  pool4: fakeAddr("P4"),
};

let smartWalletCalls;

beforeEach(() => {
  smartWalletCalls = [];
  _resetForTesting();
  _setSmartWalletsMockForTesting((args) => {
    smartWalletCalls.push(args);
    return { success: true };
  });
});

function makeLper(address, summary = {}) {
  return {
    owner: address,
    owner_short: `${address.slice(0, 8)}...`,
    summary: {
      total_positions: 5,
      win_rate: 0.5,
      roi: 0.1,
      avg_open_pnl_pct: 1.0,
      avg_hold_hours: 2,
      avg_fee_per_tvl_24h_pct: 0.5,
      total_pnl_usd: 100,
      preferred_strategy: "spot",
      preferred_range_style: "narrow",
      ...summary,
    },
  };
}

describe("top-lpers — recordTopLPers", () => {
  it("records new LPers with all fields populated", () => {
    const result = recordTopLPers({
      pool: ADDRS.pool1,
      pool_name: "GME-SOL",
      lpers: [makeLper(ADDRS.alpha)],
    });
    expect(result.recorded).toBe(1);
    expect(result.autoPromoted).toEqual([]);

    const record = getLperRecord(ADDRS.alpha);
    expect(record).toBeDefined();
    expect(record.address).toBe(ADDRS.alpha);
    expect(record.pools_seen).toHaveLength(1);
    expect(record.pools_seen[0].pool).toBe(ADDRS.pool1);
    expect(record.pools_seen[0].pool_name).toBe("GME-SOL");
    expect(record.pools_seen[0].count).toBe(1);
    expect(record.aggregate_stats.total_positions).toBe(5);
    expect(record.aggregate_stats.preferred_strategy).toBe("spot");
    expect(record.promoted).toBe(false);
    expect(record.rejected).toBe(false);
  });

  it("ignores invalid pool address", () => {
    const result = recordTopLPers({ pool: "invalid", lpers: [makeLper(ADDRS.alpha)] });
    expect(result.recorded).toBe(0);
  });

  it("ignores empty lpers array", () => {
    const result = recordTopLPers({ pool: ADDRS.pool1, lpers: [] });
    expect(result.recorded).toBe(0);
  });

  it("skips invalid LPer addresses but counts the rest", () => {
    const result = recordTopLPers({
      pool: ADDRS.pool1,
      lpers: [
        { owner: "bad-addr", summary: {} },
        makeLper(ADDRS.alpha),
      ],
    });
    expect(result.recorded).toBe(1);
    expect(getLperRecord(ADDRS.alpha)).toBeTruthy();
  });

  it("upserts pools_seen with incrementing count when same pool seen again", () => {
    recordTopLPers({ pool: ADDRS.pool1, pool_name: "GME-SOL", lpers: [makeLper(ADDRS.alpha)] });
    recordTopLPers({ pool: ADDRS.pool1, pool_name: "GME-SOL", lpers: [makeLper(ADDRS.alpha)] });
    const record = getLperRecord(ADDRS.alpha);
    expect(record.pools_seen).toHaveLength(1);
    expect(record.pools_seen[0].count).toBe(2);
  });

  it("appends new pool entry when LPer seen in different pool", () => {
    recordTopLPers({ pool: ADDRS.pool1, pool_name: "GME-SOL", lpers: [makeLper(ADDRS.alpha)] });
    recordTopLPers({ pool: ADDRS.pool2, pool_name: "WIF-SOL", lpers: [makeLper(ADDRS.alpha)] });
    const record = getLperRecord(ADDRS.alpha);
    expect(record.pools_seen).toHaveLength(2);
    const pools = record.pools_seen.map((p) => p.pool).sort();
    expect(pools).toEqual([ADDRS.pool1, ADDRS.pool2].sort());
  });

  it("merges aggregate_stats with latest values", () => {
    recordTopLPers({ pool: ADDRS.pool1, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.4 })] });
    recordTopLPers({ pool: ADDRS.pool2, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.7 })] });
    const record = getLperRecord(ADDRS.alpha);
    expect(record.aggregate_stats.win_rate).toBe(0.7); // latest wins
  });

  it("collects unique names_seen", () => {
    recordTopLPers({
      pool: ADDRS.pool1,
      lpers: [{ ...makeLper(ADDRS.alpha), owner_short: "alpha.eth" }],
    });
    recordTopLPers({
      pool: ADDRS.pool2,
      lpers: [{ ...makeLper(ADDRS.alpha), owner_short: "alpha-renamed" }],
    });
    const record = getLperRecord(ADDRS.alpha);
    expect(record.names_seen).toContain("alpha.eth");
    expect(record.names_seen).toContain("alpha-renamed");
  });
});

describe("top-lpers — auto-promotion", () => {
  it("does NOT auto-promote with too few pools", () => {
    // 2 pools < threshold of 3
    recordTopLPers({ pool: ADDRS.pool1, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.8, total_positions: 20 })] });
    const result = recordTopLPers({ pool: ADDRS.pool2, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.8, total_positions: 20 })] });
    expect(result.autoPromoted).toEqual([]);
    expect(getLperRecord(ADDRS.alpha).promoted).toBe(false);
  });

  it("does NOT auto-promote with low win_rate", () => {
    for (const pool of [ADDRS.pool1, ADDRS.pool2, ADDRS.pool3]) {
      recordTopLPers({ pool, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.4, total_positions: 20 })] });
    }
    expect(getLperRecord(ADDRS.alpha).promoted).toBe(false);
  });

  it("does NOT auto-promote with too few positions", () => {
    for (const pool of [ADDRS.pool1, ADDRS.pool2, ADDRS.pool3]) {
      recordTopLPers({ pool, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.8, total_positions: 5 })] });
    }
    expect(getLperRecord(ADDRS.alpha).promoted).toBe(false);
  });

  it("auto-promotes when ALL thresholds met", () => {
    let result;
    for (const pool of [ADDRS.pool1, ADDRS.pool2, ADDRS.pool3]) {
      result = recordTopLPers({
        pool,
        lpers: [makeLper(ADDRS.alpha, { win_rate: 0.75, total_positions: 25 })],
      });
    }
    expect(result.autoPromoted).toHaveLength(1);
    expect(result.autoPromoted[0].address).toBe(ADDRS.alpha);
    expect(getLperRecord(ADDRS.alpha).promoted).toBe(true);
    // smart-wallets sync should have been called.
    expect(smartWalletCalls).toHaveLength(1);
    expect(smartWalletCalls[0].address).toBe(ADDRS.alpha);
    expect(smartWalletCalls[0].type).toBe("lp");
    expect(smartWalletCalls[0].category).toBe("smart");
  });

  it("does NOT auto-promote rejected wallets", () => {
    // Pre-reject before any sightings.
    rejectLper({ address: ADDRS.alpha, reason: "operator-flagged" });
    for (const pool of [ADDRS.pool1, ADDRS.pool2, ADDRS.pool3]) {
      recordTopLPers({ pool, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.9, total_positions: 50 })] });
    }
    expect(getLperRecord(ADDRS.alpha).promoted).toBe(false);
    expect(getLperRecord(ADDRS.alpha).rejected).toBe(true);
    expect(smartWalletCalls).toHaveLength(0);
  });

  it("does not double-promote", () => {
    for (const pool of [ADDRS.pool1, ADDRS.pool2, ADDRS.pool3]) {
      recordTopLPers({ pool, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.75, total_positions: 25 })] });
    }
    // Already promoted — additional sightings should NOT re-trigger.
    smartWalletCalls = [];
    recordTopLPers({ pool: ADDRS.pool4, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.75, total_positions: 25 })] });
    expect(smartWalletCalls).toHaveLength(0);
  });

  it("ignores smart-wallets sync errors silently", () => {
    _setSmartWalletsMockForTesting(() => { throw new Error("boom"); });
    for (const pool of [ADDRS.pool1, ADDRS.pool2, ADDRS.pool3]) {
      recordTopLPers({ pool, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.75, total_positions: 25 })] });
    }
    // Promotion still recorded in top-lpers.json even when sync fails.
    expect(getLperRecord(ADDRS.alpha).promoted).toBe(true);
  });
});

describe("top-lpers — manual promote / reject", () => {
  it("promote requires existing record", () => {
    const r = promoteLper({ address: ADDRS.alpha });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_found");
  });

  it("promote rejects invalid address", () => {
    const r = promoteLper({ address: "junk" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_address");
  });

  it("manual promote bypasses thresholds", () => {
    recordTopLPers({ pool: ADDRS.pool1, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.1, total_positions: 1 })] });
    const r = promoteLper({ address: ADDRS.alpha, reason: "operator-trust" });
    expect(r.ok).toBe(true);
    expect(getLperRecord(ADDRS.alpha).promoted).toBe(true);
    expect(smartWalletCalls).toHaveLength(1);
  });

  it("promote on rejected returns reason=rejected", () => {
    rejectLper({ address: ADDRS.alpha });
    const r = promoteLper({ address: ADDRS.alpha });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("rejected");
  });

  it("reject on existing LPer marks them rejected", () => {
    recordTopLPers({ pool: ADDRS.pool1, lpers: [makeLper(ADDRS.alpha)] });
    const r = rejectLper({ address: ADDRS.alpha, reason: "scammer" });
    expect(r.ok).toBe(true);
    expect(r.proactive).toBeFalsy();
    const record = getLperRecord(ADDRS.alpha);
    expect(record.rejected).toBe(true);
    expect(record.rejection_reason).toBe("scammer");
  });

  it("reject on unknown address creates pre-emptive blacklist entry", () => {
    const r = rejectLper({ address: ADDRS.beta, reason: "known-bot" });
    expect(r.ok).toBe(true);
    expect(r.proactive).toBe(true);
    const record = getLperRecord(ADDRS.beta);
    expect(record).toBeDefined();
    expect(record.rejected).toBe(true);
  });
});

describe("top-lpers — leaderboard + scoring", () => {
  it("ranks by composite score: pools × win_rate × (1+roi) × recency", () => {
    // alpha: 3 pools, WR 0.7, ROI 0.2 → 3 × 0.7 × 1.2 = 2.52 (× ~1.0 recency)
    // beta:  2 pools, WR 0.9, ROI 0.5 → 2 × 0.9 × 1.5 = 2.70
    for (const pool of [ADDRS.pool1, ADDRS.pool2, ADDRS.pool3]) {
      recordTopLPers({ pool, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.7, roi: 0.2, total_positions: 5 })] });
    }
    for (const pool of [ADDRS.pool1, ADDRS.pool2]) {
      recordTopLPers({ pool, lpers: [makeLper(ADDRS.beta, { win_rate: 0.9, roi: 0.5, total_positions: 5 })] });
    }
    const board = getLeaderboard({ limit: 5 });
    // First entry must be the higher score. Beta wins by composite even
    // with one fewer pool because of its much higher WR × ROI.
    expect(board[0].address).toBe(ADDRS.beta);
    expect(board[0].score).toBeGreaterThan(board[1].score);
  });

  it("filters rejected wallets by default", () => {
    recordTopLPers({ pool: ADDRS.pool1, lpers: [makeLper(ADDRS.alpha)] });
    rejectLper({ address: ADDRS.alpha });
    expect(getLeaderboard().find((e) => e.address === ADDRS.alpha)).toBeUndefined();
    expect(getLeaderboard({ includeRejected: true }).find((e) => e.address === ADDRS.alpha)).toBeDefined();
  });

  it("onlyPromoted filter narrows to promoted entries", () => {
    recordTopLPers({ pool: ADDRS.pool1, lpers: [makeLper(ADDRS.alpha)] });
    recordTopLPers({ pool: ADDRS.pool1, lpers: [makeLper(ADDRS.beta)] });
    promoteLper({ address: ADDRS.alpha });
    const board = getLeaderboard({ onlyPromoted: true });
    expect(board.map((e) => e.address)).toEqual([ADDRS.alpha]);
  });

  it("recency decay reduces score for stale entries", () => {
    const now = new Date("2026-05-07T00:00:00Z").getTime();
    recordTopLPers(
      { pool: ADDRS.pool1, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.5, roi: 0.1 })] },
      now - 30 * 24 * 60 * 60 * 1000, // 30 days ago — at decay halflife
    );
    const oldRecord = getLperRecord(ADDRS.alpha);
    const oldScore = scoreLper(oldRecord, now);

    // Same exact record but at "today"
    recordTopLPers(
      { pool: ADDRS.pool2, lpers: [makeLper(ADDRS.alpha, { win_rate: 0.5, roi: 0.1 })] },
      now,
    );
    const freshRecord = getLperRecord(ADDRS.alpha);
    const freshScore = scoreLper(freshRecord, now);

    // Fresh score must beat the same shape from 30 days ago.
    expect(freshScore).toBeGreaterThan(oldScore);
  });
});

describe("top-lpers — getStats", () => {
  it("counts buckets correctly across mixed states", () => {
    recordTopLPers({ pool: ADDRS.pool1, lpers: [makeLper(ADDRS.alpha)] });
    recordTopLPers({ pool: ADDRS.pool1, lpers: [makeLper(ADDRS.beta)] });
    recordTopLPers({ pool: ADDRS.pool1, lpers: [makeLper(ADDRS.gamma)] });
    promoteLper({ address: ADDRS.alpha });
    rejectLper({ address: ADDRS.beta });
    const stats = getStats();
    expect(stats.total_tracked).toBe(3);
    expect(stats.promoted).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.thresholds.autoPromoteMinPools).toBe(3);
  });
});
