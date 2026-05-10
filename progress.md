# Meridian2 — Session Handoff

> **Purpose**: enable another session (AI model or human) to pick up exactly where this conversation left off without losing context.

**Last updated**: 2026-05-10 14:40 UTC+07
**Repo root**: `/Users/firda/meridian2`
**Branch**: `main` — ahead of `origin/main` by 1 commit (D5: hive_consensus + study_win_rate, not yet pushed)
**Test baseline**: **276/276 passing**

---

## TL;DR — Bot is ~95% Self-Learning (Darwin layer revived 5/10)

**May 10**: discovered & fixed silent bug in Darwin signal pipeline — `stageSignals()` was wired in screening but `getAndClearStagedSignals()` was never called downstream, so `signal-weights.json` had `recalc_count: 0` after 116 closes. Pipeline now end-to-end live.

**May 8** closed the major self-learning gaps. **A1 (top-LPer auto-discovery) live + verified**, **B1 (TP/SL self-evolve) heuristic fixed**, **hard guard prevents the LLM from skipping `study_top_lpers`**.

Bot now learns autonomously across **8 layers**:

| # | Layer | File | Status |
|---|---|---|---|
| 1 | Pool memory + cooldowns | `pool-memory.js` | ✅ |
| 2 | Lessons engine + threshold evolve | `lessons.js` | ✅ |
| 3 | Darwin signal weighting | `signal-weights.js` | ✅ pipeline fixed 5/10 |
| 4 | Top LPer auto-discovery (A1) | `src/top-lpers.js`, `tools/study.js` | ✅ live since 5/8 |
| 5 | TP/SL self-evolve (B1) | `lessons.js proposeTpSlAdjustment` | ✅ |
| 6 | Pool concentration guard (B2) | `tools/screening.js:335-355` | ✅ |
| 7 | Lessons retention (D2) | `lessons.js selectTopLessons` (60d sunset + score-rank) | ✅ |
| 8 | Hivemind + drawdown breaker + adaptive trailing | `hivemind.js`, `src/circuit-breaker.js`, `src/adaptive-trailing.js` | ✅ |

**Open gaps (all defer-able)**: D1 per-strategy weights (only relevant if non-bid_ask strategies used), D3 validation trend tracking, D4 GMGN exploration overrides. Darwin now learns from **11/11 signals**.

---

## May 10 Session — Commits

| Commit | What |
|---|---|
| `34d3bbb` | `fix(darwin): connect signal pipeline — staged signals now reach lessons.json` |
| `3c67a79` | `docs(progress): refresh handoff — Darwin pipeline fix + D5 gap + new diagnosis lessons` |
| `61c3f6d` | `feat(darwin): D5 — populate hive_consensus + study_win_rate signals` |

### Diagnosis path (May 10)

Darwin signal weighting was inert despite `signal-tracker.js` + `signal-weights.js` both being implemented. Root cause: **the bridge was missing**.

1. `index.js:675` calls `stageSignals(pool.pool, {...9 signals})` per candidate during screening — works.
2. `signal-weights.js` reads `entry.signal_snapshot` from each closed-position record in `lessons.json` — works.
3. **Gap**: nothing called `getAndClearStagedSignals(pool_address)`. Staged signals expired silently after 10min TTL. `state.trackPosition()` accepted a `signal_snapshot` param but no call site supplied it. `recordPerformance()` then had no `signal_snapshot` to forward.

**Evidence** (pre-fix): 116 perf records / 0 with `signal_snapshot`; 117 tracked positions / all `signal_snapshot=null`; `signal-weights.json` `recalc_count: 0`, `history: []`.

**Fix** (`tools/dlmm.js`): retrieve once at top of `deployPosition()`, forward to both `trackPosition()` paths (relay + manual), forward `tracked.signal_snapshot` into both `recordPerformance()` paths. 11 lines added, 0 deleted.

**Test coverage** (`test/signalPipeline.test.js`, +7): stage/clear round-trip, per-pool isolation, `state.trackPosition` preservation, integration `stage→retrieve→track→recordPerformance` with assertion on `lessons.json`, back-compat null guard.

**Verification path live**: Darwin will recalc on the next 5-close cadence once enough fresh records (with `signal_snapshot` populated) accumulate above `darwinMinSamples: 10`. Watch `[evolve] Darwin: adjusted N signal weight(s)` in `logs/agent-YYYY-MM-DD.log`.

### D5 closed (commit `61c3f6d`)

After the pipeline fix, two signals declared in `SIGNAL_NAMES` were still null on every record (`extractNumeric` saw 0 samples → lift always null):

