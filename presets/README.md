# Preset configs

Three pre-tuned `user-config.json` profiles. Pick one based on wallet size and risk appetite, then copy it into place:

```bash
cp presets/aggressive.json user-config.json
# or balanced.json / conservative.json
```

| Preset | Wallet size | Max positions | Stop loss | Take profit | Mgmt interval | OpenRouter cost |
|---|---|---|---|---|---|---|
| **conservative** | <5 SOL | 2 | -25% | +8% (trailing 4/1.5) | 15 min | low |
| **balanced** | 5-20 SOL | 4 | -40% | +5% (trailing 3/1.5) | 10 min | medium |
| **aggressive** | >20 SOL | 8 | -55% | +4% (trailing 2/1) | 5 min | high |

## What's the same across all three

- `dryRun: true` — **always start with DRY RUN to verify candidates make sense before going live**.
- `darwinEnabled: true` — adaptive threshold tuner (Meridian learns from closed positions).
- `pnlSanityMaxDiffPct: 5` — guards against PnL oracle glitches.
- `trailingTakeProfit: true` — locks in profit on a drop after a peak.
- LLM models default to `minimax/minimax-m2.5` (mgmt/screen) and `minimax/minimax-m2.7` (general). Override `managementModel` / `screeningModel` / `generalModel` if you want different ones.

## What changes between presets

### Position sizing
- `deployAmountSol` — minimum SOL per deploy (the "floor").
- `maxDeployAmount` — ceiling on a single position.
- `positionSizePct` — fraction of `(walletSol - gasReserve)` to deploy at the optimum size. The actual deploy is `clamp(deployable * positionSizePct, deployAmountSol, maxDeployAmount)`.
- `maxPositions` — hard cap on concurrent positions.

### Pool quality filters (screening)
- `minOrganic` / `minHolders` / `minMcap` / `minTvl` — quality floor for candidates. Conservative requires 75 organic, 1500 holders, $1M mcap. Aggressive accepts 55 organic, 400 holders, $100k mcap.
- `minFeeActiveTvlRatio` — yield ratio floor. Higher = pickier.
- `maxBundlePct` / `maxBotHoldersPct` / `maxTop10Pct` — rug protection. Conservative is strictest.

### Pool volatility (bin step)
Bin step is roughly inversely proportional to liquidity concentration:
- `25-100`: stable / blue-chip pairs (low vol)
- `80-125`: typical memecoin pairs (medium-high vol)
- `80-200`: ultra-volatile memecoin pairs (high vol)

Conservative stays low-mid (`25-100`); balanced sits at memecoin core (`80-125`); aggressive opens up to wild pairs (`80-200`).

### Exit rules
- `stopLossPct` (negative) — close when PnL drops below this.
- `takeProfitPct` (positive) — close when PnL rises above this. Trailing trigger / drop refines this.
- `outOfRangeWaitMinutes` / `outOfRangeBinsToClose` — close when price leaves your range.
- `minFeePerTvl24h` + `minAgeBeforeYieldCheck` — close stale positions that aren't earning enough.

### Cycle cadence
- `managementIntervalMin` — how often to re-evaluate open positions. Aggressive runs every 5 min (more LLM cost) vs conservative every 15 min.
- `screeningIntervalMin` — how often to scan for new pools.

## Safety rules (apply to all presets)

1. **Always start with `dryRun: true`** for at least 24 hours. Watch the candidates the screener proposes — they should look like pools you'd manually deploy into.
2. **Wallet must hold `gasReserve` extra SOL** beyond what you deploy. The deploy gate (`runSafetyChecks`) will block deploys that would dip below `gasReserve`.
3. `positionSizePct × maxPositions` should be ≤ ~0.6 to avoid over-deployment when many slots fill.
4. `aggressive` runs more LLM calls — budget your OpenRouter credit accordingly.
5. After enough closed positions (`darwinMinSamples: 10`), Meridian's darwin tuner will start nudging thresholds based on actual win/loss data. Watch `lessons.json` for `[AUTO-EVOLVED ...]` entries.

## Customizing further

Once you're running with a preset, use the Telegram bot or REPL to fine-tune live:

```
/setcfg maxPositions 5
/setcfg takeProfitPct 6
/setcfg stopLossPct -35
```

Values are validated (min/max/type/enum) before being applied — you can't set `maxPositions: -5` or `category: "garbage"`.

For the full button menu of common settings:

```
/settings
```
