import { config } from "../config.js";
import { recordTopLPers } from "../src/top-lpers.js";
import { log } from "../logger.js";

const AGENT_MERIDIAN_API = config.api.url;
const AGENT_MERIDIAN_PUBLIC_KEY =
  config.api.publicApiKey || process.env.PUBLIC_API_KEY || "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";

// Client-side cache for /top-lp + /study-top-lp responses. The Meridian
// server already caches the underlying data for ~30 minutes; mirroring
// that locally avoids the per-pool 60s rate limit during screening loops
// while never serving data older than the server itself would.
const _studyCache = new Map(); // pool_address -> { data, fetchedAt }
const STUDY_CACHE_TTL_MS = 25 * 60 * 1000; // 25min, just under server's 30m

function getCachedStudy(pool_address) {
  const hit = _studyCache.get(pool_address);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt >= STUDY_CACHE_TTL_MS) {
    _studyCache.delete(pool_address);
    return null;
  }
  return hit.data;
}

/**
 * True iff studyTopLPers() has been called for this pool within the
 * cache TTL (default 25min). Used by the executor's deploy_position
 * safety check to enforce A1 self-learning loop — without this guard
 * the LLM can silently bypass the prompt rule that requires a study
 * call before every deploy.
 *
 * @param {string} pool_address
 * @returns {boolean}
 */
export function hasRecentStudy(pool_address) {
  return getCachedStudy(pool_address) !== null;
}

// Test-only: force-clear the cache so tests start from a known state.
export function _resetStudyCacheForTesting() {
  _studyCache.clear();
}

function putCachedStudy(pool_address, data) {
  _studyCache.set(pool_address, { data, fetchedAt: Date.now() });
}

export async function studyTopLPers({ pool_address, limit = 4 }) {
  const cached = getCachedStudy(pool_address);
  if (cached) {
    return { ...cached, cache_hit: true };
  }

  const headers = { "x-api-key": AGENT_MERIDIAN_PUBLIC_KEY };
  const [poolRes, signalRes] = await Promise.all([
    fetch(`${AGENT_MERIDIAN_API}/top-lp/${pool_address}`, { headers }),
    fetch(`${AGENT_MERIDIAN_API}/study-top-lp/${pool_address}`, { headers }),
  ]);

  if (!poolRes.ok) {
    if (poolRes.status === 429) {
      throw new Error("Rate limit exceeded. Please wait 60 seconds before studying this pool again.");
    }
    throw new Error(`top-lp API error: ${poolRes.status}`);
  }

  if (!signalRes.ok) {
    if (signalRes.status === 429) {
      throw new Error("Rate limit exceeded. Please wait 60 seconds before studying this pool again.");
    }
    throw new Error(`study-top-lp API error: ${signalRes.status}`);
  }

  const poolData = await poolRes.json();
  const signalData = await signalRes.json();
  const topLpers = Array.isArray(poolData.topLpers) ? poolData.topLpers : [];
  const historicalOwners = Array.isArray(poolData.historicalOwners) ? poolData.historicalOwners : [];
  const ranked = topLpers.slice(0, Math.max(1, limit));

  if (!ranked.length) {
    const emptyResult = {
      pool: pool_address,
      message: "No LPAgent top LPer data found for this pool yet.",
      patterns: {},
      lpers: [],
    };
    // Cache the empty response too — saves another rate-limited round-trip
    // when the same pool is screened repeatedly within the cache window.
    putCachedStudy(pool_address, emptyResult);
    return emptyResult;
  }

  const historicalMap = new Map(historicalOwners.map((owner) => [owner.owner, owner]));

  const lpers = ranked.map((owner) => {
    const history = historicalMap.get(owner.owner);
    return {
      owner: owner.owner,
      owner_short: owner.ownerShort || `${owner.owner.slice(0, 8)}...`,
      signal_tags: [
        history?.preferredStrategy ? `strategy:${history.preferredStrategy}` : null,
        history?.preferredRangeStyle ? `range:${history.preferredRangeStyle}` : null,
      ].filter(Boolean),
      summary: {
        total_positions: owner.totalLp || history?.topPositions?.length || 0,
        avg_hold_hours: round(owner.avgAgeHours ?? history?.avgHoldHours ?? 0, 2),
        avg_open_pnl_pct: round(owner.pnlPerInflowPct ?? history?.avgPnlPct ?? 0, 2),
        avg_fee_per_tvl_24h_pct: round(owner.feePercent ?? history?.avgFeePercent ?? 0, 2),
        total_pnl_usd: round(owner.totalPnlUsd ?? 0, 2),
        total_balance_usd: round(owner.totalInflowUsd ?? 0, 2),
        avg_range_width_pct: null,
        avg_distance_to_active_pct: null,
        win_rate: round((owner.winRatePct ?? 0) / 100, 2),
        roi: round((owner.roiPct ?? 0) / 100, 4),
        fee_pct_of_capital: round(owner.feePercent ?? 0, 2),
        preferred_strategy: history?.preferredStrategy || "unknown",
        preferred_range_style: history?.preferredRangeStyle || "unknown",
      },
      positions: Array.isArray(history?.topPositions)
        ? history.topPositions.map((position) => ({
            pool: pool_address,
            pair: poolData.overview?.name || "Unknown pool",
            hold_hours: round(position.ageHours ?? 0, 2),
            pnl_usd: round(position.pnlUsd ?? 0, 2),
            pnl_pct: fmtPct(position.pnlPct),
            fee_usd: round(position.feeUsd ?? 0, 2),
            in_range_pct: position.inRange == null ? null : position.inRange ? 100 : 0,
            strategy: position.strategy || null,
            closed_reason: position.rangeStyle || null,
            balance_usd: round(position.inputValue ?? 0, 2),
            fee_per_tvl_24h_pct: round(position.feePercent ?? 0, 2),
            range_width_pct: position.widthBins ?? null,
            distance_to_active_pct: null,
            lower_bin_id: position.lowerBinId ?? null,
            upper_bin_id: position.upperBinId ?? null,
          }))
        : [],
    };
  });

  const patterns = buildPatterns(ranked, historicalOwners, signalData, poolData.overview || {});

  const poolName =
    poolData.overview?.name ||
    `${poolData.overview?.tokenXSymbol || "TOKEN"}-${poolData.overview?.tokenYSymbol || "SOL"}`;

  const result = {
    pool: pool_address,
    pool_name: poolName,
    message:
      "LPAgent-backed top LP study from Agent Meridian 30m cached owner aggregates plus owner historical positions.",
    patterns,
    lpers,
  };

  // Persist to top-lpers.json so the bot can self-discover smart LPers
  // across pools over time. Includes auto-promotion to smart-wallets.json
  // when thresholds are met. Best-effort — never fails the API call.
  try {
    const persisted = recordTopLPers({ pool: pool_address, pool_name: poolName, lpers });
    if (persisted.autoPromoted.length > 0) {
      const names = persisted.autoPromoted.map((p) => `${p.name} (${p.address.slice(0, 8)})`).join(", ");
      log("top_lpers", `🤝 Auto-promoted ${persisted.autoPromoted.length} LPer(s) to smart wallets: ${names}`);
      result.auto_promoted = persisted.autoPromoted;
    }
  } catch (err) {
    log("top_lpers_warn", `recordTopLPers failed for ${pool_address.slice(0, 8)}: ${err.message}`);
  }

  putCachedStudy(pool_address, result);
  return result;
}

