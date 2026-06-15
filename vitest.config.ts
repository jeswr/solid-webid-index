import path from "node:path";
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Many store/route tests spin up a fresh in-process PGlite (WASM Postgres) and
    // run migrate() per test; under full-suite parallelism the first PGlite boot in
    // a file can exceed vitest's 5s default purely from CPU contention (not a logic
    // failure — the same tests pass well under it in isolation). Raise the per-test
    // + hook ceiling so a loaded box never flakes a green test on a cold WASM boot.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
