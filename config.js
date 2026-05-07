import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const GMGN_CONFIG_PATH = path.join(__dirname, "gmgn-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : {};
}

const u = readJsonIfExists(USER_CONFIG_PATH);
const gmgnUserConfig = readJsonIfExists(GMGN_CONFIG_PATH);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function gmgnValue(key, legacyKey, fallback) {
  return gmgnUserConfig[key] ?? u[legacyKey] ?? fallback;
}

function gmgnArray(key, legacyKey, fallback) {
  if (Array.isArray(gmgnUserConfig[key])) return gmgnUserConfig[key];
  if (Array.isArray(u[legacyKey])) return u[legacyKey];
  return fallback;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
    // ─── Drawdown circuit breaker ──────────
    // When recent performance deteriorates the breaker auto-pauses the
    // screening cycle (management cycles continue). See src/circuit-breaker.js.
    maxDailyLossSol:           u.maxDailyLossSol           ?? 0.5,   // trip if rolling 24h SOL PnL ≤ -value
    drawdownStreakThreshold:   u.drawdownStreakThreshold   ?? 7,     // trip if N losses among ...
    drawdownStreakWindow:      u.drawdownStreakWindow      ?? 10,    // ... last K closes
    drawdownCooldownMinutes:   u.drawdownCooldownMinutes   ?? 120,   // auto-resume after this many minutes
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    source:            u.screeningSource    ?? "meteora", // meteora | gmgn
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    maxVolatility:     u.maxVolatility     ?? 5.0,   // ceiling for pool.volatility — auto-evolved by lessons.js
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    dropOkxRugpull:     u.dropOkxRugpull     ?? true, // hard-drop pools with OKX is_rugpull flag
  },

  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    interval: gmgnValue("interval", "gmgnInterval", "5m"),
    orderBy: gmgnValue("orderBy", "gmgnOrderBy", "default"),
    direction: gmgnValue("direction", "gmgnDirection", "desc"),
    limit: gmgnValue("limit", "gmgnLimit", 100),
    enrichLimit: gmgnValue("enrichLimit", "gmgnEnrichLimit", 20),
    requestDelayMs: gmgnValue("requestDelayMs", "gmgnRequestDelayMs", 350),
    maxRetries: gmgnValue("maxRetries", "gmgnMaxRetries", 2),
    holdersLimit: gmgnValue("holdersLimit", "gmgnHoldersLimit", 100),
    klineResolution: gmgnValue("klineResolution", "gmgnKlineResolution", "5m"),
    klineLookbackMinutes: gmgnValue("klineLookbackMinutes", "gmgnKlineLookbackMinutes", 60),
    filters: gmgnArray("filters", "gmgnFilters", ["renounced", "frozen", "not_wash_trading"]),
    platforms: gmgnArray("platforms", "gmgnPlatforms", ["Pump.fun", "meteora_virtual_curve", "pool_meteora"]),
    minMcap: gmgnValue("minMcap", "gmgnMinMcap", u.minMcap ?? 150_000),
    maxMcap: gmgnValue("maxMcap", "gmgnMaxMcap", u.maxMcap ?? 10_000_000),
    minTvl: gmgnValue("minTvl", "gmgnMinTvl", u.minTvl ?? 10_000),
    minVolume: gmgnValue("minVolume", "gmgnMinVolume", 1000),
    minHolders: gmgnValue("minHolders", "gmgnMinHolders", u.minHolders ?? 500),
    minTokenAgeHours: gmgnValue("minTokenAgeHours", "gmgnMinTokenAgeHours", 2),
    maxTokenAgeHours: gmgnValue("maxTokenAgeHours", "gmgnMaxTokenAgeHours", 24 * 7),
    minSmartDegenCount: gmgnValue("minSmartDegenCount", "gmgnMinSmartDegenCount", 1),
    requireKol: gmgnValue("requireKol", "gmgnRequireKol", true),
    minKolCount: gmgnValue("minKolCount", "gmgnMinKolCount", 1),
    maxRugRatio: gmgnValue("maxRugRatio", "gmgnMaxRugRatio", 0.3),
    maxTop10HolderRate: gmgnValue("maxTop10HolderRate", "gmgnMaxTop10HolderRate", 0.5),
    maxBundlerRate: gmgnValue("maxBundlerRate", "gmgnMaxBundlerRate", 0.5),
    maxRatTraderRate: gmgnValue("maxRatTraderRate", "gmgnMaxRatTraderRate", 0.2),
    maxFreshWalletRate: gmgnValue("maxFreshWalletRate", "gmgnMaxFreshWalletRate", 0.2),
    maxDevTeamHoldRate: gmgnValue("maxDevTeamHoldRate", "gmgnMaxDevTeamHoldRate", 0.02),
    preferredKolMinHoldPct: gmgnValue("preferredKolMinHoldPct", "gmgnPreferredKolMinHoldPct", 1),
    dumpKolMinHoldPct: gmgnValue("dumpKolMinHoldPct", "gmgnDumpKolMinHoldPct", 0.5),
    maxBotDegenRate: gmgnValue("maxBotDegenRate", "gmgnMaxBotDegenRate", 0.4),
    maxSniperCount: gmgnValue("maxSniperCount", "gmgnMaxSniperCount", 20),
    maxSniperHoldRate: gmgnValue("maxSniperHoldRate", "gmgnMaxSniperHoldRate", 0.3),
    minTotalFeeSol: gmgnValue("minTotalFeeSol", "gmgnMinTotalFeeSol", 30),
    athFilterPct: gmgnValue("athFilterPct", "gmgnAthFilterPct", null),
    preferredKolNames: gmgnArray("preferredKolNames", "gmgnPreferredKolNames", []),
    dumpKolNames: gmgnArray("dumpKolNames", "gmgnDumpKolNames", []),
    rejectSingleVolumeSpike: gmgnValue("rejectSingleVolumeSpike", "gmgnRejectSingleVolumeSpike", true),
    maxSingleCandleVolumeShare: gmgnValue("maxSingleCandleVolumeShare", "gmgnMaxSingleCandleVolumeShare", 0.7),
    indicatorFilter: gmgnValue("indicatorFilter", "gmgnIndicatorFilter", true),
    indicatorInterval: gmgnValue("indicatorInterval", "gmgnIndicatorInterval", "15_MINUTE"),
    indicatorRules: (() => {
      const r = gmgnUserConfig.indicatorRules || {};
      return {
        requireBullishSupertrend: r.requireBullishSupertrend ?? true,
        rejectAlreadyAtBottom:    r.rejectAlreadyAtBottom    ?? true,
        requireAboveSupertrend:   r.requireAboveSupertrend   ?? false,
        minRsi:                   r.minRsi                   ?? null,
        maxRsi:                   r.maxRsi                   ?? null,
        requireBbPosition:        r.requireBbPosition        ?? null,
      };
    })(),
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    // Minimum age (minutes) before the "pumped far above range" fast-exit
    // (rule 3) is allowed to fire. Default 5 — gives positions a chance to
    // accumulate fees before being aborted on a fast pump. Set to 0 to
    // restore the legacy always-on behaviour. The slower OOR-timeout
    // exit (rule 4) is unaffected and still gates on outOfRangeWaitMinutes.
    minAgeBeforeOORExit:   u.minAgeBeforeOORExit   ?? 5,
    // Minimum unclaimed-fees USD that lets rule 3 fire even for young
    // positions. If the position has already earned this much in fees
    // the fast-exit is justified (lock the gains). 0 disables this
    // override entirely (= age guard alone). Set to e.g. 0.05 if you
    // want pumped-and-already-earned positions to fast-exit.
    minOORFastExitFeesUsd: u.minOORFastExitFeesUsd ?? 0,
    realtimeMonitoring:        u.realtimeMonitoring        ?? false,
    realtimeOorThrottleSec:    u.realtimeOorThrottleSec    ?? 60,
    realtimeRefetchDebounceMs: u.realtimeRefetchDebounceMs  ?? 3000,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    // ── Adaptive trailing (volatility-scaled) ─────────────────────
    // Scale trailingTriggerPct / trailingDropPct with each pool's
    // volatility so high-vol pools get a wider trailing band (less likely
    // to false-exit on noise) and low-vol pools get a tighter one (locks
    // gains faster). The base values above are the centre point at
    // volatility = trailingVolPivot (default 2.5). Multiplier 0 disables
    // scaling and restores legacy fixed-band behaviour.
    trailingVolMultiplier: u.trailingVolMultiplier ?? 0.5, // 0 = off (legacy); 0.5 = mild, 1.0 = aggressive
    trailingVolPivot:      u.trailingVolPivot      ?? 2.5, // volatility centre point (no scaling here)
    trailingVolMaxScale:   u.trailingVolMaxScale   ?? 5.0, // volatility upper anchor (full +scale at this point)
    trailingMinTriggerPct: u.trailingMinTriggerPct ?? 1.5, // floor for scaled trigger
    trailingMaxTriggerPct: u.trailingMaxTriggerPct ?? 6.0, // ceiling for scaled trigger
    trailingMinDropPct:    u.trailingMinDropPct    ?? 0.75,// floor for scaled drop
    trailingMaxDropPct:    u.trailingMaxDropPct    ?? 3.0, // ceiling for scaled drop
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
    // Slippage tolerance for close-position auto-swap (LPAgent zap-out & local Jupiter fallback).
    // Expressed in basis points (10000 = 100%). Default 1000 (10%) — was 5000 (50%) which is excessive.
    closeSlippageBps:      u.closeSlippageBps      ?? 1000,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: u.minBinsBelow ?? 35,
    maxBinsBelow: u.maxBinsBelow ?? 69,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Coaching (Tier 2 self-learning) ──
  // Operator-curated memo lifecycle. /memo propose builds a digest from
  // recent perf, calls the LLM, stages a proposal, and waits for explicit
  // /memo approve. Active memos are injected into SCREENER + GENERAL
  // prompts. All defaults conservative — operator must opt-in by calling
  // /memo propose; nothing auto-runs.
  coaching: {
    digestWindowDays:      u.coachingWindowDays      ?? 7,
    minClosesForProposal:  u.coachingMinCloses       ?? 10,
    activeMemoLimit:       u.coachingActiveLimit     ?? 10,
    proposalMaxTokens:     u.coachingMaxTokens       ?? 1500,
  },

  // ─── Smart-LPer Auto-Discovery (Tier 3 self-learning) ───────
  // Top-LPer addresses harvested from Meridian /top-lp endpoint via
  // study_top_lpers tool. When the same wallet shows up in enough pools
  // with strong stats, it auto-promotes into smart-wallets.json so
  // check_smart_wallets_on_pool can use it during screening. Operator
  // can override via /lpers promote / /lpers reject from Telegram.
  smartLpers: {
    autoPromoteEnabled:      u.smartLpersAutoPromote       ?? true,
    autoPromoteMinPools:     u.smartLpersMinPools          ?? 3,    // distinct pools the LPer must appear in
    autoPromoteMinWinRate:   u.smartLpersMinWinRate        ?? 0.6,  // 60%
    autoPromoteMinPositions: u.smartLpersMinPositions      ?? 10,   // total positions tracked by Meridian
    recencyDecayDays:        u.smartLpersRecencyDecayDays  ?? 30,   // halflife for leaderboard scoring
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
    // Exploration budget — fraction of screening cycles that bypass the
    // current Darwin weights and use relaxed thresholds, so the bot keeps
    // probing pools just outside its learned comfort zone. Set to 0 to
    // disable. See runScreeningCycle in index.js.
    explorationRate:        u.darwinExplorationRate        ?? 0.10,
    explorationMultipliers: u.darwinExplorationMultipliers ?? {
      maxVolatility: 1.5,    // multiply current ceiling
      minOrganicDelta: -10,  // subtract from current floor
    },
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── Priority Fee / Compute Budget ──────
  // Prepended to every on-chain Solana tx (deploy, claim, close).
  // Keep enabled in production — without these, txs drop during congestion.
  priorityFee: {
    enabled:           u.priorityFeeEnabled           ?? true,
    computeUnitLimit:  u.priorityFeeComputeUnitLimit  ?? 600_000,
    minMicroLamports:  u.priorityFeeMinMicroLamports  ?? 1_000,
    maxMicroLamports:  u.priorityFeeMaxMicroLamports  ?? 1_000_000,
    percentile:        u.priorityFeePercentile        ?? 75,
    cacheTtlMs:        u.priorityFeeCacheTtlMs        ?? 15_000,
  },

  // ─── Twitter/X Sentiment ──────────────
  // mode: "local" (Playwright + your Twitter cookies, FREE) or "api" (GetXAPI, $0.001/call)
  // Local mode needs authToken + ct0 from your browser cookies.
  // API mode needs GETXAPI_KEY. Auto-fallback if primary fails.
  twitter: {
    enabled:           u.twitterEnabled !== false && process.env.TWITTER_ENABLED !== "false",
    mode:              nonEmptyString(u.twitterMode, process.env.TWITTER_MODE) || "local",
    authToken:         nonEmptyString(u.twitterAuthToken, process.env.TWITTER_AUTH_TOKEN),
    ct0:               nonEmptyString(u.twitterCt0, process.env.TWITTER_CT0),
    apiKey:            nonEmptyString(u.twitterApiKey, process.env.GETXAPI_KEY),
    timeoutMs:         u.twitterTimeoutMs ?? 15_000,
  },

  // ─── HiveMind ─────────────────────────
  // Opt-in. Set hiveMindEnabled=true (or HIVEMIND_ENABLED=true env) to participate.
  // README documents this as an explicit opt-in feature; do not enable by default.
  hiveMind: {
    enabled: u.hiveMindEnabled ?? (process.env.HIVEMIND_ENABLED === "true"),
    url: nonEmptyString(u.hiveMindUrl, process.env.HIVEMIND_URL, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  jupiter: {
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "7kf8boZvTSaBv3wmDdY59VFK9U2LfMsUDB2op8CmwBFy",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  // ─── Telegram Notifications ─────────────
  // All flags default to false (= notification IS sent). Set to true to mute
  // a specific category. `muteAll` overrides every per-category flag — when
  // true, NO notifications are sent. Logs (logger.js) always fire regardless.
  telegram: (() => {
    const t = u.telegram ?? {};
    return {
      muteAll:     t.muteAll     ?? u.telegramMuteAll     ?? false,
      muteDeploy:  t.muteDeploy  ?? u.telegramMuteDeploy  ?? false,
      muteClose:   t.muteClose   ?? u.telegramMuteClose   ?? false,
      muteSwap:    t.muteSwap    ?? u.telegramMuteSwap    ?? false,
      muteOor:     t.muteOor     ?? u.telegramMuteOor     ?? false,
      muteCycle:   t.muteCycle   ?? u.telegramMuteCycle   ?? false,
      muteClaim:   t.muteClaim   ?? u.telegramMuteClaim   ?? false,
    };
  })(),

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    const fresh = readJsonIfExists(USER_CONFIG_PATH);
    const s = config.screening;
    if (fresh.screeningSource != null) s.source = fresh.screeningSource;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.maxVolatility        != null) s.maxVolatility        = fresh.maxVolatility;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.dropOkxRugpull    !== undefined) s.dropOkxRugpull   = fresh.dropOkxRugpull;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
  } catch { /* ignore */ }
  try {
    const freshGmgn = readJsonIfExists(GMGN_CONFIG_PATH);
    const g = config.gmgn;
    for (const [key, value] of Object.entries(freshGmgn)) {
      if (key in g && key !== "apiKey") g[key] = value;
    }
    if (freshGmgn.apiKey) g.apiKey = freshGmgn.apiKey;
  } catch { /* ignore */ }
}
