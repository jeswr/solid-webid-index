// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * vocab.test.ts — the minted idx: ontology (DESIGN.md §4.7).
 *
 * Asserts:
 *  - every minted term carries rdfs:label, rdfs:comment, rdfs:isDefinedBy <…/ns>
 *  - the three crawl states are skos:Concept members of one skos:ConceptScheme
 *  - idx:lastCrawl is NOT defined (dropped — sw C3)
 *  - TERM-DEREFERENCE ROUND-TRIP: every term IRI the vocab mints is defined by /ns
 */

import { Store as N3Store, Parser } from "n3";
import { describe, expect, it } from "vitest";

import { serializeTurtle } from "../http/conneg";
import {
  IDX_LIVE,
  IDX_NS,
  IDX_STALE,
  IDX_UNREACHABLE,
  NS_DOC_IRI,
  buildNamespaceQuads,
  crawlStateConcept,
  mintedTermIris,
} from "./vocab";

const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";

function toStore(quads: ReturnType<typeof buildNamespaceQuads>): N3Store {
  const s = new N3Store();
  for (const q of quads) s.addQuad(q);
  return s;
}

describe("idx: vocabulary", () => {
  const quads = buildNamespaceQuads();
  const store = toStore(quads);

  it("defines every minted term with label + comment + isDefinedBy <…/ns>", () => {
    for (const iri of mintedTermIris()) {
      const labels = store.getQuads(iri, `${RDFS}label`, null, null);
      const comments = store.getQuads(iri, `${RDFS}comment`, null, null);
      const definedBy = store.getQuads(iri, `${RDFS}isDefinedBy`, null, null);
      expect(labels.length, `${iri} rdfs:label`).toBeGreaterThanOrEqual(1);
      expect(comments.length, `${iri} rdfs:comment`).toBeGreaterThanOrEqual(1);
      expect(definedBy.length, `${iri} rdfs:isDefinedBy`).toBe(1);
      expect(definedBy[0].object.value).toBe(NS_DOC_IRI);
    }
  });

  it("TERM-DEREFERENCE ROUND-TRIP: every minted term IRI is a subject defined by /ns", () => {
    for (const iri of mintedTermIris()) {
      const asSubject = store.getQuads(iri, null, null, null);
      expect(
        asSubject.length,
        `${iri} must be described by /ns`
      ).toBeGreaterThan(0);
    }
  });

  it("models the three crawl states as skos:Concepts in one ConceptScheme", () => {
    for (const concept of [IDX_LIVE, IDX_UNREACHABLE, IDX_STALE]) {
      const types = store
        .getQuads(concept.value, `${RDF}type`, null, null)
        .map((q) => q.object.value);
      expect(types).toContain(`${SKOS}Concept`);
      const scheme = store.getQuads(
        concept.value,
        `${SKOS}inScheme`,
        null,
        null
      );
      expect(scheme.length).toBe(1);
      const prefLabel = store.getQuads(
        concept.value,
        `${SKOS}prefLabel`,
        null,
        null
      );
      expect(prefLabel.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("does NOT define idx:lastCrawl (dropped — sw C3)", () => {
    expect(mintedTermIris()).not.toContain(`${IDX_NS}lastCrawl`);
    const q = store.getQuads(`${IDX_NS}lastCrawl`, null, null, null);
    expect(q.length).toBe(0);
  });

  it("serialises to valid Turtle (round-trips through the n3 parser)", async () => {
    const ttl = await serializeTurtle(quads);
    const parsed = await new Promise<N3Store>((resolve, reject) => {
      const s = new N3Store();
      new Parser({ baseIRI: NS_DOC_IRI }).parse(ttl, (err, q) => {
        if (err) reject(err);
        else if (q) s.addQuad(q);
        else resolve(s);
      });
    });
    // The parsed graph has at least as many quads as we built.
    expect(parsed.size).toBe(store.size);
  });
});

describe("crawlStateConcept mapping", () => {
  const now = 1_000_000;
  it("done + within window → Live", () => {
    expect(
      crawlStateConcept({ state: "done", nextEligibleAt: now + 1000, now })
        .value
    ).toBe(IDX_LIVE.value);
  });
  it("done + overdue recrawl → Stale", () => {
    expect(
      crawlStateConcept({ state: "done", nextEligibleAt: now - 1000, now })
        .value
    ).toBe(IDX_STALE.value);
  });
  it("failed → Unreachable", () => {
    expect(
      crawlStateConcept({ state: "failed", nextEligibleAt: 0, now }).value
    ).toBe(IDX_UNREACHABLE.value);
  });
  it("crawl-state concepts are minted under the idx: namespace", () => {
    for (const c of [IDX_LIVE, IDX_UNREACHABLE, IDX_STALE]) {
      expect(c.value.startsWith(IDX_NS)).toBe(true);
    }
  });
});
