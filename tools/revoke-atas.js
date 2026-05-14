#!/usr/bin/env node
// One-shot CLI to bulk-cleanup empty/dust SPL token ATAs and reclaim rent.
//
// Usage (from meridian2 root):
//   node tools/revoke-atas.js                # default: close strictly-empty + <=10000 raw dust
//   node tools/revoke-atas.js --threshold=0  # close ONLY strictly-empty (no burning)
//   node tools/revoke-atas.js --threshold=1000000  # close + burn up to 1M raw (decimals=6 -> $1)
//   node tools/revoke-atas.js --include-nfts # also burn ATAs with decimals<6 (DANGEROUS - may burn NFTs)
//   node tools/revoke-atas.js --dry          # preview only, no on-chain action
//
// Safe by default:
//   - never closes wSOL or USDC ATAs
//   - skips frozen accounts
//   - skips low-decimal ATAs with non-zero balance (NFT/collectible protection)
//   - won't touch ATAs above dust threshold
// Batching: ≤18 ATAs per tx.

import "../envcrypt.js";
import { revokeEmptyAtas } from "./wallet.js";

function parseArgs(argv) {
  const out = { threshold: 10000n, dry: false, includeNfts: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry" || arg === "--dry-run") {
      out.dry = true;
    } else if (arg === "--include-nfts") {
      out.includeNfts = true;
    } else if (arg.startsWith("--threshold=")) {
      const v = arg.slice("--threshold=".length);
      try {
        out.threshold = BigInt(v);
      } catch {
        console.error(`Invalid threshold value: ${v}`);
        process.exit(1);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node tools/revoke-atas.js [--threshold=<raw>] [--include-nfts] [--dry]");
      process.exit(0);
    }
  }
  return out;
}

const { threshold, dry, includeNfts } = parseArgs(process.argv);

console.log("─── ATA Rent Reclaim ───");
console.log(`Dust threshold: ${threshold} raw units (close if balance ≤ this; burn residual)`);
console.log(`NFT protection: ${includeNfts ? "OFF (⚠️  may burn NFTs/collectibles)" : "ON (skip decimals<6 with balance>0)"}`);
console.log(`Mode: ${dry ? "DRY RUN (preview only)" : "LIVE (will send transactions)"}`);
console.log("Skip: wSOL, USDC (always)\n");

if (dry) {
  process.env.DRY_RUN = "true";
}

const result = await revokeEmptyAtas({
  dustThresholdRaw: threshold,
  protectNfts: !includeNfts,
});

if (result.dry_run) {
  console.log("Dry-run mode — nothing executed.");
  console.log("Re-run without --dry to actually close accounts.");
  process.exit(0);
}

if (result.error) {
  console.error("Error:", result.error);
  process.exit(2);
}

console.log("─── Result ───");
console.log(`Closed:           ${result.closed} ATA(s)`);
console.log(`SOL reclaimed:    ${result.sol_reclaimed.toFixed(6)} SOL (~$${(result.sol_reclaimed * 180).toFixed(2)} at $180/SOL)`);
console.log(`Transactions:     ${result.txs.length}`);
for (const sig of result.txs) {
  console.log(`  https://solscan.io/tx/${sig}`);
}
if (result.accounts.length > 0) {
  console.log("\nClosed accounts:");
  for (const acc of result.accounts) {
    const dust = acc.burned_dust !== "0" ? ` (burned ${acc.burned_dust} raw dust)` : "";
    console.log(`  ${acc.mint.slice(0, 8)}…${acc.mint.slice(-4)}  ${acc.pubkey.slice(0, 8)}…${dust}`);
  }
}

process.exit(0);
