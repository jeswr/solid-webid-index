import path from "node:path";
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // pglite spins up an in-process Postgres WASM instance PER store test; when many such test
    // files boot concurrently under the default worker pool the per-instance migrate() can exceed
    // the default 5s (pure resource contention, not a logic failure — each file passes in
    // isolation). Bump the per-test + hook budget so a heavily-parallel run is not spuriously red.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
