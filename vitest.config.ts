import path from "node:path";
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Store/route tests share ONE pglite WASM engine per worker, resetting its schema (~80ms) between
    // tests instead of re-booting (src/lib/store/testStore.ts). That turned the engine boot from a
    // per-TEST cost into a one-time per-FILE cost and cut cumulative test time by roughly an order of
    // magnitude — the real fix for the contention the old 30s-timeout stopgap was masking.
    //
    // The one remaining variable cost is that single cold WASM instantiation, which under an N-way
    // parallel cold start can take a few seconds — occasionally past vitest's 5s default for the first
    // test in a file. 15s is a modest, honest ceiling for that one-time boot (half the old stopgap),
    // not a mask for per-test thrash. Tests that need a non-migrated DB drive migrate() on the same
    // shared engine via freshPgliteDb(), so they pay no extra boot either.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
