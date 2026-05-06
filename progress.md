# Meridian2 — Session Handoff

> **Purpose**: enable another session (AI model or human) to pick up exactly where this conversation left off without losing context.

**Last updated**: 2026-05-06 16:25 UTC+07
**Repo root**: `/Users/firda/meridian2`
**Branch**: `main` — synced with `origin/main` ✅ (all current commits pushed)
**Test baseline**: **170/170 passing**

---

## TL;DR of Current State (May 6, end of session)

Today's session was **diagnosis-heavy + 1 surgical perf fix** + planning for tomorrow.

1. ✅ Pushed yesterday's Tier 1 + Tier 2 self-learning commits (`7d87a08`, `118f7cf`).
2. ✅ Verified security hardening (self_update RCE, update_config clamp) — no real bug.
3. ✅ Performance audit on 73 closes — identified real issues:
   - Trailing TP mechanism actually WORKS (corrected an earlier mislabel).
   - Real bleeder = 8 stop-loss tail events (sum -25% pnl_pct).
   - GME-SOL -9.72% blowout root cause: **slow close path**, NOT validator slippage.
4. ✅ **Committed perf fix** `91e0550` — drop blanket 5s sleeps + skip redundant claim tx in `tools/dlmm.js`.
5. ✅ Helius API key verified alive — historical 401s were stale.
6. ✅ Identified Tier 3 self-learning gap: **top-LPer auto-discovery** — infrastructure 80% built, just not wired.

**Bot status**: pm2 process `meridian2` still running pre-fix code. Restart needed to apply `91e0550` (close path optimization).

---

## Completed Work This Session

### Commit `4957900` — `fix(telegram): emit notifyClose from realtime fast-close path`

**Bug**: Profit closes triggered when price pumps far above LP range fire through `handleRealtimeOor` (WS watcher), which calls `closePosition` directly, bypassing `tools/executor.js`. `notifyClose` only fires from the executor, so profit closes were silent while loss closes (caught by management cron via LLM `close_position` tool) appeared normally.

**Fix**: Import `notifyClose` in `index.js` and call it after a successful `closePosition` in `handleRealtimeOor`. See `@/Users/firda/meridian2/index.js:880-892`.

### Commit `f32ba0e` — `fix: harden close path + fatal telegram alerts`

Three independent hardening changes:

1. **Per-position close mutex** (`tools/dlmm.js`)
   - `_closeInFlight` Set declared at module scope (near `getDlmmProgramId`): `@/Users/firda/meridian2/tools/dlmm.js:397-402`.
   - Entry check + add inside `closePosition` right after DRY_RUN guard: `@/Users/firda/meridian2/tools/dlmm.js:1549-1561`.
   - Release in `finally`: `@/Users/firda/meridian2/tools/dlmm.js:2076-2078`.
   - Duplicates return `{ success: false, skipped: true, error: "close already in progress..." }`.

2. **On-chain close verification** (`tools/dlmm.js`)
   - New helper `isPositionClosedOnChain(positionAddress)` at `@/Users/firda/meridian2/tools/dlmm.js:416-425` uses `getAccountInfo` + DLMM program ownership.
   - Replaces Meteora `/positions` API polling in both branches (relay + direct). 6 × 1.5s = 9s worst case; usually resolves first attempt.
   - Relay branch verification: `@/Users/firda/meridian2/tools/dlmm.js:1643-1657`.
   - Direct branch verification: `@/Users/firda/meridian2/tools/dlmm.js:1887-1902`.

3. **Fatal Telegram alerts** (`index.js`)
   - New `emitFatalAlert(kind, err)` helper at `@/Users/firda/meridian2/index.js:932-957`.
   - Both `unhandledRejection` and `uncaughtException` route through it.
   - 2s timeout so broken Telegram endpoint cannot block pm2 restart.
   - Re-entry guard (`_fatalExitInProgress`) prevents double-send if second fatal fires during exit.

