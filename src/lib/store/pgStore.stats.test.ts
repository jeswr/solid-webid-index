// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * pgStore.stats.test.ts — incremental dataset-statistics maintenance (pss-0zp).
 *
 * Runs against pglite (in-process Postgres).  Asserts the pss-0zp acceptance:
 *   - getStats() reads O(1) pre-aggregated counters (entities + class partitions
 *     owned here, triples + property partitions owned by the TPF bead but read here);
 *   - stats reflect INSERTS incrementally (upsertTriples adds);
 *   - stats reflect ERASES incrementally (upsertTriples([]) subtracts; tombstone via
 *     the crawler path subtracts);
 *   - getPredicateCardinality is the O(1) accessor the TPF sibling reads.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { PgStore } from "./pgStore";
import type { TpfTriple } from "./ports";
import { freshTestStore } from "./testStore";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const FOAF_PERSON = "http://xmlns.com/foaf/0.1/Person";
const FOAF_AGENT = "http://xmlns.com/foaf/0.1/Agent";
const FOAF_NAME = "http://xmlns.com/foaf/0.1/name";
const FOAF_KNOWS = "http://xmlns.com/foaf/0.1/knows";

function trip(s: string, p: string, o: string, oIsIri = true): TpfTriple {
  return { s, p, o, oIsIri };
}

/** A typical served WebID profile triple set. */
function profileTriples(webid: string, name: string): TpfTriple[] {
  return [
    trip(webid, RDF_TYPE, FOAF_PERSON),
    trip(webid, FOAF_NAME, name, false),
    trip(webid, FOAF_KNOWS, "https://other.example/#me"),
  ];
}

let store: PgStore;

beforeEach(async () => {
  ({ store } = await freshTestStore());
});

