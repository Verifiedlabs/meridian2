/**
 * Pre-Deploy Yield Backtest (concentration mode).
 *
 * Why this exists:
 *   `screening.minFeePer24h` gates on a pool-level 24h yield AVERAGE. A pool
 *   can post 18% on the 24h window because of a burst that already ended,
 *   while the last 6h has been quiet. We enter, claim-fee rate is tiny.
 *
 *   This module simulates the proposed deploy (single-sided SOL, range =
 *   [active_bin - binsBelow, active_bin]) against the pool's last N hours
 *   of price OHLCV. It answers two questions:
 *     1. How often did the price stay inside the bin range we WOULD have
 *        deployed into?  → `in_range_pct`
 *     2. Of all the volume in the window, how much would have flowed
 *        through bins inside that range?                  → `vol_share_pct`
 *
 *   These are then combined with the pool-level fee-per-tvl over the same
 *   window to project an effective 24h yield rate for the position.
 *
 * Math note:
 *   `current_price` and OHLCV `close` are in the same units (verified by
 *   probing several Meteora pools). The lower price boundary is just
 *
 *     lower = current_price * (1 + bin_step / 10000) ^ (-binsBelow)
 *
 *   so we don't need bin_id arithmetic — we just compare candle close
 *   against the lower bound. Upper bound is current price (single-sided
 *   SOL constraint enforced by tools/dlmm.js#deployPosition).
 *
 * Cost: 1 HTTP call per candidate. Caller should run candidates in
 * parallel via Promise.all to keep cron tick times unchanged.
 */

import { config } from "../config.js";
import { log } from "../logger.js";

const METEORA_DLMM_BASE = "https://dlmm.datapi.meteora.ag";
const DEFAULT_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, ms = DEFAULT_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch OHLCV candles for a pool over a time window.
 * Returns array of { timestamp, open, high, low, close, volume } or null on error.
 */
