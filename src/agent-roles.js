/**
 * Centralized declaration of agent roles and the tools available to each.
 *
 * Three top-level roles:
 *   - MANAGER  — runs on the management cron, only manages open positions
 *   - SCREENER — runs on the screening cron, finds new pools to deploy into
 *   - GENERAL  — interactive REPL / Telegram, has dynamic intent-based tool
 *                slicing
 *
 * Adding a new tool? Add its name to the relevant role set(s) below and add
 * the schema in `tools/definitions.js`.
 */

export const MANAGER_TOOLS = new Set([
  "close_position",
  "claim_fees",
  "swap_token",
  "get_position_pnl",
  "get_my_positions",
  "get_wallet_balance",
  // Research-only — prompt explicitly allows this in the MANAGER role
  // (no deploy trigger). Useful when checking whether the open
  // position's pool has profitable LPers worth holding alongside.
  "study_top_lpers",
  "get_top_lpers",
]);

export const SCREENER_TOOLS = new Set([
  "deploy_position",
  "get_active_bin",
  "get_top_candidates",
  "check_smart_wallets_on_pool",
  "get_token_holders",
  "get_token_narrative",
  "get_twitter_sentiment",
  "get_token_info",
  "search_pools",
  "get_pool_memory",
  "get_wallet_balance",
  "get_my_positions",
  // A1 self-learning — required before deploy_position. Without this
  // in the SCREENER toolkit the LLM literally answers "tool not
  // available" and skips the study step entirely.
  "study_top_lpers",
  "get_top_lpers",
]);

/**
 * Tools that should ONLY be available when the user explicitly asks (via
 * intent matching) — never as part of the GENERAL fallback set. These are
 * mutating, destructive, or otherwise high-impact and require the user to
 * have phrased their request in a way that maps to a specific intent.
 */
export const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

/**
 * Per-intent tool subsets used when the user's goal in GENERAL mode matches
 * one of the patterns in INTENT_PATTERNS below. Each intent maps to the
 * minimal set of tools needed to handle that kind of request.
 */
export const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_twitter_sentiment", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_twitter_sentiment", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_performance_summary", "get_postmortem_suggestions", "get_zapout_telemetry", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

/**
 * Intent → regex patterns for goal-string matching. Order matters — the
 * first match wins. Patterns intentionally tolerate typos and informal
 * phrasing where reasonable.
 */
export const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];
