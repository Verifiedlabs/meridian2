import { describe, expect, it } from "vitest";
import { shouldUseLpAgentRelay, shouldUseZapOutRelay } from "../src/relay-policy.js";

describe("relay policy", () => {
  it("keeps relay off by default", () => {
    expect(shouldUseLpAgentRelay({})).toBe(false);
    expect(shouldUseZapOutRelay({})).toBe(false);
  });

  it("requires both lpAgentRelayEnabled and zapOutRelayEnabled for zap-out relay", () => {
    expect(shouldUseZapOutRelay({ lpAgentRelayEnabled: true, zapOutRelayEnabled: false })).toBe(false);
    expect(shouldUseZapOutRelay({ lpAgentRelayEnabled: false, zapOutRelayEnabled: true })).toBe(false);
    expect(shouldUseZapOutRelay({ lpAgentRelayEnabled: true, zapOutRelayEnabled: true })).toBe(true);
  });
});
