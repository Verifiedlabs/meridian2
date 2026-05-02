import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary, categorizeCloseReason, getPostMortemSuggestions } from "./lessons.js";
import { config } from "./config.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Highlight noteworthy lessons (skip the noisy SELF-TUNED ones — those
  //    belong in /lessons, not the briefing). We surface up to 2 actionable
  //    or pinned lessons from the last 24h, plus a pointer to /lessons.
  const lessonsLast24h = (lessonsData.lessons || [])
    .filter(l => new Date(l.created_at) > last24h)
    .filter(l => !(l.tags || []).includes("self_tune"))
    .filter(l => !/^\[SELF-TUNED\]/i.test(l.rule));
  const pinnedAll = (lessonsData.lessons || []).filter(l => l.pinned);
  const noteworthy = [...pinnedAll, ...lessonsLast24h]
    .reduce((acc, l) => acc.find(x => x.id === l.id) ? acc : [...acc, l], [])
    .slice(0, 2);

  // 4. Top close reasons over the last 24h — actually useful for daily review.
  // Uses the centralised categorizeCloseReason helper so buckets match the
  // ones surfaced in agent prompts and get_performance_summary.
  const reasonBuckets = new Map();
  for (const p of perfLast24h) {
    const key = categorizeCloseReason(p.close_reason);
    const b = reasonBuckets.get(key) || { count: 0, wins: 0, pnl: 0 };
    b.count++;
    if ((p.pnl_usd || 0) > 0.005) b.wins++;
    b.pnl += p.pnl_usd || 0;
    reasonBuckets.set(key, b);
  }
  const topReasons = [...reasonBuckets.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3);

  // 5. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 6. Format Message — operational summary, NOT a lessons dump.
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Opened: ${openedLast24h.length}  ·  📤 Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance (24h):</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}  ·  💎 Fees: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate: ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}% (${perfLast24h.length} closed)`
      : "📈 Win Rate: N/A",
  ];

  if (topReasons.length) {
    lines.push("");
    lines.push(`<b>Top close reasons (24h):</b>`);
    for (const [reason, b] of topReasons) {
      const wr = Math.round((b.wins / b.count) * 100);
      const pnlSign = b.pnl >= 0 ? "+" : "-";
      lines.push(`  • ${b.count}× ${reason} · WR ${wr}% · ${pnlSign}$${Math.abs(b.pnl).toFixed(2)}`);
    }
  }

  if (noteworthy.length) {
    lines.push("");
    lines.push(`<b>Highlights:</b>`);
    for (const l of noteworthy) {
      const tag = l.pinned ? "📌 " : "💡 ";
      lines.push(`  ${tag}${l.rule.slice(0, 120)}`);
    }
    lines.push(`<i>(See /lessons for full knowledge base.)</i>`);
  }

  lines.push("");
  lines.push(`<b>Current Portfolio:</b>`);
  lines.push(`📂 Open Positions: ${openPositions.length}`);
  if (perfSummary) {
    const pnlAll = perfSummary.total_pnl_usd ?? 0;
    lines.push(`📊 All-time: $${pnlAll.toFixed(2)} · ${perfSummary.win_rate_pct}% win · ${perfSummary.total_positions_closed} closed`);
  }

  // 7. Postmortem call-outs — only surface high/medium severity findings so
  //    the briefing stays scannable. Operator can run get_postmortem_suggestions
  //    directly for the full list.
  const postmortem = getPostMortemSuggestions({ mgmtConfig: config?.management });
  const flagged = (postmortem?.suggestions || []).filter((s) => s.severity === "high" || s.severity === "medium");
  if (flagged.length > 0) {
    lines.push("");
    lines.push(`<b>⚠️ Postmortem flags:</b>`);
    for (const s of flagged.slice(0, 3)) {
      const icon = s.severity === "high" ? "🔴" : "🟡";
      lines.push(`  ${icon} ${s.summary.slice(0, 110)}`);
    }
    lines.push(`<i>(Run get_postmortem_suggestions for full detail + action hints.)</i>`);
  }

  // 8. Compact 7-day PnL chart — purely cosmetic but useful for spotting
  //    streaks at a glance. Skipped when there's no closed-position data.
  const chart = buildPnlChart7d(lessonsData.performance || []);
  if (chart) {
    lines.push("");
    lines.push(`<b>📊 7-day PnL</b>`);
    lines.push(`<pre>${chart}</pre>`);
  }

  lines.push("────────────────");

  return lines.join("\n");
}

/**
 * Render a compact 7-day daily-PnL bar chart using ASCII blocks. Returns
 * null when there's no signal (zero closed positions or all-zero PnL).
 * Bars are right-anchored for negative days and left-anchored for
 * positive days, so the centre line lives on the same column.
 *
 * Exported for unit testing.
 */
export function buildPnlChart7d(performance, opts = {}) {
  const { days = 7, barWidth = 16, now = new Date() } = opts;
  if (!Array.isArray(performance)) return null;
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const dayPerf = performance.filter((p) => {
      const t = new Date(p.recorded_at || p.closed_at || 0).getTime();
      return t >= dayStart.getTime() && t < dayEnd.getTime();
    });
    const pnl = dayPerf.reduce((s, p) => s + (Number(p.pnl_usd) || 0), 0);
    buckets.push({
      label: dayStart.toISOString().slice(5, 10), // MM-DD (UTC)
      pnl,
      count: dayPerf.length,
    });
  }

  const maxAbs = buckets.reduce((m, b) => Math.max(m, Math.abs(b.pnl)), 0);
  if (maxAbs === 0) return null;

  const lines = [];
  for (const b of buckets) {
    const blocks = Math.min(barWidth, Math.round((Math.abs(b.pnl) / maxAbs) * barWidth));
    const bar = b.pnl >= 0
      ? "█".repeat(blocks).padEnd(barWidth, " ")
      : " ".repeat(barWidth - blocks) + "█".repeat(blocks);
    const sign = b.pnl >= 0 ? "+" : "-";
    const pnlStr = `${sign}$${Math.abs(b.pnl).toFixed(2)}`;
    const dot = b.pnl > 0.005 ? "🟢" : b.pnl < -0.005 ? "🔴" : "⚪";
    const countStr = b.count > 0 ? `${b.count}×` : "—";
    lines.push(`${b.label}  ${dot} ${bar}  ${pnlStr.padStart(8, " ")}  ${countStr}`);
  }
  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
