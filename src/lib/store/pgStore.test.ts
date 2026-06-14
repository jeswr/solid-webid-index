// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * pgStore.test.ts — Vitest tests for PgStore using pglite (in-memory Postgres).
 *
 * No network, no Neon account required.  All tests run against an in-process
 * Postgres WASM instance via @electric-sql/pglite.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PgStore, createPgliteExecutor } from "./pgStore.js";
import type { DocRecord } from "./ports.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Create a fresh in-memory PGlite instance and a migrated PgStore for each test. */
async function makeTestStore(): Promise<{ store: PgStore; db: PGlite }> {
  const db = new PGlite();
  const executor = createPgliteExecutor(db);
  const store = new PgStore(executor);
  await store.migrate();
  return { store, db };
}

/** Minimal valid DocRecord factory — callers override only the fields they care about. */
function makeDoc(
  overrides: Partial<DocRecord> & { docUrl: string }
): DocRecord {
  return {
    docUrl: overrides.docUrl,
    host: overrides.host ?? new URL(overrides.docUrl).hostname,
    webid: overrides.webid ?? null,
    state: overrides.state ?? "done",
    depth: overrides.depth ?? 0,
    rootSeed: overrides.rootSeed ?? null,
    suggestBudget: overrides.suggestBudget ?? null,
    source: overrides.source ?? "seed",
    discoveredFrom: overrides.discoveredFrom ?? null,
    claimToken: overrides.claimToken ?? null,
    claimedAt: overrides.claimedAt ?? null,
    attempts: overrides.attempts ?? 1,
    etag: overrides.etag ?? null,
    lastModified: overrides.lastModified ?? null,
    contentHash: overrides.contentHash ?? null,
    lastCrawled: overrides.lastCrawled ?? Date.now(),
    nextEligibleAt: overrides.nextEligibleAt ?? 0,
    enqueuedAt: overrides.enqueuedAt ?? Date.now(),
    httpStatus: overrides.httpStatus ?? 200,
    isSolid: overrides.isSolid ?? true,
    failClass: overrides.failClass ?? null,
    error: overrides.error ?? null,
    noindex: overrides.noindex ?? false,
    rawRdf: overrides.rawRdf ?? null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PgStore — migration", () => {
  it("applies schema cleanly on a blank database", async () => {
    const db = new PGlite();
    const executor = createPgliteExecutor(db);
    const store = new PgStore(executor);
    // Should not throw
    await expect(store.migrate()).resolves.toBeUndefined();
  });

  it("is idempotent — applying schema twice does not error", async () => {
    const { store } = await makeTestStore();
    // Second apply should be a no-op (IF NOT EXISTS guards every statement)
    await expect(store.migrate()).resolves.toBeUndefined();
  });
});

