/**
 * tools/twitter.js — Twitter/X sentiment analysis for token screening.
 *
 * Two modes:
 *   "local"  — Playwright Chromium + your Twitter session cookies (FREE, unlimited)
 *   "api"    — GetXAPI.com REST API ($0.001/call, ~20 tweets per call)
 *
 * Auto-fallback: if primary mode fails, tries the other mode.
 * Results cached for 30 minutes to avoid redundant fetches.
 *
 * The result is injected into the LLM prompt and tracked as a Darwinian signal
 * ("twitter_sentiment") so the system can learn whether Twitter buzz actually
 * predicts profitable LP positions.
 */

import { config } from "../config.js";
import { log } from "../logger.js";

// ─── Sentiment Keywords ──────────────────────────────────────────

const BULLISH_KEYWORDS = [
  "moon", "bullish", "pump", "buy", "ape", "gem", "100x", "1000x",
  "send it", "lfg", "wagmi", "accumulate", "undervalued", "breakout",
  "rocket", "fire", "huge", "massive", "explode", "parabolic",
  "holding", "hodl", "diamond hands", "conviction", "alpha",
];

const BEARISH_KEYWORDS = [
  "dump", "bearish", "sell", "rug", "scam", "dead", "rekt", "ngmi",
  "exit", "short", "overvalued", "crash", "ponzi", "fraud", "fake",
  "avoid", "warning", "careful", "sus", "sketchy", "honeypot",
];

const SPAM_PATTERNS = [
  "follow @", "his signals", "his recommendations", "helped me earn",
  "been profitable", "crypto expert", "must-follow", "market reads",
  "market insights", "dm me for", "join my group", "free signals",
];

const KOL_FOLLOWER_THRESHOLD = 10_000;

// ─── Cache ───────────────────────────────────────────────────────

const _cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCached(symbol) {
  const key = symbol.toUpperCase();
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(symbol, data) {
  const key = symbol.toUpperCase();
  _cache.set(key, { data, ts: Date.now() });
  if (_cache.size > 200) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < 50; i++) _cache.delete(oldest[i][0]);
  }
}

// ─── Playwright Browser Pool (reuse across calls) ────────────────

let _browser = null;
let _context = null;
let _page = null;
let _browserLaunchPromise = null;

async function getLocalPage() {
  if (_page && !_page.isClosed()) return _page;

  // Prevent concurrent launches
  if (_browserLaunchPromise) return _browserLaunchPromise;

  _browserLaunchPromise = (async () => {
    try {
      const { chromium } = await import("playwright");

      if (_browser) {
        try { await _browser.close(); } catch {}
      }

      _browser = await chromium.launch({ headless: true });
      _context = await _browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      });

      const authToken = config.twitter?.authToken;
      const ct0 = config.twitter?.ct0;
      if (!authToken || !ct0) {
        throw new Error("Twitter cookies not configured (authToken + ct0 required for local mode)");
      }

      await _context.addCookies([
        { name: "auth_token", value: authToken, domain: ".x.com", path: "/", secure: true, httpOnly: true },
        { name: "ct0", value: ct0, domain: ".x.com", path: "/", secure: true },
        { name: "dnt", value: "1", domain: ".x.com", path: "/" },
      ]);

      _page = await _context.newPage();

      // Warm up session
      await _page.goto("https://x.com/home", { timeout: 20000 });
      await _page.waitForTimeout(3000);

      log("twitter", "Playwright browser session ready");
      return _page;
    } catch (err) {
      _browser = null;
      _context = null;
      _page = null;
      throw err;
    } finally {
      _browserLaunchPromise = null;
    }
  })();

  return _browserLaunchPromise;
}

// ─── Main Export ─────────────────────────────────────────────────

/**
 * Get Twitter/X sentiment analysis for a token.
 * @param {object} params
 * @param {string} params.symbol — Token ticker (e.g. "WISH", "SOL")
 * @param {string} [params.mint] — Token mint address (optional, for context)
 * @returns {Promise<object|null>} Sentiment data or null if unavailable
 */
