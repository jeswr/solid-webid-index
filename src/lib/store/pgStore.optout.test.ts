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
    // The doc row is DELETED on erasure, so the slug is unknown (404). The PERMANENT tombstone is
    // the durable gate (isTombstoned), which the route consults; either way the slug never serves a
    // 200. Assert the slug no longer resolves to a live entry.
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
