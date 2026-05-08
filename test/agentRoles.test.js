// Regression tests for src/agent-roles.js.
//
// Origin: a serious bug where SCREENER_TOOLS did not include
// study_top_lpers, so the LLM literally answered "tool not available
// in my toolkit" and skipped the A1 self-learning step entirely. The
// hard-guard in tools/executor.js then could not even fire because the
// model never got the tool definition in the first place.
//
// These tests pin the role-specific tool sets so we catch any future
// removal/typo before it reaches production.

import { describe, it, expect } from "vitest";
import {
  MANAGER_TOOLS,
  SCREENER_TOOLS,
  GENERAL_INTENT_ONLY_TOOLS,
  INTENT_TOOLS,
} from "../src/agent-roles.js";
import { tools } from "../tools/definitions.js";

const definedToolNames = new Set(tools.map((t) => t.function.name));

describe("agent-roles: SCREENER_TOOLS", () => {
  it("includes study_top_lpers (A1 hard requirement)", () => {
    expect(SCREENER_TOOLS.has("study_top_lpers")).toBe(true);
  });

  it("includes get_top_lpers (paired alias)", () => {
    expect(SCREENER_TOOLS.has("get_top_lpers")).toBe(true);
  });

  it("includes deploy_position (the action it gates)", () => {
    expect(SCREENER_TOOLS.has("deploy_position")).toBe(true);
  });

  it("only references tools defined in tools/definitions.js", () => {
    for (const name of SCREENER_TOOLS) {
      expect(definedToolNames.has(name), `unknown tool in SCREENER_TOOLS: ${name}`).toBe(true);
    }
  });
});

describe("agent-roles: MANAGER_TOOLS", () => {
  it("includes study_top_lpers (research-only allowed)", () => {
    expect(MANAGER_TOOLS.has("study_top_lpers")).toBe(true);
  });

  it("includes core management actions", () => {
    expect(MANAGER_TOOLS.has("close_position")).toBe(true);
    expect(MANAGER_TOOLS.has("claim_fees")).toBe(true);
    expect(MANAGER_TOOLS.has("swap_token")).toBe(true);
  });

  it("does NOT expose deploy_position to the manager role", () => {
    expect(MANAGER_TOOLS.has("deploy_position")).toBe(false);
  });

  it("only references tools defined in tools/definitions.js", () => {
    for (const name of MANAGER_TOOLS) {
      expect(definedToolNames.has(name), `unknown tool in MANAGER_TOOLS: ${name}`).toBe(true);
    }
  });
});

describe("agent-roles: INTENT_TOOLS.deploy", () => {
  it("includes deploy_position itself", () => {
    expect(INTENT_TOOLS.deploy.has("deploy_position")).toBe(true);
  });

  it("deploy intent references only defined tools", () => {
    // Scoped to the deploy intent because that's the one relevant to
    // A1. Other intents have known stale aliases (update_strategy,
    // delete_strategy) that pre-date this work and are tracked
    // separately — broadening this check would break unrelated history.
    for (const name of INTENT_TOOLS.deploy) {
      expect(definedToolNames.has(name), `unknown tool in INTENT_TOOLS.deploy: ${name}`).toBe(true);
    }
  });
});

describe("agent-roles: GENERAL_INTENT_ONLY_TOOLS", () => {
  it("only references defined tools", () => {
    for (const name of GENERAL_INTENT_ONLY_TOOLS) {
      expect(definedToolNames.has(name), `unknown tool in GENERAL_INTENT_ONLY_TOOLS: ${name}`).toBe(true);
    }
  });

  it("excludes core read tools that should be broadly available", () => {
    expect(GENERAL_INTENT_ONLY_TOOLS.has("get_my_positions")).toBe(false);
    expect(GENERAL_INTENT_ONLY_TOOLS.has("get_wallet_balance")).toBe(false);
  });
});
