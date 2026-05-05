/**
 * Tier 2 self-learning: Coaching memo lifecycle.
 *
 * Pure-logic module (no LLM, no Telegram, no fs side effects beyond
 * memos.json). Drives the digest → propose → approve → inject loop.
 *
 *   1. generateDigest()        — deterministic text from perf + lessons
 *   2. (LLM)                   — see ./coaching-llm.js
 *   3. validateMemoProposal()  — sanity-check the LLM output
 *   4. setPendingProposal()    — stage for operator approval
 *   5. approvePendingProposal()→ active memo (FIFO-retired at limit)
 *   6. getActiveMemos()        — caller injects into system prompt
 *   7. rollbackMemo()          — undo an active memo if perf regresses
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { writeJsonAtomicSync } from "../fs-utils.js";
import { log } from "../logger.js";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const MEMOS_FILE = path.join(__dirname, "..", "memos.json");

const DEFAULT_STATE = () => ({ active: [], pending: null, history: [] });

// ─── Persistence ────────────────────────────────────────────────
//
// In-memory cache with disk write-through so tests can mock fs writes
// to noops without losing state between calls inside a single test.

let _state = null;

function loadState() {
  if (_state) return _state;
  if (!fs.existsSync(MEMOS_FILE)) {
    _state = DEFAULT_STATE();
    return _state;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(MEMOS_FILE, "utf8"));
    _state = {
      active:  Array.isArray(raw.active)  ? raw.active  : [],
      pending: raw.pending ?? null,
      history: Array.isArray(raw.history) ? raw.history : [],
    };
  } catch (e) {
    log("coaching_warn", `Failed to load ${MEMOS_FILE}: ${e.message}`);
    _state = DEFAULT_STATE();
  }
  return _state;
}

function saveState(state) {
  _state = state;
  try {
    writeJsonAtomicSync(MEMOS_FILE, state);
  } catch (e) {
    log("coaching_warn", `Failed to persist ${MEMOS_FILE}: ${e.message}`);
  }
}

// ─── Digest Generation ────────────────────────────────────────

/**
 * Build a deterministic text digest summarizing recent performance and
 * top lessons. This is the *only* context the LLM gets — keeping it
 * structured prevents the model from hallucinating numbers.
 *
 * @param {Object} args
 * @param {Object} args.perfSummary  — output of getPerformanceSummary()
 * @param {Array}  [args.lessons]    — pre-ranked lessons (Tier 1 selectTopLessons)
 * @param {number} [args.windowDays] — annotation only; affects header text
 * @returns {{ok:boolean, reason?:string, text:string|null, snapshot:Object|null}}
 */
export function generateDigest({ perfSummary, lessons = [], windowDays = 7 }) {
  if (!perfSummary || !Number.isFinite(perfSummary.total_positions_closed) || perfSummary.total_positions_closed < 1) {
    return { ok: false, reason: "no_perf_data", text: null, snapshot: null };
  }

  const lines = [
    `PERFORMANCE DIGEST (${windowDays}d window, ${perfSummary.total_positions_closed} closes)`,
    "─────────────────────────────────────────",
    `Win rate: ${perfSummary.win_rate_pct ?? 0}% (${perfSummary.winners ?? 0}W ${perfSummary.losers ?? 0}L ${perfSummary.flat ?? 0}F)`,
    `Avg PnL: ${perfSummary.avg_pnl_pct ?? 0}% | Total: ${perfSummary.total_pnl_pct ?? 0}%`,
    `Avg winner: ${perfSummary.avg_winner_pnl_pct ?? 0}% | Avg loser: ${perfSummary.avg_loser_pnl_pct ?? 0}%`,
    "",
  ];

  if (perfSummary.by_exploration) {
    const e = perfSummary.by_exploration.exploration;
    const n = perfSummary.by_exploration.normal;
    lines.push("By cycle type:");
    if (n) lines.push(`  Normal:      WR ${n.win_rate_pct}% (n=${n.count}, avg ${n.avg_pnl_pct}%)`);
    if (e) lines.push(`  Exploration: WR ${e.win_rate_pct}% (n=${e.count}, avg ${e.avg_pnl_pct}%)`);
    lines.push("");
  }

  if (perfSummary.by_close_reason) {
    const sorted = Object.entries(perfSummary.by_close_reason).sort(
      (a, b) => (b[1].sum_pnl_pct ?? 0) - (a[1].sum_pnl_pct ?? 0),
    );
    if (sorted.length) {
      lines.push("By close reason (sum PnL desc):");
      for (const [reason, stats] of sorted) {
        lines.push(`  ${String(reason).padEnd(18)} n=${stats.count}, avg ${stats.avg_pnl_pct}%, sum ${stats.sum_pnl_pct}%`);
      }
      lines.push("");
    }
  }

  const ranked = Array.isArray(lessons) ? lessons.slice(0, 10) : [];
  if (ranked.length > 0) {
    lines.push(`TOP LESSONS (${ranked.length}):`);
    for (const l of ranked) {
      const seen = l._seen && l._seen > 1 ? ` (seen ${l._seen}×)` : "";
      const tag  = l.outcome ? `[${String(l.outcome).toUpperCase()}]` : "";
      const rule = String(l.rule || "").slice(0, 160);
      lines.push(`  ${tag} ${rule}${seen}`);
    }
    lines.push("");
  }

  return {
    ok: true,
    text: lines.join("\n"),
    snapshot: {
      total_closes: perfSummary.total_positions_closed,
      win_rate_pct: perfSummary.win_rate_pct ?? null,
      avg_pnl_pct:  perfSummary.avg_pnl_pct ?? null,
      window_days:  windowDays,
      generated_at: new Date().toISOString(),
    },
  };
}

