/**
 * tools/twitter.js — Twitter/X sentiment analysis for token screening.
 *
 * Scrapes Twitter data for a token ticker to assess social buzz, KOL engagement,
 * and overall sentiment. Used as an enrichment step in the screening pipeline.
 *
 * Data sources (tried in order):
 *   1. GetXAPI.com — $0.001/call (~20 tweets), no rate limit, pay-per-use
 *   2. Nitter RSS scraping — fallback, no auth needed
 *   3. Graceful null — if all sources fail, screening continues without Twitter data
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

const KOL_FOLLOWER_THRESHOLD = 10_000;

// ─── Nitter Instances (fallback) ─────────────────────────────────

const NITTER_INSTANCES = [
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
  "https://nitter.cz",
];

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

  const timeoutMs = config.twitter?.timeoutMs ?? 15_000;

  try {
    // Try GetXAPI first (primary — $0.001/call, no rate limit)
    const apiKey = config.twitter?.apiKey;
    if (apiKey) {
      const result = await withTimeout(
        fetchGetXApi(symbol, apiKey),
        timeoutMs,
      );
      if (result) {
        log("twitter", `GetXAPI OK for $${symbol}: ${result.tweet_count_24h} tweets, sentiment=${result.sentiment}`);
        return result;
      }
    }

    // Fallback: Nitter RSS scraping
    const nitterResult = await withTimeout(
      fetchNitter(symbol),
      timeoutMs,
    );
    if (nitterResult) {
      log("twitter", `Nitter OK for $${symbol}: ${nitterResult.tweet_count_24h} tweets, sentiment=${nitterResult.sentiment}`);
      return nitterResult;
    }

    log("twitter", `No Twitter data available for $${symbol}`);
    return null;
  } catch (err) {
    log("twitter", `Error fetching Twitter data for $${symbol}: ${err.message}`);
    return null;
  }
}

// ─── GetXAPI.com ─────────────────────────────────────────────────
// Docs: https://docs.getxapi.com
// Endpoint: GET /twitter/tweet/advanced_search
// Cost: $0.001/call (~20 tweets), no rate limit
// Auth: Bearer token

async function fetchGetXApi(symbol, apiKey) {
  const query = `$${symbol} OR #${symbol}`;
  const url = `https://api.getxapi.com/twitter/tweet/advanced_search?q=${encodeURIComponent(query)}&product=Latest`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (res.status === 401) {
      log("twitter", "GetXAPI auth failed — check GETXAPI_KEY");
      return null;
    }
    if (res.status === 429) {
      log("twitter", "GetXAPI rate limited");
      return null;
    }
    if (!res.ok) {
      log("twitter", `GetXAPI error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const tweets = data.tweets || [];
    if (!tweets.length) {
      return buildResult(symbol, [], "getxapi");
    }

    return buildResult(symbol, tweets.map(normalizeGetXApiTweet), "getxapi");
  } catch (err) {
    log("twitter", `GetXAPI fetch error: ${err.message}`);
    return null;
  }
}

function normalizeGetXApiTweet(tweet) {
  // GetXAPI fields: text, likeCount, retweetCount, replyCount, viewCount,
  // quoteCount, createdAt, author { userName, name, followers, isBlueVerified }
  const author = tweet.author || {};
  return {
    text: tweet.text || "",
    likes: tweet.likeCount ?? 0,
    retweets: tweet.retweetCount ?? 0,
    replies: tweet.replyCount ?? 0,
    views: tweet.viewCount ?? 0,
    author_followers: author.followers ?? 0,
    author_name: author.userName ?? "unknown",
    author_verified: author.isBlueVerified ?? false,
    created_at: tweet.createdAt || null,
    url: tweet.url || null,
  };
}

// ─── Nitter RSS Fallback ─────────────────────────────────────────

async function fetchNitter(symbol) {
  const query = encodeURIComponent(`$${symbol}`);

  for (const instance of NITTER_INSTANCES) {
    try {
      const url = `${instance}/search/rss?f=tweets&q=${query}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MeridianBot/1.0)" },
        redirect: "follow",
      });

      if (!res.ok) continue;

      const xml = await res.text();
      const tweets = parseNitterRss(xml);
      if (tweets.length > 0) {
        return buildResult(symbol, tweets, `nitter:${instance}`);
      }
    } catch {
      continue; // try next instance
    }
  }

  return null;
}

function parseNitterRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = extractTag(itemXml, "title");
    const description = extractTag(itemXml, "description");
    const pubDate = extractTag(itemXml, "pubDate");
    const creator = extractTag(itemXml, "dc:creator");

    items.push({
      text: cleanHtml(description || title || ""),
      likes: 0,       // RSS doesn't have engagement data
      retweets: 0,
      author_followers: 0,
      author_name: creator || "unknown",
      created_at: pubDate || null,
    });
  }

  return items;
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, "s");
  const match = regex.exec(xml);
  return match ? match[1].trim() : null;
}

function cleanHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Result Builder ──────────────────────────────────────────────

function buildResult(symbol, tweets, source) {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  // Filter to last 24h if we have timestamps
  const recent = tweets.filter((t) => {
    if (!t.created_at) return true; // keep if no timestamp
    const ts = new Date(t.created_at).getTime();
    return ts >= oneDayAgo;
  });

  const tweetCount = recent.length;

  // Engagement
  const engagementTotal = recent.reduce(
    (sum, t) => sum + (t.likes || 0) + (t.retweets || 0),
    0,
  );

  // KOL detection
  const kols = recent.filter((t) => t.author_followers >= KOL_FOLLOWER_THRESHOLD);
  const kolNames = [...new Set(kols.map((t) => t.author_name))];

  // Sentiment analysis
  const sentiment = analyzeSentiment(recent);

  // Buzz level
  const buzzLevel = computeBuzzLevel(tweetCount, engagementTotal, kols.length);

  // Top tweets by engagement
  const topTweets = [...recent]
    .sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets))
    .slice(0, 3)
    .map((t) => ({
      text: t.text.slice(0, 200),
      likes: t.likes,
      retweets: t.retweets,
      author_followers: t.author_followers,
    }));

  // Build summary
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
    // Weight by engagement
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
  // Score based on volume + engagement + KOL presence
  let score = 0;
  score += Math.min(tweetCount / 10, 5);       // max 5 pts from tweet count
  score += Math.min(engagement / 500, 5);       // max 5 pts from engagement
  score += Math.min(kolCount * 2, 4);           // max 4 pts from KOLs

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