- **`hive_consensus`** (boolean, by design choice): true iff at least one HiveMind shared lesson's rule text mentions the candidate's primary token symbol (case-insensitive, ≥2 chars to skip noisy `X` matches). Computed once-per-cycle in `index.js` from `getSharedLessons()` and threaded into the existing `stageSignals({...})` call. Moved from `HIGHER_IS_BETTER` → `BOOLEAN_SIGNALS` in `signal-weights.js` so `computeBooleanLift` handles it (numeric `extractNumeric` drops booleans via `typeof` check).
- **`study_win_rate`** (numeric mean of `studyResult.lpers[].summary.win_rate`): enriched at deploy time inside `tools/dlmm.deployPosition` after `getAndClearStagedSignals()`. The study cache is warm at that point because `executor.runSafetyChecks` forces `study_top_lpers` before `deploy_position`. Cold pools leave the field null — `extractNumeric` drops nulls, so missing data doesn't pollute lift.

New exports: `signal-tracker.computeHiveConsensus`, `signal-tracker.computeStudyWinRate`, `hivemind.getSharedLessons`, `tools/study.getStudyCacheData`. Tests: 11 added covering both helpers' edge cases.

---

## May 8 Session — Commits

| Commit | What |
|---|---|
| `08b769c` | `feat(top-lpers): tier 3 self-learning — auto-discover smart LPers` (A1 core) |
| `2e2dd41` | `feat(self-learn): tier B1 TP/SL proposals + B2 pool guard + tier C log cleanup` |
| `86b4b04` | `fix(prompt): study_top_lpers as HARD RULE before deploy` |
| `435f6e7` | `feat(a1): hard guard — study_top_lpers required before deploy_position` |
| `7c617b3` | `fix(roles): expose study_top_lpers to SCREENER + MANAGER toolkits` ← **the real bug** |
| `0c936d2` | `fix(b1): exclude trailing exits from hard-TP rate calc` |

### Diagnosis path (worth remembering)

A1 was inert for ~12 hours after deploy because of **three stacked bugs**:

1. **Prompt too soft** (only "should call") — fixed in `86b4b04` to HARD RULE.
2. **No server-side enforcement** — added executor-level guard in `435f6e7`. Telegram alert fires when guard blocks.
3. **`study_top_lpers` not in `SCREENER_TOOLS`** (`@/Users/firda/meridian2/src/agent-roles.js`) — LLM literally answered "tool not available in my toolkit". Fixed in `7c617b3`. **This was the actual root cause.** Prompt + guard were unreachable until tool was exposed.

After `7c617b3`, screening cycle 03:13:49 UTC paired `study_top_lpers(Clawd-SOL)` → 36s later → `deploy_position(Clawd-SOL)`. `top-lpers.json` populated with 3 LPers.

### B1 heuristic fix (`0c936d2`)

`proposeTpSlAdjustment` counted both `take_profit` AND `trailing` close reasons toward `tpRate`. Production data: 7 hard TP + 24 trailing in 95 closes = 32% > 20% threshold → blocked. Truth: hard TP only fires 7%, winners' max barely crosses TP=4%.

Fix: only `take_profit` counts toward TP rate. Trailing is a distinct mechanism (peak-pullback), not "TP target reached". Now proposes TP 4 → 1.5 on real data.

---

## Self-Learning Architecture (How It Loops)

```
┌─ Position closes ────────────────────────────────────────────┐
│  recordPerformance(pool, pnl, close_reason)                  │
│       ↓                                                      │
│  ┌─ Pool memory ─┐  ┌─ Lessons ─┐  ┌─ Darwin ─┐  ┌─ Breaker┐│
│  │ avg_pnl_pct   │  │ derive    │  │ recalc   │  │ trip if │ │
│  │ win_rate      │  │ lesson    │  │ weights  │  │ streak  │ │
│  │ cooldowns     │  │           │  │          │  │         │ │
│  └───────────────┘  └───────────┘  └──────────┘  └─────────┘│
└──────────────────────────────────────────────────────────────┘
                             ↓
┌─ Next screening cycle ──────────────────────────────────────┐
│  GMGN funnel → candidates                                    │
│       ↓                                                      │
│  Cooldown filter + B2 pool concentration guard               │
│       ↓                                                      │
│  Prompt injection: lessons + Darwin weights + perf summary   │
│       ↓                                                      │
│  ┌─ HARD GUARD: deploy_position requires study_top_lpers ───┐│
│  │  for the same pool within last 25min (cache window)      ││
│  └──────────────────────────────────────────────────────────┘│
│       ↓                                                      │
│  study_top_lpers → record top LPers in top-lpers.json        │
│       ↓                                                      │
│  Auto-promote LPer → smart-wallets.json (≥3 pools, WR≥60%,   │
│       ≥10 pos)                                               │
│       ↓                                                      │
│  deploy_position with bins/strategy chosen by LLM            │
└──────────────────────────────────────────────────────────────┘
                             ↓
┌─ Periodic (every N closes) ─────────────────────────────────┐
│  evolveThresholds(perf, config)                              │
│       ↓                                                      │
│  Auto-apply: maxVolatility, minOrganic, minFeeActiveTvlRatio │
│  Propose only (operator approval): takeProfitPct, stopLossPct│
│       ↓                                                      │
│  Telegram: /risk → list pending proposals                    │
│  /risk accept <id> → apply to user-config.json + live config │
│  /risk reject <id> → mark rejected                           │
│  Auto-expire after 7 days                                    │
└──────────────────────────────────────────────────────────────┘
```