// ─── Memo Validation ──────────────────────────────────────────
//
// Defense against reward-hacking from the LLM. We never auto-approve;
// even after these checks the operator must explicitly accept via
// /memo approve. But we surface obvious bad proposals here so the
// operator sees them flagged.

const SUSPICIOUS_PATTERNS = [
  /\bskip\s+all\b/i,
  /\bdo\s+not\s+deploy\b/i,
  /\bnever\s+deploy\b/i,
  /\bstop\s+all\b/i,
  /\bclose\s+all\b/i,
  /\bdisable\b/i,
  /\bset\s+(maxOpenPositions|deployAmountSol)\s*=\s*0\b/i,
];

/**
 * Validate a memo proposal's structure and content before allowing
 * approval. Returns ok=false with errors[] if any issue is found.
 *
 * @param {Object} proposal
 * @param {Array<string|{rule:string}>} proposal.rules
 * @param {Object} [opts]
 */
export function validateMemoProposal(proposal, opts = {}) {
  const {
    maxRules       = 5,
    maxRuleLength  = 240,
    maxTotalLength = 1500,
    minRules       = 1,
  } = opts;
  const errors = [];

  if (!proposal || typeof proposal !== "object") {
    return { ok: false, errors: ["proposal_not_object"] };
  }

  const rules = Array.isArray(proposal.rules) ? proposal.rules : [];

  if (rules.length < minRules)  errors.push(`too_few_rules:${rules.length}<${minRules}`);
  if (rules.length > maxRules)  errors.push(`too_many_rules:${rules.length}>${maxRules}`);

  let totalLen = 0;
  for (const r of rules) {
    const text = typeof r === "string" ? r : (r && r.rule) || "";
    if (typeof text !== "string" || !text.trim()) {
      errors.push("empty_rule");
      continue;
    }
    if (text.length > maxRuleLength) errors.push(`rule_too_long:${text.length}>${maxRuleLength}`);
    totalLen += text.length;

    for (const pat of SUSPICIOUS_PATTERNS) {
      if (pat.test(text)) {
        errors.push(`suspicious_pattern:${pat.source}`);
        break;
      }
    }
  }

  if (totalLen > maxTotalLength) errors.push(`total_too_long:${totalLen}>${maxTotalLength}`);

  return { ok: errors.length === 0, errors };
}

// ─── Memo Lifecycle ───────────────────────────────────────────

/**
 * Generate a memo id of the form YYYY-Www-XXXX (year, ISO-week, random).
 * Deterministic prefix keeps memos chronologically sortable in operator UI.
 * Random suffix avoids collisions when multiple memos are created in the
 * same millisecond (tests, fast-fire approve loops, etc.).
 */