4. **Realtime handler dedupe log** (`index.js`)
   - `handleRealtimeOor` recognizes new `skipped: true` return shape — logs as `[realtime]` (not `realtime_warn`). See `@/Users/firda/meridian2/index.js:890-893`.

### Not Committed but Fix Landed Earlier This Conversation Chain
Nothing — both hardening changes are committed. Test baseline: **105/105 passing**, duration ~900ms.

---

## User Preferences / Communication Style

- **Language**: Indonesian-English casual mix. `gw` = "I", `lo` = "you", `bro` friendly. Match this register.
- **Direct answers**: user prefers terse, concrete replies. No "you're absolutely right!" preamble.
- **Show evidence**: user likes citations — line numbers, log excerpts, commit hashes.
- **Prefers concrete scenarios** over abstract descriptions when evaluating designs (see the "how would E/A/B look" explanation).

---

## Session 2 — E + A + B Implemented (commit pending in this session)

User said "lanjutin bro" → defaulted to recommended option 1 (all three).

### Files added
- `@/Users/firda/meridian2/src/circuit-breaker.js` — drawdown breaker module.
- `@/Users/firda/meridian2/test/circuitBreaker.test.js` — 12 tests.
- `@/Users/firda/meridian2/test/holdoutValidation.test.js` — 9 tests.

### Files modified
- `@/Users/firda/meridian2/config.js` — added `risk.maxDailyLossSol`, `risk.drawdownStreakThreshold`, `risk.drawdownStreakWindow`, `risk.drawdownCooldownMinutes`, `darwin.explorationRate`, `darwin.explorationMultipliers`.
- `@/Users/firda/meridian2/index.js` — breaker import + gate in `runScreeningCycle`, exploration mode decision + threshold overrides + position tagging in finally, `/resume` extended to clear breaker, `/risk` shows breaker state.
- `@/Users/firda/meridian2/lessons.js` — `recordPerformance` feeds breaker + persists exploration flag, `getPerformanceSummary` adds `by_exploration` bucket, evolve hook logs Darwin validation rejections.
- `@/Users/firda/meridian2/signal-weights.js` — `splitTrainHoldout` + `assessTrainHoldoutConsistency` exported, `recalculateWeights` gates persistence on validation result.
- `@/Users/firda/meridian2/state.js` — `setPositionExploration` helper.
- `@/Users/firda/meridian2/tools/screening.js` — `discoverPools` + `getTopCandidates` accept `screeningOverrides` parameter.
- `@/Users/firda/meridian2/test/getPerformanceSummary.test.js` — 3 new tests for `by_exploration`.

### E — Drawdown Circuit Breaker (DELIVERED)

New module `src/circuit-breaker.js` exports `recordClose`, `isScreeningPaused`, `getStatus`, `resume`, `_resetForTesting`. Persists state to `circuit-breaker.json` so pm2 restarts don't silently re-enable screening during a drawdown.

Trip conditions:
- Losing streak — at least `risk.drawdownStreakThreshold` (default 7) losses among last `risk.drawdownStreakWindow` (default 10) closes.
- Daily loss cap — rolling 24h SOL PnL ≤ `-risk.maxDailyLossSol` (default 0.5 SOL).

Integration:
- `lessons.js recordPerformance` feeds the breaker after each close (approximating SOL PnL via `pnl_pct × amount_sol / 100`); fires Telegram alert on `justTripped`.
- `index.js runScreeningCycle` checks `isScreeningPausedByBreaker()` after the existing pre-checks; auto-resumes when cooldown elapses.
- `/resume` command clears the breaker manually in addition to its existing cron behavior.
- `/risk` Telegram message includes a circuit-breaker section showing trip state, recent loss count, and 24h PnL vs cap.

Tests cover trip on streak, trip on daily loss, cumulative daily loss, auto-resume after cooldown, manual resume, recentCloses windowing, daily window rollover, justTripped semantics, willResumeAt computation.

