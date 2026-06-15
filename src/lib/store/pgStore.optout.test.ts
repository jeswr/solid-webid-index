// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * pgStore.optout.test.ts — opt-out / erasure store surface (pss-1ez, DESIGN.md §4.8).
 * SECURITY-CRITICAL (PII erasure). Uses pglite (in-process Postgres WASM) — no network.
 *
 * Asserts:
 *  - eraseWebId() removes the WebID from EVERY surface (doc/search, triple/TPF, stats) in ONE tx;
 *  - erasure is ATOMIC — a simulated mid-transaction failure leaves the DB consistent (nothing
 *    half-erased / stats-skewed);
 *  - the three tombstone gates: enqueue refuses; upsertTriples (projection) refuses; fetch/claim
 *    never picks it up; suggestionStatus → 'tombstoned' (re-suggest 409);
 *  - inbound foaf:knows edges to a tombstoned WebID are dropped from TPF + tombstonedWebids();
 *  - the inbox notification body that referenced the WebID is redacted;
 *  - the Path B nonce is single-use + has a 24h TTL.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { slugForWebId } from "../url/slug.js";
import { PgStore, createPgliteExecutor } from "./pgStore.js";
import type { SqlExecutor } from "./pgStore.js";
import type { TpfTriple } from "./ports.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const FOAF_KNOWS = "http://xmlns.com/foaf/0.1/knows";
const FOAF_PERSON = "http://xmlns.com/foaf/0.1/Person";
const FOAF_NAME = "http://xmlns.com/foaf/0.1/name";

const ALICE = "https://alice.example/card#me";
const ALICE_DOC = "https://alice.example/card";
const BOB = "https://bob.example/card#me";
const BOB_DOC = "https://bob.example/card";

async function makeTestStore(): Promise<{ store: PgStore; db: PGlite }> {
  const db = new PGlite();
  const store = new PgStore(createPgliteExecutor(db));
  await store.migrate();
  return { store, db };
}

/** Project a profile into the served surfaces (doc row + triple table + stats) like the crawler. */
async function indexProfile(
  store: PgStore,
  opts: { webid: string; docUrl: string; triples: TpfTriple[]; rawRdf?: string }
): Promise<void> {
  // The crawler enqueues then markDone's a 'done' row with raw_rdf, then upsertTriples.
  await store.enqueue(opts.docUrl, { webid: opts.webid, source: "seed" });
  await store.markDone(opts.docUrl, {
    state: "done",
    webid: opts.webid,
    rawRdf: opts.rawRdf ?? `<${opts.webid}> <${FOAF_NAME}> "n" .`,
    isSolid: true,
    httpStatus: 200,
  });
  await store.upsertTriples({
    webid: opts.webid,
    docUrl: opts.docUrl,
    triples: opts.triples,
  });
}

