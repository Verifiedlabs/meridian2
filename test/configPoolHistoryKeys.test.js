import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const executorSrc = fs.readFileSync(path.join(root, "tools/executor.js"), "utf8");
const configSrc = fs.readFileSync(path.join(root, "config.js"), "utf8");
const definitionsSrc = fs.readFileSync(path.join(root, "tools/definitions.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(root, "index.js"), "utf8");

describe("poolHistory config key wiring", () => {
  it("registers validators in update_config", () => {
    expect(/poolHistoryGuardEnabled\s*:\s*bool\(\)/.test(executorSrc)).toBe(true);
    expect(/poolHistoryMinSamples\s*:\s*num\(0,\s*1e6,\s*\{\s*integer:\s*true\s*\}\)/.test(executorSrc)).toBe(true);
    expect(/poolHistoryMaxAvgPnl\s*:\s*num\(-1000,\s*1000\)/.test(executorSrc)).toBe(true);
  });

  it("maps update_config keys into config.screening", () => {
    expect(/poolHistoryGuardEnabled\s*:\s*\["screening",\s*"poolHistoryGuardEnabled"\]/.test(executorSrc)).toBe(true);
    expect(/poolHistoryMinSamples\s*:\s*\["screening",\s*"poolHistoryMinSamples"\]/.test(executorSrc)).toBe(true);
    expect(/poolHistoryMaxAvgPnl\s*:\s*\["screening",\s*"poolHistoryMaxAvgPnl"\]/.test(executorSrc)).toBe(true);
  });

  it("defines defaults and hot-reload hooks in config", () => {
    expect(/poolHistoryGuardEnabled:\s*u\.poolHistoryGuardEnabled\s*\?\?\s*true/.test(configSrc)).toBe(true);
    expect(/poolHistoryMinSamples:\s*u\.poolHistoryMinSamples\s*\?\?\s*3/.test(configSrc)).toBe(true);
    expect(/poolHistoryMaxAvgPnl:\s*u\.poolHistoryMaxAvgPnl\s*\?\?\s*-1/.test(configSrc)).toBe(true);

    expect(/fresh\.poolHistoryGuardEnabled !== undefined\)\s*s\.poolHistoryGuardEnabled = fresh\.poolHistoryGuardEnabled;/.test(configSrc)).toBe(true);
    expect(/fresh\.poolHistoryMinSamples\s*!= null\)\s*s\.poolHistoryMinSamples = fresh\.poolHistoryMinSamples;/.test(configSrc)).toBe(true);
    expect(/fresh\.poolHistoryMaxAvgPnl\s*!= null\)\s*s\.poolHistoryMaxAvgPnl\s*= fresh\.poolHistoryMaxAvgPnl;/.test(configSrc)).toBe(true);
  });

  it("documents poolHistory keys for update_config usage", () => {
    expect(definitionsSrc.includes("poolHistoryGuardEnabled")).toBe(true);
    expect(definitionsSrc.includes("poolHistoryMinSamples")).toBe(true);
    expect(definitionsSrc.includes("poolHistoryMaxAvgPnl")).toBe(true);
  });

  it("wires poolHistory keys into telegram settings UI", () => {
    expect(/poolHistoryGuardEnabled:\s*config\.screening\.poolHistoryGuardEnabled/.test(indexSrc)).toBe(true);
    expect(/poolHistoryMinSamples:\s*config\.screening\.poolHistoryMinSamples/.test(indexSrc)).toBe(true);
    expect(/poolHistoryMaxAvgPnl:\s*config\.screening\.poolHistoryMaxAvgPnl/.test(indexSrc)).toBe(true);

    expect(indexSrc.includes('toggleButton("poolHistoryGuardEnabled"')).toBe(true);
    expect(indexSrc.includes('inputButton("poolHistoryMinSamples"')).toBe(true);
    expect(indexSrc.includes('inputButton("poolHistoryMaxAvgPnl"')).toBe(true);
  });
});
