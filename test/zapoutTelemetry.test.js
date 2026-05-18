import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetZapOutTelemetryForTests,
  getZapOutTelemetrySummary,
  recordNativeZapOutFail,
  recordNativeZapOutFallbackUsed,
  recordNativeZapOutSuccess,
} from "../src/zapout-telemetry.js";

describe("zapout telemetry", () => {
  beforeEach(() => {
    __resetZapOutTelemetryForTests();
  });

  afterEach(() => {
    __resetZapOutTelemetryForTests();
  });

  it("counts success/fail/fallback events", () => {
    recordNativeZapOutSuccess({ position: "pos1" });
    recordNativeZapOutFail({ position: "pos2" });
    recordNativeZapOutFallbackUsed({ position: "pos3" });

    const summary = getZapOutTelemetrySummary();
    expect(summary.counters.native_zapout_success).toBe(1);
    expect(summary.counters.native_zapout_fail).toBe(1);
    expect(summary.counters.native_zapout_fallback_used).toBe(1);
    expect(summary.recent.length).toBe(3);
  });
});
