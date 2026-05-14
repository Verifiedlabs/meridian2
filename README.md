# Meridian

**Autonomous Meteora DLMM liquidity-provider agent for Solana, powered by an LLM.**

Meridian opens, monitors, and closes concentrated-liquidity positions on Meteora DLMM pools without you needing to babysit them. It picks pools, sizes positions, claims fees, exits when a position drifts out of range or stops earning, and learns from each closed position to refine its own thresholds over time.

> ⚠️ **This is real money on Solana mainnet.** You can lose all of it — to bad pool picks, rug pulls, RPC failures, slippage, smart-contract risk, or LLM mistakes. Read the [Before you start](#-before-you-start) section before doing anything else.

---

## Table of contents

1. [What it does](#what-it-does)
2. [How it works](#how-it-works)
3. [⚠ Before you start](#-before-you-start)
4. [What you need](#what-you-need)
5. [Step-by-step setup](#step-by-step-setup)
6. [Choosing a preset](#choosing-a-preset)
7. [Your first run](#your-first-run)
8. [Going live](#going-live)
9. [Maintenance — reclaiming ATA rent](#maintenance--reclaiming-ata-rent)
10. [Telegram setup](#telegram-setup)
11. [Common errors and how to fix them](#common-errors-and-how-to-fix-them)
12. [REPL commands](#repl-commands)
13. [Glossary](#glossary)
14. [How it learns](#how-it-learns)
15. [Hive Mind (optional)](#hive-mind-optional)
16. [Repo layout](#repo-layout)

---

## What it does

- **Screens pools** — every 30 minutes (default), scans Meteora **or GMGN** pools and filters by fee/TVL ratio, organic score, holder count, market cap, bin step, bundler %, top-10 holder concentration, KOL/smart-degen counts, OKX rugpull/wash-trading flags, and more.
- **Deploys positions** — picks the best surviving candidate and opens an LP position with a sized, configurable SOL amount (the LLM decides which pool, you set the bounds).
- **Manages positions** — every 10 minutes, evaluates each open position for stop-loss, take-profit (incl. **adaptive trailing**), out-of-range, low-yield, and PnL-suspect exits.
- **Realtime fast-close** — a WebSocket watcher reacts within seconds when price pumps far above range or trips a profit-protection rule, instead of waiting for the next 10-min management cycle.
- **Claims fees** — when fees accrued cross your `minClaimAmount` threshold.
- **Closes and re-deploys** — when a position hits exit criteria, closes it, optionally swaps the base token back to SOL, and feeds the result into the lessons system. Each close notification now includes the close reason.
- **Auto-reclaims ATA rent** — after a position is closed and swapped back to SOL, the bot automatically closes the now-empty SPL token account to reclaim ~0.002 SOL in rent (configurable via `autoRevokeAtaAfterClose`).
- **Self-protects** — circuit breaker trips on daily-loss / consecutive-loss limits and pauses new deploys until cooldown elapses; exploration budget caps over-deployment to similar pools; pool-history guard cools down pools that keep dumping you.
- **Learns** — five tiers of self-learning: composite-scored lesson injection, operator-curated coaching memos, top-LPer auto-discovery, TP/SL self-evolve proposals (operator-approved), and pool-level guards. After 10+ closes, the **darwin tuner** auto-evolves screening thresholds based on your actual win/loss data.
- **Talks to you** — REPL prompt, Telegram **control panel** with inline buttons, daily briefings, OOR alerts, deploy/close notifications, daily PnL calendar, postmortem flags, exposure/risk snapshot.

---

## How it works

Meridian runs a **ReAct loop**: each cycle the LLM reads live data → calls a tool → reads the result → calls another tool, etc. → makes a decision. Three specialised agent roles run on independent cron schedules, each with its own scoped toolkit (so a SCREENER can't accidentally close positions, a MANAGER can't deploy fresh ones):

| Role | Default cadence | What it does |
|---|---|---|
| **SCREENER** (Hunter Alpha) | every 30 min | discovers candidates → studies top LPers → deploys into the best surviving one |
| **MANAGER** (Healer Alpha) | every 10 min | evaluates each open position and acts (stay / close / claim / swap) |
| **GENERAL** | on demand | free-form chat / Telegram commands, full toolkit |
| **Realtime watcher** | continuous | WS-driven fast-close on profit-protection / OOR rules |
| **Health check** | every 60 min | summarises portfolio state to Telegram |

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position state, deploy/close transactions
- Meteora DLMM PnL API — live position yield + fee accrual
- Solana RPC (Helius by default) — wallet balances, token accounts
- Pool screener (Meteora or GMGN) — candidate discovery
- OKX Web3 — rugpull / wash-trading / bundler / sniper flags (no API key needed)
- Optional: LPAgent API for top-LPer studies, Jupiter API for swaps

LLMs are accessed via **OpenRouter** by default, but you can swap any OpenAI-compatible endpoint (LM Studio, local llama.cpp server, etc.) by setting `LLM_BASE_URL` and `LLM_API_KEY` in `.env`.

---

## ⚠ Before you start

**1. Use a fresh, dedicated wallet.** Generate a brand-new Phantom wallet just for Meridian. Do **not** import your main wallet. Worst case, only the funds in the dedicated wallet are at risk.

**2. Start small.** First run with **0.5–1 SOL**. Do not deposit your savings into the bot. After 7+ days of stable behaviour, scale up gradually.

**3. Read what the bot is about to do.** Watch your Telegram and the REPL output for at least the first 24 hours. Make sure the candidates make sense to you before going live.

**4. The agent makes decisions you might disagree with.** It is autonomous. If you don't like its picks, stop the bot, tighten the filters in `user-config.json`, and try again.

**5. Risks (non-exhaustive):**
- Pool tokens rug → you lose the base-token side of your position
- Price pumps far above your range → impermanent loss
- LLM picks a bad pool → loss until exit rule triggers
- RPC/network failure → tx may not land, partial position state
- Slippage on close swap → can be 10%+ on illiquid pools

**6. You are responsible.** Meridian is provided as-is. The contributors are not financial advisors and not liable for your losses.

---

## What you need

| Item | Required | Where to get it | Notes |
|---|---|---|---|
| Node.js 18+ | ✓ | https://nodejs.org | Check with `node -v` |
| A dedicated Solana wallet | ✓ | [Phantom](https://phantom.app) → create new wallet → export private key | Use the **base58** key (Phantom default) |
| 0.5–1 SOL in the wallet | ✓ | Buy on any CEX → withdraw to your new wallet | Need extra for gas + reserve |
| OpenRouter API key | ✓ | https://openrouter.ai → Keys → Create | ~$2–5/day depending on model + cycle frequency |
| Helius API key | ✓ | https://helius.dev → free tier | For RPC + wallet balance lookups |
| Telegram bot (optional) | – | [@BotFather](https://t.me/BotFather) | Recommended — lets you control the bot from your phone |
| LPAgent API key (optional) | – | https://lpagent.io | Enables top-LPer study tool |

---

## Step-by-step setup

### 1. Clone and install

```bash
git clone https://github.com/Verifiedlabs/meridian2.git
cd meridian2
npm install
```

Default branch is `main` and is the active development branch.

If `npm install` errors on your machine, make sure you're on Node.js **18 or newer** (`node -v`).

### 2. Configure environment variables

Copy the example file and edit it:

```bash
cp .env.example .env
```

Open `.env` and fill in **at minimum**:

```env
# ── Wallet ───────────────────────────
WALLET_PRIVATE_KEY=<paste base58 private key from your dedicated Phantom wallet>

# ── Solana RPC ───────────────────────
RPC_URL=https://mainnet.helius-rpc.com/?api-key=<your_helius_key>
# You can also set multiple endpoints for failover:
# RPC_URL=https://primary,https://backup1,https://backup2

# ── LLM ──────────────────────────────
OPENROUTER_API_KEY=sk-or-...

# ── API keys ─────────────────────────
HELIUS_API_KEY=<your_helius_key>

# ── Behaviour ────────────────────────
DRY_RUN=true                 # IMPORTANT: keep true for first run
LOG_LEVEL=info
```

**Optional (recommended):**

```env
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_CHAT_ID=<your chat id, see telegram setup below>
TELEGRAM_ALLOWED_USER_IDS=<your telegram user id>
LPAGENT_API_KEY=<your lpagent key>
```

### 3. (Optional) Configure GMGN screener

If you want to use GMGN instead of Meteora for pool discovery:

```bash
cp gmgn-config.example.json gmgn-config.json
```

Edit `gmgn-config.json` and add your GMGN API key. If you skip this step, the bot defaults to Meteora screening.

### 4. Pick a preset

The repo ships with four pre-tuned `user-config.json` profiles in [`presets/`](./presets/). Pick one and copy it:

```bash
cp presets/conservative.json user-config.json     # if wallet < 5 SOL
# or
cp presets/balanced.json user-config.json         # if wallet 5–20 SOL (recommended default)
# or
cp presets/aggressive.json user-config.json       # if wallet > 20 SOL, comfortable with high-frequency
# or
cp presets/micro-live.json user-config.json       # for collecting real PnL data with tiny live trades (0.05 SOL/position)
```

See [Choosing a preset](#choosing-a-preset) below for help deciding.

You can also start from `user-config.example.json` and tune ~80 fields manually if you know what you're doing.

### 5. (Optional) Encrypt your `.env`

If you don't want plain-text secrets on disk:

```bash
cp .env .env.raw
printf "your-strong-passphrase-here\n" > .envrypt
npm run env:encrypt
rm .env.raw      # only after you confirm the encrypted .env still works
```

Meridian uses **AES-256-GCM with scrypt KDF** (the new `v2:` format). Old XOR-encrypted files (`v1:` format) still load with a one-time warning, after which you should re-encrypt.

Keep `.env.raw` and `.envrypt` local — both are gitignored.

### 6. Verify the install

```bash
npm test
```

You should see something like:

```
 Test Files  18 passed (18)
      Tests  258 passed (258)
   Duration  ~2s
```

The suite covers state machine transitions, safety checks, deterministic close rules, agent role gating, threshold evolution, holdout validation, adaptive trailing, circuit breaker, top-LPer scoring, lesson scoring, performance summaries, postmortem suggestions, risk proposals, pool-history guard, daily PnL chart, daily PnL calendar, and coaching.

If any test fails, do **not** continue. Open an issue with the output.

### 7. First run — DRY RUN

```bash
npm run dev
```

This sets `DRY_RUN=true` and starts the bot. **No real transactions will be submitted.** You'll see:

- Startup banner with `Mode: DRY RUN`
- Wallet balance + open positions (should be empty)
- First screening cycle within ~15 min (or sooner depending on `screeningIntervalMin`)
- "would_deploy" messages in logs/Telegram instead of real deploys
- "would_close" messages in logs/Telegram instead of real closes

Watch this for **at least 24–48 hours**. Read the candidate descriptions. Are the pools the bot wants to deploy into pools you'd manually pick? If yes, proceed to live mode. If no, tighten filters in `user-config.json` (raise `minOrganic`, `minHolders`, `minMcap`; lower `maxBundlePct`, `maxBotHoldersPct`).

> **Important caveat about DRY_RUN:** because deploy/close are short-circuited before `state.json` and `lessons.json` are written, DRY_RUN does **not** record real PnL data — it only lets you observe screening + LLM decisions. To collect actual closed-position records that seed the darwin tuner, use the `micro-live` preset (real on-chain trades, but capped to 0.05 SOL/position).

---

## Choosing a preset

| Preset | Wallet size | Max positions | Risk profile | When to use |
|---|---|---|---|---|
| `conservative` | < 5 SOL | 2 | Low — strict filters, -25% SL, +8% TP, 15-min cycles | First-timer, capital preservation, sleep-mode |
| `balanced` | 5–20 SOL | 4 | Medium — default Meteora memecoin range, -40% SL, +5% TP, 10-min cycles | Recommended default for active trader |
| `aggressive` | > 20 SOL | 8 | High — loose filters, -55% SL, +4% TP, 5-min cycles | Wallet you can afford to risk + daily monitoring |
| `micro-live` | 0.5–1 SOL | 1 (0.05 SOL/pos) | Live but tiny | Collecting real PnL data to validate strategy without risking meaningful capital |

See [`presets/README.md`](./presets/README.md) for the full glossary of which parameter does what.

After you have ~20–30 closed positions logged in `lessons.json`, the darwin tuner (`darwinEnabled: true` in all presets) will start nudging your thresholds based on your actual win/loss outcomes — at that point, it doesn't matter much which preset you started from, the bot will converge on what works in current pool conditions.

---

## Your first run

What you'll see in the first hour:

1. **Startup**: wallet balance, open positions (none), config summary, "DRY RUN" banner
2. **0–15 min**: first screening cycle runs. Pulls top pools from Meteora API → applies all filters → enriches with OKX risk data → drops wash-trading and rugpull-flagged pools → presents survivors to the LLM
3. **LLM decision**: model reasons over the candidates and picks one (or none, if all candidates fail its qualitative checks)
4. **DRY RUN deploy**: log shows `would_deploy: { pool: ..., amount: 0.5 SOL, ... }` — no actual transaction
5. **Management cycle (10 min later)**: model evaluates the (zero) open positions, no action

What to look for:
- **Funnel logs** (`logs/YYYY-MM-DD.log` and Telegram) show how many pools survived each filter. If 0 pools survive the wash/rugpull/organic/holders filter and that happens consistently for hours, your filters are too tight — loosen them.
- **LLM reasoning** in cycle reports. The model explains why it picked or rejected. If reasoning is consistently bad (e.g. picking pools that obviously look like rugs to you), tighten the filters or change the model.
- **Errors**: any 502/503 from OpenRouter is automatically retried with the fallback model (`stepfun/step-3.5-flash:free`). RPC errors are retried with backoff against fallback endpoints if you set them.

---

## Going live

After your DRY_RUN observation period:

1. Stop the bot (`/stop` in REPL or Ctrl+C)
2. Edit `.env`: set `DRY_RUN=false`
3. **First live run with `presets/micro-live.json`** to collect real PnL data with bounded risk
4. Run: `npm start`
5. Watch the first deploy carefully — confirm the tx hash on https://solscan.io
6. After 20–30 closed positions, evaluate your data: win rate, average PnL, expectancy
7. If profitable, scale up: switch to `balanced` or `aggressive` preset

---

## Maintenance — reclaiming ATA rent

Over time your wallet accumulates empty SPL token accounts (one per token you've ever held). Each costs ~0.00204 SOL in rent. Meridian handles this automatically after position closes, but you can also clean up manually:

```bash
# Preview what would be closed (dry run)
node tools/revoke-atas.js --dry

# Close strictly-empty accounts only (safe — no dust burned)
node tools/revoke-atas.js --threshold=0

# Close + burn up to $0.01 of dust per account (default)
node tools/revoke-atas.js
```

The tool skips wSOL, USDC, frozen accounts, and low-decimal balances (NFT/collectible protection). See `tools/revoke-atas.js --help` for options.

## Telegram setup

Strongly recommended — lets you control the bot remotely from your phone.

### Step 1: Create the bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, follow prompts to name your bot
3. Copy the bot token (looks like `123456:ABC-DEF...`)

### Step 2: Find your chat ID and user ID

Message your new bot once (anything — `hi` works). Then visit:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

Replace `<YOUR_TOKEN>` with the token from BotFather. In the JSON response:
- `result[0].message.chat.id` is your **chat ID**
- `result[0].message.from.id` is your **user ID**

### Step 3: Add to `.env`

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=<chat id from step 2>
TELEGRAM_ALLOWED_USER_IDS=<your user id from step 2>
```

`TELEGRAM_ALLOWED_USER_IDS` is **mandatory if your chat is a group** — without it, the bot ignores all incoming commands for safety. For a 1-on-1 DM chat, set it anyway as a safety measure.

### What you'll get

- Cycle reports (every screening + management run)
- Deploy notifications: pair, amount, position address, tx hash, range coverage, bin step, base fee
- Close notifications: pair, PnL, **close reason** (e.g. `Trailing TP: peak 5.2% → 3.5%`, `Out of range too long`, `Low yield: fee/TVL 0.3% < 1%`)
- OOR alerts: when a position is out of range past your wait threshold
- Daily briefing: 24-hour portfolio summary with 7-day PnL chart + postmortem flags
- Postmortem flags: high/medium severity diagnostic alerts when patterns emerge in the last N closes

### Commands

You can chat with the bot the same way as in the REPL or use slash commands. Only allowed user IDs can send commands.

**Quickest path: `/panel`** — opens the **MERIDIAN CONTROL PANEL** with inline buttons for every common action. No need to memorise commands.

| Command | What it does |
|---|---|
| `/panel` or `/dashboard` | Open the control panel (recommended UX) |
| `/help` | Show all commands |
| `/status` or `/wallet` | Wallet balance + open positions |
| `/positions` | Detailed table of open positions |
| `/pool <n>` | Detailed info for one position |
| `/close <n>` / `/closeall` | Close one or all positions |
| `/set <n> <note>` | Add an operator note to a position (LLM reads it) |
| `/screen` / `/candidates` / `/deploy <n>` | Force-screen now, list cached candidates, deploy by index |
| `/history` | Last 7 days of closed positions with PnL + reasons |
| `/perf` | Performance summary (close-reason histogram, win rate, PnL) |
| `/calendar [YYYY-MM]` | **Daily PnL calendar** with prev/next nav (default: current month) |
| `/lessons` | Auto-derived lessons + close-reason breakdown |
| `/postmortem` or `/pm` | High/medium severity diagnostic flags |
| `/risk` | Exposure snapshot + worst-case loss if all SLs fire |
| `/risk proposals` / `/risk accept <id>` / `/risk reject <id>` | Operator-approved TP/SL self-evolve proposals |
| `/why <n>` | Explain why a specific position was deployed |
| `/briefing` | Morning briefing on demand |
| `/config` / `/settings` / `/setcfg <key> <value>` | Show / button-edit / persist runtime config |
| `/hive` / `/hive pull` | HiveMind sync status / manual pull |
| `/pause` / `/resume` | Stop / start cron cycles |
| `/stop` | Graceful shutdown |

Free-form chat (anything not matching a slash command) is routed through the GENERAL agent — `"close everything"`, `"how much have we earned today?"`, `"what do you think of pool 2?"`.

---

## Common errors and how to fix them

| Error | Likely cause | Fix |
|---|---|---|
| `Error: WALLET_PRIVATE_KEY missing` | `.env` not loaded or key blank | Confirm `.env` exists, run `npm run dev` from repo root |
| `Error: failed to fetch from RPC` | Helius rate limit or wrong key | Check Helius dashboard; set fallback endpoints in `RPC_URL` (comma-separated) |
| `[envcrypt] WARN: legacy XOR format detected` | You have v1-encrypted env values | Run `npm run env:encrypt` to upgrade to v2 (AES-256-GCM) |
| `OpenRouter 401: invalid API key` | Wrong or revoked OPENROUTER_API_KEY | Generate new key at openrouter.ai/keys |
| `OpenRouter 402: insufficient credits` | Out of OpenRouter credit | Top up at openrouter.ai/credits |
| `bin_step out of range` during deploy | LLM tried a pool with bin step outside `minBinStep`/`maxBinStep` | This is the safety check working — no action needed |
| `position_count >= maxPositions` | Hit your concurrent-position cap | Either close some via `/close <n>` or raise `maxPositions` |
| `Insufficient SOL for deploy` | Wallet below `gasReserve + amount_y` | Top up wallet or lower `deployAmountSol` |
| `update_config validation failed: maxPositions out of range` | LLM tried to set an invalid value | Validators are working — no action needed |
| Telegram commands ignored | `TELEGRAM_ALLOWED_USER_IDS` empty in a group | Set your user ID in `.env` and restart |
| `Tx simulation failed: 0x1` | Insufficient SOL for tx fee | Add SOL to wallet |
| Bot deploys but immediately closes with `pnl-suspicious` | PnL oracle gave bogus reading | This is the safety guard at work; will retry next cycle |

If something else goes wrong, check `logs/YYYY-MM-DD.log` first. Most errors have a clear root cause in the log.

---

## REPL commands

After `npm start` or `npm run dev`, the prompt looks like:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

The REPL exposes the same slash-command surface as Telegram (see the Telegram **Commands** table above) — `/status`, `/positions`, `/screen`, `/close <n>`, `/history`, `/perf`, `/calendar`, `/lessons`, `/postmortem`, `/risk`, `/why <n>`, `/briefing`, `/config`, `/settings`, `/pause`, `/resume`, `/stop`. Plus the REPL-only shortcuts:

| Command | What it does |
|---|---|
| `1`, `2`, `3` ... | Manually deploy into the numbered candidate from last `/candidates` |
| `auto` | Let the agent pick the best candidate and deploy now (skip cron wait) |
| `go` | Start cron without deploying anything |
| `/learn` | Run `study_top_lpers` on every candidate pool, save lessons |
| `/learn <pool_address>` | Study a specific pool |
| `/thresholds` | Show current screening thresholds + closed-position stats |
| `/evolve` | Trigger threshold darwin tuning (needs 5+ closed positions) |
| anything else | Free-form chat with the agent — ask questions, request analysis, instruct actions |

Free-form chat persists session history (last 10 messages), so you can have a conversation: `"close everything"`, `"how much have we earned today?"`, `"what do you think of pool 2?"`.

---

## Glossary

| Term | Meaning |
|---|---|
| **DLMM** | Dynamic Liquidity Market Maker. Meteora's concentrated-liquidity AMM where LPs deposit into specific bins (price ranges) instead of the whole curve. |
| **Bin** | A discrete price tick. Each pool has a `bin_step` (e.g. 100 = 1% per bin). Active bin = current price tick. |
| **Bin step** | Width of each bin. Stable pairs use 1–25, blue chips 25–80, memecoins 80–125, exotic 125+. |
| **Bins below / bins above** | How many bins below/above the active bin your position covers. More bins = wider range = lower yield but lower OOR risk. |
| **OOR** | Out of Range. Price moved outside your position's bin range. Position stops earning fees and starts incurring impermanent loss against the side that pumped. |
| **Active bin** | The bin where current price sits. Only this bin earns fees. |
| **Strategy** | How liquidity is distributed across your bins: `spot` = uniform, `bid_ask` = concentrated at edges, `curve` = bell-shaped. |
| **Organic score** | Meteora's measure of "real" volume vs wash. 0–100, higher = more legit. |
| **Bundler %** | Fraction of supply held by wallets funded from the same source. High = likely insider/sniper concentration. |
| **TVL** | Total Value Locked in the pool, USD. |
| **Fee/active-TVL ratio** | Fees earned in 24h ÷ TVL in active bin. Higher = better yield. |
| **Bin step ratio** | Fee tier. With `bin_step=100` and `baseFactor=10000`, base fee = 1%. |
| **Stop loss** | PnL % that triggers an automatic close. |
| **Trailing TP** | Take-profit that activates after PnL crosses `trailingTriggerPct`, then closes when PnL drops `trailingDropPct` from peak. Locks in gains during a pullback. |
| **Darwin tuner** | The auto-evolution module: after enough closed positions, mutates thresholds (`maxVolatility`, `minFeeActiveTvlRatio`, `minOrganic`) based on win/loss outcomes. |

---

## How it learns

Meridian's self-learning system has five tiers, each operating on a different timescale:

### Tier 0 — `lessons.json` recorder

Every closed position is recorded with PnL, hold duration, exit reason, fees earned, range efficiency. The `recordPerformance()` function in `lessons.js` writes these and **auto-derives short structured lessons** after each batch of closes (e.g. `"OOR pumped above range — consider tighter upside coverage on memecoin pools"`).

### Tier 1 — composite-scored lesson injection

Lessons are scored by `recency × evidence_weight × pinned-priority` and the top-N injected into the LLM's system prompt for subsequent cycles. So the agent doesn't drown in noise — it sees only the most relevant + recent + high-evidence rules. See `selectTopLessons()` in `lessons.js`.

### Tier 2 — coaching memos (operator-curated)

You can pin / unpin lessons, add manual coaching memos with `addLesson(rule, tags, { pinned: true })` (or via the LLM tool), and they ride alongside auto-derived lessons in the prompt. See `src/coaching.js` + `src/coaching-llm.js`.

### Tier 3 — top-LPer auto-discovery

Before deploying, the SCREENER **must** call `study_top_lpers` (this is a hard rule in the prompt). The tool fetches the top LP wallets active on the pool from LPAgent, derives behaviour patterns (avg hold time, range width, win rate), and stores them in `top-lpers.json`. The agent then mimics what successful LPers do on similar pools. See `src/top-lpers.js`.

### Tier 4 — TP/SL self-evolve proposals

`proposeTpSlAdjustment()` analyses winners vs losers across the last N closes and emits **proposals** (e.g. `"loosen stopLossPct from -40 to -45 — current SL is firing on 38% of trades that would have recovered"`). Proposals are surfaced via `/risk proposals` and require **operator approval** — never auto-applied. See `lessons.js`.

### Tier 5 — pool-level guards

- `pool-memory.json` — Per-pool deploy history + snapshots. Detects "this pool keeps dumping me out of range" patterns and cools down the pool (`oorCooldownTriggerCount` + `oorCooldownHours`).
- **Repeat-deploy cooldown** — Caps re-deploys into the same pool within a window unless minimum fees were earned last time.
- **Circuit breaker** (`src/circuit-breaker.js`) — Trips on daily-loss / consecutive-loss limits and blocks new deploys until cooldown elapses.
- **Exploration budget** — Caps how many deploys go to similar (low-evidence) pools so the agent doesn't over-explore at the expense of validated picks.
- **Holdout validation** — Reserves a % of closes for out-of-sample threshold evaluation.

### Darwin threshold tuning

After at least `darwinMinSamples` closed positions (default 10), `evolveThresholds()` looks at winners vs losers and adjusts:

- `maxVolatility` — pool volatility ceiling
- `minFeeActiveTvlRatio` — yield floor
- `minOrganic` — organic-score floor

Runs every `darwinRecalcEvery` closes (default 5). The rationale for each change is logged.

You can trigger it manually with `/evolve`.

---

## Hive Mind (optional)

A collective-intelligence module where multiple Meridian agents anonymously share lessons + deploy outcomes. Off by default in this build.

**What you get:** crowd-sourced consensus on which pools, strategies, and thresholds work across all hive members.

**What you share:** lessons, deploy outcomes (pool, strategy, PnL, hold time), screening thresholds. **Never wallet addresses, balances, or keys.**

**To opt in:**

1. Set in `user-config.json`:
   ```json
   "hiveMindUrl": "https://meridian-hive-api-production.up.railway.app",
   "hiveMindApiKey": "<your token from the private Telegram>",
   ```
2. Or add to `.env`:
   ```env
   HIVE_MIND_URL=https://meridian-hive-api-production.up.railway.app
   HIVE_MIND_API_KEY=<your token>
   ```
3. Restart the bot.

To register a new agent ID, see the snippet in `hivemind.js`. Without `HIVE_MIND_API_KEY`, the bot runs fully local — no telemetry leaves your machine.

---

## Repo layout

```
index.js                    REPL + cron orchestration + Telegram polling + control panel
agent.js                    ReAct loop (LLM ↔ tools)
config.js                   Loads user-config.json + .env
prompt.js                   System prompts per agent role
state.js                    Position registry (state.json)
lessons.js                  Closed-position recorder + darwin tuner + TP/SL proposals
pool-memory.js              Per-pool deploy history (pool-memory.json)
strategy-library.js         Saved LP strategies
briefing.js                 Daily briefing + 7-day PnL chart + daily PnL calendar
telegram.js                 Telegram bot polling + notifications + control-panel rendering
hivemind.js                 Optional collective-intelligence sync
smart-wallets.js            KOL/alpha wallet tracker
signal-tracker.js           Multi-signal aggregation (Discord, Twitter, GMGN, etc.)
signal-weights.js           Signal-weight tuning from outcomes
decision-log.js             Per-position decision log (why deployed / closed)
token-blacklist.js          Permanent token blacklist
logger.js                   Daily-rotating logs (logs/)
rpc.js                      Multi-endpoint RPC failover
tx-priority.js              Priority-fee + compute-budget helpers
envcrypt.js                 AES-256-GCM env encryption (v2)
fs-utils.js                 Atomic file writes

src/
  format.js                 Pure formatting helpers (countdown, candidates, help text)
  deterministic.js          Deterministic close-rule logic
  agent-roles.js            Tool sets per agent role (SCREENER / MANAGER / GENERAL)
  adaptive-trailing.js      Volatility-aware trailing-TP trigger
  circuit-breaker.js        Daily-loss / consecutive-loss circuit breaker
  realtime-watcher.js       WS subscriber for fast-close on price moves
  top-lpers.js              Top-LPer auto-discovery + scoring
  coaching.js               Operator-curated coaching memos
  coaching-llm.js           LLM-side coaching tool implementations

tools/
  definitions.js            Tool schemas (what the LLM sees)
  executor.js               Tool dispatch + safety checks + update_config validators
  dlmm.js                   Meteora DLMM SDK wrapper
  screening.js              Pool discovery + filtering pipeline (Meteora + GMGN)
  wallet.js                 Wallet balances + Jupiter swap
  token.js                  Token info + holders + narrative
  study.js                  Top-LPer study via LPAgent
  okx.js                    OKX risk/cluster/price enrichment
  gmgn.js                   GMGN screener client
  twitter.js                Twitter sentiment for tokens
  chart-indicators.js       TA indicator pulls for pool charts

presets/
  conservative.json         Low-risk preset
  balanced.json             Default preset
  aggressive.json           High-frequency preset
  micro-live.json           Real-data collection preset
  README.md                 Preset documentation

test/                       18 vitest files, 258 tests total
```

Run `npm test` to execute all unit tests (~2s).

---

## License

MIT. See `package.json`.

---

## Disclaimer

Meridian is an experimental autonomous trading agent. It deploys real funds on Solana mainnet to volatile, often unaudited memecoin pools. **You will lose money.** The maintainers offer no guarantees of profit, correctness, or safety. Use at your own risk.
