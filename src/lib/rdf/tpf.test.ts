// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * tpf.test.ts — unit tests for the TPF RDF helpers (lib/rdf/tpf.ts):
 *  - datasetToTriples: dataset → flat {s,p,o,oIsIri}, IRI/literal disambiguation,
 *    blank-node/blank-object skipping;
 *  - buildFragmentQuads: the three-part fragment graph shape (controls + metadata).
 *
 * Pure (no DB / network).
 */

import { DataFactory, Store as N3Store } from "n3";
import { describe, expect, it } from "vitest";

import { INDEX_BASE_URL } from "../config";
import { buildFragmentQuads, datasetToTriples } from "./tpf";

const { namedNode, literal, blankNode, quad } = DataFactory;

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const HYDRA = "http://www.w3.org/ns/hydra/core#";
const VOID = "http://rdfs.org/ns/void#";
const FOAF = "http://xmlns.com/foaf/0.1/";

describe("datasetToTriples", () => {
  it("flattens IRI + literal objects with correct oIsIri", () => {
    const ds = new N3Store();
    const alice = namedNode("https://alice.example/c#me");
    ds.addQuad(
      quad(alice, namedNode(`${RDF}type`), namedNode(`${FOAF}Person`))
    );
    ds.addQuad(quad(alice, namedNode(`${FOAF}name`), literal("Alice")));

    const triples = datasetToTriples(ds);
    expect(triples.length).toBe(2);

    const typeT = triples.find((t) => t.p === `${RDF}type`);
    expect(typeT?.oIsIri).toBe(true);
    expect(typeT?.o).toBe(`${FOAF}Person`);

    const nameT = triples.find((t) => t.p === `${FOAF}name`);
    expect(nameT?.oIsIri).toBe(false);
    expect(nameT?.o).toBe("Alice");
  });

  it("skips blank-node subjects and blank-node objects", () => {
    const ds = new N3Store();
    const alice = namedNode("https://alice.example/c#me");
    const bn = blankNode("addr");
    // blank-node SUBJECT → skipped
    ds.addQuad(quad(bn, namedNode(`${FOAF}name`), literal("x")));
    // blank-node OBJECT → skipped
    ds.addQuad(quad(alice, namedNode(`${FOAF}knows`), bn));
    // a valid IRI→IRI triple → kept
    ds.addQuad(
      quad(
        alice,
        namedNode(`${FOAF}knows`),
        namedNode("https://bob.example/c#me")
      )
    );

    const triples = datasetToTriples(ds);
    expect(triples.length).toBe(1);
    expect(triples[0].o).toBe("https://bob.example/c#me");
    expect(triples[0].oIsIri).toBe(true);
  });
});

describe("buildFragmentQuads", () => {
  function toStore(quads: ReturnType<typeof buildFragmentQuads>): N3Store {
    const s = new N3Store();
    s.addQuads(quads);
    return s;
  }

  const dataset = `${INDEX_BASE_URL}/#dataset`;
  const endpoint = `${INDEX_BASE_URL}/tpf`;

  it("emits data + metadata + controls in one graph", () => {
    const store = toStore(
      buildFragmentQuads({
        pattern: { p: `${FOAF}name` },
        triples: [
          {
            s: "https://alice.example/c#me",
            p: `${FOAF}name`,
            o: "Alice",
            oIsIri: false,
          },
        ],
        estimate: 1,
        itemsPerPage: 100,
        cursor: undefined,
        nextCursor: null,
      })
    );

    const fragment = `${endpoint}?p=${encodeURIComponent(`${FOAF}name`)}`;

    // DATA
    expect(
      store.getQuads("https://alice.example/c#me", `${FOAF}name`, null, null)
        .length
    ).toBe(1);

    // METADATA
    expect(
      store.getQuads(fragment, `${RDF}type`, `${HYDRA}Collection`, null).length
    ).toBe(1);
    expect(
      store.getQuads(fragment, `${RDF}type`, `${VOID}Dataset`, null).length
    ).toBe(1);
    expect(
      store.getQuads(dataset, `${VOID}subset`, fragment, null).length
    ).toBe(1);
    expect(
      Number(
        store.getQuads(fragment, `${VOID}triples`, null, null)[0].object.value
      )
    ).toBe(1);

    // CONTROLS — IriTemplate template + mapping count
    const search = store.getQuads(dataset, `${HYDRA}search`, null, null);
    expect(search.length).toBe(1);
    const tmpl = search[0].object;
    expect(
      store.getQuads(tmpl, `${HYDRA}template`, null, null)[0].object.value
    ).toBe(`${endpoint}{?s,p,o}`);
    expect(store.getQuads(tmpl, `${HYDRA}mapping`, null, null).length).toBe(3);
  });

  it("adds hydra:next only when nextCursor is present; previous only on non-first pages", () => {
    const firstPage = toStore(
      buildFragmentQuads({
        pattern: {},
        triples: [],
        estimate: 0,
        itemsPerPage: 100,
        cursor: undefined,
        nextCursor: "CURSOR1",
      })
    );
    expect(
      firstPage.getQuads(endpoint, `${HYDRA}next`, null, null).length
    ).toBe(1);
    expect(
      firstPage.getQuads(endpoint, `${HYDRA}previous`, null, null).length
    ).toBe(0);

    const laterPage = toStore(
      buildFragmentQuads({
        pattern: {},
        triples: [],
        estimate: 0,
        itemsPerPage: 100,
        cursor: "CURSOR1",
        nextCursor: null,
      })
    );
    const frag = `${endpoint}?cursor=CURSOR1`;
    expect(laterPage.getQuads(frag, `${HYDRA}next`, null, null).length).toBe(0);
    expect(
      laterPage.getQuads(frag, `${HYDRA}previous`, null, null).length
    ).toBe(1);
  });
});
