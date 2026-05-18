import { describe, expect, it } from "vitest";
import {
  estimatePriceMovePctFromBins,
  shouldTriggerStopLossFromBins,
  shouldBypassStopLossConfirmationOnEmergencyOor,
  evaluateWsStopLossConfirmation,
} from "../src/realtime-stoploss.js";

describe("realtime stop-loss bin estimator", () => {
  it("estimates negative move when active bin drops", () => {
    const estimated = estimatePriceMovePctFromBins({ deployBin: -400, activeBin: -407, binStep: 100 });
    expect(estimated).not.toBeNull();
    expect(estimated).toBeLessThan(0);
  });

  it("triggers when estimated move crosses stop-loss", () => {
    const result = shouldTriggerStopLossFromBins({
      deployBin: -400,
      activeBin: -407,
      binStep: 100,
      stopLossPct: -6,
    });
    expect(result.trigger).toBe(true);
    expect(result.estimatedPct).toBeLessThanOrEqual(-6);
  });

  it("does not trigger when drawdown is above stop-loss threshold", () => {
    const result = shouldTriggerStopLossFromBins({
      deployBin: -400,
      activeBin: -404,
      binStep: 100,
      stopLossPct: -6,
    });
    expect(result.trigger).toBe(false);
    expect(result.estimatedPct).toBeGreaterThan(-6);
  });

  it("returns safe false for invalid values", () => {
    const result = shouldTriggerStopLossFromBins({
      deployBin: null,
      activeBin: -404,
      binStep: 100,
      stopLossPct: -6,
    });
    expect(result.trigger).toBe(false);
    expect(result.estimatedPct).toBeNull();
  });

  it("bypasses confirmation for severe OOR moves", () => {
    expect(
      shouldBypassStopLossConfirmationOnEmergencyOor({
        isOor: true,
        activeBin: -620,
        lower: -600,
        upper: -560,
        emergencyBins: 8,
      }),
    ).toBe(true);
  });

  it("does not bypass confirmation for non-emergency OOR moves", () => {
    expect(
      shouldBypassStopLossConfirmationOnEmergencyOor({
        isOor: true,
        activeBin: -606,
        lower: -600,
        upper: -560,
        emergencyBins: 8,
      }),
    ).toBe(false);
  });

  it("resets pending confirmation when live pnl rebounds", () => {
    const first = evaluateWsStopLossConfirmation({
      stopLossPct: -6,
      currentPnlPct: -6.2,
      confirmationsPassed: 0,
      requiredConfirmations: 2,
    });
    expect(first.confirmed).toBe(false);
    expect(first.nextConfirmationsPassed).toBe(1);
    expect(first.reset).toBe(false);

    const rebound = evaluateWsStopLossConfirmation({
      stopLossPct: -6,
      currentPnlPct: -5.8,
      confirmationsPassed: first.nextConfirmationsPassed,
      requiredConfirmations: 2,
    });
    expect(rebound.confirmed).toBe(false);
    expect(rebound.nextConfirmationsPassed).toBe(0);
    expect(rebound.reset).toBe(true);
  });

  it("confirms stop-loss after consistent live breaches", () => {
    const first = evaluateWsStopLossConfirmation({
      stopLossPct: -6,
      currentPnlPct: -6.3,
      confirmationsPassed: 0,
      requiredConfirmations: 2,
    });
    expect(first.confirmed).toBe(false);
    expect(first.nextConfirmationsPassed).toBe(1);
    expect(first.reset).toBe(false);

    const second = evaluateWsStopLossConfirmation({
      stopLossPct: -6,
      currentPnlPct: -6.1,
      confirmationsPassed: first.nextConfirmationsPassed,
      requiredConfirmations: 2,
    });
    expect(second.confirmed).toBe(true);
    expect(second.nextConfirmationsPassed).toBe(2);
    expect(second.reset).toBe(false);
  });
});
