/**
 * Adaptive trailing-stop scaling.
 *
 * Scales `trailingTriggerPct` and `trailingDropPct` based on the position's
 * pool volatility. High-vol pools get a wider trailing band (less likely
 * to false-exit on noise); low-vol pools get a tighter band (locks gains
 * faster).
 *
 * Math:
 *   scale = 1 + multiplier × (vol - pivot) / (volMaxScale - pivot)
 *   trigger = clamp(baseTrigger × scale, minTrigger, maxTrigger)
 *   drop    = clamp(baseDrop × scale,    minDrop,    maxDrop)
 *
 * Edge cases:
 *   - multiplier <= 0 → no scaling (returns base values clamped only by
 *     hard min/max, in case the operator typed a base value outside the
 *     clamps).
 *   - vol == null → no scaling (we have no signal to scale from).
 *   - volMaxScale <= pivot → divide-by-zero guarded; falls back to base.
 *
 * Returned object also includes `scale` and `volatility` so callers can
 * surface the scaling decision in logs / Telegram for debuggability.
 */

function clamp(value, min, max) {
  if (Number.isFinite(min) && value < min) return min;
  if (Number.isFinite(max) && value > max) return max;
  return value;
}

/**
 * @param {Object} pos       — position record from state.json (must have `volatility`)
 * @param {Object} mgmtConfig — config.management
 * @returns {{ triggerPct: number, dropPct: number, scale: number, volatility: number|null, scaled: boolean }}
 */
export function getEffectiveTrailingParams(pos, mgmtConfig) {
  const baseTrigger = Number(mgmtConfig?.trailingTriggerPct);
  const baseDrop    = Number(mgmtConfig?.trailingDropPct);
  const multiplier  = Number(mgmtConfig?.trailingVolMultiplier ?? 0);
  const pivot       = Number(mgmtConfig?.trailingVolPivot ?? 2.5);
  const volMaxScale = Number(mgmtConfig?.trailingVolMaxScale ?? 5.0);

  // BUG-2 (Audit 5/21): when `trailingMinTriggerPct` is unset, the previous
  // -Infinity floor allowed safeScale=0.05 to drag baseTrigger × 0.05 down
  // to ~0.4% in low-vol pools — fast-firing TP at almost nothing. Use a
  // conservative floor of max(baseTrigger × 0.3, 1.5%) so the trailing
  // band can't collapse beyond meaningful drift.
  const cfgMinTrigger = Number(mgmtConfig?.trailingMinTriggerPct);
  const cfgMaxTrigger = Number(mgmtConfig?.trailingMaxTriggerPct);
  const cfgMinDrop    = Number(mgmtConfig?.trailingMinDropPct);
  const cfgMaxDrop    = Number(mgmtConfig?.trailingMaxDropPct);
  const fallbackMinTrigger = Number.isFinite(baseTrigger)
    ? Math.max(baseTrigger * 0.3, 1.5)
    : 1.5;
  const fallbackMinDrop = Number.isFinite(baseDrop)
    ? Math.max(baseDrop * 0.3, 0.5)
    : 0.5;
  const minTrigger = Number.isFinite(cfgMinTrigger) ? cfgMinTrigger : fallbackMinTrigger;
  const maxTrigger = Number.isFinite(cfgMaxTrigger) ? cfgMaxTrigger : Infinity;
  const minDrop    = Number.isFinite(cfgMinDrop)    ? cfgMinDrop    : fallbackMinDrop;
  const maxDrop    = Number.isFinite(cfgMaxDrop)    ? cfgMaxDrop    : Infinity;

  const volatility = pos?.volatility != null && Number.isFinite(Number(pos.volatility))
    ? Number(pos.volatility)
    : null;

  // Disabled / no signal → return base values (still respect hard clamps so
  // an obviously-broken base config can't bypass operator-defined bounds).
  const denom = volMaxScale - pivot;
  if (!Number.isFinite(baseTrigger) || !Number.isFinite(baseDrop)) {
    return {
      triggerPct: baseTrigger,
      dropPct: baseDrop,
      scale: 1,
      volatility,
      scaled: false,
    };
  }
  if (multiplier <= 0 || volatility == null || denom === 0) {
    return {
      triggerPct: clamp(baseTrigger, minTrigger, maxTrigger),
      dropPct:    clamp(baseDrop,    minDrop,    maxDrop),
      scale: 1,
      volatility,
      scaled: false,
    };
  }

  // scale at vol=pivot is exactly 1; at vol=volMaxScale, scale = 1 + multiplier
  const scale = 1 + multiplier * ((volatility - pivot) / denom);
  // Negative scale would invert the trailing band. Floor at a tiny positive
  // value so the math stays well-behaved; the explicit clamps below then
  // round to the user-defined floor.
  const safeScale = Math.max(scale, 0.05);

  return {
    triggerPct: clamp(baseTrigger * safeScale, minTrigger, maxTrigger),
    dropPct:    clamp(baseDrop    * safeScale, minDrop,    maxDrop),
    scale: safeScale,
    volatility,
    scaled: true,
  };
}