export async function getTwitterSentiment({ symbol, mint }) {
  if (!config.twitter?.enabled) return null;
  if (!symbol) return null;

  const cached = getCached(symbol);
  if (cached !== null) {
    log("twitter", `Cache hit for $${symbol} (${cached.sentiment})`);
    return cached;
  }

  const mode = config.twitter?.mode || "local";
  const timeoutMs = config.twitter?.timeoutMs ?? 15_000;

  let result = null;

  // Primary mode
  try {
    if (mode === "local") {
      result = await withTimeout(fetchLocal(symbol), timeoutMs);
    } else {
      result = await withTimeout(fetchGetXApi(symbol, config.twitter?.apiKey), timeoutMs);
    }
  } catch (err) {
    log("twitter", `Primary (${mode}) failed for $${symbol}: ${err.message}`);
  }

  // Fallback to other mode
  if (!result) {
    try {
      if (mode === "local" && config.twitter?.apiKey) {
        log("twitter", `Fallback to API for $${symbol}`);
        result = await withTimeout(fetchGetXApi(symbol, config.twitter.apiKey), timeoutMs);
      } else if (mode === "api" && config.twitter?.authToken && config.twitter?.ct0) {
        log("twitter", `Fallback to local for $${symbol}`);
        result = await withTimeout(fetchLocal(symbol), timeoutMs);
      }
    } catch (err) {
      log("twitter", `Fallback failed for $${symbol}: ${err.message}`);
    }
  }

  if (result) {
    log("twitter", `${result.source} OK for $${symbol}: ${result.tweet_count_24h} tweets, sentiment=${result.sentiment}`);
    setCache(symbol, result);
    return result;
  }

  log("twitter", `No Twitter data available for $${symbol}`);
  return null;
}

// ─── Local Mode (Playwright Chromium) ────────────────────────────

async function fetchLocal(symbol) {
  const page = await getLocalPage();

  const captured = [];
  const onResponse = (response) => {
    if (response.url().includes("SearchTimeline") && response.status() === 200) {
      try { captured.push(response.json()); } catch {}
    }
  };

  page.on("response", onResponse);

  try {
    await page.goto(
      `https://x.com/search?q=%24${encodeURIComponent(symbol)}&src=typed_query&f=live`,
      { timeout: 20000 },
    );
    await page.waitForTimeout(8000);
  } finally {
    page.removeListener("response", onResponse);
  }

  // Resolve captured promises
  const responses = await Promise.all(captured.map(p => p.catch((err) => { log("twitter_warn", `tweet fetch failed: ${err.message}`); return null; })));
  const tweets = [];
  for (const data of responses) {
    if (data) tweets.push(...parseGraphQLTweets(data));
  }

  if (!tweets.length) return null;

  const clean = filterSpam(tweets);
  return buildResult(symbol, clean, "local");
}

function parseGraphQLTweets(data) {
  const tweets = [];
  const instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];

  for (const inst of instructions) {
    for (const entry of inst.entries || []) {
      let result = entry?.content?.itemContent?.tweet_results?.result;
      if (!result) continue;
      if (result.__typename === "TweetWithVisibilityResults") {
        result = result.tweet || result;
      }

      const legacy = result.legacy;
      if (!legacy?.full_text) continue;

      const userResult = result.core?.user_results?.result || {};
      const userCore = userResult.core || {};
      const userLegacy = userResult.legacy || {};

      tweets.push({
        text: legacy.full_text,
        likes: legacy.favorite_count || 0,
        retweets: legacy.retweet_count || 0,
        author_followers: userLegacy.followers_count || 0,
        author_name: userCore.screen_name || "unknown",
        author_verified: userResult.is_blue_verified || false,
        created_at: legacy.created_at || null,
      });
    }
  }
  return tweets;
}

function filterSpam(tweets) {
  return tweets.filter((t) => {
    const text = t.text.toLowerCase();
    return !SPAM_PATTERNS.some((pat) => text.includes(pat));
  });
}

// ─── API Mode (GetXAPI.com) ──────────────────────────────────────

async function fetchGetXApi(symbol, apiKey) {
  if (!apiKey) return null;

  const query = `$${symbol} OR #${symbol}`;
  const url = `https://api.getxapi.com/twitter/tweet/advanced_search?q=${encodeURIComponent(query)}&product=Latest`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (res.status === 401) { log("twitter", "GetXAPI auth failed"); return null; }
    if (res.status === 429) { log("twitter", "GetXAPI rate limited"); return null; }
    if (!res.ok) { log("twitter", `GetXAPI error: ${res.status}`); return null; }

    const data = await res.json();
    const tweets = data.tweets || [];
    if (!tweets.length) return buildResult(symbol, [], "api");

    return buildResult(symbol, tweets.map(normalizeGetXApiTweet), "api");
  } catch (err) {
    log("twitter", `GetXAPI fetch error: ${err.message}`);
    return null;
  }
}

