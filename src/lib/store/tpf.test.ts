// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * tpf.test.ts — store-level tests for the Triple Pattern Fragments read seam
 * (DESIGN.md §4.5): PgStore.tpf / estimatePatternCardinality / upsertTriples.
 *
 * Kept SEPARATE from pgStore.test.ts (which a concurrent stats sibling edits) so
 * the two test files do not contend.  pglite (in-process Postgres WASM) — no
 * network, no Neon account.
 */

import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

import { PgStore, createPgliteExecutor } from "./pgStore.js";
import type { DocRecord, TpfTriple } from "./ports.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const FOAF_PERSON = "http://xmlns.com/foaf/0.1/Person";
const FOAF_NAME = "http://xmlns.com/foaf/0.1/name";
const SOLID_ISSUER = "http://www.w3.org/ns/solid/terms#oidcIssuer";

async function makeTestStore(): Promise<{ store: PgStore }> {
  const db = new PGlite();
  const store = new PgStore(createPgliteExecutor(db));
  await store.migrate();
  return { store };
}

function makeDoc(o: Partial<DocRecord> & { docUrl: string }): DocRecord {
  return {
    docUrl: o.docUrl,
    host: o.host ?? new URL(o.docUrl).hostname,
    webid: o.webid ?? null,
    state: o.state ?? "done",
    depth: o.depth ?? 0,
    rootSeed: o.rootSeed ?? null,
    suggestBudget: o.suggestBudget ?? null,
    source: o.source ?? "seed",
    discoveredFrom: o.discoveredFrom ?? null,
    claimToken: o.claimToken ?? null,
    claimedAt: o.claimedAt ?? null,
    attempts: o.attempts ?? 1,
    etag: o.etag ?? null,
    lastModified: o.lastModified ?? null,
    contentHash: o.contentHash ?? null,
    lastCrawled: o.lastCrawled ?? Date.now(),
    nextEligibleAt: o.nextEligibleAt ?? 0,
    enqueuedAt: o.enqueuedAt ?? Date.now(),
    httpStatus: o.httpStatus ?? 200,
    isSolid: o.isSolid ?? true,
    failClass: o.failClass ?? null,
    error: o.error ?? null,
    noindex: o.noindex ?? false,
    rawRdf: o.rawRdf ?? null,
    label: o.label ?? null,
    slug: o.slug ?? null,
  };
}