function buildPatterns(ranked, historicalOwners, signalData, overview) {
  const avgHold = avg(ranked.map((o) => o.avgAgeHours).filter(isNum));
  const avgOpenPnlPct = avg(ranked.map((o) => o.pnlPerInflowPct).filter(isNum));
  const avgFeePct = avg(ranked.map((o) => o.feePercent).filter(isNum));
  const avgRoiPct = avg(ranked.map((o) => o.roiPct).filter(isNum));
  const preferredStrategies = countValues(historicalOwners.map((o) => o.preferredStrategy).filter(Boolean));
  const preferredRanges = countValues(historicalOwners.map((o) => o.preferredRangeStyle).filter(Boolean));

  return {
    top_lper_count: ranked.length,
    study_mode: "lpagent_top_lpers",
    pool_name:
      overview.name || `${overview.tokenXSymbol || "TOKEN"}-${overview.tokenYSymbol || "SOL"}`,
    active_position_count: signalData.activePositionCount ?? ranked.length,
    owner_count: signalData.ownerCount ?? ranked.length,
    avg_hold_hours: round(avgHold, 2),
    avg_open_pnl_pct: round(avgOpenPnlPct, 2),
    avg_fee_percent: round(avgFeePct, 2),
    avg_roi_pct: round(avgRoiPct, 2),
    best_open_pnl_pct: ranked[0] ? `${round(ranked[0].pnlPerInflowPct || 0, 2)}%` : null,
    scalper_count: ranked.filter((o) => (o.avgAgeHours || 0) < 1).length,
    holder_count: ranked.filter((o) => (o.avgAgeHours || 0) >= 4).length,
    preferred_strategies: preferredStrategies,
    preferred_range_styles: preferredRanges,
    top_historical_owners: (signalData.topHistoricalOwners || []).slice(0, 3),
    suggested_style: signalData.suggestedStyle || null,
  };
}

function countValues(values) {
  const map = new Map();
  for (const value of values) {
    map.set(value, (map.get(value) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function isNum(value) {
  return Number.isFinite(Number(value));
}

function fmtPct(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${round(n, 2)}%`;
}
