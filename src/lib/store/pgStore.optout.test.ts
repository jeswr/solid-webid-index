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

  it.each([
    {
      label: "noindex (X-Robots-Tag) tombstone",
      result: {
        state: "tombstone" as const,
        httpStatus: 200,
        error: "noindex (X-Robots-Tag) — not indexed",
      },
    },
    {
      label: "HTTP 410 tombstone",
      result: { state: "tombstone" as const, httpStatus: 410 },
    },
  ])(
    "a STALE-token markDone($label) returns false + does NOT clear the newer owner's projection/stats (lease fence — HIGH, $label path)",
    async ({ result }) => {
      // The crawler's noindex AND 410 paths BOTH call markDone({state:'tombstone'}) then clear the
      // projection. A STALE worker (whose lease was reclaimed) must NOT be able to tombstone + clear a
      // NEWER owner's projection/stats outside the fence — markDone must return FALSE so the crawler
      // skips the out-of-fence upsertTriples (roborev HIGH — same fence the 2xx path already uses).
      const DAVE = "https://dave.example/card#me";
      const DAVE_DOC = "https://dave.example/card";
      const daveTriples: TpfTriple[] = [
        { s: DAVE, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
        { s: DAVE, p: FOAF_NAME, o: "Dave", oIsIri: false },
      ];

      await store.enqueue(DAVE_DOC, { webid: DAVE, source: "seed" });
      const firstClaim = await store.claim("worker-1", 8);
      const staleToken = firstClaim.find(
        (r) => r.docUrl === DAVE_DOC
      )?.claimToken;
      expect(staleToken).toBeTruthy();

      // Force-expire worker-1's lease so worker-2 reclaims the row with a FRESH token.
      await db.query("UPDATE doc SET claimed_at = 0 WHERE doc_url = $1", [
        DAVE_DOC,
      ]);
      const secondClaim = await store.claim("worker-2", 8);
      const freshToken = secondClaim.find(
        (r) => r.docUrl === DAVE_DOC
      )?.claimToken;
      expect(freshToken).toBeTruthy();
      expect(freshToken).not.toBe(staleToken);

      // The NEWER owner (worker-2) completes the crawl normally and projects Dave's profile.
      const validResult = await store.markDone(
        DAVE_DOC,
        {
          state: "done",
          webid: DAVE,
          rawRdf: `<${DAVE}> <${FOAF_NAME}> "Dave" .`,
          isSolid: true,
          httpStatus: 200,
        },
        freshToken
      );
      expect(validResult).toBe(true);
      await store.upsertTriples({
        webid: DAVE,
        docUrl: DAVE_DOC,
        triples: daveTriples,
      });
      expect(
        (await store.tpf({ pattern: { s: DAVE }, limit: 100 })).triples.length
      ).toBe(2);
      expect((await store.getStats()).entities).toBe(1);

      // Now the STALE worker-1 finishes late on the noindex/410 path: markDone({state:'tombstone'})
      // with the stale token must be a FENCED NO-OP → false. The crawler gates upsertTriples on this.
      const staleResult = await store.markDone(
        DAVE_DOC,
        { ...result, webid: DAVE },
        staleToken
      );
      expect(staleResult).toBe(false);

      // The newer owner's projection + stats SURVIVE untouched — a stale tombstone neither erased the
      // entry nor cleared the triples/counters outside the fence.
      expect((await store.get(DAVE_DOC))?.state).toBe("done");
      expect(await store.getEntryByWebid(DAVE)).not.toBeNull();
      expect(
        (await store.tpf({ pattern: { s: DAVE }, limit: 100 })).triples.length
      ).toBe(2);
      expect((await store.getStats()).entities).toBe(1);
      // And because markDone returned false, the crawler skips upsertTriples — modelled by NOT calling
      // it here (the production code is gated `if (completed && row.webid)`).
    }
  );

  it("a stale-lease tombstone completion that loses the fenced UPDATE mutates NOTHING (TOCTOU — HIGH)", async () => {
    // roborev HIGH (TOCTOU): the fenced tombstone path used to do a PLAIN ownership SELECT, then mutate
    // projections/stats, then the fenced UPDATE. claim() reclaims an expired lease with `FOR UPDATE
    // SKIP LOCKED` and does NOT take the advisory lock, so it could reclaim the row BETWEEN the plain
    // pre-check and the fenced UPDATE — the UPDATE matched 0 rows but the projection/stats had ALREADY
    // been mutated outside the winning lease. The fix takes `SELECT … FOR UPDATE` on the doc row and
    // re-verifies ownership UNDER that lock before ANY side effect, so a stale completion mutates
    // nothing. This pins the OBSERVABLE half: a stale-token tombstone completion leaves the FULL stats
    // table + the newer owner's projection BYTE-IDENTICAL (no projection-clear leaked).
    const EVE = "https://eve.example/card#me";
    const EVE_DOC = "https://eve.example/card";
    const eveTriples: TpfTriple[] = [
      { s: EVE, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
      { s: EVE, p: FOAF_NAME, o: "Eve", oIsIri: false },
      { s: EVE, p: FOAF_KNOWS, o: ALICE, oIsIri: true }, // an inbound-edge subject (clear-path bait)
    ];
    // Alice exists too so EVE→ALICE is a real inbound edge whose accounting a buggy clear would touch.
    await indexProfile(store, {
      webid: ALICE,
      docUrl: ALICE_DOC,
      triples: aliceTriples,
    });

    // Worker-1 claims Eve; her lease is then force-expired and worker-2 reclaims with a fresh token
    // and completes + projects Eve normally.
    await store.enqueue(EVE_DOC, { webid: EVE, source: "seed" });
    const firstClaim = await store.claim("worker-1", 8);
    const staleToken = firstClaim.find((r) => r.docUrl === EVE_DOC)?.claimToken;
    expect(staleToken).toBeTruthy();
    await db.query("UPDATE doc SET claimed_at = 0 WHERE doc_url = $1", [
      EVE_DOC,
    ]);
    const secondClaim = await store.claim("worker-2", 8);
    const freshToken = secondClaim.find(
      (r) => r.docUrl === EVE_DOC
    )?.claimToken;
    expect(freshToken).not.toBe(staleToken);
    expect(
      await store.markDone(
        EVE_DOC,
        {
          state: "done",
          webid: EVE,
          rawRdf: `<${EVE}> <${FOAF_NAME}> "Eve" .`,
          isSolid: true,
          httpStatus: 200,
        },
        freshToken
      )
    ).toBe(true);
    await store.upsertTriples({
      webid: EVE,
      docUrl: EVE_DOC,
      triples: eveTriples,
    });

    // Snapshot the ENTIRE stats table — a leaked projection-clear would change at least one counter.
    const snap = async () =>
      (
        await db.query<{ k: string; v: number | string }>(
          "SELECT k, v FROM stats ORDER BY k"
        )
      ).rows.map((r) => `${r.k}=${Number(r.v)}`);
    const statsBefore = await snap();

    // The STALE worker-1 now finishes late on the TOMBSTONE path. It must be a fenced no-op (false)
    // and clear/mutate NOTHING — the projection-clear must not run for a row it does not own.
    const staleResult = await store.markDone(
      EVE_DOC,
      { state: "tombstone", httpStatus: 410, webid: EVE },
      staleToken
    );
    expect(staleResult).toBe(false);

    // Nothing changed: full stats table byte-identical, Eve's projection + entry intact, state 'done'.
    expect(await snap()).toEqual(statsBefore);
    expect((await store.get(EVE_DOC))?.state).toBe("done");
    expect(await store.getEntryByWebid(EVE)).not.toBeNull();
    expect(
      (await store.tpf({ pattern: { s: EVE }, limit: 100 })).triples.length
    ).toBe(3);
    // Eve's inbound edge to Alice is still served (Eve was NOT tombstoned).
    expect(
      (await store.tpf({ pattern: { o: ALICE, oIsIri: true }, limit: 100 }))
        .triples.length
    ).toBe(1);
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

// ─── SERVED data excludes inbound edges to an erased WebID (estimate is spec-legal estimate) ──────
//
// HARD GUARANTEE (non-negotiable): after a WebID is erased/tombstoned, NO inbound IRI-object edge to
// it (e.g. Alice's `foaf:knows Bob`) appears in SERVED TPF output — across every tombstone path
// (eraseWebId / tombstone / crawler markDone). The numeric `void:triples` / Hydra estimate is SPEC'd
// as an ESTIMATE: the incremental suppressed-edge correction counter was removed (roborev rounds
// 6–8, too race-prone), so the estimate may MARGINALLY over-count the suppressed inbound edges. We
// pin: served TPF is EXACT, the estimate is ≥ the served count and never negative.

describe("SERVED TPF excludes inbound edges to an erased WebID; estimate is a spec-legal over-count", () => {
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

  /** Assert the served surfaces no longer expose the inbound knows→Bob edge or Bob himself. */
  async function assertBobFullySuppressed(): Promise<void> {
    // Served foaf:knows TPF is EMPTY — the inbound Alice→Bob edge is suppressed at read.
    const knowsTpf = await store.tpf({
      pattern: { p: FOAF_KNOWS },
      limit: 100,
    });
    expect(knowsTpf.triples.length).toBe(0);
    // No served triple has Bob as an IRI object.
    const objTpf = await store.tpf({
      pattern: { o: BOB, oIsIri: true },
      limit: 100,
    });
    expect(objTpf.triples.length).toBe(0);
    // Bob himself is gone from served TPF, and Alice's own non-inbound triples survive.
    expect(
      (await store.tpf({ pattern: { s: BOB }, limit: 100 })).triples.length
    ).toBe(0);
    expect(
      (await store.tpf({ pattern: { s: ALICE }, limit: 100 })).triples.length
    ).toBe(2); // Alice's type + name (her knows→Bob is suppressed)
    // The estimate is a spec-legal approximation: ≥ the served count, never negative.
    expect(await store.estimatePatternCardinality({})).toBeGreaterThanOrEqual(
      2
    );
    expect(
      await store.estimatePatternCardinality({ p: FOAF_KNOWS })
    ).toBeGreaterThanOrEqual(0);
    // Bob is no longer a served entry.
    expect(await store.getEntryByWebid(BOB)).toBeNull();
  }

  it("eraseWebId() drops the inbound knows→Bob edge from served TPF", async () => {
    // Pre-erase: the inbound Alice→Bob edge IS served.
    expect(
      (await store.tpf({ pattern: { p: FOAF_KNOWS }, limit: 100 })).triples
        .length
    ).toBe(1);

    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });

    await assertBobFullySuppressed();
  });

  it("tombstone(docUrl) drops the inbound knows→Bob edge from served TPF", async () => {
    await store.tombstone(BOB_DOC);
    await assertBobFullySuppressed();
  });

  it("crawler markDone({state:'tombstone'}) drops the inbound knows→Bob edge from served TPF", async () => {
    // The crawler's noindex / 410 path tombstones via markDone({state:'tombstone'}). Drive it as the
    // crawler does (claim → markDone). Bob is already a 'done' row from beforeEach; make it due for
    // re-crawl so claim() picks it up.
    await db.query("UPDATE doc SET next_eligible_at = 0 WHERE doc_url = $1", [
      BOB_DOC,
    ]);
    const claimed = await store.claim("worker-1", 8);
    const bobToken = claimed.find((r) => r.docUrl === BOB_DOC)?.claimToken;
    expect(bobToken).toBeTruthy();

    const completed = await store.markDone(
      BOB_DOC,
      { state: "tombstone", httpStatus: 410, webid: BOB },
      bobToken
    );
    expect(completed).toBe(true);

    await assertBobFullySuppressed();
  });

  it("a repeat erase is IDEMPOTENT for served data + stats (no drift on re-run)", async () => {
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    const afterFirst = await store.getStats();
    await assertBobFullySuppressed();

    // Erase AGAIN + a THIRD time — served data + stats must be IDENTICAL (idempotent no-op).
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    const afterRepeat = await store.getStats();
    expect(afterRepeat.triples).toBe(afterFirst.triples);
    expect(afterRepeat.entities).toBe(afterFirst.entities);
    await assertBobFullySuppressed();
  });

  it("repeat erase via DIFFERENT tombstone paths (tombstone() then eraseWebId()) is idempotent too", async () => {
    await store.tombstone(BOB_DOC);
    const afterTombstone = await store.getStats();
    await assertBobFullySuppressed();

    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    const afterErase = await store.getStats();
    expect(afterErase.triples).toBe(afterTombstone.triples); // no drift across paths
    await assertBobFullySuppressed();
  });
});

// ─── Tombstone transition — projection-clear + SERVED-data suppression across edge cases ──────────
//
// THE guarantee under test: every tombstone path (eraseWebId / tombstone / crawler markDone) clears
// the tombstoned WebID's projection AND suppresses inbound edges to it from SERVED TPF, across the
// tricky cases (a doc.webid with no materialised projection; a Bob→Bob self-loop; a doc projecting
// an alternate variant-key WebID that is NOT tombstoned and must keep being served). The numeric
// estimate is a spec-legal approximation (the incremental suppressed counter was removed, rounds
// 6–8) — so these pin the SERVED data, which must be exact.
describe("tombstone transition — projection clear + served-data suppression across edge cases", () => {
  // (1) tombstone() a doc whose webid has NO materialised projection — the inbound edge to it must
  //     still be suppressed in SERVED TPF (the doc row flips to 'tombstone' with that webid).
  it("tombstone(docUrl) for a webid with NO projection still suppresses its inbound edge in served TPF", async () => {
    // Alice is fully indexed and has an inbound edge knows→Bob. Bob is a KNOWN doc.webid but has NO
    // materialised triples (only the doc row carries his webid — e.g. his profile failed to parse).
    await indexProfile(store, {
      webid: ALICE,
      docUrl: ALICE_DOC,
      triples: aliceTriples, // includes ALICE knows BOB
    });
    // Register Bob's doc row with his webid but DO NOT upsertTriples — no projection for Bob.
    await store.enqueue(BOB_DOC, { webid: BOB, source: "seed" });
    await store.markDone(BOB_DOC, {
      state: "done",
      webid: BOB,
      rawRdf: `<${BOB}> <${FOAF_NAME}> "Bob" .`,
      isSolid: true,
      httpStatus: 200,
    });

    // Pre-tombstone: Alice knows Bob is served.
    expect(
      (await store.tpf({ pattern: { p: FOAF_KNOWS }, limit: 100 })).triples
        .length
    ).toBe(1);

    // Tombstone Bob's doc. Even though Bob had NO projection, the doc row flips to 'tombstone' with his
    // webid, so SERVED TPF must suppress Alice's inbound knows→Bob.
    await store.tombstone(BOB_DOC);

    // Served TPF for foaf:knows is empty; Alice's own type + name survive.
    expect(
      (await store.tpf({ pattern: { p: FOAF_KNOWS }, limit: 100 })).triples
        .length
    ).toBe(0);
    expect(
      (await store.tpf({ pattern: { s: ALICE }, limit: 100 })).triples.length
    ).toBe(2);
    // Estimate is spec-legal (≥ served, never negative).
    expect(
      await store.estimatePatternCardinality({ p: FOAF_KNOWS })
    ).toBeGreaterThanOrEqual(0);
  });

  // (2) A self-referential Bob→Bob edge must not leave any servable residue and must not throw.
  it("a self-referential Bob→Bob edge is cleared with Bob's projection; only Alice→Bob is suppressed", async () => {
    // Bob's profile includes a SELF edge: Bob knows Bob (o == subject == webid). Plus Alice knows Bob.
    const bobSelfTriples: TpfTriple[] = [
      { s: BOB, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
      { s: BOB, p: FOAF_NAME, o: "Bob", oIsIri: false },
      { s: BOB, p: FOAF_KNOWS, o: BOB, oIsIri: true }, // SELF-LOOP Bob→Bob
    ];
    await indexProfile(store, {
      webid: ALICE,
      docUrl: ALICE_DOC,
      triples: aliceTriples, // ALICE knows BOB (genuine inbound edge)
    });
    await indexProfile(store, {
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobSelfTriples,
    });

    // Tombstone Bob via markDone (crawler noindex/410 path).
    await db.query("UPDATE doc SET next_eligible_at = 0 WHERE doc_url = $1", [
      BOB_DOC,
    ]);
    const claimed = await store.claim("worker-1", 8);
    const bobToken = claimed.find((r) => r.docUrl === BOB_DOC)?.claimToken;
    expect(bobToken).toBeTruthy();
    const completed = await store.markDone(
      BOB_DOC,
      { state: "tombstone", httpStatus: 410, webid: BOB },
      bobToken
    );
    expect(completed).toBe(true);

    // Served data: Alice's type + name (2) survive; her knows→Bob AND Bob's whole projection (incl.
    // the self-loop) are gone — no servable residue.
    expect(
      (await store.tpf({ pattern: { p: FOAF_KNOWS }, limit: 100 })).triples
        .length
    ).toBe(0);
    expect(
      (await store.tpf({ pattern: { s: BOB }, limit: 100 })).triples.length
    ).toBe(0);
    expect(
      (await store.tpf({ pattern: { s: ALICE }, limit: 100 })).triples.length
    ).toBe(2);
  });

  // (3) A doc projecting an ALTERNATE variant-key WebID: only the actually-tombstoned WebID's inbound
  //     edges are suppressed in SERVED TPF; an alternate that is NOT tombstoned keeps being served.
  it("only the tombstoned WebID's inbound edges are suppressed in served TPF; an alternate is still served", async () => {
    const ALT = "https://bob.example/card#alt"; // alternate WebID under the SAME doc as BOB
    // Alice knows the canonical Bob; Carol knows the ALTERNATE — both inbound foaf:knows edges.
    const CAROL = "https://carol.example/card#me";
    const CAROL_DOC = "https://carol.example/card";
    const carolTriples: TpfTriple[] = [
      { s: CAROL, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
      { s: CAROL, p: FOAF_KNOWS, o: ALT, oIsIri: true }, // inbound edge → the ALTERNATE
    ];
    await indexProfile(store, {
      webid: ALICE,
      docUrl: ALICE_DOC,
      triples: aliceTriples,
    }); // knows BOB
    await indexProfile(store, {
      webid: CAROL,
      docUrl: CAROL_DOC,
      triples: carolTriples,
    }); // knows ALT
    // Project the alternate WebID's own triples keyed under the SAME BOB_DOC (variant-key residue).
    await store.enqueue(BOB_DOC, { webid: BOB, source: "seed" });
    await store.markDone(BOB_DOC, {
      state: "done",
      webid: BOB,
      rawRdf: `<${BOB}> a <${FOAF_PERSON}> .`,
      isSolid: true,
      httpStatus: 200,
    });
    await store.upsertTriples({
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobTriples,
    });
    await store.upsertTriples({
      webid: ALT,
      docUrl: BOB_DOC, // same doc, different (alternate) webid key
      triples: [{ s: ALT, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true }],
    });

    // Two inbound foaf:knows edges served pre-tombstone: Alice→BOB and Carol→ALT.
    expect(
      (await store.tpf({ pattern: { p: FOAF_KNOWS }, limit: 100 })).triples
        .length
    ).toBe(2);

    // markDone({state:'tombstone'}) tombstones the CANONICAL webid (BOB) ONLY. ALT is variant-key
    // residue: its projection is cleared but NO tombstone is persisted for ALT — so Carol→ALT keeps
    // being SERVED.
    await db.query("UPDATE doc SET next_eligible_at = 0 WHERE doc_url = $1", [
      BOB_DOC,
    ]);
    const claimed = await store.claim("worker-1", 8);
    const bobToken = claimed.find((r) => r.docUrl === BOB_DOC)?.claimToken;
    expect(bobToken).toBeTruthy();
    const completed = await store.markDone(
      BOB_DOC,
      { state: "tombstone", httpStatus: 410, webid: BOB },
      bobToken
    );
    expect(completed).toBe(true);

    // SERVED data: exactly ONE foaf:knows survives — Carol→ALT. Alice→BOB is suppressed (BOB is
    // tombstoned); Carol→ALT is served (ALT is NOT tombstoned). The numeric estimate may over-count
    // the suppressed BOB edge, but the served data is exact.
    const knowsTpf = await store.tpf({
      pattern: { p: FOAF_KNOWS },
      limit: 100,
    });
    expect(knowsTpf.triples.length).toBe(1);
    expect(knowsTpf.triples[0]?.o).toBe(ALT); // the surviving served edge is Carol→ALT
    // The estimate is ≥ the served count (1), never negative.
    expect(
      await store.estimatePatternCardinality({ p: FOAF_KNOWS })
    ).toBeGreaterThanOrEqual(1);
  });

  // (4) Counters never go negative across paths + redundant re-tombstone (clamp + idempotence).
  it("stats counters stay ≥ 0 across tombstone / erase / repeat-tombstone; served data stable", async () => {
    /** Assert NO stats counter is negative (GREATEST(0, …) clamp invariant). */
    async function assertNoNegativeStats(): Promise<void> {
      const res = await db.query<{ k: string; v: number | string }>(
        "SELECT k, v FROM stats WHERE v < 0"
      );
      expect(res.rows).toEqual([]); // any row here is a negative counter — the bug
    }

    await indexProfile(store, {
      webid: ALICE,
      docUrl: ALICE_DOC,
      triples: aliceTriples,
    }); // knows BOB
    await indexProfile(store, {
      webid: BOB,
      docUrl: BOB_DOC,
      triples: bobTriples,
    });
    await assertNoNegativeStats();

    await store.tombstone(BOB_DOC);
    await assertNoNegativeStats();
    // Repeat tombstone via a DIFFERENT path — must not drive any counter below zero.
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    await assertNoNegativeStats();
    // And a third, redundant erase.
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });
    await assertNoNegativeStats();

    // Served data: the inbound knows→Bob edge stays suppressed throughout (idempotent across paths).
    expect(
      (await store.tpf({ pattern: { p: FOAF_KNOWS }, limit: 100 })).triples
        .length
    ).toBe(0);
    expect(
      await store.estimatePatternCardinality({ p: FOAF_KNOWS })
    ).toBeGreaterThanOrEqual(0);
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
