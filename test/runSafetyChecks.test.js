// Tests for runSafetyChecks() — deploy_position pre-execution gate.
//
// This function checks bin_step bounds, position count limits, duplicate
// pool/token guards, amount validity, and SOL balance. It calls
// getMyPositions() and getWalletBalances() under the hood so we mock
// those via vi.mock().

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dlmm.js → getMyPositions
vi.mock("../tools/dlmm.js", () => ({
  getMyPositions: vi.fn(),
  // Other named exports referenced by executor.js — return harmless stubs
  getActiveBin: vi.fn(),
  deployPosition: vi.fn(),
  getWalletPositions: vi.fn(),
  getPositionPnl: vi.fn(),
  claimFees: vi.fn(),
  closePosition: vi.fn(),
  searchPools: vi.fn(),
}));

// Mock wallet.js → getWalletBalances
vi.mock("../tools/wallet.js", () => ({
  getWalletBalances: vi.fn(),
  swapToken: vi.fn(),
  normalizeMint: (m) => m,
}));

const { getMyPositions } = await import("../tools/dlmm.js");
const { getWalletBalances } = await import("../tools/wallet.js");
const { runSafetyChecks } = await import("../tools/executor.js");
const { config } = await import("../config.js");

const POOL = "Pool1111111111111111111111111111111111111111";
const POOL2 = "Pool2222222222222222222222222222222222222222";
const TOKEN_A = "TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B = "TokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function setMyPositions(arr) {
  getMyPositions.mockResolvedValue({ total_positions: arr.length, positions: arr });
}
function setBalance(sol) {
  getWalletBalances.mockResolvedValue({ sol });
}

beforeEach(() => {
  vi.clearAllMocks();
  config.screening.minBinStep = 80;
  config.screening.maxBinStep = 125;
  config.risk.maxPositions = 3;
  config.risk.maxDeployAmount = 50;
  config.management.deployAmountSol = 0.5;
  config.management.gasReserve = 0.2;
  // Disable A1 study-before-deploy guard for legacy tests so they
  // continue to exercise their original assertions. The guard has its
  // own dedicated describe block below.
  if (config.smartLpers) config.smartLpers.enforceStudyBeforeDeploy = false;
  process.env.DRY_RUN = "true";
});

describe("runSafetyChecks: deploy_position", () => {
  it("rejects bin_step below minBinStep", async () => {
    setMyPositions([]);
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 50,
      amount_y: 0.5,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/bin_step 50/);
  });

  it("rejects bin_step above maxBinStep", async () => {
    setMyPositions([]);
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 200,
      amount_y: 0.5,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/bin_step 200/);
  });

  it("rejects when at maxPositions", async () => {
    setMyPositions([
      { pool: "p1", base_mint: TOKEN_A },
      { pool: "p2", base_mint: TOKEN_B },
      { pool: "p3", base_mint: "T3" },
    ]);
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,
      amount_y: 0.5,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/Max positions/);
  });

  it("rejects duplicate pool", async () => {
    setMyPositions([{ pool: POOL, base_mint: TOKEN_A }]);
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,
      amount_y: 0.5,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/Already have an open position in pool/);
  });

  it("rejects duplicate base_mint across different pools", async () => {
    setMyPositions([{ pool: POOL2, base_mint: TOKEN_A }]);
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      base_mint: TOKEN_A,
      bin_step: 100,
      amount_y: 0.5,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/Already holding base token/);
  });

  it("rejects zero or negative amount", async () => {
    setMyPositions([]);
    const r1 = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,
      amount_y: 0,
    });
    expect(r1.pass).toBe(false);
    expect(r1.reason).toMatch(/positive SOL amount/);

    const r2 = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,
    });
    expect(r2.pass).toBe(false);
    expect(r2.reason).toMatch(/positive SOL amount/);
  });

  it("rejects amount below minimum deploy amount", async () => {
    setMyPositions([]);
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,
      amount_y: 0.05,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/below the minimum deploy amount/);
  });

  it("rejects amount above maxDeployAmount", async () => {
    setMyPositions([]);
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,
      amount_y: 100,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/exceeds maximum allowed/);
  });

  it("accepts a valid deploy in DRY_RUN (no balance check)", async () => {
    setMyPositions([]);
    process.env.DRY_RUN = "true";
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      base_mint: TOKEN_A,
      bin_step: 100,
      amount_y: 1.0,
    });
    expect(result.pass).toBe(true);
  });

  it("rejects when SOL balance is below amount + gasReserve (live mode)", async () => {
    setMyPositions([]);
    setBalance(0.5); // need 1.0 + 0.2 = 1.2
    process.env.DRY_RUN = "false";
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,
      amount_y: 1.0,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/Insufficient SOL/);
    process.env.DRY_RUN = "true";
  });

  it("accepts when SOL balance is sufficient (live mode)", async () => {
    setMyPositions([]);
    setBalance(2.0);
    process.env.DRY_RUN = "false";
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      base_mint: TOKEN_A,
      bin_step: 100,
      amount_y: 1.0,
    });
    expect(result.pass).toBe(true);
    process.env.DRY_RUN = "true";
  });
});

