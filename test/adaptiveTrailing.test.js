import { describe, it, expect } from "vitest";
import { getEffectiveTrailingParams } from "../src/adaptive-trailing.js";

const baseConfig = {
  trailingTriggerPct: 3.0,
  trailingDropPct: 1.5,
  trailingVolMultiplier: 0.5,
  trailingVolPivot: 2.5,
  trailingVolMaxScale: 5.0,
  trailingMinTriggerPct: 1.5,
  trailingMaxTriggerPct: 6.0,
  trailingMinDropPct: 0.75,
  trailingMaxDropPct: 3.0,
};

describe("getEffectiveTrailingParams", () => {
  it("returns base values clamped when scaling disabled (multiplier=0)", () => {
    const r = getEffectiveTrailingParams({ volatility: 4 }, { ...baseConfig, trailingVolMultiplier: 0 });
    expect(r.scaled).toBe(false);
    expect(r.triggerPct).toBe(3.0);
    expect(r.dropPct).toBe(1.5);
    expect(r.scale).toBe(1);
  });

  it("returns base values when volatility is missing", () => {
    const r = getEffectiveTrailingParams({}, baseConfig);
    expect(r.scaled).toBe(false);
    expect(r.triggerPct).toBe(3.0);
    expect(r.dropPct).toBe(1.5);
  });

  it("returns base values when volatility equals pivot (no scaling)", () => {
    const r = getEffectiveTrailingParams({ volatility: 2.5 }, baseConfig);
    expect(r.scaled).toBe(true);
    expect(r.triggerPct).toBeCloseTo(3.0, 5);
    expect(r.dropPct).toBeCloseTo(1.5, 5);
    expect(r.scale).toBeCloseTo(1.0, 5);
  });

  it("widens trailing band on high-vol pools", () => {
    const r = getEffectiveTrailingParams({ volatility: 5 }, baseConfig);
    // scale = 1 + 0.5 * (5 - 2.5) / (5 - 2.5) = 1.5
    expect(r.scale).toBeCloseTo(1.5, 5);
    expect(r.triggerPct).toBeCloseTo(4.5, 5);
    expect(r.dropPct).toBeCloseTo(2.25, 5);
  });

  it("tightens trailing band on low-vol pools", () => {
    const r = getEffectiveTrailingParams({ volatility: 0 }, baseConfig);
    // scale = 1 + 0.5 * (0 - 2.5) / 2.5 = 0.5
    expect(r.scale).toBeCloseTo(0.5, 5);
    expect(r.triggerPct).toBeCloseTo(1.5, 5); // 3.0 * 0.5 = 1.5 (== floor)
    // 1.5 * 0.5 = 0.75 (== floor)
    expect(r.dropPct).toBeCloseTo(0.75, 5);
  });

  it("clamps trigger at upper bound on extreme volatility", () => {
    const r = getEffectiveTrailingParams({ volatility: 100 }, { ...baseConfig, trailingVolMultiplier: 1.0 });
    // unbounded scale would be huge, but clamped to maxTriggerPct=6.0
    expect(r.triggerPct).toBe(6.0);
    expect(r.dropPct).toBe(3.0);
  });

  it("clamps drop at lower bound on extreme low volatility with strong multiplier", () => {
    const r = getEffectiveTrailingParams({ volatility: -10 }, { ...baseConfig, trailingVolMultiplier: 1.0 });
    expect(r.triggerPct).toBe(1.5); // floor
    expect(r.dropPct).toBe(0.75);   // floor
  });

  it("treats string volatility as numeric", () => {
    const r = getEffectiveTrailingParams({ volatility: "5" }, baseConfig);
    expect(r.scaled).toBe(true);
    expect(r.scale).toBeCloseTo(1.5, 5);
  });

  it("handles divide-by-zero (volMaxScale == pivot) gracefully", () => {
    const r = getEffectiveTrailingParams({ volatility: 4 }, { ...baseConfig, trailingVolMaxScale: 2.5 });
    expect(r.scaled).toBe(false);
    expect(r.triggerPct).toBe(3.0);
    expect(r.dropPct).toBe(1.5);
  });

  it("scale floor prevents inverted bands at very negative scale", () => {
    // Force a hugely-negative computed scale via massive multiplier and
    // negative volatility — the helper should floor it (and the explicit
    // hard clamps then round to the operator-defined min).
    const r = getEffectiveTrailingParams({ volatility: -100 }, {
      ...baseConfig,
      trailingVolMultiplier: 100,
      trailingMinTriggerPct: 0.5,
      trailingMinDropPct: 0.25,
    });
    expect(r.triggerPct).toBeGreaterThanOrEqual(0.5);
    expect(r.dropPct).toBeGreaterThanOrEqual(0.25);
  });
});