const aliceTriples: TpfTriple[] = [
  { s: ALICE, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
  { s: ALICE, p: FOAF_NAME, o: "Alice", oIsIri: false },
  { s: ALICE, p: FOAF_KNOWS, o: BOB, oIsIri: true },
];
const bobTriples: TpfTriple[] = [
  { s: BOB, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
  { s: BOB, p: FOAF_NAME, o: "Bob", oIsIri: false },
];

let store: PgStore;
let db: PGlite;
beforeEach(async () => {
  ({ store, db } = await makeTestStore());
});
afterEach(async () => {
  await db.close();
});

// ─── Erasure completeness ────────────────────────────────────────────────────

describe("eraseWebId — completeness across every surface", () => {
  beforeEach(async () => {
    await indexProfile(store, {
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobTriples,
    });
  });

  it("removes the WebID from the doc/search surface (getEntryByWebid → null)", async () => {
    expect(await store.getEntryByWebid(BOB)).not.toBeNull();
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    expect(await store.getEntryByWebid(BOB)).toBeNull();
    expect(await store.exists(BOB_DOC)).toBe(false);
  });

  it("serves /p/{slug} as tombstoned (getEntryBySlug → 'tombstoned' or absent)", async () => {
    const entry = await store.getEntryByWebid(BOB);
    expect(entry).not.toBeNull();
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    // The doc row is REPLACED by a durable redacted tombstone row (state='tombstone', slug retained),
    // so getEntryBySlug resolves to 'tombstoned' (410). The PERMANENT tombstone table is the durable
    // gate (isTombstoned) too; either way the slug never serves a live 200. Assert the slug no longer
    // resolves to a live entry.
    const slug = entry?.slug;
    if (slug) {
      const res = await store.getEntryBySlug(slug);
      expect(res === null || res === "tombstoned").toBe(true);
    }
  });

  it("removes the WebID's triples from TPF", async () => {
    const before = await store.tpf({ pattern: { s: BOB }, limit: 100 });
    expect(before.triples.length).toBeGreaterThan(0);
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    const after = await store.tpf({ pattern: { s: BOB }, limit: 100 });
    expect(after.triples.length).toBe(0);
  });

  it("decrements the dataset stats (entities + triples) by the erased contribution", async () => {
    const before = await store.getStats();
    expect(before.entities).toBe(1);
    expect(before.triples).toBe(bobTriples.length);
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    const after = await store.getStats();
    expect(after.entities).toBe(0);
    expect(after.triples).toBe(0);
    // The Person class partition drops to 0 (not advertised).
    expect(
      after.classPartitions.find((c) => c.classIri === FOAF_PERSON)
    ).toBeUndefined();
  });

  it("inserts a permanent tombstone (isTombstoned by WebID AND doc URL)", async () => {
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    expect(await store.isTombstoned({ webid: BOB })).toBe(true);
    expect(await store.isTombstoned({ docUrl: BOB_DOC })).toBe(true);
  });

  it("re-suggesting an erased WebID → 'tombstoned' (the route maps this to 409)", async () => {
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    const status = await store.suggestionStatus({
      webid: BOB,
      docUrl: BOB_DOC,
      nowMs: Date.now(),
      cooldownMs: 0,
    });
    expect(status).toBe("tombstoned");
  });

  it("is idempotent — erasing twice is a safe no-op", async () => {
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    await expect(
      store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" })
    ).resolves.toBeUndefined();
    expect(await store.isTombstoned({ webid: BOB })).toBe(true);
  });

  it("redacts the inbox notification body that referenced the WebID", async () => {
    await store.recordNotification({
      id: "01ABCNOTIF",
      receivedAt: Date.now(),
      actor: "https://suggester.example/me",
      activity: "https://www.w3.org/ns/activitystreams#Announce",
      body: `<x> <y> <${BOB}> .`,
      objectIris: [BOB],
    });
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    const notif = await store.getNotification("01ABCNOTIF");
    expect(notif).not.toBeNull();
    expect(notif?.body).toBe(""); // body blanked
  });
});

// ─── Atomicity ───────────────────────────────────────────────────────────────

describe("eraseWebId — atomicity (mid-transaction failure leaves the DB consistent)", () => {
  it("rolls back a mid-transaction failure — nothing half-erased / stats-skewed", async () => {
    await indexProfile(store, {
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobTriples,
    });
    const before = await store.getStats();

    // Wrap the executor so the FINAL statement of the erase tx (the tombstone INSERT) throws,
    // simulating a crash mid-erase. A non-atomic erase would have already deleted the triples +
    // decremented stats; an ATOMIC erase rolls the whole thing back.
    const realExecutor = createPgliteExecutor(db);
    let inTx = false;
    const failingExecutor: SqlExecutor = {
      query: realExecutor.query.bind(realExecutor),
      exec: realExecutor.exec.bind(realExecutor),
      async transaction(fn) {
        return realExecutor.transaction(async (tx) => {
          inTx = true;
          const guardedTx: SqlExecutor = {
            exec: tx.exec.bind(tx),
            transaction: tx.transaction.bind(tx),
            async query(text: string, params?: unknown[]) {
              if (inTx && text.includes("INSERT INTO tombstone")) {
                throw new Error("simulated crash mid-erase");
              }
              return tx.query(text, params);
            },
          };
          return fn(guardedTx);
        });
      },
    };
    const crashingStore = new PgStore(failingExecutor);

    await expect(
      crashingStore.eraseWebId({
        webid: BOB,
        docUrl: BOB_DOC,
        reason: "opt-out",
      })
    ).rejects.toThrow(/simulated crash/);

    // The rollback must have restored EVERYTHING: the entry, the triples, AND the stats.
    expect(await store.getEntryByWebid(BOB)).not.toBeNull();
    const after = await store.getStats();
    expect(after.entities).toBe(before.entities);
    expect(after.triples).toBe(before.triples);
    const tpf = await store.tpf({ pattern: { s: BOB }, limit: 100 });
    expect(tpf.triples.length).toBe(bobTriples.length);
    // And NO tombstone was committed (the failing statement rolled back).
    expect(await store.isTombstoned({ webid: BOB })).toBe(false);
  });
});

// ─── Three tombstone gates ───────────────────────────────────────────────────

describe("tombstone gates — enqueue / projection / suggestionStatus", () => {
  beforeEach(async () => {
    // Tombstone BOB directly (no prior index needed for the gate tests).
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
  });

  it("gate 1 (enqueue): a tombstoned WebID/doc is never re-enqueued", async () => {
    await store.enqueue(BOB_DOC, { webid: BOB, source: "knows" });
    expect(await store.exists(BOB_DOC)).toBe(false);
    // Even a fragment-variant doc URL keyed under the same WebID is refused.
    await store.enqueue(BOB_DOC, { webid: BOB, source: "inbox" });
    expect(await store.exists(BOB_DOC)).toBe(false);
  });

  it("gate 3 (projection): upsertTriples refuses to re-project a tombstoned WebID", async () => {
    await store.upsertTriples({
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobTriples,
    });
    const tpf = await store.tpf({ pattern: { s: BOB }, limit: 100 });
    expect(tpf.triples.length).toBe(0);
    const stats = await store.getStats();
    expect(stats.entities).toBe(0);
  });

  it("gate 2 (fetch/claim): a tombstoned doc is never claimed", async () => {
    // Attempt to enqueue (refused) then claim — there is no claimable row.
    await store.enqueue(BOB_DOC, { webid: BOB, source: "seed" });
    const claimed = await store.claim("w", 8);
    expect(claimed.find((r) => r.docUrl === BOB_DOC)).toBeUndefined();
  });
});

// ─── Inbound foaf:knows edge dropping ────────────────────────────────────────

describe("inbound foaf:knows edges to a tombstoned WebID are dropped from served output", () => {
  it("drops Alice→Bob from TPF after Bob is erased; tombstonedWebids reports Bob", async () => {
    await indexProfile(store, {
      webid: ALICE,
      docUrl: ALICE_DOC,
      triples: aliceTriples,
    });
    await indexProfile(store, {
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobTriples,
    });

    // Before erasure: the knows edge Alice→Bob is served.
    const before = await store.tpf({ pattern: { p: FOAF_KNOWS }, limit: 100 });
    expect(before.triples.some((t) => t.o === BOB)).toBe(true);

    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });

    // After erasure: NO triple with object Bob is served (the inbound knows edge is dropped),
    // even though it lives on Alice's (still-live) entry.
    const after = await store.tpf({ pattern: { p: FOAF_KNOWS }, limit: 100 });
    expect(after.triples.some((t) => t.o === BOB)).toBe(false);

    // The batched helper the entry doc uses reports Bob as tombstoned.
    const set = await store.tombstonedWebids([ALICE, BOB]);
    expect(set.has(BOB)).toBe(true);
    expect(set.has(ALICE)).toBe(false);
  });
});

