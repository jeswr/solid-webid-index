// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * pgStore.test.ts — Vitest tests for PgStore using pglite (in-memory Postgres).
 *
 * No network, no Neon account required.  All tests run against an in-process
 * Postgres WASM instance via @electric-sql/pglite.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PgStore,
  createPgliteExecutor,
  splitSqlStatements,
} from "./pgStore.js";
import type { DocRecord, DocState } from "./ports.js";

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

  it("enqueue() + claim() — claim() returns the enqueued pending row", async () => {
    await store.enqueue("https://frank.example/card");

    const claimed = await store.claim("worker-1", 8);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].docUrl).toBe("https://frank.example/card");
    expect(claimed[0].state).toBe("claimed");
    // claim_token is now a fresh UUID, NOT the workerId
    expect(claimed[0].claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(claimed[0].attempts).toBe(1);
    expect(claimed[0].claimedAt).not.toBeNull();
  });

  it("claim() returns at most batchSize rows", async () => {
    // Enqueue 10 pending rows
    for (let i = 0; i < 10; i++) {
      await store.enqueue(`https://batch${i}.example/card`);
    }

    const claimed = await store.claim("worker-1", 5);
    expect(claimed.length).toBeLessThanOrEqual(5);
    // All returned rows must be marked claimed with the SAME unique token (one per claim() call)
    expect(claimed.length).toBeGreaterThan(0);
    const batchToken = claimed[0].claimToken;
    expect(batchToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    for (const row of claimed) {
      expect(row.state).toBe("claimed");
      // All rows in the same batch share the same token
      expect(row.claimToken).toBe(batchToken);
    }
  });

  it("claim() returns [] when the frontier is empty", async () => {
    const claimed = await store.claim("worker-empty", 8);
    expect(claimed).toHaveLength(0);
  });

  it("claim() — a fresh (unexpired) claimed row is NOT re-claimed by another worker", async () => {
    await store.enqueue("https://locked.example/card");

    // First worker claims the row
    const first = await store.claim("worker-A", 8);
    expect(first).toHaveLength(1);
    // Token is a UUID, not the workerId
    expect(first[0].claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    // Second worker must not re-claim the same row (it's still claimed + lease not expired)
    const second = await store.claim("worker-B", 8);
    expect(second).toHaveLength(0);
  });

  it("claim() — two concurrent claim() calls return DISJOINT row sets (the key correctness test)", async () => {
    // Enqueue 20 rows to give both workers plenty to claim
    for (let i = 0; i < 20; i++) {
      await store.enqueue(`https://concurrent${i}.example/card`);
    }

    // Fire both claim() calls concurrently — they must not share any row
    const [setA, setB] = await Promise.all([
      store.claim("worker-concurrent-A", 8),
      store.claim("worker-concurrent-B", 8),
    ]);

    const urlsA = new Set(setA.map((r) => r.docUrl));
    const urlsB = new Set(setB.map((r) => r.docUrl));

    // No URL may appear in both sets
    for (const url of urlsA) {
      expect(urlsB.has(url)).toBe(false);
    }

    // Each set must actually have claimed their rows (not 0 each)
    // With 20 rows and batchSize=8 each, both workers should get rows
    expect(setA.length + setB.length).toBeGreaterThan(0);

    // All returned rows must be marked claimed.
    // Each claim() call produces ONE unique UUID token shared across its batch —
    // so all rows in setA share the same token, and all rows in setB share a
    // DIFFERENT token.  Neither token equals the workerId string.
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const tokenA = setA[0]?.claimToken;
    const tokenB = setB[0]?.claimToken;
    expect(tokenA).toMatch(uuidPattern);
    expect(tokenB).toMatch(uuidPattern);
    // The two batches must have different tokens
    expect(tokenA).not.toBe(tokenB);

    for (const row of setA) {
      expect(row.state).toBe("claimed");
      expect(row.claimToken).toBe(tokenA);
    }
    for (const row of setB) {
      expect(row.state).toBe("claimed");
      expect(row.claimToken).toBe(tokenB);
    }
  });

  it("claim() — an expired lease row IS reclaimable after LEASE_MS", async () => {
    const { LEASE_MS } = await import("../config.js");

    // Use a fresh store+db pair so we can directly backdate claimed_at.
    const { store: freshStore, db: freshDb } = await makeTestStore();

    await freshStore.enqueue("https://expired2.example/card");

    // First claim — row transitions to 'claimed'
    const first = await freshStore.claim("worker-first", 8);
    expect(first).toHaveLength(1);

    // Backdate claimed_at to simulate an expired lease (more than LEASE_MS ago).
    const expiredClaimedAt = Date.now() - LEASE_MS - 1;
    await freshDb.query(
      `UPDATE doc SET claimed_at = $1 WHERE doc_url = 'https://expired2.example/card'`,
      [expiredClaimedAt]
    );

    // A second worker should now be able to reclaim the expired row.
    const reclaimed = await freshStore.claim("worker-second", 8);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].docUrl).toBe("https://expired2.example/card");
    // Token is a fresh UUID, not the workerId string
    expect(reclaimed[0].claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    // The reclaim token must be different from the first worker's token
    expect(reclaimed[0].claimToken).not.toBe(first[0].claimToken);
    expect(reclaimed[0].attempts).toBe(2); // incremented from the first claim
  });

  it("markDone() releases a claimed row (sets state and clears claim_token)", async () => {
    await store.enqueue("https://release.example/card");
    const claimed = await store.claim("worker-X", 8);
    expect(claimed).toHaveLength(1);
    const token = claimed[0].claimToken;
    expect(token).not.toBeNull();

    await store.markDone(
      "https://release.example/card",
      { state: "done", httpStatus: 200 },
      token
    );

    const doc = await store.get("https://release.example/card");
    expect(doc?.state).toBe("done");
    expect(doc?.claimToken).toBeNull();
    expect(doc?.claimedAt).toBeNull();
  });

  // ─── Lease-fence tests (roborev HIGH fix) ──────────────────────────────────

  it("markDone() with a STALE token is a safe no-op — new owner's state survives", async () => {
    // Scenario: worker-A claims the row (gets a unique UUID tokenA), its lease expires,
    // worker-B reclaims it (gets a DIFFERENT unique UUID tokenB).
    // worker-A's late markDone(tokenA) must NOT clobber worker-B's in-progress state.
    const { LEASE_MS } = await import("../config.js");
    const { store: freshStore, db: freshDb } = await makeTestStore();

    await freshStore.enqueue("https://stale-token.example/card");

    // worker-A claims the row — receives a unique UUID token
    const firstClaimed = await freshStore.claim("worker-A", 8);
    expect(firstClaimed).toHaveLength(1);
    const tokenA = firstClaimed[0].claimToken as string;
    // token is a UUID, not the workerId
    expect(tokenA).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    // Backdate claimed_at so worker-A's lease appears expired
    const expiredClaimedAt = Date.now() - LEASE_MS - 1;
    await freshDb.query(
      `UPDATE doc SET claimed_at = $1 WHERE doc_url = 'https://stale-token.example/card'`,
      [expiredClaimedAt]
    );

    // worker-B reclaims the expired row — gets a DIFFERENT unique UUID token
    const secondClaimed = await freshStore.claim("worker-B", 8);
    expect(secondClaimed).toHaveLength(1);
    const tokenB = secondClaimed[0].claimToken as string;
    expect(tokenB).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    // Critical: tokenB must differ from tokenA so the fence actually works
    expect(tokenB).not.toBe(tokenA);

    // worker-A's late markDone with its now-stale tokenA must be a no-op
    await expect(
      freshStore.markDone(
        "https://stale-token.example/card",
        {
          state: "done",
          httpStatus: 200,
          webid: "https://stale-worker.example/card#me",
        },
        tokenA
      )
    ).resolves.toBeUndefined(); // must NOT throw

    // worker-B's state and token must be preserved — not clobbered by worker-A
    const rowAfter = await freshStore.get("https://stale-token.example/card");
    expect(rowAfter?.state).toBe("claimed"); // still in worker-B's claimed state
    expect(rowAfter?.claimToken).toBe(tokenB); // worker-B's UUID token still present
    expect(rowAfter?.webid).toBeNull(); // worker-A's webid must NOT have been written
  });

  it("two sequential claims of the same row (after expiry) yield DIFFERENT claim tokens", async () => {
    // This directly tests the uniqueness invariant: even re-claiming the same row
    // with the same workerId must produce a fresh token each time.
    const { LEASE_MS } = await import("../config.js");
    const { store: freshStore, db: freshDb } = await makeTestStore();

    await freshStore.enqueue("https://token-uniqueness.example/card");

    // First claim
    const first = await freshStore.claim("worker-same", 8);
    expect(first).toHaveLength(1);
    const token1 = first[0].claimToken as string;
    expect(token1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    // Backdate to expire the lease
    await freshDb.query(
      `UPDATE doc SET claimed_at = $1 WHERE doc_url = 'https://token-uniqueness.example/card'`,
      [Date.now() - LEASE_MS - 1]
    );

    // Same worker reclaims — must get a DIFFERENT token
    const second = await freshStore.claim("worker-same", 8);
    expect(second).toHaveLength(1);
    const token2 = second[0].claimToken as string;
    expect(token2).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    // The two tokens MUST be different — this is the core of the fix
    expect(token2).not.toBe(token1);
  });

  it("worker-B's markDone(tokenB) succeeds after worker-A's stale markDone(tokenA) no-ops", async () => {
    // Full lifecycle: A claims → lease expires → B reclaims → A's markDone is no-op
    //                → B's markDone succeeds and is visible.
    const { LEASE_MS } = await import("../config.js");
    const { store: freshStore, db: freshDb } = await makeTestStore();

    await freshStore.enqueue("https://full-lifecycle.example/card");

    // worker-A claims
    const claimedA = await freshStore.claim("worker-A", 8);
    expect(claimedA).toHaveLength(1);
    const tokenA = claimedA[0].claimToken as string;

    // Expire worker-A's lease
    await freshDb.query(
      `UPDATE doc SET claimed_at = $1 WHERE doc_url = 'https://full-lifecycle.example/card'`,
      [Date.now() - LEASE_MS - 1]
    );

    // worker-B reclaims
    const claimedB = await freshStore.claim("worker-B", 8);
    expect(claimedB).toHaveLength(1);
    const tokenB = claimedB[0].claimToken as string;
    expect(tokenB).not.toBe(tokenA);

    // worker-A's stale markDone — no-op
    await freshStore.markDone(
      "https://full-lifecycle.example/card",
      { state: "done", httpStatus: 200, webid: "https://stale.example/#me" },
      tokenA
    );

    // Row is still claimed by B
    const midRow = await freshStore.get("https://full-lifecycle.example/card");
    expect(midRow?.state).toBe("claimed");
    expect(midRow?.claimToken).toBe(tokenB);
    expect(midRow?.webid).toBeNull(); // A's write was no-op

    // worker-B's markDone succeeds
    await freshStore.markDone(
      "https://full-lifecycle.example/card",
      { state: "done", httpStatus: 200, webid: "https://real.example/#me" },
      tokenB
    );

    const finalRow = await freshStore.get(
      "https://full-lifecycle.example/card"
    );
    expect(finalRow?.state).toBe("done");
    expect(finalRow?.claimToken).toBeNull();
    expect(finalRow?.claimedAt).toBeNull();
    expect(finalRow?.webid).toBe("https://real.example/#me"); // B's write succeeded
  });

  it("markDone() with the CORRECT token succeeds and clears the lease", async () => {
    const { store: freshStore } = await makeTestStore();

    await freshStore.enqueue("https://correct-token.example/card");
    const claimed = await freshStore.claim("worker-correct", 8);
    expect(claimed).toHaveLength(1);
    // Token is a UUID returned by claim(), not the workerId
    const token = claimed[0].claimToken as string;
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    await expect(
      freshStore.markDone(
        "https://correct-token.example/card",
        { state: "done", httpStatus: 200, isSolid: true },
        token
      )
    ).resolves.toBeUndefined();

    const doc = await freshStore.get("https://correct-token.example/card");
    expect(doc?.state).toBe("done");
    expect(doc?.claimToken).toBeNull();
    expect(doc?.claimedAt).toBeNull();
    expect(doc?.isSolid).toBe(true);
  });

  // ─── Due-recrawl eligibility tests (roborev MEDIUM fix) ──────────────────

  it("claim() — a due 'done' row (next_eligible_at in the past) IS re-claimable", async () => {
    const { store: freshStore } = await makeTestStore();

    await freshStore.enqueue("https://due-recrawl.example/card");

    // First worker claims + marks done with next_eligible_at in the past
    const firstClaimed = await freshStore.claim("worker-initial", 8);
    expect(firstClaimed).toHaveLength(1);
    const firstToken = firstClaimed[0].claimToken as string;

    await freshStore.markDone(
      "https://due-recrawl.example/card",
      {
        state: "done",
        httpStatus: 200,
        nextEligibleAt: Date.now() - 1, // already due
      },
      firstToken
    );

    const afterDone = await freshStore.get("https://due-recrawl.example/card");
    expect(afterDone?.state).toBe("done");

    // A new worker should be able to claim the due-done row
    const reclaimed = await freshStore.claim("worker-recrawl", 8);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].docUrl).toBe("https://due-recrawl.example/card");
    // Token is a UUID, not the workerId
    expect(reclaimed[0].claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(reclaimed[0].state).toBe("claimed");
  });

  it("claim() — a due 'failed' row (next_eligible_at in the past) IS re-claimable", async () => {
    const { store: freshStore } = await makeTestStore();

    await freshStore.enqueue("https://due-failed.example/card");

    // Directly set the row to 'failed' with a past next_eligible_at via put()
    const doc = await freshStore.get("https://due-failed.example/card");
    // doc is always set — just enqueued above; cast to narrow the type
    const docRecord = doc as NonNullable<typeof doc>;
    await freshStore.put({
      ...docRecord,
      state: "failed",
      failClass: "transient",
      nextEligibleAt: Date.now() - 1, // already due
    });

    // A worker should be able to claim the due-failed row
    const claimed = await freshStore.claim("worker-failed-recrawl", 8);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].docUrl).toBe("https://due-failed.example/card");
    // Token is a UUID, not the workerId
    expect(claimed[0].claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("claim() — a not-yet-due 'done' row is NOT claimed", async () => {
    const { store: freshStore } = await makeTestStore();

    await freshStore.enqueue("https://not-yet-due.example/card");
    const firstClaimed = await freshStore.claim("worker-initial-nd", 8);
    expect(firstClaimed).toHaveLength(1);
    const firstToken = firstClaimed[0].claimToken as string;

    // Mark done with next_eligible_at far in the future
    await freshStore.markDone(
      "https://not-yet-due.example/card",
      {
        state: "done",
        httpStatus: 200,
        nextEligibleAt: Date.now() + 14 * 24 * 60 * 60 * 1000, // 14 days from now
      },
      firstToken
    );

    // No worker should claim it — it's not due yet
    const notClaimed = await freshStore.claim("worker-should-not-get", 8);
    expect(notClaimed).toHaveLength(0);
  });

  // ─── shared suggest budget (anti-amplification C2) ───────────────────────────

  it("enqueue() seeds a shared suggest_budget row keyed on rootSeed", async () => {
    const { store } = await makeTestStore();
    await store.enqueue("https://root.example/card", {
      source: "inbox",
      rootSeed: "https://root.example/card",
      suggestBudget: 3,
    });
    // Three consumptions succeed, the fourth is refused — the budget is shared + finite.
    expect(
      await store.tryConsumeSuggestBudget("https://root.example/card")
    ).toBe(true);
    expect(
      await store.tryConsumeSuggestBudget("https://root.example/card")
    ).toBe(true);
    expect(
      await store.tryConsumeSuggestBudget("https://root.example/card")
    ).toBe(true);
    expect(
      await store.tryConsumeSuggestBudget("https://root.example/card")
    ).toBe(false);
  });

  it("tryConsumeSuggestBudget() returns false for a root with no budget row", async () => {
    const { store } = await makeTestStore();
    expect(
      await store.tryConsumeSuggestBudget("https://unknown.example/card")
    ).toBe(false);
  });

  it("enqueue() does NOT reset a partially-spent shared budget on re-enqueue", async () => {
    const { store } = await makeTestStore();
    await store.enqueue("https://re.example/card", {
      source: "inbox",
      rootSeed: "https://re.example/card",
      suggestBudget: 2,
    });
    expect(await store.tryConsumeSuggestBudget("https://re.example/card")).toBe(
      true
    );
    // Re-enqueue with the same root + budget must NOT reset remaining (ON CONFLICT DO NOTHING).
    await store.enqueue("https://re.example/card", {
      source: "inbox",
      rootSeed: "https://re.example/card",
      suggestBudget: 2,
    });
    // Only one slot remains.
    expect(await store.tryConsumeSuggestBudget("https://re.example/card")).toBe(
      true
    );
    expect(await store.tryConsumeSuggestBudget("https://re.example/card")).toBe(
      false
    );
  });

  // ─── live frontier count (FRONTIER_CAP enforcement) ──────────────────────────

  it("countFrontier() counts pending AND claimed rows (not just pending)", async () => {
    const { store } = await makeTestStore();
    await store.enqueue("https://f1.example/card");
    await store.enqueue("https://f2.example/card");
    await store.enqueue("https://f3.example/card");
    expect(await store.countFrontier()).toBe(3);

    // Claim one row → it moves pending → claimed. A pending-only count would drop to 2; the LIVE
    // frontier count must STILL be 3 because a claimed row is in-flight, part of the frontier.
    const claimed = await store.claim("worker-frontier", 1);
    expect(claimed).toHaveLength(1);
    expect(await store.countFrontier()).toBe(3);
  });

  it("countFrontier() excludes terminal states (done/skipped/tombstone)", async () => {
    const { store } = await makeTestStore();
    await store.enqueue("https://done.example/card");
    const claimed = await store.claim("worker-term", 1);
    await store.markDone(
      "https://done.example/card",
      { state: "done", httpStatus: 200, nextEligibleAt: Date.now() + 1e12 },
      claimed[0].claimToken as string
    );
    await store.enqueue("https://pending.example/card");
    // Only the still-pending row counts toward the live frontier.
    expect(await store.countFrontier()).toBe(1);
  });
});