---

## Verified Live (May 8 morning)

```
02:26:09  +  deploy_position     pool=4d4XPuZ5  ← HANTA (BEFORE A1 fix)
03:13:49  +  study_top_lpers     pool=9SN2Awqk  ← Clawd-SOL ✓ A1 working
03:14:25  +  deploy_position     pool=9SN2Awqk  ← paired (36s later) ✓
```

`top-lpers.json` (4.2 KB) — 3 LPers tracked from Clawd-SOL. None promoted yet (need ≥3 pools sample). `smart-wallets.json` not yet created — will appear after first auto-promotion.

---

## Telegram Commands Reference

| Command | What |
|---|---|
| `/lpers` | Top LPer leaderboard sorted by composite score |
| `/lpers stats` | Corpus stats + active thresholds |
| `/lpers info <addr>` | Full record dump |
| `/lpers promote <addr>` | Manual promote (bypass thresholds) |
| `/lpers reject <addr>` | Blacklist from auto-promotion |
| `/risk` | Drawdown breaker state + pending TP/SL proposals |
| `/risk accept <id>` | Apply proposal to live config + user-config.json |
| `/risk reject <id>` | Mark proposal rejected |
| `/resume` | Clear circuit breaker manually |

---

## Open Gaps (Defer-able)

### D1 — Per-strategy Darwin weights
Currently all strategies (spot/bid_ask/curve) share one weight set. Bot operates 100% bid_ask → no functional impact. Becomes relevant only if you experiment with non-bid_ask strategies.

**To implement**: split `signal-weights.json` keyed by strategy: `{ bid_ask: {...}, spot: {...}, curve: {...} }`. Min sample threshold per strategy to avoid overfit. ~2-3 hours.

### D3 — Validation trend tracking
`validation.signMatches/signTotal` is logged per cycle but not tracked over time. Regime shift detection still manual.

**To implement**: timeseries in `decision-log.json` + alert on trend break. ~1 hour.

### D4 — GMGN exploration overrides
Exploration mode (`darwin.explorationRate`) loosens thresholds for Meteora discovery path but is ignored in GMGN funnel. Niche.

**To implement**: separate exploration thresholds for GMGN stages. ~30 min.

### Tier C — Log noise (cosmetic)
Most cleaned in `2e2dd41`. Remaining: `editMessage` "message not modified" 400s — already swallowed. Watch for any new noise.

---

## Critical Files Quick-Reference

| File | Role |
|---|---|
| `index.js` | Main orchestrator: cron, cycles, Telegram, fatal handlers |
| `tools/dlmm.js` | DLMM primitives: deploy, claim, close, swap |
| `tools/executor.js` | Tool dispatcher; **runSafetyChecks** with A1 hard guard at `:767-786` |
| `tools/study.js` | studyTopLPers with TTL cache + `hasRecentStudy()` export |
| `tools/screening.js` | GMGN funnel + B2 pool concentration guard at `:335-355` |
| `state.js` | Position tracking, exit rule evaluation |
| `lessons.js` | recordPerformance, evolveThresholds, **proposeTpSlAdjustment** at `:631-709`, lifecycle of risk proposals |
| `signal-weights.js` | Darwin weighting, recalculateWeights with hold-out validation |
| `pool-memory.js` | Per-pool history + `getPoolHistoryStats()` for B2 |
| `src/top-lpers.js` | A1 LPer persistence + auto-promotion |
| `src/agent-roles.js` | **SCREENER/MANAGER tool sets** — must include `study_top_lpers` |
| `src/circuit-breaker.js` | Drawdown trip on streak / daily loss |
| `src/adaptive-trailing.js` | Volatility-scaled trailing TP/SL |
| `prompt.js` | System prompt — HARD RULE for study_top_lpers at `:172` |
| `hivemind.js` | Cross-agent shared lessons |
| `config.js` | Config normalization; `smartLpers.enforceStudyBeforeDeploy` flag |
| `telegram.js` | Bot commands; benign error swallow + HTML fallback |

