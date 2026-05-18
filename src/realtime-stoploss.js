export function estimatePriceMovePctFromBins({ deployBin, activeBin, binStep }) {
  if (deployBin == null || activeBin == null || binStep == null) return null;

  const d = Number(deployBin);
  const a = Number(activeBin);
  const step = Number(binStep);
  if (!Number.isFinite(d) || !Number.isFinite(a) || !Number.isFinite(step) || step <= 0) return null;

  const stepRatio = 1 + (step / 10_000);
  const estimatedPct = (Math.pow(stepRatio, a - d) - 1) * 100;
  return Number.isFinite(estimatedPct) ? estimatedPct : null;
}

export function shouldTriggerStopLossFromBins({ deployBin, activeBin, binStep, stopLossPct }) {
  const sl = Number(stopLossPct);
  if (!Number.isFinite(sl) || sl >= 0) return { trigger: false, estimatedPct: null };

  const estimatedPct = estimatePriceMovePctFromBins({ deployBin, activeBin, binStep });
  if (!Number.isFinite(estimatedPct)) return { trigger: false, estimatedPct: null };

  return {
    trigger: estimatedPct <= sl,
    estimatedPct,
  };
}

export function shouldBypassStopLossConfirmationOnEmergencyOor({
  isOor,
  activeBin,
  lower,
  upper,
  emergencyBins,
}) {
  const bins = Number(emergencyBins);
  if (!isOor || !Number.isFinite(bins) || bins <= 0) return false;

  const active = Number(activeBin);
  const lo = Number(lower);
  const up = Number(upper);
  if (!Number.isFinite(active) || !Number.isFinite(lo) || !Number.isFinite(up)) return false;

  if (active < lo) return lo - active >= bins;
  if (active > up) return active - up >= bins;
  return false;
}

export function evaluateWsStopLossConfirmation({
  stopLossPct,
  currentPnlPct,
  confirmationsPassed,
  requiredConfirmations = 2,
}) {
  const sl = Number(stopLossPct);
  const pnl = Number(currentPnlPct);
  const required = Number(requiredConfirmations);
  const passed = Number(confirmationsPassed) || 0;

  if (!Number.isFinite(sl) || sl >= 0 || !Number.isFinite(required) || required < 1 || !Number.isFinite(pnl)) {
    return { confirmed: false, nextConfirmationsPassed: 0, reset: true };
  }

  if (pnl > sl) {
    return { confirmed: false, nextConfirmationsPassed: 0, reset: true };
  }

  const nextConfirmationsPassed = passed + 1;
  return {
    confirmed: nextConfirmationsPassed >= required,
    nextConfirmationsPassed,
    reset: false,
  };
}