// ─── roborev finding tests ────────────────────────────────────────────────────
// These tests directly cover the four HIGH/MEDIUM/LOW findings addressed by
// "fix(store): address roborev (require-in-ESM HIGH, search fallback, markDone, migrate)".

describe("roborev fix 1 — no require() in ESM (createNeonExecutor)", () => {
  it("createNeonExecutor is importable as an ESM module (no require())", async () => {
    // The HIGH finding was require("@neondatabase/serverless") inside an ESM module.
    // Verify the fix: createNeonExecutor must be importable without a ReferenceError
    // on require — if require() were present, the dynamic import would throw in an
    // ESM context.  The factory itself (before any query) must not throw.
    const { createNeonExecutor: importedFactory } = await import(
      "./pgStore.js"
    );
    // Constructing an executor must not invoke require() — it only calls neon()
    // lazily on first query.  We never make a query here, so this is safe.
    expect(() =>
      importedFactory("postgresql://test:test@localhost/test")
    ).not.toThrow();
  });

  it("pgStore.ts has a top-level ESM import for neon (no require)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/lib/store/pgStore.ts"),
      "utf-8"
    );
    // Must have a top-level ESM import for neon at the module level
    expect(src).toMatch(
      /^import\s*\{[^}]*neon[^}]*\}\s*from\s*["']@neondatabase\/serverless["']/m
    );
    // Must NOT have require("@neondatabase/serverless") as executable code.
    // We check lines that are not inside block-comment or line-comment context
    // by verifying the pattern only matches when preceded by clear require syntax.
    // The simplest reliable check: the string require("@neondatabase must not appear.
    expect(src).not.toContain('require("@neondatabase');
    expect(src).not.toContain("require('@neondatabase");
  });
});