---

## Conventions to Follow

- **Never delete tests**. Baseline: 244 tests in 17 files.
- **Before commit**: `node --check <changed>.js && npm test` must pass.
- **Atomic writes**: JSON state goes through `writeJsonAtomicSync` (`fs-utils.js`) — never raw `fs.writeFileSync`.
- **No new top-level state files** without strong reason. Existing: `state.json`, `lessons.json`, `signal-weights.json`, `pool-memory.json`, `decision-log.json`, `user-config.json`, `token-blacklist.json`, `dev-blocklist.json`, `circuit-breaker.json`, `hivemind-*.json`, `top-lpers.json`, (eventually) `smart-wallets.json`.
- **Minimal edits**: prefer surgical fixes over refactors.
- **Indonesian-English communication** in chat. Code + comments stay English.
- **No comments churn**: don't add/delete unrelated comments during a change.

---

## User Preferences / Communication Style

- **Language**: Indonesian-English casual mix. `gw` = "I", `lo` = "you", `bro/cok/asu/kontol` = casual filler. Match this register.
- **Direct answers**: terse, concrete. No "you're absolutely right!" preamble.
- **Show evidence**: line numbers, log excerpts, commit hashes.
- **Be honest**: when something doesn't work, say so. Don't claim verification you didn't run.
- **Prefer concrete scenarios** over abstract descriptions.

---

## How to Resume in Next Session

1. Read this `progress.md`.
2. `git log --oneline -n 5` → confirm latest is `61c3f6d` or newer.
3. `npm test` → confirm 276+ tests pass.
4. Check live state:
   ```bash
   ls -la top-lpers.json smart-wallets.json
   cat lessons.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('proposals:', len(d.get('risk_proposals',[])), 'lessons:', len(d.get('lessons',[])), 'perf:', len(d.get('performance',[])))"
   tail -50 logs/agent-$(date +%Y-%m-%d).log
   ```
5. Verify Darwin recalc fired at least once: `cat signal-weights.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('recalc_count:', d.get('recalc_count',0), 'last:', d.get('last_recalc'))"`. If `recalc_count > 0`, the 5/10 fix is confirmed live. Spot-check that `lessons.json` perf records have `signal_snapshot.hive_consensus` (boolean) and (for warm pools) `signal_snapshot.study_win_rate` (number).
6. Ask user what to work on. Default options: D1 (per-strategy weights, ~2-3h), D3 (validation trend, ~1h), D4 (GMGN exploration, ~30min), or new direction.

---

## Diagnosis Lessons (May 8)

When a feature doesn't fire despite "being implemented":

1. **Check tool exposure first** — `agent.js` filters by role via `agent-roles.js`. A tool registered in `executor.js` but not in `SCREENER_TOOLS`/`MANAGER_TOOLS` is invisible to the LLM.
2. **Check prompt rule strength** — soft "should" / "consider" gets ignored. Use HARD RULE format alongside `fees_sol` and similar gates.
3. **Add server-side guard** as last line of defense — even with perfect prompt, LLMs can skip. The guard returns an actionable error and the LLM retries with the missing call.
4. **Telegram alert on guard fire** — silent enforcement is invisible. You want to know when the LLM is being lazy.

This pattern applies to any future feature with "LLM must call X before Y" semantics.

## Diagnosis Lessons (May 10)

When a self-learning subsystem appears implemented but produces no observable change:

1. **Trace the data flow end-to-end, not just per-module presence**. The Darwin bug had a stager (`stageSignals`) and a consumer (`signal-weights`) both correct in isolation — the bridge `getAndClearStagedSignals` was simply never called. `grep -rn` for the consumer function name across the repo before assuming it works.
2. **Verify with live state files**, not just unit tests. `signal-weights.json` showed `recalc_count: 0` after 116 closes — that's a smoking gun. Periodic spot-check of state files catches silent dormancy.
3. **A `Map` with TTL fails silently**. The 10-min TTL on `_staged` means missed retrievals look exactly like "no signal data available" — no error, no warning. For pipelines with fire-and-forget staging, log on TTL eviction or assert downstream coverage in tests.
4. **The destination schema accepting an optional field is not proof the field flows**. `state.trackPosition({signal_snapshot})` happily accepted `null` for 117 deploys; type-loose JS gave no hint that nobody was supplying it.