describe("PgStore stats — incremental maintenance", () => {
  it("getStats() is empty on a fresh index", async () => {
    const s = await store.getStats();
    expect(s.triples).toBe(0);
    expect(s.entities).toBe(0);
    expect(s.classes).toBe(0);
    expect(s.properties).toBe(0);
    expect(s.classPartitions).toEqual([]);
    expect(s.propertyPartitions).toEqual([]);
  });

  it("counts INSERTS incrementally (entities, triples, class & property partitions)", async () => {
    const webid = "https://alice.example/card#me";
    await store.upsertTriples({
      webid,
      docUrl: "https://alice.example/card",
      triples: profileTriples(webid, "Alice"),
    });

    const s = await store.getStats();
    expect(s.entities).toBe(1);
    expect(s.triples).toBe(3);
    // One distinct class (foaf:Person) and three distinct predicates.
    expect(s.classes).toBe(1);
    expect(s.properties).toBe(3);

    const personPartition = s.classPartitions.find(
      (c) => c.classIri === FOAF_PERSON
    );
    expect(personPartition?.entities).toBe(1);

    const knowsPartition = s.propertyPartitions.find(
      (p) => p.propertyIri === FOAF_KNOWS
    );
    expect(knowsPartition?.triples).toBe(1);
  });

  it("two WebIDs aggregate their partition counts", async () => {
    await store.upsertTriples({
      webid: "https://alice.example/#me",
      docUrl: "https://alice.example/card",
      triples: profileTriples("https://alice.example/#me", "Alice"),
    });
    await store.upsertTriples({
      webid: "https://bob.example/#me",
      docUrl: "https://bob.example/card",
      triples: profileTriples("https://bob.example/#me", "Bob"),
    });

    const s = await store.getStats();
    expect(s.entities).toBe(2);
    expect(s.triples).toBe(6);
    expect(
      s.classPartitions.find((c) => c.classIri === FOAF_PERSON)?.entities
    ).toBe(2);
    expect(
      s.propertyPartitions.find((p) => p.propertyIri === FOAF_KNOWS)?.triples
    ).toBe(2);
  });

  it("re-projection (re-crawl) applies the DELTA, never double-counts", async () => {
    const webid = "https://alice.example/#me";
    const docUrl = "https://alice.example/card";
    await store.upsertTriples({
      webid,
      docUrl,
      triples: profileTriples(webid, "Alice"),
    });

    // Re-crawl: same WebID, now typed foaf:Agent instead of foaf:Person, and drops
    // the foaf:knows triple.
    await store.upsertTriples({
      webid,
      docUrl,
      triples: [
        trip(webid, RDF_TYPE, FOAF_AGENT),
        trip(webid, FOAF_NAME, "Alice", false),
      ],
    });

    const s = await store.getStats();
    // Still exactly one entity (not two — the delta, not an add).
    expect(s.entities).toBe(1);
    expect(s.triples).toBe(2);
    // foaf:Person dropped to 0 → no longer a distinct class; foaf:Agent now present.
    expect(s.classes).toBe(1);
    expect(
      s.classPartitions.find((c) => c.classIri === FOAF_PERSON)
    ).toBeUndefined();
    expect(
      s.classPartitions.find((c) => c.classIri === FOAF_AGENT)?.entities
    ).toBe(1);
    // foaf:knows dropped to 0 → no longer a distinct property.
    expect(
      s.propertyPartitions.find((p) => p.propertyIri === FOAF_KNOWS)
    ).toBeUndefined();
  });

  it("ERASE via upsertTriples([]) subtracts the whole contribution", async () => {
    const webid = "https://alice.example/#me";
    const docUrl = "https://alice.example/card";
    await store.upsertTriples({
      webid,
      docUrl,
      triples: profileTriples(webid, "Alice"),
    });
    expect((await store.getStats()).entities).toBe(1);

    // Erase: empty triple list = delete-by-webid.
    await store.upsertTriples({ webid, docUrl, triples: [] });

    const s = await store.getStats();
    expect(s.entities).toBe(0);
    expect(s.triples).toBe(0);
    expect(s.classes).toBe(0);
    expect(s.properties).toBe(0);
    expect(s.classPartitions).toEqual([]);
    expect(s.propertyPartitions).toEqual([]);
  });

  it("erasing ONE of two WebIDs leaves the other's counts exact", async () => {
    await store.upsertTriples({
      webid: "https://alice.example/#me",
      docUrl: "https://alice.example/card",
      triples: profileTriples("https://alice.example/#me", "Alice"),
    });
    await store.upsertTriples({
      webid: "https://bob.example/#me",
      docUrl: "https://bob.example/card",
      triples: profileTriples("https://bob.example/#me", "Bob"),
    });

    await store.upsertTriples({
      webid: "https://alice.example/#me",
      docUrl: "https://alice.example/card",
      triples: [],
    });

    const s = await store.getStats();
    expect(s.entities).toBe(1);
    expect(s.triples).toBe(3);
    expect(
      s.classPartitions.find((c) => c.classIri === FOAF_PERSON)?.entities
    ).toBe(1);
    expect(
      s.propertyPartitions.find((p) => p.propertyIri === FOAF_KNOWS)?.triples
    ).toBe(1);
  });

  it("getPredicateCardinality is the O(1) accessor for the TPF sibling", async () => {
    const webid = "https://alice.example/#me";
    await store.upsertTriples({
      webid,
      docUrl: "https://alice.example/card",
      triples: profileTriples(webid, "Alice"),
    });
    expect(await store.getPredicateCardinality(FOAF_KNOWS)).toBe(1);
    expect(await store.getPredicateCardinality(FOAF_NAME)).toBe(1);
    // An absent predicate reads 0 (no row), never throws.
    expect(
      await store.getPredicateCardinality("http://example/never-used")
    ).toBe(0);
  });

  it("counters never go negative under a double erase", async () => {
    const webid = "https://alice.example/#me";
    const docUrl = "https://alice.example/card";
    await store.upsertTriples({
      webid,
      docUrl,
      triples: profileTriples(webid, "Alice"),
    });
    await store.upsertTriples({ webid, docUrl, triples: [] });
    // Second erase of an already-erased WebID is a no-op (no triples to subtract).
    await store.upsertTriples({ webid, docUrl, triples: [] });
    const s = await store.getStats();
    expect(s.entities).toBe(0);
    expect(s.triples).toBe(0);
  });

  it("a doc that re-resolves to a DIFFERENT webid evicts the stale projection (roborev)", async () => {
    const docUrl = "https://pod.example/card";
    const w1 = "https://pod.example/card#alice";
    const w2 = "https://pod.example/card#bob";

    // First crawl: doc resolves to w1.
    await store.upsertTriples({
      webid: w1,
      docUrl,
      triples: profileTriples(w1, "Alice"),
    });
    let s = await store.getStats();
    expect(s.entities).toBe(1);
    expect(s.triples).toBe(3);

    // Re-crawl: SAME doc now resolves to w2 (e.g. the profile's #me subject changed).
    // The stale w1 triples + their stats must be evicted, not left counted forever.
    await store.upsertTriples({
      webid: w2,
      docUrl,
      triples: profileTriples(w2, "Bob"),
    });
    s = await store.getStats();
    // Still exactly one entity + three triples (w1 fully evicted, w2 inserted).
    expect(s.entities).toBe(1);
    expect(s.triples).toBe(3);
    // The stale w1 triples are gone from the table.
    const w1Tpf = await store.tpf({
      pattern: { s: w1 },
      limit: 10,
    });
    expect(w1Tpf.triples.length).toBe(0);
  });
});

