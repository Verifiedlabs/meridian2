// Tests for config.computeDeployAmount() — wallet-balance → deploy-amount scaling.
//
// Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
// where deployable = max(0, walletSol - gasReserve).

import { describe, it, expect, beforeEach } from "vitest";
import { config, computeDeployAmount } from "../config.js";

const DEFAULT_RESERVE = 0.2;
const DEFAULT_PCT = 0.35;

function setup({ floor = 0.5, ceil = 50, reserve = DEFAULT_RESERVE, pct = DEFAULT_PCT } = {}) {
  config.management.gasReserve = reserve;
  config.management.positionSizePct = pct;
  config.management.deployAmountSol = floor;
  config.risk.maxDeployAmount = ceil;
}

describe("computeDeployAmount", () => {
  beforeEach(() => setup());

  it("returns floor when wallet is below floor + gas reserve", () => {
    expect(computeDeployAmount(0.6)).toBe(0.5); // (0.6 - 0.2) * 0.35 = 0.14 → floor=0.5
  });

  it("returns floor when wallet has nothing deployable (below gas reserve)", () => {
    expect(computeDeployAmount(0.1)).toBe(0.5);
    expect(computeDeployAmount(0)).toBe(0.5);
  });

  it("scales linearly above floor up to ceiling", () => {
    // wallet=2.0 → deployable=1.8 → 1.8*0.35 = 0.63
    expect(computeDeployAmount(2.0)).toBe(0.63);
    // wallet=3.0 → deployable=2.8 → 0.98
    expect(computeDeployAmount(3.0)).toBe(0.98);
    // wallet=4.0 → deployable=3.8 → 1.33
    expect(computeDeployAmount(4.0)).toBe(1.33);
  });

  it("clamps to ceiling when wallet is large", () => {
    setup({ floor: 0.5, ceil: 5 });
    expect(computeDeployAmount(100)).toBe(5);
  });

  it("respects custom positionSizePct", () => {
    setup({ pct: 0.5 });
    // wallet=2.0 → deployable=1.8 → 0.9
    expect(computeDeployAmount(2.0)).toBe(0.9);
  });

  it("respects custom gasReserve", () => {
    setup({ reserve: 1.0 });
    // wallet=2.0 → deployable=1.0 → 0.35 → floor=0.5
    expect(computeDeployAmount(2.0)).toBe(0.5);
    // wallet=5.0 → deployable=4.0 → 1.4
    expect(computeDeployAmount(5.0)).toBe(1.4);
  });

  it("never returns negative even if balance < reserve and pct is high", () => {
    setup({ pct: 1.0 });
    expect(computeDeployAmount(-1)).toBeGreaterThanOrEqual(0);
    expect(computeDeployAmount(0)).toBeGreaterThanOrEqual(0);
  });

  it("rounds to 2 decimals", () => {
    // wallet=1.7 → deployable=1.5 → 0.525 → 0.52 (rounded down at 2dp)
    expect(computeDeployAmount(1.7)).toBe(0.52);
    // wallet=3.0 → deployable=2.8 → 0.98
    expect(computeDeployAmount(3.0)).toBe(0.98);
    // result should always be a number with at most 2 decimal places
    const result = computeDeployAmount(2.5);
    expect(Number.isFinite(result)).toBe(true);
    expect(result.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("ceiling wins even if floor > computed > ceiling — pathological config", () => {
    setup({ floor: 10, ceil: 5 });
    // floor 10 > ceiling 5: result clamped to ceiling
    // dynamic = 0.6 → max(10, 0.6) = 10 → min(5, 10) = 5
    expect(computeDeployAmount(2.0)).toBe(5);
  });
});