### A — Exploration Budget (DELIVERED)

Config keys `darwin.explorationRate` (default 0.10) and `darwin.explorationMultipliers` (default `{ maxVolatility: 1.5, minOrganicDelta: -10 }`).

`runScreeningCycle` flow:
1. After pre-checks, decides `explorationMode = Math.random() < explorationRate`.
2. If exploration: builds `screeningOverrides = { maxVolatility: cur × 1.5, minOrganic: max(0, cur - 10) }` and logs `🔍 EXPLORATION MODE`.
3. Passes overrides to `getTopCandidates({ limit, screeningOverrides })` → `discoverPools` merges them onto `config.screening`.
4. Injects exploration banner into agent goal text so the LLM treats Darwin weights as advisory.
5. In the `finally` block, diffs post-cycle vs pre-cycle position addresses and tags new positions via `setPositionExploration(addr, mode)`.

`recordPerformance` reads `tracked.exploration` and persists it on the perf entry. `getPerformanceSummary` returns a `by_exploration` block (`{ normal: {...}, exploration: {...} }`) when exploration records exist.

GMGN screening source ignores overrides for now — its filtering uses different metrics. Exploration only affects the Meteora discovery path.

### B — Hold-Out Validation (DELIVERED)

Added two exported helpers in `signal-weights.js`:
- `splitTrainHoldout(records, holdoutRatio)` — deterministic stride split (every 5th record at offset 4 → holdout at 20%).
- `assessTrainHoldoutConsistency(train, holdout, minSamples)` — for each signal, computes lift on both halves; returns `commit: boolean` based on whether ≥50% of validated signals match in lift sign across train and holdout.

`recalculateWeights` flow change:
1. Filter perfData to rolling `windowDays` window (unchanged).
2. **NEW**: Split into train (80%) / holdout (20%); run consistency check.
3. If consistency rejects → return early with `{ changes: [], weights, validation }`. Logged as `Darwin: skipped recalc — <reason>`.
4. Otherwise compute lifts on **train only** (true hold-out) and proceed.
5. Falls back to full recent dataset when train is too small.

`lessons.js` evolve hook now logs validation rejections so user has visibility when Darwin chose not to update due to noise.

Validation skips itself (commit=true) when there are <3 signals to validate or when holdout lacks bucket coverage — preserves legacy behavior in low-data regimes.

---

## How to Verify After pm2 Restart

```bash
pm2 restart meridian2
# Then watch for:
#   [cron] 🔍 EXPLORATION MODE — relaxed thresholds: ...   (every ~10 cycles)
#   [evolve] Darwin: skipped recalc — holdout disagreement ...   (when noise rejected)
#   [circuit_breaker] 🛑 TRIPPED: ...   (during drawdown)
```

Smoke-test command from Telegram:
- `/risk` → should display the new "Drawdown circuit breaker" section.
- `/resume` → should clear breaker if tripped (no-op if not).

## Known Follow-Ups (Priority Ranked for Tomorrow)

### 🔥 TIER A — Highest impact, do first

**A1. Top-LPer auto-discovery** (Tier 3 self-learning, ~2-3 hours)

The single highest-ROI improvement. Infrastructure 80% built, just not wired into the screening loop.

- **Existing**: `tools/study.js` already wraps Meridian API endpoints `/top-lp/<pool>` and `/study-top-lp/<pool>` (uses shared public API key — no extra auth needed). Returns full LPer data: address, win_rate, ROI, preferred strategy, position history. Tools `study_top_lpers` + `get_top_lpers` are registered in `tools/executor.js:249-250` and exposed in prompt.
- **Gap**: prompt at `@/Users/firda/meridian2/prompt.js:210-226` explicitly **forbids** auto-call ("Do NOT call get_top_candidates or study_top_lpers while you have healthy open positions"). 0 calls in 8 days of action logs. Result: feature is dead unless operator manually triggers via Telegram.
- **No-proxy decision**: rate limit IS the cache hit policy (server caches 30m, per-pool 60s cooldown). Bypassing via proxy is pointless because the response is identical for 30m. Build client-side cache instead.