const ALICE = "https://alice.example/c#me";
const ALICE_DOC = "https://alice.example/c";
const ALICE_TRIPLES: TpfTriple[] = [
  { s: ALICE, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
  { s: ALICE, p: FOAF_NAME, o: "Alice", oIsIri: false },
  { s: ALICE, p: SOLID_ISSUER, o: "https://idp.example", oIsIri: true },
];

async function seed(
  store: PgStore,
  webid: string,
  docUrl: string,
  triples: TpfTriple[]
): Promise<void> {
  await store.put(makeDoc({ docUrl, webid }));
  await store.upsertTriples({ webid, docUrl, triples });
}

// ─── tpf() matching ────────────────────────────────────────────────────────────

describe("PgStore.tpf — pattern matching", () => {
  let store: PgStore;
  beforeEach(async () => {
    ({ store } = await makeTestStore());
    await seed(store, ALICE, ALICE_DOC, ALICE_TRIPLES);
  });

  it("matches ?s=", async () => {
    const { triples } = await store.tpf({ pattern: { s: ALICE }, limit: 100 });
    expect(triples.length).toBe(3);
  });

  it("matches ?p=", async () => {
    const { triples } = await store.tpf({
      pattern: { p: FOAF_NAME },
      limit: 100,
    });
    expect(triples.length).toBe(1);
    expect(triples[0].o).toBe("Alice");
    expect(triples[0].oIsIri).toBe(false);
  });

  it("matches an IRI ?o= but not a literal of the same value", async () => {
    const iri = await store.tpf({
      pattern: { o: "https://idp.example", oIsIri: true },
      limit: 100,
    });
    expect(iri.triples.length).toBe(1);
    expect(iri.triples[0].p).toBe(SOLID_ISSUER);

    const lit = await store.tpf({
      pattern: { o: "https://idp.example", oIsIri: false },
      limit: 100,
    });
    expect(lit.triples.length).toBe(0);
  });

  it("matches an exact ?s=&p=&o= triple", async () => {
    const { triples } = await store.tpf({
      pattern: { s: ALICE, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
      limit: 100,
    });
    expect(triples.length).toBe(1);
  });

  it("empty pattern returns the whole dataset", async () => {
    const { triples } = await store.tpf({ pattern: {}, limit: 100 });
    expect(triples.length).toBe(3);
  });
});

// ─── tombstone filtering ───────────────────────────────────────────────────────

describe("PgStore.tpf — tombstone filtering (DESIGN.md §4.8 H1)", () => {
  let store: PgStore;
  beforeEach(async () => {
    ({ store } = await makeTestStore());
    await seed(store, ALICE, ALICE_DOC, ALICE_TRIPLES);
  });

  it("never returns triples about a tombstoned WebID", async () => {
    expect((await store.tpf({ pattern: {}, limit: 100 })).triples.length).toBe(
      3
    );

    await store.tombstone(ALICE_DOC);

    expect((await store.tpf({ pattern: {}, limit: 100 })).triples.length).toBe(
      0
    );
    expect(
      (await store.tpf({ pattern: { s: ALICE }, limit: 100 })).triples.length
    ).toBe(0);
    expect(
      (await store.tpf({ pattern: { p: FOAF_NAME }, limit: 100 })).triples
        .length
    ).toBe(0);
  });

  it("a tombstoned WebID's triples are excluded from the cardinality estimate", async () => {
    await store.tombstone(ALICE_DOC);
    // Predicate estimate falls back to a bounded COUNT (the stats counter may still
    // reflect pre-tombstone totals — the COUNT applies the tombstone gate), so the
    // ?p= estimate must be 0 after tombstoning.
    const est = await store.estimatePatternCardinality({
      s: ALICE,
      p: FOAF_NAME,
    });
    expect(est).toBe(0);
  });
});

// ─── keyset pagination ─────────────────────────────────────────────────────────

describe("PgStore.tpf — keyset pagination", () => {
  let store: PgStore;
  beforeEach(async () => {
    ({ store } = await makeTestStore());
    for (let i = 0; i < 5; i++) {
      const w = `https://p${i}.example/c#me`;
      await seed(store, w, `https://p${i}.example/c`, [
        { s: w, p: FOAF_NAME, o: `Person ${i}`, oIsIri: false },
      ]);
    }
  });

  it("paginates forward with disjoint, complete coverage", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const { triples, nextCursor } = await store.tpf({
        pattern: { p: FOAF_NAME },
        limit: 2,
        cursor,
      });
      pages++;
      for (const t of triples) {
        // No triple appears twice across pages.
        expect(seen.has(t.s)).toBe(false);
        seen.add(t.s);
      }
      if (nextCursor === null) break;
      cursor = nextCursor;
      // Guard against an infinite loop in a broken cursor implementation.
      expect(pages).toBeLessThan(10);
    }
    expect(seen.size).toBe(5);
    expect(pages).toBe(3); // 2 + 2 + 1
  });

  it("a stable cursor returns the same page twice", async () => {
    const first = await store.tpf({
      pattern: { p: FOAF_NAME },
      limit: 2,
    });
    expect(first.nextCursor).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const cursor = first.nextCursor!;
    const a = await store.tpf({ pattern: { p: FOAF_NAME }, limit: 2, cursor });
    const b = await store.tpf({ pattern: { p: FOAF_NAME }, limit: 2, cursor });
    expect(a.triples.map((t) => t.s).sort()).toEqual(
      b.triples.map((t) => t.s).sort()
    );
  });
});

// ─── estimatePatternCardinality ────────────────────────────────────────────────

describe("PgStore.estimatePatternCardinality", () => {
  let store: PgStore;
  beforeEach(async () => {
    ({ store } = await makeTestStore());
  });

  it("empty pattern reads the total-triples stats counter", async () => {
    await seed(store, ALICE, ALICE_DOC, ALICE_TRIPLES);
    expect(await store.estimatePatternCardinality({})).toBe(3);
  });

  it("predicate-only reads the per-predicate stats counter", async () => {
    for (let i = 0; i < 4; i++) {
      const w = `https://q${i}.example/c#me`;
      await seed(store, w, `https://q${i}.example/c`, [
        { s: w, p: FOAF_NAME, o: `Q ${i}`, oIsIri: false },
      ]);
    }
    expect(await store.estimatePatternCardinality({ p: FOAF_NAME })).toBe(4);
  });

  it("a re-projection keeps the stats counters consistent (no drift)", async () => {
    await seed(store, ALICE, ALICE_DOC, ALICE_TRIPLES);
    expect(await store.estimatePatternCardinality({})).toBe(3);
    // Re-project the SAME webid with fewer triples → counters must drop, not double.
    await store.upsertTriples({
      webid: ALICE,
      docUrl: ALICE_DOC,
      triples: [{ s: ALICE, p: FOAF_NAME, o: "Alice", oIsIri: false }],
    });
    expect(await store.estimatePatternCardinality({})).toBe(1);
    expect(await store.estimatePatternCardinality({ p: FOAF_NAME })).toBe(1);
    expect(await store.estimatePatternCardinality({ p: RDF_TYPE })).toBe(0);
  });

  it("erasure (empty triple list) clears the WebID's contribution", async () => {
    await seed(store, ALICE, ALICE_DOC, ALICE_TRIPLES);
    await store.upsertTriples({
      webid: ALICE,
      docUrl: ALICE_DOC,
      triples: [],
    });
    expect(await store.estimatePatternCardinality({})).toBe(0);
    expect(
      (await store.tpf({ pattern: { s: ALICE }, limit: 100 })).triples.length
    ).toBe(0);
  });
});
