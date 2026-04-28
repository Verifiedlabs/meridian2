import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // forks pool allows process.chdir() — needed for tests that exercise
    // state.js (which writes to ./state.json relative to cwd).
    pool: "forks",
    include: ["test/**/*.test.js"],
    // Tests run in worker threads with shared filesystem state — disable
    // parallelism for files that touch state.json / lessons-state.json so
    // they don't race. Individual tests within a file still run serially.
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Don't load real env vars (.env may have prod RPC, wallet keys, etc.)
    env: {
      DRY_RUN: "true",
      WALLET_PRIVATE_KEY: "test-key-not-real",
      RPC_URL: "https://api.mainnet-beta.solana.com",
      OPENROUTER_API_KEY: "test-key-not-real",
    },
  },
});
