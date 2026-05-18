import { describe, it, expect, vi } from "vitest";
import { resolveDeployBinOffsets, buildDeployBinRange } from "../tools/dlmm.js";

describe("resolveDeployBinOffsets", () => {
  it("keeps explicit bins when downside/upside inputs are both zero", () => {
    const getBinIdFromPrice = vi.fn();
    const result = resolveDeployBinOffsets({
      activeBinId: 100,
      activePrice: 10,
      actualBinStep: 100,
      binsBelow: 35,
      binsAbove: 0,
      downsidePctInput: 0,
      upsidePctInput: 0,
      getBinIdFromPrice,
    });
    expect(result).toEqual({ activeBinsBelow: 35, activeBinsAbove: 0 });
    expect(getBinIdFromPrice).not.toHaveBeenCalled();
  });

  it("applies percentage override when any percentage is positive", () => {
    const getBinIdFromPrice = vi
      .fn()
      .mockImplementationOnce(() => 90)
      .mockImplementationOnce(() => 108);
    const result = resolveDeployBinOffsets({
      activeBinId: 100,
      activePrice: 10,
      actualBinStep: 100,
      binsBelow: 35,
      binsAbove: 0,
      downsidePctInput: 5,
      upsidePctInput: 5,
      getBinIdFromPrice,
    });
    expect(result).toEqual({ activeBinsBelow: 10, activeBinsAbove: 8 });
    expect(getBinIdFromPrice).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid percentage inputs", () => {
    expect(() =>
      resolveDeployBinOffsets({
        activeBinId: 100,
        activePrice: 10,
        actualBinStep: 100,
        binsBelow: 35,
        binsAbove: 0,
        downsidePctInput: "abc",
        upsidePctInput: 0,
        getBinIdFromPrice: () => 100,
      }),
    ).toThrow("downside_pct and upside_pct must be valid numbers");
  });
});

describe("buildDeployBinRange", () => {
  it("rejects zero-width ranges", () => {
    expect(() =>
      buildDeployBinRange({
        activeBinId: 100,
        activeBinsBelow: 0,
        activeBinsAbove: 0,
        isSingleSidedSol: false,
      }),
    ).toThrow("Invalid zero-width bin range");
  });

  it("rejects single-sided ranges that collapse to zero width", () => {
    expect(() =>
      buildDeployBinRange({
        activeBinId: 100,
        activeBinsBelow: 0,
        activeBinsAbove: 12,
        isSingleSidedSol: true,
      }),
    ).toThrow("Invalid zero-width bin range");
  });

  it("builds valid single-sided range pinned at active bin", () => {
    const result = buildDeployBinRange({
      activeBinId: 100,
      activeBinsBelow: 35,
      activeBinsAbove: 10,
      isSingleSidedSol: true,
    });
    expect(result).toMatchObject({
      activeBinsBelow: 35,
      activeBinsAbove: 0,
      totalBins: 35,
      minBinId: 65,
      maxBinId: 100,
      isWideRange: false,
    });
  });
});