describe("roborev fix 2 — search() non-FTS errors are not swallowed", () => {
  it("a non-FTS executor error propagates out of search() unchanged", async () => {
    // Build a mock executor whose query() always throws a non-FTS error.
    // This simulates a connection or schema error that must not be masked.
    const connectionError = new Error("connection refused");

    const mockExecutor = {
      query: vi.fn().mockRejectedValue(connectionError),
      exec: vi.fn().mockResolvedValue(undefined),
    };

    const store = new PgStore(mockExecutor);

    // search() must rethrow the connection error, not silently fall back.
    await expect(store.search({ query: "alice", limit: 10 })).rejects.toThrow(
      "connection refused"
    );
  });

  it("search() falls back to plainto_tsquery only when websearch_to_tsquery is absent", async () => {
    // Simulate an error that looks like 'websearch_to_tsquery does not exist'
    // (what pglite / older Postgres returns for undefined function).
    const undefinedFnError = new Error(
      "function websearch_to_tsquery(unknown, unknown) does not exist"
    );
    (undefinedFnError as Error & { code?: string }).code = "42883";

    let callCount = 0;
    const mockExecutor = {
      query: vi.fn().mockImplementation((text: string) => {
        callCount++;
        if (callCount === 1 && text.includes("websearch_to_tsquery")) {
          // First call (websearch path) fails with undefined_function
          return Promise.reject(undefinedFnError);
        }
        // Second call (plainto fallback) succeeds with empty rows
        return Promise.resolve([]);
      }),
      exec: vi.fn().mockResolvedValue(undefined),
    };

    const store = new PgStore(mockExecutor);
    // Should not throw — the fallback path handles the undefined_function error.
    const result = await store.search({ query: "alice", limit: 10 });
    expect(result.rows).toHaveLength(0);
    expect(callCount).toBe(2); // websearch attempted, then plainto fallback
  });
});