export async function fetchPoolOhlcv(poolAddress, { timeframe = "5m", windowHours = 6 } = {}) {
  if (!poolAddress) return null;
  const now = Math.floor(Date.now() / 1000);
  const from = now - Math.max(1, windowHours) * 3600;
  const url = `${METEORA_DLMM_BASE}/pools/${poolAddress}/ohlcv?timeframe=${encodeURIComponent(timeframe)}&start_time=${from}&end_time=${now}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      log("backtest_warn", `ohlcv ${poolAddress.slice(0, 8)} ${res.status}`);
      return null;
    }
    const d = await res.json();
    return Array.isArray(d?.data) ? d.data : [];
  } catch (e) {
    log("backtest_warn", `ohlcv ${poolAddress.slice(0, 8)} fetch failed: ${e.message}`);
    return null;
  }
}

/**
 * Fetch the live pool detail (current_price, bin_step, fee_tvl_ratio per
 * timeframe). Used as the second input to the backtest.
 */
export async function fetchPoolDetailLite(poolAddress) {
  if (!poolAddress) return null;
  const url = `${METEORA_DLMM_BASE}/pools/${poolAddress}`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      log("backtest_warn", `pool detail ${poolAddress.slice(0, 8)} ${res.status}`);
      return null;
    }
    const d = await res.json();
    return {
      current_price: Number(d?.current_price) || null,
      bin_step:      Number(d?.pool_config?.bin_step) || null,
      tvl:           Number(d?.tvl) || null,
      fees:          d?.fees || null,            // { '30m':..., '1h':..., '4h':..., '12h':..., '24h':... }
      volume:        d?.volume || null,
      fee_tvl_ratio: d?.fee_tvl_ratio || null,
    };
  } catch (e) {
    log("backtest_warn", `pool detail ${poolAddress.slice(0, 8)} fetch failed: ${e.message}`);
    return null;
  }
}

/** Pool detail fees timeframes match `4h` window for our 6h backtest closely
 *  enough to use as the basis. We pick the closest-matching window from the
 *  available set, with a small extrapolation factor.
 */
function pickBaselineWindow(fees, feeRatio, windowHours) {
  // Available keys: 30m, 1h, 2h, 4h, 12h, 24h
  const map = {
    "30m":  0.5,
    "1h":   1,
    "2h":   2,
    "4h":   4,
    "12h":  12,
    "24h":  24,
  };
  let best = null;
  for (const [k, h] of Object.entries(map)) {
    const ratio = Number(feeRatio?.[k]);
    const fee   = Number(fees?.[k]);
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const score = Math.abs(Math.log(h / windowHours)); // closest in log-space
    if (!best || score < best.score) best = { key: k, hours: h, ratio, fee, score };
  }
  return best;
}

/**
 * Run the concentration-mode backtest.
 *
 * Inputs:
 *   - poolAddress
 *   - binsBelow (already computed by the caller via computeBinsBelow)
 *   - cfg (resolved sub-config, see config.screening.backtest)
 *
 * Returns:
 *   { ok, in_range_pct, vol_share_pct, projected_24h_yield, baseline_yield,
 *     baseline_window, candle_count, window_hours, lower_bound_pct, reason }
 *
 * Never throws. On any error returns { ok: false, reason }.
 */
export async function runYieldBacktest({
  poolAddress,
  binsBelow,
  cfg,
} = {}) {
  if (!poolAddress) return { ok: false, reason: "no_pool" };
  if (!Number.isFinite(binsBelow) || binsBelow <= 0) return { ok: false, reason: "no_bins_below" };

  const windowHours = Number.isFinite(cfg?.windowHours) ? cfg.windowHours : 6;
  const timeframe   = cfg?.timeframe || "5m";

  // Fetch OHLCV + pool detail in parallel.
  const [candles, detail] = await Promise.all([
    fetchPoolOhlcv(poolAddress, { timeframe, windowHours }),
    fetchPoolDetailLite(poolAddress),
  ]);

  if (!candles || candles.length === 0) return { ok: false, reason: "no_ohlcv" };
  if (!detail?.current_price || !detail?.bin_step) return { ok: false, reason: "no_pool_detail" };

  const m       = 1 + detail.bin_step / 10000;
  const lower   = detail.current_price * Math.pow(m, -binsBelow);
  const upper   = detail.current_price * 1.0005; // tiny upper tolerance for current bin
  const lowerBoundPct = (Math.pow(m, -binsBelow) - 1) * 100; // negative %, e.g. -26.0 for 30 bins @ bin_step 100

  let inRangeBuckets = 0, totalVol = 0, inRangeVol = 0;
  for (const c of candles) {
    const close = Number(c?.close);
    const vol   = Number(c?.volume) || 0;
    totalVol += vol;
    if (Number.isFinite(close) && close >= lower && close <= upper) {
      inRangeBuckets++;
      inRangeVol += vol;
    }
  }

  const inRangePct  = candles.length > 0 ? inRangeBuckets / candles.length : 0;
  const volSharePct = totalVol > 0 ? inRangeVol / totalVol : 0;

  // Projected 24h yield rate FOR THIS POSITION.
  //   poolBaseline = pool-level fee/TVL % over its closest available window
  //   posShare     = volSharePct (fraction of activity our range catches)
  //   normalize    = scale baseline window → 24h
  //
  // Note: this assumes our liquidity is roughly proportional in active TVL.
  // Real position liquidity share matters too, but at deploy size of ~0.5 SOL
  // vs pool TVL of $10k+, our share is small enough that the dominant factor
  // is whether the price even visits our range.
  let projected24hYield = 0;
  let baseline = null;
  if (detail.fee_tvl_ratio && detail.fees) {
    baseline = pickBaselineWindow(detail.fees, detail.fee_tvl_ratio, windowHours);
    if (baseline?.ratio > 0) {
      // Scale baseline ratio (which is for `baseline.hours`) up to 24h
      const baseline24h = baseline.ratio * (24 / baseline.hours);
      projected24hYield = baseline24h * volSharePct;
    }
  }

  return {
    ok: true,
    window_hours:        windowHours,
    timeframe,
    candle_count:        candles.length,
    in_range_pct:        Number(inRangePct.toFixed(4)),
    vol_share_pct:       Number(volSharePct.toFixed(4)),
    lower_bound_pct:     Number(lowerBoundPct.toFixed(2)),
    baseline_yield:      baseline ? Number((baseline.ratio).toFixed(2)) : null,
    baseline_window:     baseline ? baseline.key : null,
    projected_24h_yield: Number(projected24hYield.toFixed(2)),
    computed_at:         new Date().toISOString(),
  };
}

/**
 * Decide if a backtest result fails the gate. Returns null if it passes,
 * otherwise a string reason. Caller handles logging / filtering.
 *
 * Gate rules:
 *   - If `gateEnabled` is false, never reject (computation only).
 *   - If backtest itself errored (`ok: false`), do NOT reject — fail open
 *     to avoid starving the bot on transient API errors.
 */
export function evaluateBacktestGate(backtest, cfg) {
  if (!cfg || cfg.gateEnabled !== true) return null;
  if (!backtest || backtest.ok !== true) return null; // fail open

  const minProj = Number.isFinite(cfg.minProjectedYield) ? cfg.minProjectedYield : 0;
  const minRange = Number.isFinite(cfg.minInRangeFraction) ? cfg.minInRangeFraction : 0;

  if (minRange > 0 && backtest.in_range_pct < minRange) {
    return `backtest in-range ${(backtest.in_range_pct * 100).toFixed(0)}% < min ${(minRange * 100).toFixed(0)}%`;
  }
  if (minProj > 0 && backtest.projected_24h_yield < minProj) {
    return `backtest proj 24h yield ${backtest.projected_24h_yield}% < min ${minProj}%`;
  }
  return null;
}

/** Stable label used by Telegram + LLM prompt. */
export function labelBacktestRegime(backtest) {
  if (!backtest || backtest.ok !== true) return "n/a";
  const proj = backtest.projected_24h_yield;
  const rng  = backtest.in_range_pct;
  if (proj >= 15 && rng >= 0.7) return "strong";
  if (proj >= 8  && rng >= 0.5) return "ok";
  if (proj >= 4)                 return "weak";
  return "poor";
}