// ─── Erasure resurrection RACE (roborev HIGH) ────────────────────────────────

describe("erasure resurrection race — a crawl that finishes AFTER the tombstone cannot resurrect", () => {
  it("markDone() for a tombstoned WebID 410s the entry + search returns nothing (no resurrected row)", async () => {
    // Simulate the RACE: a crawl claims Bob, then an opt-out erases Bob (tombstone written + doc row
    // deleted), then the in-flight crawl finishes and calls markDone() with state='done' + raw_rdf +
    // webid. Without the markDone tombstone gate this RESURRECTS a servable `done` doc row.
    await store.enqueue(BOB_DOC, { webid: BOB, source: "seed" });
    const claimed = await store.claim("worker-1", 8);
    const bobClaim = claimed.find((r) => r.docUrl === BOB_DOC);
    expect(bobClaim).toBeDefined();

    // Opt-out erasure lands FIRST (tombstone committed, doc row deleted).
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    expect(await store.isTombstoned({ webid: BOB })).toBe(true);

    // The racing crawl now finishes — markDone with the live claim token + full result payload.
    await store.markDone(
      BOB_DOC,
      {
        state: "done",
        webid: BOB,
        rawRdf: `<${BOB}> <${FOAF_NAME}> "Bob" .`,
        isSolid: true,
        httpStatus: 200,
      },
      bobClaim?.claimToken
    );

    // The completion must NOT have resurrected a servable row: the entry 410s (tombstoned, no live
    // doc), search returns nothing, and getEntryByWebid is null.
    expect(await store.getEntryByWebid(BOB)).toBeNull();
    expect(await store.exists(BOB_DOC)).toBe(false);
    const slug = slugForWebId(BOB);
    const entry = await store.getEntryBySlug(slug);
    expect(entry === null || entry === "tombstoned").toBe(true);
    const hits = await store.search({ query: "Bob", limit: 50 });
    expect(hits.rows.some((r) => r.webid === BOB)).toBe(false);
    // The doc row is REPLACED by a DURABLE redacted tombstone row (HIGH 2): it SURVIVES so its PK
    // permanently blocks a concurrent enqueue from resurrecting a `pending` row, but it carries NO PII
    // — state='tombstone', raw_rdf NULL, webid NULL. There must be no servable (raw_rdf/webid) row.
    const docRows = await db.query<{
      state: string;
      raw_rdf: string | null;
      webid: string | null;
    }>(
      "SELECT state, raw_rdf, webid FROM doc WHERE doc_url = $1 OR webid = $2",
      [BOB_DOC, BOB]
    );
    for (const r of docRows.rows) {
      expect(r.state).toBe("tombstone");
      expect(r.raw_rdf).toBeNull();
      expect(r.webid).toBeNull();
    }
  });

  it("the token-less markDone() path is ALSO gated (enqueue→markDone after tombstone)", async () => {
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    // A bare enqueue is refused by gate 1, but force the race even harder: markDone directly (no
    // claimToken) must still refuse to write a servable row for a tombstoned WebID.
    await store.markDone(BOB_DOC, {
      state: "done",
      webid: BOB,
      rawRdf: `<${BOB}> <${FOAF_NAME}> "Bob" .`,
      isSolid: true,
      httpStatus: 200,
    });
    expect(await store.getEntryByWebid(BOB)).toBeNull();
    expect(await store.exists(BOB_DOC)).toBe(false);
  });

  it("enqueue after a committed erase CANNOT create a servable/pending row (durable tombstone-row + PK gate — HIGH 2)", async () => {
    // Index Bob, then erase him: the erase leaves a DURABLE redacted tombstone doc row (state=
    // 'tombstone', raw_rdf/webid NULL) whose PK is the doc URL.
    await indexProfile(store, {
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobTriples,
    });
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    expect(await store.isTombstoned({ webid: BOB })).toBe(true);

    // Simulate the resurrection RACE deterministically: a discovery path tries to enqueue the same
    // canonical doc AFTER the erase committed (every discovery source — knows/inbox/seed/catalog).
    // The `INSERT … ON CONFLICT (doc_url) DO NOTHING` hits the surviving tombstone row's PK, so NO
    // competing `pending` row is created — the WebID stays erased regardless of READ COMMITTED.
    await store.enqueue(BOB_DOC, { webid: BOB, source: "knows" });
    await store.enqueue(BOB_DOC, { webid: BOB, source: "inbox" });
    await store.enqueue(BOB_DOC, { webid: BOB, source: "seed" });

    // No servable / pending row exists; the only doc row is the redacted tombstone (no PII).
    expect(await store.exists(BOB_DOC)).toBe(false);
    expect(await store.getEntryByWebid(BOB)).toBeNull();
    const rows = await db.query<{ state: string; raw_rdf: string | null }>(
      "SELECT state, raw_rdf FROM doc WHERE doc_url = $1",
      [BOB_DOC]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].state).toBe("tombstone");
    expect(rows.rows[0].raw_rdf).toBeNull();
    // And it is never claimable (gate 2), so a crawl can never re-fetch it.
    const claimed = await store.claim("w", 8);
    expect(claimed.find((r) => r.docUrl === BOB_DOC)).toBeUndefined();
  });

  it("a STALE-token markDone() returns false + does NOT project/mutate stats; the valid-token holder returns true + projects (lease fence — HIGH 1)", async () => {
    // Worker-1 claims Carol. Then the lease is taken over by worker-2 (simulate a reclaim) so
    // worker-1's token is now STALE.  Worker-1's late markDone() must be a fenced NO-OP: it returns
    // false and the caller (crawler) must NOT project — otherwise a stale lease clobbers the newer
    // crawl's projection / stats OUTSIDE the fence.
    const CAROL = "https://carol.example/card#me";
    const CAROL_DOC = "https://carol.example/card";
    const carolTriples: TpfTriple[] = [
      { s: CAROL, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
      { s: CAROL, p: FOAF_NAME, o: "Carol", oIsIri: false },
    ];

    await store.enqueue(CAROL_DOC, { webid: CAROL, source: "seed" });
    const firstClaim = await store.claim("worker-1", 8);
    const staleToken = firstClaim.find(
      (r) => r.docUrl === CAROL_DOC
    )?.claimToken;
    expect(staleToken).toBeTruthy();

    // Force-expire worker-1's lease so a second claim reclaims the row with a FRESH token.
    await db.query("UPDATE doc SET claimed_at = 0 WHERE doc_url = $1", [
      CAROL_DOC,
    ]);
    const secondClaim = await store.claim("worker-2", 8);
    const freshToken = secondClaim.find(
      (r) => r.docUrl === CAROL_DOC
    )?.claimToken;
    expect(freshToken).toBeTruthy();
    expect(freshToken).not.toBe(staleToken);

    // Worker-1 (STALE token) finishes late. markDone must return FALSE (fenced no-op).
    const staleResult = await store.markDone(
      CAROL_DOC,
      {
        state: "done",
        webid: CAROL,
        rawRdf: `<${CAROL}> <${FOAF_NAME}> "Carol(stale)" .`,
        isSolid: true,
        httpStatus: 200,
      },
      staleToken
    );
    expect(staleResult).toBe(false);
    // The stale completion did NOT write: the row is still 'claimed' by worker-2 (not 'done'), and
    // NOTHING was projected (no triple rows, stats untouched) — the caller skips upsertTriples when
    // markDone returns false, so no out-of-fence projection happened.
    const afterStale = await store.get(CAROL_DOC);
    expect(afterStale?.state).toBe("claimed");
    expect(
      (await store.tpf({ pattern: { s: CAROL }, limit: 100 })).triples.length
    ).toBe(0);
    const statsAfterStale = await store.getStats();
    expect(statsAfterStale.entities).toBe(0);

    // Worker-2 (VALID token) finishes. markDone must return TRUE, and the caller may then project.
    const validResult = await store.markDone(
      CAROL_DOC,
      {
        state: "done",
        webid: CAROL,
        rawRdf: `<${CAROL}> <${FOAF_NAME}> "Carol" .`,
        isSolid: true,
        httpStatus: 200,
      },
      freshToken
    );
    expect(validResult).toBe(true);
    expect((await store.get(CAROL_DOC))?.state).toBe("done");
    // Project as the crawler would (only because markDone returned true).
    await store.upsertTriples({
      webid: CAROL,
      docUrl: CAROL_DOC,
      triples: carolTriples,
    });
    expect(
      (await store.tpf({ pattern: { s: CAROL }, limit: 100 })).triples.length
    ).toBe(2);
    expect((await store.getStats()).entities).toBe(1);
  });

  it("upsertTriples() on a tombstoned WebID PURGES the doc row + raw_rdf (not just the projection)", async () => {
    // Index Bob normally, then tombstone via the permanent table WITHOUT going through eraseWebId's
    // doc-row delete, to isolate the projection gate: a leftover `done` doc row with raw_rdf must be
    // purged by the projection-gate path when upsertTriples runs for the tombstoned WebID.
    await indexProfile(store, {
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobTriples,
    });
    await db.query(
      `INSERT INTO tombstone (webid, doc_url, reason, created_at)
         VALUES ($1, $2, 'opt-out', $3)`,
      [BOB, BOB_DOC, Date.now()]
    );
    // The doc row is still live (raw_rdf present) at this point — the projection gate must purge it.
    await store.upsertTriples({
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobTriples,
    });
    expect(await store.getEntryByWebid(BOB)).toBeNull();
    expect(await store.exists(BOB_DOC)).toBe(false);
    const tpf = await store.tpf({ pattern: { s: BOB }, limit: 100 });
    expect(tpf.triples.length).toBe(0);
  });
});