Build steps:
1. `src/top-lpers.js` — write-through persistence to `top-lpers.json`. Schema: `{address: {names, pools_seen, aggregate_stats: {win_rate, roi, total_positions}, last_seen}}`. Match `circuit-breaker.js` pattern.
2. Client-side TTL cache (~25min, just under server's 30min) inside `tools/study.js`.
3. SCREENER prompt: loosen "do not call" line; add "FOR EACH top-3 candidate → call study_top_lpers + persist".
4. Auto-promotion: after wallet appears in ≥3 pools with WR ≥60% and ≥10 total positions, call existing `addSmartWallet({type:"lp"})` automatically.
5. Telegram: `/lpers leaderboard`, `/lpers promote <addr>`, `/lpers reject <addr>` (Tier 2-style approval).
6. Tests: persistence, scoring, auto-promotion threshold, dedup across pool visits.

Why this matters most: bot is LP-focused. Tracking top LPers (not KOL traders) is the right wallet-level signal for an LP bot. Currently `smart-wallets.json` is empty — bot never gets the `check_smart_wallets_on_pool` boost. Auto-discovery fixes that without manual operator curation.

### 🟡 TIER B — Worth doing, smaller scope

**B1. Self-evolve TP/SL thresholds** (~1-2 hours)

Currently `lessons.js evolveThresholds` evolves screening params (`maxVolatility`, `minOrganic`, `minFeeActiveTvlRatio`) but NOT risk params (`takeProfitPct`, `stopLossPct`). This is a real gap — `getPostMortemSuggestions` at `@/Users/firda/meridian2/lessons.js:1148-1162` already recommends symmetric R/R adjustment, but the system never auto-applies it.

Data point: TP=4 fired only 3× in 73 closes. avg_win=1.18% (most winners don't reach TP). TP candidates evolve toward 2.5-3% would capture more wins. Same logic for SL — current -6% with 21s slow-close = effective -9% in volatile pools.

Build: extend `evolveThresholds` to compute distribution of winners' peak PnL and losers' max-drawdown, propose new TP/SL via same lesson-based mechanism. Start CONSERVATIVE — propose, don't auto-apply for risk params (operator approval like Tier 2 memos).

**B2. Pool concentration guard** (~30 min)

Pool memory shows GME-SOL had `avg_pnl_pct: -2.11%, win_rate: 0.67` after 3 deploys. Bot redeployed 4 min after a -10% loss because cooldown only fires for "repeat fee-generating deploys", not for SL events. Add SCREENER pre-check: skip pool if `pool_memory.sample ≥ 3 AND avg_pnl_pct < -1%` unless operator explicitly overrides.

### 🟢 TIER C — Log noise cleanup (low impact, easy wins)

Already analyzed in earlier session. Volume rankings:

- **C1. Silent "message not modified" Telegram errors** (54 logs / 8 days) — catch + swallow in `editMessage`/`editMessageWithButtons`. Cosmetic no-op.
- **C2. Downgrade "Position settling 1-3/6"** WARN → debug (~8 logs). Keep attempt 4-6 visible.
- **C3. Fix HTML escape bug "Unsupported start tag"** (5 logs). Hunt missing `escapeHtml` before `sendHTML` call.

### ⚫ TIER D — From earlier sessions, still relevant

1. **Per-strategy learning** (option D from earlier menu) — separate Darwin weights for spot vs bid_ask vs curve. Currently all strategies share one weight set. Defer until enough non-bid_ask samples exist (current data: 73/73 are bid_ask).
2. **Lessons retention** — `lessons.json` still grows unbounded (76KB → grew to 87KB). Need cap/merge policy.
3. **GMGN exploration support** — exploration overrides are ignored on the GMGN path; would need separate threshold tuning.
4. **Validation trend tracking** — log `validation.signMatches/signTotal` over time for regime shift detection.

## Critical Files Quick-Reference

| File | Role |
|---|---|
| `index.js` (3174 lines) | Main orchestrator: cron, cycles, Telegram, fatal handlers, REPL |
| `tools/dlmm.js` (2107 lines) | DLMM primitives: deploy, claim, close, swap — where the mutex + on-chain verify live |
| `tools/executor.js` | Tool dispatcher called by LLM; fires `notifyClose` on success |
| `state.js` | Position tracking, exit rule evaluation, sync with on-chain reality |
| `lessons.js` | `recordPerformance`, `evolveThresholds`, lesson derivation, hivemind push |
| `signal-weights.js` | Darwin weighting, `recalculateWeights`, `getWeightsSummary` |
| `signal-tracker.js` | `stageSignals` / `getAndClearStagedSignals` — pairs signals with outcomes |
| `src/adaptive-trailing.js` | Volatility-scaled trailing TP/SL |
| `pool-memory.js` | Per-pool deploy history + `recallForPool` |
| `src/deterministic.js` | `getDeterministicCloseRule` — evaluates stop-loss, trailing TP, OOR, low-yield |
| `src/realtime-watcher.js` | WS watcher that fires `onOor` → `handleRealtimeOor` |
| `prompt.js` | Builds LLM system prompt — injects lessons, weights, postmortem, performance |
| `hivemind.js` | Cross-agent shared learning push/pull |
| `config.js` | Config normalization; `management`, `screening`, `darwin`, `risk`, `llm` sections |
| `telegram.js` | Bot commands, `notifyClose`, `sendMessage`, `createLiveMessage`, mute gating |

---

## Conventions to Follow

- **Never delete tests**. Baseline: 105 tests in 9 files. Always add tests for new logic; never weaken existing.
- **Before commit**: `node --check <changed>.js && npm test` must pass.
- **Commit format**: Conventional commits — `fix:`, `feat:`, `chore:`. Multi-line body OK, explain root cause not just symptom.
- **Atomic writes**: JSON state goes through `writeJsonAtomicSync` (see `fs-utils.js`) — never raw `fs.writeFileSync`.
- **No new top-level state files** without strong reason. Existing: `state.json`, `lessons.json`, `signal-weights.json`, `pool-memory.json`, `decision-log.json`, `user-config.json`, `token-blacklist.json`, `dev-blocklist.json`, `hivemind-*.json`.
- **No comments churn**: don't add/delete unrelated comments during a change.
- **Minimal edits**: prefer small surgical fixes over refactors. User explicitly prefers not refactoring the 3174-line `index.js` until test coverage improves.
- **Indonesian-English communication** in chat (see preferences above). Code + comments stay English.

---

## Known Weaknesses Noted but NOT Fixed

These were flagged in the audit but not yet addressed:

1. **state.js `syncOpenPositions` auto-close path** (`@/Users/firda/meridian2/state.js:531-555`) doesn't notify Telegram when it reconciles a missing position. Edge case — rare. Low priority.
2. **`lessons.json` grows unbounded** — currently 66KB, no rotation. Needs cap (e.g. last 500 per category).
3. **Decision log** is capped at 100 entries (verified). OK.
4. **Close verification timing mismatch with pnl API**: even with on-chain confirm, the Meteora PnL API (fetched ~5s after close) can still return stale data. `recordPerformance` skips suspicious outliers (<-90% unless stop-loss reason) but fallback chain is complex.
5. **GMGN rate limiting** — user declined proxy rotation for now. Logs show ~154 GMGN hits per 2000 lines.
6. **`index.js` size** — 3174 lines; refactor deferred.

---

## How to Resume in Next Session

Paste the following starter into the new session after opening repo `/Users/firda/meridian2`:

> Read `progress.md` at the repo root. Session context is there. User wants to continue with the priority list at "Known Follow-Ups". Default plan is Tier A1 (top-LPer auto-discovery) unless user picks otherwise. Match the user's casual Indonesian-English style.

For a new AI model, first calls should be:

```
1. read_file /Users/firda/meridian2/progress.md
2. run_command "git log --oneline -n 5"   → confirm latest is 91e0550
3. run_command "npm test"                  → confirm 170 tests pass
4. Ask user: "Lanjut Tier A1 (top-LPer auto-discovery) atau pick yang lain?"
```

Default recommendation if user says "bebas/yaudah/gas": **A1 first** (highest ROI, infrastructure ready).

---

## Open Questions for Next Session

1. **Which tier to start with?** Default = A1 (top-LPer auto-discovery). Operator can override.
2. **pm2 restart not yet done** for `91e0550` close-path optimization. Restart `meridian2` to apply, then watch median close duration_ms in `logs/actions-*.jsonl` (expected drop ~13s → ~5-8s).
3. **For A1**: whether to auto-promote LPers to `smart_wallets.json` automatically after threshold OR require Telegram approval (Tier 2-style). Default proposed: auto-promote with threshold (≥3 pools, WR ≥60%, ≥10 positions) but provide `/lpers reject <addr>` to undo.

---

## Diagnosis Notes (May 6 — for context)

These were discovered today but NOT acted on (unless explicitly mentioned in commits above). Useful background for future sessions:

### Performance audit (n=73 closes / 7.8 days)

```
Win rate         : 63.0%  (46W / 26L / 1 flat)
Avg PnL/trade    : +0.236%
True $ net       : +$4.23 (final-init+fees) on $1333 cumulative
Gross fee yield  : 1.503% / 7.8d ≈ ~70% APY-equiv
Avg hold         : 58 min
Range efficiency : 88.7%
```

### True exit-mechanism breakdown (after re-classifying mislabeled "trailing TP" buckets):

```
OOR_PUMPED (rule 3):  n=30  +15.35% sum  +0.51% avg  $4.05 fees   ← workhorse
TRAILING_DROP (real): n= 9  +12.37% sum  +1.37% avg  $8.59 fees   ← BEST $/trade
LOW_YIELD:            n=13   +0.99% sum  +0.08% avg  $0.16 fees   ← deploy waste
STOP_LOSS:            n= 8  -25.55% sum  -3.19% avg  $4.75 fees   ← 💀 main drag
TAKE_PROFIT:          n= 3  +12.47% sum  +4.16% avg  $1.20 fees   ← rare hit
```

Stop-loss tail events (6 real, 2 mislabeled positive):
- STJUDE -4.93% (organic=26, low quality)
- BELIEF -6.05% (vol=5.34, high vol)
- Dragon -5.14% (vol=3.77, organic=82)
- UNIPUMP -3.39%, Spirit -4.29%
- **GME -9.72%** (worst single, 62% past SL threshold) — root cause = slow close path (fixed in `91e0550`)

### Slow-close root cause (for future ref)

Pre-fix `closePosition` flow: 5s blanket sleep + redundant Step 1 claim tx + Step 2 close+claim tx = ~13s median, p95 20.5s. The 5s sleep was deflagged as redundant (poll loop covered RPC lag); Step 1 was redundant when Step 2 used `shouldClaimAndClose`. Both fixed without behavior change — failure modes preserved.

### Key infrastructure already in place but underused

| Feature | Status | Why dormant |
|---|---|---|
| `study_top_lpers` tool | wired but 0 calls in 8 days | prompt forbids auto-call (`prompt.js:210`) |
| `add_smart_wallet` tracker | 0 entries in `smart-wallets.json` | never populated |
| `check_smart_wallets_on_pool` | works but always returns `tracked=0` | depends on smart-wallets.json |
| `get_postmortem_suggestions` | active | already advises symmetric R/R but auto-evolve doesn't act on it |
| `getPerformanceSummary by_exploration` | active | useful for Tier B1 (TP/SL evolve) data |
