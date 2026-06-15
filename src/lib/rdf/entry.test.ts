// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * entry.test.ts — the DESCRIBE-ONLY entry graph (DESIGN.md §2.3 / §4.1, sw H3 + M4).
 *
 * Asserts:
 *  - the agent's identity is the UPSTREAM WebID (foaf:primaryTopic of <>)
 *  - NO minted `<>#me a foaf:Person` — the describe-only invariant
 *  - provenance: dcterms:source / prov:wasDerivedFrom / dcterms:modified
 *  - void:inDataset + idx:crawlState (a skos:Concept IRI, not a literal)
 *  - foaf:knows objects are upstream WebIDs, NEVER $ORIGIN/p/... index URLs (sw M4)
 *  - idx:lastCrawl is NOT emitted
 *  - non-https foaf:img is dropped
 */

import { Store as N3Store } from "n3";
import { describe, expect, it } from "vitest";

import { buildEntryQuads } from "./entry";
import { DATASET_IRI, IDX_ENTRY, IDX_LIVE, IDX_NS } from "./vocab";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const DCT = "http://purl.org/dc/terms/";
const PROV = "http://www.w3.org/ns/prov#";
const VOID = "http://rdfs.org/ns/void#";

const ENTRY_URL = "https://idx.example/p/aaaaaaaaaaaaaaaaaaaaaaaa";
const DOC_URL = "https://alice.pod/card";
const WEBID = "https://alice.pod/card#me";

function build(overrides?: {
  knows?: string[];
  photoUrl?: string;
  state?: string;
  nextEligibleAt?: number;
  now?: number;
}): N3Store {
  const now = overrides?.now ?? 2_000_000;
  const quads = buildEntryQuads({
    entryUrl: ENTRY_URL,
    docUrl: DOC_URL,
    projection: {
      webId: WEBID,
      name: "Alice",
      photoUrl: overrides?.photoUrl ?? "https://alice.pod/avatar.png",
      oidcIssuers: ["https://idp.example"],
      storageUrls: ["https://alice.pod/"],
      knows: overrides?.knows ?? ["https://bob.pod/card#me"],
    },
    lastCrawled: 1_500_000,
    state: overrides?.state ?? "done",
    nextEligibleAt: overrides?.nextEligibleAt ?? now + 1000,
    now,
  });
  const store = new N3Store();
  for (const q of quads) store.addQuad(q);
  return store;
}

describe("buildEntryQuads — describe-only invariant", () => {
  it("the upstream WebID is the foaf:primaryTopic of the entry doc", () => {
    const s = build();
    const topic = s.getQuads(ENTRY_URL, `${FOAF}primaryTopic`, null, null);
    expect(topic.length).toBe(1);
    expect(topic[0].object.value).toBe(WEBID);
  });

  it("the entry doc is typed idx:Entry + foaf:PersonalProfileDocument (NOT foaf:Person)", () => {
    const s = build();
    const types = s
      .getQuads(ENTRY_URL, `${RDF}type`, null, null)
      .map((q) => q.object.value);
    expect(types).toContain(IDX_ENTRY.value);
    expect(types).toContain(`${FOAF}PersonalProfileDocument`);
    expect(types).not.toContain(`${FOAF}Person`);
  });

  it("NEVER mints `$ORIGIN/p/{slug}#me a foaf:Person` (the 5-star violation)", () => {
    const s = build();
    // No subject under the entry-URL namespace is typed foaf:Person.
    const persons = s.getQuads(null, `${RDF}type`, `${FOAF}Person`, null);
    for (const q of persons) {
      expect(q.subject.value.startsWith(`${ENTRY_URL}`)).toBe(false);
      expect(q.subject.value.startsWith("https://idx.example/p/")).toBe(false);
    }
    // Specifically, neither <ENTRY_URL#me> nor <ENTRY_URL> is described as a Person.
    expect(s.getQuads(`${ENTRY_URL}#me`, null, null, null).length).toBe(0);
  });

  it("the WebID points back at the description doc (foaf:isPrimaryTopicOf)", () => {
    const s = build();
    const back = s.getQuads(WEBID, `${FOAF}isPrimaryTopicOf`, null, null);
    expect(back.length).toBe(1);
    expect(back[0].object.value).toBe(ENTRY_URL);
  });

  it("emits provenance: dcterms:source + prov:wasDerivedFrom → the source doc", () => {
    const s = build();
    expect(s.getQuads(ENTRY_URL, `${DCT}source`, DOC_URL, null).length).toBe(1);
    expect(
      s.getQuads(ENTRY_URL, `${PROV}wasDerivedFrom`, DOC_URL, null).length
    ).toBe(1);
  });

  it("emits dcterms:modified + prov:generatedAtTime (NOT idx:lastCrawl)", () => {
    const s = build();
    expect(s.getQuads(ENTRY_URL, `${DCT}modified`, null, null).length).toBe(1);
    expect(
      s.getQuads(ENTRY_URL, `${PROV}generatedAtTime`, null, null).length
    ).toBe(1);
    // idx:lastCrawl must never appear.
    expect(s.getQuads(null, `${IDX_NS}lastCrawl`, null, null).length).toBe(0);
  });

  it("emits void:inDataset and idx:crawlState as a skos:Concept IRI (not a literal)", () => {
    const s = build();
    const inDataset = s.getQuads(ENTRY_URL, `${VOID}inDataset`, null, null);
    expect(inDataset.length).toBe(1);
    expect(inDataset[0].object.value).toBe(DATASET_IRI);

    const crawlState = s.getQuads(ENTRY_URL, `${IDX_NS}crawlState`, null, null);
    expect(crawlState.length).toBe(1);
    // It is a NamedNode (IRI), not a string literal.
    expect(crawlState[0].object.termType).toBe("NamedNode");
    expect(crawlState[0].object.value).toBe(IDX_LIVE.value);
  });

  it("foaf:knows objects are upstream WebIDs, NEVER index URLs (sw M4)", () => {
    const s = build({
      knows: ["https://bob.pod/card#me", "https://carol.pod/profile#me"],
    });
    const knows = s.getQuads(WEBID, `${FOAF}knows`, null, null);
    expect(knows.length).toBe(2);
    for (const q of knows) {
      expect(q.object.termType).toBe("NamedNode");
      // Must be the upstream WebID — never rewritten to a /p/{slug} index URL.
      expect(q.object.value.startsWith("https://idx.example/p/")).toBe(false);
    }
    const objs = knows.map((q) => q.object.value).sort();
    expect(objs).toEqual([
      "https://bob.pod/card#me",
      "https://carol.pod/profile#me",
    ]);
  });

  it("drops a non-https foaf:img (javascript:/data: avatar defence)", () => {
    const s = build({ photoUrl: "javascript:alert(1)" });
    expect(s.getQuads(WEBID, `${FOAF}img`, null, null).length).toBe(0);
  });

  it("keeps an https foaf:img", () => {
    const s = build({ photoUrl: "https://alice.pod/avatar.png" });
    const img = s.getQuads(WEBID, `${FOAF}img`, null, null);
    expect(img.length).toBe(1);
    expect(img[0].object.value).toBe("https://alice.pod/avatar.png");
  });

  it("idx:crawlState reflects an overdue doc as Stale", () => {
    const now = 2_000_000;
    const s = build({ state: "done", nextEligibleAt: now - 1, now });
    const cs = s.getQuads(ENTRY_URL, `${IDX_NS}crawlState`, null, null);
    expect(cs[0].object.value).toBe(`${IDX_NS}Stale`);
  });
});