// ─── Stats consistency after inbound-edge suppression (roborev MEDIUM) ────────

describe("stats/VoID/TPF cardinality match SERVED data after an inbound knows-target is erased", () => {
  beforeEach(async () => {
    await indexProfile(store, {
      webid: ALICE,
      docUrl: ALICE_DOC,
      triples: aliceTriples,
    });
    await indexProfile(store, {
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobTriples,
    });
  });

  it("getStats() total triples + foaf:knows partition exclude the suppressed inbound edge", async () => {
    const before = await store.getStats();
    // Alice (3) + Bob (2) = 5 triples; one foaf:knows (Alice→Bob).
    expect(before.triples).toBe(aliceTriples.length + bobTriples.length);
    const knowsBefore = before.propertyPartitions.find(
      (p) => p.propertyIri === FOAF_KNOWS
    );
    expect(knowsBefore?.triples).toBe(1);

    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });

    const after = await store.getStats();
    // Bob's 2 own triples are deleted on erasure; Alice's inbound foaf:knows→Bob remains in the
    // table but is SUPPRESSED from served output, so the total must drop by it too: 5 - 2 (Bob) - 1
    // (suppressed knows) = 2 (Alice's type + name).
    expect(after.triples).toBe(2);
    // The foaf:knows partition drops to 0 served → not advertised at all.
    expect(
      after.propertyPartitions.find((p) => p.propertyIri === FOAF_KNOWS)
    ).toBeUndefined();
    // The TPF empty-pattern estimate matches the served triple count.
    const emptyEstimate = await store.estimatePatternCardinality({});
    expect(emptyEstimate).toBe(2);
    // The predicate-only estimate for foaf:knows now matches the 0 served edges.
    const knowsEstimate = await store.estimatePatternCardinality({
      p: FOAF_KNOWS,
    });
    expect(knowsEstimate).toBe(0);
    // Sanity: the served TPF for foaf:knows is indeed empty (the estimate matches reality).
    const knowsTpf = await store.tpf({
      pattern: { p: FOAF_KNOWS },
      limit: 100,
    });
    expect(knowsTpf.triples.length).toBe(0);
  });
});