// ─── A1 hard guard: study_top_lpers required before deploy_position ──
//
// The guard checks whether studyTopLPers() was called for the same pool
// within the cache TTL (25min). If not, deploy is blocked with an
// actionable error message that tells the LLM to retry after calling
// study_top_lpers. We exercise both paths here (block when no study,
// pass-through after a study) and verify the disable flag works.
describe("runSafetyChecks: A1 study-before-deploy guard", () => {
  let _resetStudyCacheForTesting;
  let studyTopLPers;

  beforeEach(async () => {
    config.smartLpers.enforceStudyBeforeDeploy = true;
    setMyPositions([]);
    const studyMod = await import("../tools/study.js");
    _resetStudyCacheForTesting = studyMod._resetStudyCacheForTesting;
    studyTopLPers = studyMod.studyTopLPers;
    _resetStudyCacheForTesting();
  });

  it("blocks deploy when no recent study call for the pool", async () => {
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,
      amount_y: 0.5,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/study_top_lpers required/);
    expect(result.reason).toContain(POOL);
  });

  it("includes a copy-paste-ready retry hint in the error message", async () => {
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,
      amount_y: 0.5,
    });
    expect(result.reason).toContain(`study_top_lpers({pool_address: "${POOL}"})`);
  });

  it("passes through when a recent study has been recorded", async () => {
    // Mock global fetch to satisfy studyTopLPers without hitting the API.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ topLpers: [], historicalOwners: [] }),
    });

    try {
      // Populate the cache via a real (but mocked-fetch) study call
      await studyTopLPers({ pool_address: POOL });

      const result = await runSafetyChecks("deploy_position", {
        pool_address: POOL,
        bin_step: 100,
        amount_y: 0.5,
      });
      // Guard passes — bin_step etc. then validate further. With
      // bin_step=100 and amount_y=0.5 within bounds, the rest pass.
      expect(result.pass).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("can be disabled via config.smartLpers.enforceStudyBeforeDeploy", async () => {
    config.smartLpers.enforceStudyBeforeDeploy = false;
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,
      amount_y: 0.5,
    });
    // Without the guard, the rest of the safety chain runs and passes.
    expect(result.pass).toBe(true);
  });

  it("does not block tools other than deploy_position", async () => {
    const result = await runSafetyChecks("close_position", {
      position_address: "abc",
    });
    // close_position has its own checks; the study guard MUST NOT fire.
    expect(result.reason || "").not.toMatch(/study_top_lpers/);
  });

  it("blocks even when bin_step would be valid (guard runs first)", async () => {
    const result = await runSafetyChecks("deploy_position", {
      pool_address: POOL,
      bin_step: 100,         // valid
      amount_y: 0.5,         // valid
      base_mint: TOKEN_A,    // valid
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/study_top_lpers required/);
  });
});