function genMemoId(now = new Date()) {
  const yr = now.getUTCFullYear();
  const onejan = new Date(Date.UTC(yr, 0, 1));
  const week = Math.ceil(((now - onejan) / 86400000 + onejan.getUTCDay() + 1) / 7);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${yr}-W${String(week).padStart(2, "0")}-${suffix}`;
}

/**
 * Stage a proposal as pending. Replaces any existing pending (only one
 * pending at a time so the operator never has stacked proposals).
 */
export function setPendingProposal({ rules, summary = null, snapshot = null }) {
  const validation = validateMemoProposal({ rules });
  const state = loadState();
  const memo = {
    id: genMemoId(),
    status: "pending",
    rules: (rules || []).map((r) => (typeof r === "string" ? r : (r && r.rule) || "")).filter(Boolean),
    summary: summary || null,
    snapshot: snapshot || null,
    createdAt: new Date().toISOString(),
    validation,
  };
  state.pending = memo;
  saveState(state);
  log("coaching", `Pending proposal ${memo.id} (${memo.rules.length} rules, valid=${validation.ok})`);
  return memo;
}

/**
 * Approve the pending proposal → active. FIFO-retire oldest active when
 * over activeMemoLimit so the prompt budget stays bounded.
 */
export function approvePendingProposal({ activeMemoLimit = 10 } = {}) {
  const state = loadState();
  if (!state.pending) return { ok: false, reason: "no_pending" };
  if (!state.pending.validation || !state.pending.validation.ok) {
    return { ok: false, reason: "invalid", errors: state.pending.validation?.errors || [] };
  }
  const memo = {
    ...state.pending,
    status: "active",
    approvedAt: new Date().toISOString(),
  };
  state.active.push(memo);
  state.pending = null;
  while (state.active.length > activeMemoLimit) {
    const retired = state.active.shift();
    retired.status = "retired";
    retired.retiredAt = new Date().toISOString();
    state.history.push(retired);
  }
  saveState(state);
  log("coaching", `Approved memo ${memo.id} → ${state.active.length} active`);
  return { ok: true, memo, activeCount: state.active.length };
}

/** Reject the pending proposal — moves it to history with reason. */
export function rejectPendingProposal(reason = "operator") {
  const state = loadState();
  if (!state.pending) return { ok: false, reason: "no_pending" };
  const memo = {
    ...state.pending,
    status: "rejected",
    rejectedAt: new Date().toISOString(),
    rejectedReason: String(reason).slice(0, 120),
  };
  state.history.push(memo);
  state.pending = null;
  saveState(state);
  log("coaching", `Rejected memo ${memo.id} (${reason})`);
  return { ok: true, memo };
}

/** Roll back an active memo (perf regression observed). */
export function rollbackMemo(id) {
  if (!id) return { ok: false, reason: "no_id" };
  const state = loadState();
  const idx = state.active.findIndex((m) => m.id === id);
  if (idx === -1) return { ok: false, reason: "not_found" };
  const [memo] = state.active.splice(idx, 1);
  memo.status = "rolled_back";
  memo.rolledBackAt = new Date().toISOString();
  state.history.push(memo);
  saveState(state);
  log("coaching", `Rolled back memo ${id}`);
  return { ok: true, memo };
}

// ─── Read Helpers ─────────────────────────────────────────────

export function getActiveMemos()      { return loadState().active; }
export function getPendingProposal()  { return loadState().pending; }
export function getMemosState()       { return loadState(); }

/**
 * Format active memos as a system-prompt block. Returns empty string
 * if no active memos so the caller can splice unconditionally.
 */
export function formatMemosForPrompt(memos) {
  if (!Array.isArray(memos) || memos.length === 0) return "";
  const lines = [];
  for (const m of memos) {
    const date = String(m.approvedAt || m.createdAt || "").slice(0, 10);
    lines.push(`[${m.id} @ ${date}]`);
    for (const rule of (m.rules || [])) {
      lines.push(`  - ${rule}`);
    }
  }
  return lines.join("\n");
}

// ─── Test Helpers ─────────────────────────────────────────────
// Resets the in-memory cache so the next loadState() re-reads from
// disk (or returns the default if disk reads are mocked away).

export function _resetForTesting() {
  _state = null;
}