describe("PgStore — ReadStore", () => {
  let store: PgStore;

  beforeEach(async () => {
    ({ store } = await makeTestStore());
  });

  afterEach(async () => {
    // pglite instances are GC'd; nothing to close explicitly
  });

  it("put() + get() round-trips a DocRecord", async () => {
    const doc = makeDoc({
      docUrl: "https://alice.example/card",
      webid: "https://alice.example/card#me",
      rawRdf:
        "@prefix foaf: <http://xmlns.com/foaf/0.1/> . <#me> a foaf:Person .",
    });

    await store.put(doc);
    const retrieved = await store.get(doc.docUrl);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.docUrl).toBe(doc.docUrl);
    expect(retrieved?.webid).toBe(doc.webid);
    expect(retrieved?.isSolid).toBe(true);
    expect(retrieved?.rawRdf).toBe(doc.rawRdf);
  });

  it("get() returns null for an unknown URL", async () => {
    const result = await store.get("https://unknown.example/card");
    expect(result).toBeNull();
  });

  it("exists() returns true for a known, non-tombstoned URL", async () => {
    const doc = makeDoc({ docUrl: "https://bob.example/profile" });
    await store.put(doc);
    expect(await store.exists(doc.docUrl)).toBe(true);
  });

  it("exists() returns false for an unknown URL", async () => {
    expect(await store.exists("https://nobody.example/card")).toBe(false);
  });

  it("put() with the same docUrl updates the row (upsert), not duplicates", async () => {
    const doc = makeDoc({
      docUrl: "https://carol.example/profile",
      webid: null,
    });
    await store.put(doc);

    const updated = { ...doc, webid: "https://carol.example/profile#me" };
    await store.put(updated);

    const retrieved = await store.get(doc.docUrl);
    expect(retrieved?.webid).toBe("https://carol.example/profile#me");

    // Confirm there is exactly one row (no duplicates)
    const { rows } = await store.list({ limit: 100 });
    const matches = rows.filter((r) => r.docUrl === doc.docUrl);
    expect(matches).toHaveLength(1);
  });

  it("tombstone() hides a doc from get()", async () => {
    const doc = makeDoc({ docUrl: "https://dave.example/card" });
    await store.put(doc);

    await store.tombstone(doc.docUrl);
    expect(await store.get(doc.docUrl)).toBeNull();
  });

  it("tombstone() hides a doc from exists()", async () => {
    const doc = makeDoc({ docUrl: "https://eve.example/card" });
    await store.put(doc);
    await store.tombstone(doc.docUrl);
    expect(await store.exists(doc.docUrl)).toBe(false);
  });

  it("list() filters by state correctly", async () => {
    const pending = makeDoc({
      docUrl: "https://p.example/card",
      state: "pending",
    });
    const done = makeDoc({
      docUrl: "https://d.example/card",
      state: "done",
    });
    await store.put(pending);
    await store.put(done);

    const pendingList = await store.list({ state: "pending", limit: 100 });
    const doneList = await store.list({ state: "done", limit: 100 });

    expect(pendingList.rows.map((r) => r.docUrl)).toContain(pending.docUrl);
    expect(pendingList.rows.map((r) => r.docUrl)).not.toContain(done.docUrl);

    expect(doneList.rows.map((r) => r.docUrl)).toContain(done.docUrl);
    expect(doneList.rows.map((r) => r.docUrl)).not.toContain(pending.docUrl);
  });
});

describe("PgStore — SearchIndex (FTS)", () => {
  let store: PgStore;

  beforeEach(async () => {
    ({ store } = await makeTestStore());
  });

  async function seedFtsDocs() {
    const docs: Array<Partial<DocRecord> & { docUrl: string }> = [
      {
        docUrl: "https://alice.example/card",
        webid: "https://alice.example/card#me",
        rawRdf:
          '<https://alice.example/card#me> <http://xmlns.com/foaf/0.1/name> "Alice Wonderland" .',
        state: "done",
        isSolid: true,
      },
      {
        docUrl: "https://bob.example/card",
        webid: "https://bob.example/card#me",
        rawRdf:
          '<https://bob.example/card#me> <http://xmlns.com/foaf/0.1/name> "Bob Builder" .',
        state: "done",
        isSolid: true,
      },
      {
        docUrl: "https://carol.example/card",
        webid: "https://carol.example/card#me",
        rawRdf:
          '<https://carol.example/card#me> <http://xmlns.com/foaf/0.1/name> "Carol Danvers" .',
        state: "done",
        isSolid: true,
      },
      {
        docUrl: "https://dave.example/profile",
        webid: "https://dave.example/profile#me",
        rawRdf:
          '<https://dave.example/profile#me> <http://xmlns.com/foaf/0.1/name> "Dave Alice Andersen" .',
        state: "done",
        isSolid: true,
      },
    ];

    for (const d of docs) {
      await store.put(makeDoc(d));
    }
  }

  it("search() returns results matching the query", async () => {
    await seedFtsDocs();

    const { rows } = await store.search({ query: "alice", limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
    // alice.example/card and dave.example/profile both mention "Alice"
    const urls = rows.map((r) => r.docUrl);
    expect(urls).toContain("https://alice.example/card");
  });

  it("search() results are ordered by rank DESC", async () => {
    await seedFtsDocs();

    const { rows } = await store.search({ query: "alice", limit: 10 });
    // Ranks must be non-increasing
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].rank).toBeGreaterThanOrEqual(rows[i].rank);
    }
  });

  it("search() excludes tombstoned documents", async () => {
    await seedFtsDocs();
    await store.tombstone("https://alice.example/card");

    const { rows } = await store.search({ query: "Wonderland", limit: 10 });
    const urls = rows.map((r) => r.docUrl);
    expect(urls).not.toContain("https://alice.example/card");
  });

  it("search() keyset pagination — second page continues after first", async () => {
    await seedFtsDocs();

    // Search for a term that matches several docs
    const page1 = await store.search({ query: "alice", limit: 1 });
    expect(page1.rows).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await store.search({
      query: "alice",
      limit: 10,
      cursor: page1.nextCursor ?? undefined,
    });

    // Page 2 must not repeat page 1's result
    const page1Urls = page1.rows.map((r) => r.docUrl);
    const page2Urls = page2.rows.map((r) => r.docUrl);
    for (const url of page1Urls) {
      expect(page2Urls).not.toContain(url);
    }
  });

  it("search() returns empty results for an unmatched query", async () => {
    await seedFtsDocs();
    const { rows, nextCursor } = await store.search({
      query: "xylophone",
      limit: 10,
    });
    expect(rows).toHaveLength(0);
    expect(nextCursor).toBeNull();
  });
});

