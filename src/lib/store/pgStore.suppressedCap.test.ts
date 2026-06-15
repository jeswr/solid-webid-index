// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * pgStore.suppressedCap.test.ts — the capped-stats-correction regression (roborev MEDIUM).
 *
 * The earlier correction subtracted suppressed inbound tombstone edges only up to
 * TPF_ESTIMATE_COUNT_CAP, so a dataset with MORE suppressed inbound edges than the cap still
 * over-reported void:triples / hydra:totalItems for the empty + predicate-only estimates. The fix
 * maintains the suppressed-edge count INCREMENTALLY (`sup` total + `sp:<pred>` per-predicate) so the
 * O(1) stats path subtracts the FULL hidden count with NO cap.
 *
 * This test sets TPF_ESTIMATE_COUNT_CAP DELIBERATELY LOW and then erases a WebID with MANY MORE
 * inbound foaf:knows edges than the cap, asserting getStats() + the empty/predicate-only estimates
 * exclude EVERY suppressed edge (not just the first `cap`). Uses pglite — no network.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TpfTriple } from "./ports.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const FOAF_KNOWS = "http://xmlns.com/foaf/0.1/knows";
const FOAF_PERSON = "http://xmlns.com/foaf/0.1/Person";
const FOAF_NAME = "http://xmlns.com/foaf/0.1/name";

const BOB = "https://bob.example/card#me";
const BOB_DOC = "https://bob.example/card";

// A small cap so the dataset comfortably EXCEEDS it; the suppressed-edge correction must still be
// exact (it reads the incremental `sup`/`sp:` counters, not a capped scan).
const CAP = 5;
const SUPPRESSED_EDGES = 17; // > CAP — a capped scan would under-correct by (SUPPRESSED_EDGES - CAP).

describe("suppressed-edge stats correction is exact when the dataset EXCEEDS the cap (roborev MEDIUM)", () => {
  let store: import("./pgStore.js").PgStore;
  let db: PGlite;

  beforeEach(async () => {
    // Force a LOW cap, then (re)import config + the store so the module-load const picks it up.
    vi.resetModules();
    vi.stubEnv("TPF_ESTIMATE_COUNT_CAP", String(CAP));
    const { TPF_ESTIMATE_COUNT_CAP } = await import("../config.js");
    expect(TPF_ESTIMATE_COUNT_CAP).toBe(CAP); // guard: the low cap is actually in effect

    const { PgStore, createPgliteExecutor } = await import("./pgStore.js");
    db = new PGlite();
    store = new PgStore(createPgliteExecutor(db));
    await store.migrate();
  });

  afterEach(async () => {
    await db.close();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("getStats() + empty/predicate estimates subtract ALL suppressed inbound edges, not just `cap`", async () => {
    // Index Bob (the erase target) plus SUPPRESSED_EDGES distinct people who each foaf:knows Bob.
    const bobTriples: TpfTriple[] = [
      { s: BOB, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
    ];
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

    for (let i = 0; i < SUPPRESSED_EDGES; i++) {
      const webid = `https://p${i}.example/card#me`;
      const docUrl = `https://p${i}.example/card`;
      const triples: TpfTriple[] = [
        { s: webid, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
        { s: webid, p: FOAF_NAME, o: `P${i}`, oIsIri: false },
        { s: webid, p: FOAF_KNOWS, o: BOB, oIsIri: true }, // inbound edge → Bob
      ];
      await store.enqueue(docUrl, { webid, source: "seed" });
      await store.markDone(docUrl, {
        state: "done",
        webid,
        rawRdf: `<${webid}> <${FOAF_NAME}> "P${i}" .`,
        isSolid: true,
        httpStatus: 200,
      });
      await store.upsertTriples({ webid, docUrl, triples });
    }

    const before = await store.getStats();
    // Bob: 1 (type). Each person: 3 (type + name + knows). Total = 1 + 3*N.
    const totalBefore = 1 + 3 * SUPPRESSED_EDGES;
    expect(before.triples).toBe(totalBefore);
    const knowsBefore = before.propertyPartitions.find(
      (p) => p.propertyIri === FOAF_KNOWS
    );
    expect(knowsBefore?.triples).toBe(SUPPRESSED_EDGES);

    // Erase Bob. His own 1 triple is deleted; the SUPPRESSED_EDGES inbound foaf:knows→Bob edges
    // survive in `triple` (under live subjects) but are SUPPRESSED at read.
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });

    const after = await store.getStats();
    // Served total = (1 + 3N) - 1 (Bob's own) - N (suppressed inbound knows) = 2N.
    // CRUCIAL: the suppressed subtraction is the FULL N (= SUPPRESSED_EDGES, which is > CAP), proving
    // the correction is NOT capped. A capped correction would leave (N - CAP) edges over-reported.
    expect(after.triples).toBe(2 * SUPPRESSED_EDGES);
    // The foaf:knows partition drops to 0 served (all N inbound edges suppressed) → not advertised.
    expect(
      after.propertyPartitions.find((p) => p.propertyIri === FOAF_KNOWS)
    ).toBeUndefined();

    // The TPF empty-pattern estimate matches the served triple count (full subtraction, no cap).
    expect(await store.estimatePatternCardinality({})).toBe(
      2 * SUPPRESSED_EDGES
    );
    // The predicate-only estimate for foaf:knows is 0 (every edge suppressed) — NOT (N - CAP).
    expect(await store.estimatePatternCardinality({ p: FOAF_KNOWS })).toBe(0);
    // Sanity: the served TPF for foaf:knows is indeed empty (estimate matches reality).
    const knowsTpf = await store.tpf({
      pattern: { p: FOAF_KNOWS },
      limit: 1000,
    });
    expect(knowsTpf.triples.length).toBe(0);
  });
});
