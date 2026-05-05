# Meridian2 — Session Handoff

> **Purpose**: enable another session (AI model or human) to pick up exactly where this conversation left off without losing context.

**Last updated**: 2026-05-05 15:50 UTC+07
**Repo root**: `/Users/firda/meridian2`
**Branch**: `main` (ahead of `origin/main` by 6 commits — not pushed yet)

---

## TL;DR of Current State

1. Session 1: profit-close Telegram fix + 3 high-priority hardening fixes (close mutex, on-chain verification, fatal alerts).
2. Session 1: honest self-learning audit, presented E + A + B as next upgrade.
3. **Session 2 (this session): all of E + A + B implemented** — drawdown circuit breaker, exploration budget, hold-out validation.
4. **Test baseline grew 105 → 129** (24 new tests), all passing.

**Bot status**: runs via pm2 as `meridian2`. Config: `user-config.json` has `telegramMuteCycle: true` (suppresses cycle summaries), `muteClose: false`. Bot still running OLD code — restart needed to apply session-2 commits.

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

## Known Follow-Ups (Not Started)

1. **Per-strategy learning** (option D from earlier menu) — separate Darwin weights for spot vs bid_ask vs curve. Currently all strategies share one weight set.
2. **Lessons retention** — `lessons.json` still grows unbounded. Need cap/merge policy.
3. **GMGN exploration support** — overrides are ignored on the GMGN path; would need separate threshold tuning.
4. **Validation trend tracking** — log `validation.signMatches/signTotal` over time to detect when noise level changes (regime shift detection).

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

> Read `progress.md` at the repo root. Session context is there. The user was deciding between 4 options for the next upgrade (E/A/B combinations). Ask the user which they chose and proceed with implementation following the specs in the file. Match the user's casual Indonesian-English style.

For a new AI model, the first calls should be:

```
1. read_file /Users/firda/meridian2/progress.md
2. run_command "git log --oneline -n 10" to confirm commit state
3. run_command "npm test" to confirm 105 tests still pass
4. Ask user which option (1/2/3/4) they want to proceed with
```

---

## Open Questions for Next Session

1. **Which of E / A / B to implement?** (User decision pending.)
2. **Should uncommitted work get pushed?** Branch is 5 commits ahead of `origin/main`; user hasn't pushed yet. Check with user before `git push`.
3. **Should we restart pm2 to apply current commits?** Bot is still running the old code since the last restart — fixes aren't live until `pm2 restart meridian2`. User may want to smoke-test first.
