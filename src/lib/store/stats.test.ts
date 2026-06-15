// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * stats.test.ts — the incremental dataset-statistics maths (DESIGN.md §2.1.j).
 *
 * Pure functions: classEntityContribution (derive a WebID's owned contribution) and
 * classDelta (the signed incremental adjustment). No DB.
 */

import { describe, expect, it } from "vitest";

import {
  EMPTY_CLASS_CONTRIBUTION,
  type StatTriple,
  classDelta,
  classEntityContribution,
  classKey,
  propertyKey,
} from "./stats.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const FOAF_PERSON = "http://xmlns.com/foaf/0.1/Person";
const FOAF_AGENT = "http://xmlns.com/foaf/0.1/Agent";

function t(s: string, p: string, o: string, oIsIri = true): StatTriple {
  return { s, p, o, oIsIri };
}

describe("classEntityContribution", () => {
  it("counts one entity for any non-empty triple set", () => {
    const c = classEntityContribution([
      t(
        "https://a.example/#me",
        "http://xmlns.com/foaf/0.1/name",
        "Alice",
        false
      ),
    ]);
    expect(c.isEntity).toBe(1);
    expect(c.classes).toEqual({});
  });

  it("counts zero entity for an empty triple set (erased WebID)", () => {
    const c = classEntityContribution([]);
    expect(c.isEntity).toBe(0);
    expect(c.classes).toEqual({});
  });

  it("counts each rdf:type IRI as a class partition entry", () => {
    const c = classEntityContribution([
      t("https://a.example/#me", RDF_TYPE, FOAF_PERSON),
      t("https://a.example/#me", RDF_TYPE, FOAF_AGENT),
    ]);
    expect(c.classes).toEqual({ [FOAF_PERSON]: 1, [FOAF_AGENT]: 1 });
  });

  it("de-duplicates a (class, subject) pair within one WebID's triples", () => {
    // Same subject typed foaf:Person twice → counts once for that class.
    const c = classEntityContribution([
      t("https://a.example/#me", RDF_TYPE, FOAF_PERSON),
      t("https://a.example/#me", RDF_TYPE, FOAF_PERSON),
    ]);
    expect(c.classes).toEqual({ [FOAF_PERSON]: 1 });
  });

  it("counts distinct subjects of the same class separately", () => {
    const c = classEntityContribution([
      t("https://a.example/#me", RDF_TYPE, FOAF_PERSON),
      t("https://a.example/#you", RDF_TYPE, FOAF_PERSON),
    ]);
    expect(c.classes).toEqual({ [FOAF_PERSON]: 2 });
  });

  it("ignores a literal rdf:type object (not a class)", () => {
    const c = classEntityContribution([
      t("https://a.example/#me", RDF_TYPE, "Person", false),
    ]);
    expect(c.classes).toEqual({});
  });
});

describe("classDelta", () => {
  it("insert (empty → contribution) yields positive deltas", () => {
    const next = classEntityContribution([
      t("https://a.example/#me", RDF_TYPE, FOAF_PERSON),
    ]);
    const d = classDelta(EMPTY_CLASS_CONTRIBUTION, next);
    expect(d.entities).toBe(1);
    expect(d.classes).toEqual({ [FOAF_PERSON]: 1 });
  });

  it("erase (contribution → empty) yields negative deltas", () => {
    const old = classEntityContribution([
      t("https://a.example/#me", RDF_TYPE, FOAF_PERSON),
    ]);
    const d = classDelta(old, EMPTY_CLASS_CONTRIBUTION);
    expect(d.entities).toBe(-1);
    expect(d.classes).toEqual({ [FOAF_PERSON]: -1 });
  });

  it("re-crawl that drops one class and adds another nets correctly", () => {
    const old = classEntityContribution([
      t("https://a.example/#me", RDF_TYPE, FOAF_PERSON),
    ]);
    const next = classEntityContribution([
      t("https://a.example/#me", RDF_TYPE, FOAF_AGENT),
    ]);
    const d = classDelta(old, next);
    // Still one entity (no change), Person -1, Agent +1.
    expect(d.entities).toBe(0);
    expect(d.classes).toEqual({ [FOAF_PERSON]: -1, [FOAF_AGENT]: 1 });
  });

  it("omits zero-net class deltas (unchanged class)", () => {
    const same = classEntityContribution([
      t("https://a.example/#me", RDF_TYPE, FOAF_PERSON),
    ]);
    const d = classDelta(same, same);
    expect(d.entities).toBe(0);
    expect(d.classes).toEqual({});
  });
});

describe("stats key helpers", () => {
  it("namespaces class and property keys distinctly", () => {
    expect(classKey(FOAF_PERSON)).toBe(`c:${FOAF_PERSON}`);
    expect(propertyKey("http://xmlns.com/foaf/0.1/knows")).toBe(
      "p:http://xmlns.com/foaf/0.1/knows"
    );
    // The two namespaces never collide.
    expect(classKey("x")).not.toBe(propertyKey("x"));
  });
});