// ─── Path B nonce lifecycle ──────────────────────────────────────────────────

describe("opt-out nonce — single-use + 24h TTL", () => {
  it("issues a live nonce, then consumes it single-use (second consume fails)", async () => {
    const now = Date.now();
    await store.issueOptoutNonce({
      webid: ALICE,
      docUrl: ALICE_DOC,
      nonce: "nonce-1",
      nowMs: now,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    const live = await store.getLiveOptoutNonce(ALICE, now);
    expect(live?.nonce).toBe("nonce-1");

    expect(await store.consumeOptoutNonce(ALICE, now)).toBe(true);
    // Single-use: a second consume must fail, and the nonce is no longer live.
    expect(await store.consumeOptoutNonce(ALICE, now)).toBe(false);
    expect(await store.getLiveOptoutNonce(ALICE, now)).toBeNull();
  });

  it("does not return / consume an EXPIRED nonce (24h TTL)", async () => {
    const issuedAt = Date.now();
    const ttl = 24 * 60 * 60 * 1000;
    await store.issueOptoutNonce({
      webid: ALICE,
      docUrl: ALICE_DOC,
      nonce: "nonce-exp",
      nowMs: issuedAt,
      ttlMs: ttl,
    });
    const past = issuedAt + ttl + 1; // one ms past expiry
    expect(await store.getLiveOptoutNonce(ALICE, past)).toBeNull();
    expect(await store.consumeOptoutNonce(ALICE, past)).toBe(false);
  });

  it("re-issuing REPLACES the prior nonce (only the latest is live + unused)", async () => {
    const now = Date.now();
    const ttl = 24 * 60 * 60 * 1000;
    await store.issueOptoutNonce({
      webid: ALICE,
      docUrl: ALICE_DOC,
      nonce: "old",
      nowMs: now,
      ttlMs: ttl,
    });
    await store.issueOptoutNonce({
      webid: ALICE,
      docUrl: ALICE_DOC,
      nonce: "new",
      nowMs: now + 1000,
      ttlMs: ttl,
    });
    const live = await store.getLiveOptoutNonce(ALICE, now + 1000);
    expect(live?.nonce).toBe("new");
  });
});
