// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * testStore.ts — shared pglite test fixture (pss-5mnb).
 *
 * The expensive part of a pglite-backed test is the WASM ENGINE BOOT (~1s warm, several seconds
 * cold), not the migrate (~20ms). Every store/route test used to construct its own `new PGlite()`
 * in `beforeEach`, so the WASM engine was booted hundreds of times across the suite — and under the
 * parallel fork pool those simultaneous cold boots thrashed the CPU and occasionally blew past
 * vitest's default per-test timeout (the symptom the old 30s-timeout stopgap masked).
 *
 * This module boots ONE pglite engine PER WORKER PROCESS and hands out a freshly-migrated store by
 * RESETTING the schema (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` + re-migrate, ~80ms)
 * between tests instead of re-booting. Vitest runs the tests within a single file sequentially in
 * one worker, and separate test files run in separate forks — so each worker owns its own engine
 * and the reset is never racing a concurrent test. The result is a green suite that is faster AND
 * more stable, so the timeout drops back to vitest's default.
 *
 * Tests that need a NON-migrated or custom-shape database (e.g. the migrate() idempotency tests that
 * build an OLD-shape `doc` table first) must still construct their own `new PGlite()` — this helper
 * is only for the common "fresh, fully-migrated store" path.
 */

import type { PGlite } from "@electric-sql/pglite";
import { PgStore, createPgliteExecutor } from "./pgStore";

/** A migrated store + its underlying pglite handle (for tests that issue raw SQL). */
export interface TestStore {
  store: PgStore;
  db: PGlite;
}

// One engine per worker process, reused (schema-reset) across that worker's tests.
let enginePromise: Promise<PGlite> | null = null;

function bootEngine(): Promise<PGlite> {
  if (enginePromise === null) {
    // Dynamic import keeps pglite dev-only and out of the production bundle graph.
    enginePromise = import("@electric-sql/pglite").then(
      ({ PGlite }) => new PGlite()
    );
  }
  return enginePromise;
}

// Start the (~1s, one-time) WASM boot EAGERLY at module load. Each test file imports this module at
// the top, so the boot overlaps vitest's import/setup phase (which is NOT subject to testTimeout)
// instead of being charged to the first test — keeping that first test inside the default budget.
// Errors are swallowed here and re-surfaced by the awaited getEngine() call so they aren't unhandled.
void bootEngine().catch(() => {});

async function getEngine(): Promise<PGlite> {
  return bootEngine();
}

/**
 * Return this worker's shared pglite engine with a BLANK schema (every table dropped, NOT migrated).
 *
 * For tests that must drive migrate() themselves or build a non-standard (e.g. OLD-shape) `doc` table
 * before migrating — they would otherwise pay a cold WASM boot. Resetting the shared engine's schema
 * (~80ms) gives them the same blank-database isolation a brand-new `new PGlite()` would, minus the boot.
 */
export async function freshPgliteDb(): Promise<PGlite> {
  const db = await getEngine();
  await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  return db;
}

/**
 * Return a freshly-migrated {@link PgStore} backed by this worker's shared pglite engine.
 *
 * The schema is fully reset (every table dropped and re-created) before the store is returned, so
 * each test sees an empty, fully-migrated database — the same isolation a brand-new `new PGlite()`
 * gives, at a fraction of the cost because the WASM engine is only booted once per worker.
 */
export async function freshTestStore(): Promise<TestStore> {
  const db = await freshPgliteDb();
  const store = new PgStore(createPgliteExecutor(db));
  await store.migrate();
  return { store, db };
}
