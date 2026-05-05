/**
 * Coaching: LLM call wrapper.
 *
 * Kept separate from src/coaching.js so the core lifecycle (digest,
 * validation, persistence) stays pure-testable. This module is the
 * only piece that talks to the LLM provider.
 */

import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { log } from "../logger.js";
import { config } from "../config.js";

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey:  process.env.LLM_API_KEY  || process.env.OPENROUTER_API_KEY,
  timeout: 60_000,
});

const META_PROMPT = `You are a trading coach reviewing the meridian2 LP bot's recent performance.

Your job: based ONLY on the digest below, propose 3-5 SPECIFIC rule additions to improve future deploys.

Each rule MUST be:
- Concrete and numeric (no vague "be careful" / "be more selective"). Cite ranges and thresholds.
- Backed by data from the digest (cite the relevant n=, WR%, avg PnL%).
- Actionable by the screening agent (refers to deploy/skip/score-boost decisions on candidate pools).

DO NOT propose rules that:
- Disable the bot entirely (no "skip all", "do not deploy", "stop all", "disable").
- Change risk-management thresholds (TP/SL/trailing) — that is outside coaching scope.
- Are vague or based on small samples (n < 5 in any cited bucket).

Return STRICT JSON in this exact shape — no markdown fences, no commentary outside JSON:

{
  "summary": "one sentence describing the overall direction of these rules",
  "rules": [
    { "rule": "concrete rule text including specific numbers", "reasoning": "data citation from the digest" }
  ]
}`;

/**
 * Call the LLM to produce a memo proposal from a digest.
 *
 * @param {string} digestText - structured digest from generateDigest()
 * @param {Object} [opts]
 * @param {string} [opts.model]    - LLM model id (defaults to config.llm.generalModel)
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{summary:string, rules:Array<{rule:string,reasoning?:string}>}>}
 */
export async function proposeMemoFromDigest(digestText, opts = {}) {
  const {
    model = config.llm?.generalModel || process.env.LLM_MODEL || "openrouter/healer-alpha",
    maxTokens = 1500,
  } = opts;
  if (!digestText || typeof digestText !== "string") {
    throw new Error("digestText required");
  }

  log("coaching", `Calling LLM for memo proposal (model=${model}, digestLen=${digestText.length})`);

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: META_PROMPT },
      { role: "user",   content: digestText },
    ],
    temperature: 0.3,
    max_tokens: maxTokens,
  });

  const raw = response?.choices?.[0]?.message?.content || "";
  const cleaned = String(raw)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(cleaned));
      log("coaching_warn", "Repaired malformed JSON from LLM");
    } catch (e) {
      throw new Error(`LLM did not return valid JSON: ${e.message} — raw[:200]: ${raw.slice(0, 200)}`);
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("LLM response is not an object");
  }
  if (!Array.isArray(parsed.rules)) {
    throw new Error("LLM response missing 'rules' array");
  }

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
    rules: parsed.rules
      .map((r) => {
        if (typeof r === "string") return { rule: r };
        if (r && typeof r === "object" && typeof r.rule === "string") return r;
        return null;
      })
      .filter(Boolean),
  };
}
