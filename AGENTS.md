# Meridian2 — Project Agent Instructions

This file extends the global rules at `~/.config/opencode/AGENTS.md`.
Only project-specific concerns are listed below.

For architecture, agent roles, tool organization, and runtime conventions:
`@CLAUDE.md` (lazy-load on need-to-know basis — 226 lines, don't preload
unless directly relevant to the current task).

---

## Hot-Reload Awareness

Many config fields auto-reload from `user-config.json` without restart.
Adding a new config field needs ALL FIVE updates:

1. **Default** in `config.js` — initial structure (e.g.
   `screening.backtest.enabled: u.backtestEnabled ?? false`)
2. **Reload entry** in `config.js#reloadScreeningThresholds` — copies
   value from fresh JSON into live `config` object
3. **Validator** in `tools/executor.js` (top-of-file schema map)
4. **CONFIG_MAP** entry in `tools/executor.js` — defines persist path
   for `update_config` tool
5. **UI hook** in `index.js` if user-facing — `settingValue()` map +
   page button row + page-routing in input/toggle handlers

Skip any of these and behavior diverges between fresh-start and
hot-reload. Verify all 5 when touching configs.

---

## Restart Awareness

JS code in `index.js`, `tools/*.js`, etc. does **NOT** hot-reload.
Only JSON config files do. After touching any `.js`, the bot needs:

```
Ctrl-C → node index.js
```

Always tell the user this explicitly when shipping a code change —
don't assume they remember.

---

## Screening Pipeline Has Multiple Filter Stages

When debugging "bot not deploying" issues, **identify which stage
rejected candidates** before proposing fixes. Filters live in
multiple files:

- `tools/gmgn.js` — Stage 1-5 internal to GMGN (e.g.
  `minFeePer24h` filter at Stage 5, `@/Users/firda/meridian2/tools/gmgn.js:688`)
- `tools/screening.js` — post-discovery filters (blacklist, dev block,
  cooldowns, pool history guard, PVP, OKX risk, backtest gate)
- `tools/dlmm.js` — pre-deploy safety checks
- `index.js` — circuit breaker, max positions

Look at the log line `Stage5 final: N → M` to identify funnel choke
points. If `M=0` consistently, a Stage 5 filter is too tight. If
`Stage5 final: N → N` but no deploy, the rejection is downstream.

---

## Logs Live In Daily-Rotated Files

- Agent log: `logs/agent-YYYY-MM-DD.log` — human-readable, all `log()` calls
- Action log: `logs/actions-YYYY-MM-DD.jsonl` — structured, every tool call
- Telegram log: not persisted

When debugging, grep both. Today's file may not exist yet if no
deploys happened.

---

## Sensitive Operations

These require user approval, never auto-run:

- `deploy_position`, `close_position`, `claim_fees`, `swap_token`
- Any `update_config` that sets risk thresholds, `dryRun`, `solMode`,
  position size, or anything affecting deploy safety
- Any change to `user-config.json` (especially `minFeePer24h`,
  `minFeeActiveTvlRatio`, `maxBundlePct`, etc. — these directly gate
  the bot's entry decisions)

---

## Reference

Full project documentation: `@CLAUDE.md`