describe("roborev fix 3 — markDone() throws on unknown docUrl", () => {
  it("markDone() throws when the URL was never enqueued", async () => {
    const { store } = await makeTestStore();

    // Calling markDone() on a URL with no row must throw rather than silently no-op.
    await expect(
      store.markDone("https://never-enqueued.example/card", { state: "done" })
    ).rejects.toThrow(/no row found.*never-enqueued\.example/i);
  });

  it("markDone() succeeds when the URL was previously enqueued", async () => {
    const { store } = await makeTestStore();

    await store.enqueue("https://known.example/card");
    // Must not throw
    await expect(
      store.markDone("https://known.example/card", {
        state: "done",
        httpStatus: 200,
      })
    ).resolves.toBeUndefined();

    const doc = await store.get("https://known.example/card");
    expect(doc?.state).toBe("done" satisfies DocState);
  });
});

describe("roborev fix 4 — migrate() multi-statement and idempotency", () => {
  it("migrate() applies schema cleanly via exec() (no manual splitting)", async () => {
    const db = new PGlite();
    const executor = createPgliteExecutor(db);
    const store = new PgStore(executor);
    await expect(store.migrate()).resolves.toBeUndefined();
    // Verify the doc table exists by inserting a row
    const { rows } = await db.query<{ doc_url: string }>(
      "SELECT doc_url FROM doc LIMIT 1"
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  it("migrate() is idempotent — running it three times does not error", async () => {
    const db = new PGlite();
    const executor = createPgliteExecutor(db);
    const store = new PgStore(executor);
    await store.migrate();
    await store.migrate();
    await expect(store.migrate()).resolves.toBeUndefined();
  });
});

describe("splitSqlStatements() — robustness", () => {
  it("splits simple DDL statements on semicolons", () => {
    const sql = "CREATE TABLE a (id INT); CREATE TABLE b (id INT);";
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe("CREATE TABLE a (id INT)");
    expect(stmts[1]).toBe("CREATE TABLE b (id INT)");
  });

  it("does not split on a semicolon inside a string literal", () => {
    const sql = `INSERT INTO t VALUES ('val;ue'); SELECT 1;`;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe(`INSERT INTO t VALUES ('val;ue')`);
    expect(stmts[1]).toBe("SELECT 1");
  });

  it("does not split on a semicolon in a double-quoted identifier", () => {
    const sql = `SELECT "col;name" FROM t; SELECT 2;`;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe(`SELECT "col;name" FROM t`);
    expect(stmts[1]).toBe("SELECT 2");
  });

  it("strips line comments (-- …) without breaking adjacent statements", () => {
    const sql =
      "-- comment\nCREATE TABLE x (id INT); -- inline\nCREATE TABLE y (id INT);";
    const stmts = splitSqlStatements(sql);
    // Both real statements must be present; comment text must not appear
    expect(stmts.some((s) => s.includes("CREATE TABLE x"))).toBe(true);
    expect(stmts.some((s) => s.includes("CREATE TABLE y"))).toBe(true);
    expect(stmts.every((s) => !s.includes("-- comment"))).toBe(true);
  });

  it("strips block comments /* … */ without breaking adjacent statements", () => {
    const sql = "/* header */\nCREATE TABLE z (id INT /* col comment */);";
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/CREATE TABLE z/);
    expect(stmts[0]).not.toMatch(/\/\*/);
  });

  it("handles escaped single-quotes ('') inside string literals", () => {
    const sql = `INSERT INTO t VALUES ('it''s a test; check'); SELECT 1;`;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("it''s a test; check");
  });

  it("returns an empty array for a blank / comment-only script", () => {
    const sql = "-- nothing here\n/* block */\n  \n";
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(0);
  });

  it("does not split on a semicolon inside a $$ dollar-quoted body", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1;";
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("$$ BEGIN; RETURN 1; END; $$");
    expect(stmts[1]).toBe("SELECT 1");
  });

  it("handles tagged dollar-quotes ($tag$ … $tag$)", () => {
    const sql = "DO $body$ BEGIN; PERFORM 1; END $body$; SELECT 2;";
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("$body$ BEGIN; PERFORM 1; END $body$");
    expect(stmts[1]).toBe("SELECT 2");
  });

  it("does not treat $1 parameter placeholders as dollar-quotes", () => {
    const sql = "UPDATE t SET a=$1 WHERE id=$2; SELECT 3;";
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toBe("UPDATE t SET a=$1 WHERE id=$2");
    expect(stmts[1]).toBe("SELECT 3");
  });
});

describe("PgStore — PolitenessStore", () => {
  it("returns a zeroed default for an unknown host (immediately fetchable)", async () => {
    const { store } = await makeTestStore();
    const s = await store.getHostState("unknown.example");
    expect(s).toEqual({
      host: "unknown.example",
      nextAllowedAt: 0,
      consecutiveErrors: 0,
    });
  });

  it("stamps and reads back next_allowed_at + consecutive_errors (upsert)", async () => {
    const { store } = await makeTestStore();
    await store.stampHost("alice.example", 5000, 2);
    let s = await store.getHostState("alice.example");
    expect(s.nextAllowedAt).toBe(5000);
    expect(s.consecutiveErrors).toBe(2);

    // Upsert overwrites in place (no duplicate row).
    await store.stampHost("alice.example", 9000, 0);
    s = await store.getHostState("alice.example");
    expect(s.nextAllowedAt).toBe(9000);
    expect(s.consecutiveErrors).toBe(0);
  });
});