describe("PgStore — schema constraints", () => {
  let db: PGlite;

  beforeEach(async () => {
    ({ db } = await makeTestStore());
  });

  it("doc state CHECK constraint rejects an invalid state value", async () => {
    const executor = createPgliteExecutor(db);
    // Bypass PgStore.put() to directly insert an invalid state
    await expect(
      executor.query(
        `INSERT INTO doc (doc_url, host, state, source, enqueued_at)
         VALUES ('https://bad.example/card', 'bad.example', 'invalid_state', 'seed', $1)`,
        [Date.now()]
      )
    ).rejects.toThrow();
  });
});

describe("PgStore — CrawlCoordinator", () => {
  let store: PgStore;

  beforeEach(async () => {
    ({ store } = await makeTestStore());
  });

  it("enqueue() adds a pending row", async () => {
    await store.enqueue("https://frank.example/card");
    const doc = await store.get("https://frank.example/card");
    // get() excludes tombstones but not pending — however pending is a valid non-tombstone state
    // enqueue sets state=pending; get() should return it
    expect(doc).not.toBeNull();
    expect(doc?.state).toBe("pending");
  });

  it("enqueue() is idempotent — second call does not overwrite", async () => {
    await store.enqueue("https://idempotent.example/card");
    // First call creates the row in pending state.
    // Manually advance the row to 'done' to prove second enqueue doesn't reset it.
    await store.markDone("https://idempotent.example/card", {
      state: "done",
      httpStatus: 200,
    });
    await store.enqueue("https://idempotent.example/card");

    const doc = await store.get("https://idempotent.example/card");
    // State should still be 'done' — enqueue is ON CONFLICT DO NOTHING
    expect(doc?.state).toBe("done");
  });

  it("markDone() updates state and clears claim_token", async () => {
    await store.enqueue("https://grace.example/card");
    await store.markDone("https://grace.example/card", {
      state: "done",
      httpStatus: 200,
      isSolid: true,
      webid: "https://grace.example/card#me",
    });

    const doc = await store.get("https://grace.example/card");
    expect(doc?.state).toBe("done");
    expect(doc?.claimToken).toBeNull();
    expect(doc?.isSolid).toBe(true);
    expect(doc?.webid).toBe("https://grace.example/card#me");
  });

  it("needsRecrawl() returns true for an unknown URL", async () => {
    expect(await store.needsRecrawl("https://unknown.example/card")).toBe(true);
  });

  it("needsRecrawl() returns false for a recently-done URL", async () => {
    await store.enqueue("https://heidi.example/card");
    await store.markDone("https://heidi.example/card", {
      state: "done",
      nextEligibleAt: Date.now() + 14 * 24 * 60 * 60 * 1000, // 14 days from now
    });
    expect(await store.needsRecrawl("https://heidi.example/card")).toBe(false);
  });

  it("claim() throws NotImplementedError (stub for pss-5i8)", async () => {
    await expect(store.claim("worker-1", 8)).rejects.toThrow("pss-5i8");
  });
});
