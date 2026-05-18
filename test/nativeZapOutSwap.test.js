import { describe, expect, it, vi } from "vitest";
import { runNativeZapOutSwap } from "../tools/dlmm.js";

describe("runNativeZapOutSwap", () => {
  it("skips when there is no swappable token balance", async () => {
    const result = await runNativeZapOutSwap("TokenMint1111111111111111111111111111111111", {
      getWalletBalances: async () => ({ tokens: [] }),
      swapToken: vi.fn(),
    });
    expect(result.swapped).toBe(false);
    expect(result.attempted).toBe(false);
  });

  it("swaps to SOL when balance is present", async () => {
    const swapToken = vi.fn(async () => ({ tx: "tx123", amount_out: 1.23 }));
    const result = await runNativeZapOutSwap("TokenMint1111111111111111111111111111111111", {
      getWalletBalances: async () => ({
        tokens: [
          {
            mint: "TokenMint1111111111111111111111111111111111",
            balance: 123.45,
            usd: 10,
            symbol: "TOK",
          },
        ],
      }),
      swapToken,
    });
    expect(swapToken).toHaveBeenCalledTimes(1);
    expect(result.swapped).toBe(true);
    expect(result.tx).toBe("tx123");
  });

  it("returns non-fatal failure when swap throws", async () => {
    const result = await runNativeZapOutSwap("TokenMint1111111111111111111111111111111111", {
      getWalletBalances: async () => ({
        tokens: [
          {
            mint: "TokenMint1111111111111111111111111111111111",
            balance: 12,
            usd: 2,
            symbol: "TOK",
          },
        ],
      }),
      swapToken: async () => { throw new Error("swap failed"); },
    });
    expect(result.swapped).toBe(false);
    expect(result.attempted).toBe(true);
    expect(String(result.error || "")).toContain("swap failed");
  });
});
