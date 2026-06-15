// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * pgStore.suppressedCap.test.ts — the SERVED-DATA suppression guarantee under a low estimate cap.
 *
 * The incremental `sup`/`sp:<pred>` suppressed-edge correction counter was REMOVED (roborev rounds
 * 6–8) as too race-prone. TPF `void:triples` / Hydra `totalItems` are SPEC'd as ESTIMATES, so the
 * O(1) estimate is now allowed to MARGINALLY over-count inbound edges to an erased WebID. The HARD,
 * non-negotiable guarantee that this test pins: the actual SERVED TPF output MUST suppress EVERY
 * inbound edge to a tombstoned WebID — even when the dataset (and the number of suppressed edges)
 * comfortably exceeds TPF_ESTIMATE_COUNT_CAP, so a capped scan could never have covered them all.
 *
 * Uses pglite — no network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TpfTriple } from "./ports";
import { freshPgliteDb } from "./testStore";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const FOAF_KNOWS = "http://xmlns.com/foaf/0.1/knows";
const FOAF_PERSON = "http://xmlns.com/foaf/0.1/Person";
const FOAF_NAME = "http://xmlns.com/foaf/0.1/name";

const BOB = "https://bob.example/card#me";
const BOB_DOC = "https://bob.example/card";

// A small cap so the dataset (and the suppressed-edge set) comfortably EXCEEDS it — proving the
// SERVED-data suppression is enforced at read by the SQL gate, not by a capped scan.
const CAP = 5;
const SUPPRESSED_EDGES = 17; // > CAP

describe("served TPF suppresses ALL inbound edges to an erased WebID, even past the estimate cap", () => {
  let store: import("./pgStore").PgStore;

  beforeEach(async () => {
    // Force a LOW cap, then (re)import config + the store so the module-load const picks it up.
    // freshPgliteDb is bound at top-of-file (before resetModules), so it keeps using the shared engine.
    vi.resetModules();
    vi.stubEnv("TPF_ESTIMATE_COUNT_CAP", String(CAP));
    const { TPF_ESTIMATE_COUNT_CAP } = await import("../config");
    expect(TPF_ESTIMATE_COUNT_CAP).toBe(CAP); // guard: the low cap is actually in effect

    const { PgStore, createPgliteExecutor } = await import("./pgStore");
    const db = await freshPgliteDb();
    store = new PgStore(createPgliteExecutor(db));
    await store.migrate();
  });

  afterEach(() => {
    // No db.close() — the shared per-worker engine is reset on the next freshPgliteDb() call.
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("erasing a WebID drops EVERY inbound foaf:knows edge from served TPF (no cap on the read gate)", async () => {
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

    // Before erase: every inbound knows→Bob edge is served.
    const knowsBefore = await store.tpf({
      pattern: { p: FOAF_KNOWS },
      limit: 1000,
    });
    expect(knowsBefore.triples.length).toBe(SUPPRESSED_EDGES);

    // Erase Bob. His own triple is deleted; the SUPPRESSED_EDGES inbound foaf:knows→Bob edges survive
    // in `triple` (under live subjects) but MUST be suppressed at read by tombstoneObjectClause.
    await store.eraseWebId({ webid: BOB, docUrl: BOB_DOC, reason: "opt-out" });

    // HARD GUARANTEE: the SERVED TPF for foaf:knows is EMPTY — EVERY inbound edge is suppressed, not
    // just the first `cap`. The read gate is a correlated NOT EXISTS, never a capped scan.
    const knowsTpf = await store.tpf({
      pattern: { p: FOAF_KNOWS },
      limit: 1000,
    });
    expect(knowsTpf.triples.length).toBe(0);

    // And no served triple anywhere has Bob as an IRI object (full inbound suppression).
    const objTpf = await store.tpf({
      pattern: { o: BOB, oIsIri: true },
      limit: 1000,
    });
    expect(objTpf.triples.length).toBe(0);

    // Bob himself is gone from served TPF (subject-tombstoned + rows deleted).
    const bobTpf = await store.tpf({ pattern: { s: BOB }, limit: 1000 });
    expect(bobTpf.triples.length).toBe(0);

    // The numeric estimate is a SPEC-LEGAL approximation: it may over-count the suppressed inbound
    // edges (it no longer subtracts them), but it must never be NEGATIVE and must remain ≥ the truly
    // served count. The empty-pattern estimate counts each live person's surviving 2 served triples
    // PLUS the (now suppressed-but-still-counted) N inbound knows edges.
    const estimate = await store.estimatePatternCardinality({});
    expect(estimate).toBeGreaterThanOrEqual(2 * SUPPRESSED_EDGES);
    // The per-predicate estimate for foaf:knows reads the O(1) counter (still N) — a legal over-count
    // versus the 0 actually served. The contract is "estimate ≥ served, never negative".
    const knowsEstimate = await store.estimatePatternCardinality({
      p: FOAF_KNOWS,
    });
    expect(knowsEstimate).toBeGreaterThanOrEqual(0);
  });
});