function normalizeGetXApiTweet(tweet) {
  const author = tweet.author || {};
  return {
    text: tweet.text || "",
    likes: tweet.likeCount ?? 0,
    retweets: tweet.retweetCount ?? 0,
    author_followers: author.followers ?? 0,
    author_name: author.userName ?? "unknown",
    author_verified: author.isBlueVerified ?? false,
    created_at: tweet.createdAt || null,
  };
}

// ─── Result Builder ──────────────────────────────────────────────

function buildResult(symbol, tweets, source) {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const recent = tweets.filter((t) => {
    if (!t.created_at) return true;
    const ts = new Date(t.created_at).getTime();
    return ts >= oneDayAgo;
  });

  const tweetCount = recent.length;
  const engagementTotal = recent.reduce(
    (sum, t) => sum + (t.likes || 0) + (t.retweets || 0), 0,
  );

  const kols = recent.filter((t) => t.author_followers >= KOL_FOLLOWER_THRESHOLD);
  const kolNames = [...new Set(kols.map((t) => t.author_name))];
  const sentiment = analyzeSentiment(recent);
  const buzzLevel = computeBuzzLevel(tweetCount, engagementTotal, kols.length);

  const topTweets = [...recent]
    .sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets))
    .slice(0, 3)
    .map((t) => ({
      text: t.text.slice(0, 200),
      likes: t.likes,
      retweets: t.retweets,
      author_followers: t.author_followers,
      author_name: t.author_name,
    }));

  const summary = buildSummary(symbol, tweetCount, engagementTotal, kolNames, sentiment, buzzLevel);

  return {
    symbol,
    tweet_count_24h: tweetCount,
    engagement_total: engagementTotal,
    kol_mentions: kolNames.length,
    kol_names: kolNames.slice(0, 5),
    sentiment,
    buzz_level: buzzLevel,
    top_tweets: topTweets,
    summary,
    source,
  };
}

function analyzeSentiment(tweets) {
  let bullishScore = 0;
  let bearishScore = 0;

  for (const tweet of tweets) {
    const text = tweet.text.toLowerCase();
    const weight = 1 + Math.log1p((tweet.likes || 0) + (tweet.retweets || 0));
    for (const kw of BULLISH_KEYWORDS) {
      if (text.includes(kw)) bullishScore += weight;
    }
    for (const kw of BEARISH_KEYWORDS) {
      if (text.includes(kw)) bearishScore += weight;
    }
  }

  if (bullishScore === 0 && bearishScore === 0) return "neutral";
  const ratio = bullishScore / (bullishScore + bearishScore);
  if (ratio >= 0.65) return "bullish";
  if (ratio <= 0.35) return "bearish";
  return "neutral";
}

function computeBuzzLevel(tweetCount, engagement, kolCount) {
  let score = 0;
  score += Math.min(tweetCount / 10, 5);
  score += Math.min(engagement / 500, 5);
  score += Math.min(kolCount * 2, 4);
  if (score >= 8) return "HIGH";
  if (score >= 4) return "MEDIUM";
  if (score >= 1) return "LOW";
  return "NONE";
}

function buildSummary(symbol, tweetCount, engagement, kolNames, sentiment, buzzLevel) {
  if (tweetCount === 0) {
    return `$${symbol}: No Twitter activity found in last 24h.`;
  }
  const parts = [`$${symbol}: ${tweetCount} tweets in 24h`];
  if (engagement > 0) parts.push(`${engagement} total engagement`);
  if (kolNames.length > 0) {
    parts.push(`${kolNames.length} KOL(s): ${kolNames.slice(0, 3).join(", ")}`);
  }
  parts.push(`sentiment=${sentiment}`, `buzz=${buzzLevel}`);
  return parts.join(", ");
}

// ─── Utility ─────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Twitter fetch timeout (${ms}ms)`)), ms),
    ),
  ]);
}