describe("PgStore stats — direct tombstone() subtracts stats (roborev)", () => {
  it("a direct tombstone(docUrl) decrements entities/triples/p:<iri> so estimates don't over-count", async () => {
    const webid = "https://alice.example/#me";
    const docUrl = "https://alice.example/card";
    await store.upsertTriples({
      webid,
      docUrl,
      triples: profileTriples(webid, "Alice"),
    });
    expect(await store.getPredicateCardinality(FOAF_KNOWS)).toBe(1);

    // The opt-out / erasure path uses tombstone(docUrl) directly (not the crawler's
    // markDone path). It must subtract the stats so the predicate-only cardinality
    // (which reads the 'p:<iri>' counter directly) no longer counts the erased WebID.
    await store.tombstone(docUrl);

    expect(await store.getPredicateCardinality(FOAF_KNOWS)).toBe(0);
    const s = await store.getStats();
    expect(s.entities).toBe(0);
    expect(s.triples).toBe(0);
    expect(s.classes).toBe(0);
    expect(s.properties).toBe(0);
  });
});

describe("PgStore stats — backfill on migrate (roborev)", () => {
  it("re-projects existing served rows lacking triples into triple + stats", async () => {
    // Simulate a pre-triple-table database: a served `done` row with raw_rdf but NO
    // materialised triples (as if it was crawled before the triple/stats tables shipped).
    const { store: s, db } = await freshTestStore();

    const webid = "https://carol.example/card#me";
    const docUrl = "https://carol.example/card";
    const rawRdf = [
      `<${webid}> <${RDF_TYPE}> <${FOAF_PERSON}> .`,
      `<${webid}> <${FOAF_NAME}> "Carol" .`,
    ].join("\n");

    // Insert a served row directly with raw_rdf but DELETE its triples + reset stats
    // to mimic the pre-backfill state.
    await s.enqueue(docUrl, { webid });
    await s.markDone(docUrl, {
      state: "done",
      httpStatus: 200,
      isSolid: true,
      webid,
      rawRdf,
    });
    // Wipe any triples/stats so the row looks un-projected.
    await db.query("DELETE FROM triple WHERE webid = $1", [webid]);
    await db.query("DELETE FROM stats");

    expect((await s.getStats()).entities).toBe(0);

    // Re-running migrate() backfills the missing projection.
    await s.migrate();

    const stats = await s.getStats();
    expect(stats.entities).toBe(1);
    expect(stats.triples).toBe(2);
    expect(
      stats.classPartitions.find((c) => c.classIri === FOAF_PERSON)?.entities
    ).toBe(1);
    // The triples are now queryable via TPF.
    const tpf = await s.tpf({ pattern: { s: webid }, limit: 10 });
    expect(tpf.triples.length).toBe(2);
  });
});
