// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * datasetDescription.test.ts — the VoID + DCAT-3 graph builders (DESIGN.md §4.2).
 *
 * Builds the quads, serialises to Turtle, parses back, and asserts the SW-conformant
 * shape: void:Dataset + dcat:Dataset, access methods, stats from the stats table,
 * vocabularies, the foaf:knows Linkset, dcterms:rights, void:exampleResource, the
 * SPARQL endpoint absent-by-default / present-when-on, and the / catalog's ldp:inbox
 * body triple + hydra:search.
 */

import { Store as N3Store, Parser } from "n3";
import { describe, expect, it } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import type { DatasetStats } from "@/lib/store/ports";

import {
  DATASET_DESCRIPTION_IRIS,
  buildRootCatalogQuads,
  buildVoidQuads,
} from "./datasetDescription";
import { DATASET_IRI } from "./vocab";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const VOID = "http://rdfs.org/ns/void#";
const DCAT = "http://www.w3.org/ns/dcat#";
const DCT = "http://purl.org/dc/terms/";
const LDP = "http://www.w3.org/ns/ldp#";
const HYDRA = "http://www.w3.org/ns/hydra/core#";
const SD = "http://www.w3.org/ns/sparql-service-description#";
const FOAF = "http://xmlns.com/foaf/0.1/";

function parseTurtle(ttl: string): Promise<N3Store> {
  return new Promise((resolve, reject) => {
    const s = new N3Store();
    new Parser({ baseIRI: INDEX_BASE_URL }).parse(ttl, (err, q) => {
      if (err) reject(err);
      else if (q) s.addQuad(q);
      else resolve(s);
    });
  });
}

import { serializeTurtle } from "@/lib/http/conneg";

async function toStore(quads: Parameters<typeof serializeTurtle>[0]) {
  return parseTurtle(await serializeTurtle(quads));
}

const STATS: DatasetStats = {
  triples: 42,
  entities: 7,
  classes: 2,
  properties: 3,
  classPartitions: [
    { classIri: `${FOAF}Person`, entities: 7 },
    { classIri: `${FOAF}Agent`, entities: 3 },
  ],
  propertyPartitions: [
    { propertyIri: `${FOAF}knows`, triples: 12 },
    { propertyIri: `${FOAF}name`, triples: 7 },
    { propertyIri: `${RDF}type`, triples: 10 },
  ],
};

describe("buildVoidQuads", () => {
  it("types the dataset as both void:Dataset and dcat:Dataset", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    const types = store
      .getQuads(DATASET_IRI, `${RDF}type`, null, null)
      .map((q) => q.object.value);
    expect(types).toContain(`${VOID}Dataset`);
    expect(types).toContain(`${DCAT}Dataset`);
  });

  it("emits the stats from the stats table (triples / entities / classes / properties)", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    expect(
      store.getQuads(DATASET_IRI, `${VOID}triples`, null, null)[0]?.object.value
    ).toBe("42");
    expect(
      store.getQuads(DATASET_IRI, `${VOID}entities`, null, null)[0]?.object
        .value
    ).toBe("7");
    expect(
      store.getQuads(DATASET_IRI, `${VOID}classes`, null, null)[0]?.object.value
    ).toBe("2");
    expect(
      store.getQuads(DATASET_IRI, `${VOID}properties`, null, null)[0]?.object
        .value
    ).toBe("3");
  });

  it("emits a void:classPartition and void:propertyPartition per partition", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    const classParts = store.getQuads(
      DATASET_IRI,
      `${VOID}classPartition`,
      null,
      null
    );
    expect(classParts.length).toBe(2);
    // Each partition node has a void:class + void:entities.
    for (const cp of classParts) {
      expect(store.getQuads(cp.object, `${VOID}class`, null, null).length).toBe(
        1
      );
      expect(
        store.getQuads(cp.object, `${VOID}entities`, null, null).length
      ).toBe(1);
    }
    const propParts = store.getQuads(
      DATASET_IRI,
      `${VOID}propertyPartition`,
      null,
      null
    );
    expect(propParts.length).toBe(3);
    for (const pp of propParts) {
      expect(
        store.getQuads(pp.object, `${VOID}property`, null, null).length
      ).toBe(1);
      expect(
        store.getQuads(pp.object, `${VOID}triples`, null, null).length
      ).toBe(1);
    }
  });

  it("advertises the TPF endpoint as void:uriLookupEndpoint", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    expect(
      store.getQuads(DATASET_IRI, `${VOID}uriLookupEndpoint`, null, null)[0]
        ?.object.value
    ).toBe(DATASET_DESCRIPTION_IRIS.tpfEndpoint);
  });

  it("emits a PAGED void:dataDump distribution (not a live function)", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    const dump = store.getQuads(DATASET_IRI, `${VOID}dataDump`, null, null)[0]
      ?.object.value;
    expect(dump).toBe(DATASET_DESCRIPTION_IRIS.dump);
    // It is also a dcat:Distribution.
    expect(
      store.getQuads(
        DATASET_DESCRIPTION_IRIS.dump,
        `${RDF}type`,
        `${DCAT}Distribution`,
        null
      ).length
    ).toBe(1);
  });

  it("emits void:vocabulary for the vocabularies the dataset uses", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    const vocabs = store
      .getQuads(DATASET_IRI, `${VOID}vocabulary`, null, null)
      .map((q) => q.object.value);
    expect(vocabs).toContain(FOAF);
    expect(vocabs).toContain(VOID);
    expect(vocabs).toContain(`${INDEX_BASE_URL}/ns#`);
  });

  it("emits a void:Linkset for foaf:knows with the link predicate", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    const linkset = DATASET_DESCRIPTION_IRIS.knowsLinkset;
    expect(
      store.getQuads(linkset, `${RDF}type`, `${VOID}Linkset`, null).length
    ).toBe(1);
    expect(
      store.getQuads(linkset, `${VOID}linkPredicate`, `${FOAF}knows`, null)
        .length
    ).toBe(1);
    // The linkset triple count mirrors the foaf:knows property partition (12).
    expect(
      store.getQuads(linkset, `${VOID}triples`, null, null)[0]?.object.value
    ).toBe("12");
  });

  it("emits dcterms:rights clarifying PII ownership", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    const rights = store.getQuads(DATASET_IRI, `${DCT}rights`, null, null);
    expect(rights.length).toBe(1);
    expect(rights[0].object.value.toLowerCase()).toContain("personal data");
  });

  it("void:exampleResource points at a real /p/{slug} when given a slug", async () => {
    const slug = "abcdefghijklmnopqrstuvwx"; // 24-char base32-shaped
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: slug })
    );
    const example = store.getQuads(
      DATASET_IRI,
      `${VOID}exampleResource`,
      null,
      null
    );
    expect(example.length).toBe(1);
    expect(example[0].object.value).toBe(`${INDEX_BASE_URL}/p/${slug}`);
  });

  it("omits void:exampleResource when the index is empty (no dangling example)", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    expect(
      store.getQuads(DATASET_IRI, `${VOID}exampleResource`, null, null).length
    ).toBe(0);
  });

  it("does NOT advertise a SPARQL endpoint when the flag is OFF (default)", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    expect(
      store.getQuads(DATASET_IRI, `${VOID}sparqlEndpoint`, null, null).length
    ).toBe(0);
    expect(
      store.getQuads(null, `${RDF}type`, `${SD}Service`, null).length
    ).toBe(0);
  });

  it("DOES advertise the SPARQL endpoint + sd:Service when the flag is ON", async () => {
    const store = await toStore(
      buildVoidQuads(STATS, { sparqlEnabled: true, exampleSlug: null })
    );
    expect(
      store.getQuads(DATASET_IRI, `${VOID}sparqlEndpoint`, null, null)[0]
        ?.object.value
    ).toBe(DATASET_DESCRIPTION_IRIS.sparqlEndpoint);
    expect(
      store.getQuads(null, `${RDF}type`, `${SD}Service`, null).length
    ).toBe(1);
  });
});

describe("buildRootCatalogQuads (GET /)", () => {
  it("emits a dcat:Catalog + dcat:Dataset", async () => {
    const store = await toStore(
      buildRootCatalogQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    expect(
      store.getQuads(
        DATASET_DESCRIPTION_IRIS.catalog,
        `${RDF}type`,
        `${DCAT}Catalog`,
        null
      ).length
    ).toBe(1);
    expect(
      store.getQuads(DATASET_IRI, `${RDF}type`, `${DCAT}Dataset`, null).length
    ).toBe(1);
  });

  it("emits the </inbox/> ldp:inbox triple IN THE BODY", async () => {
    const store = await toStore(
      buildRootCatalogQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    const inbox = store.getQuads(INDEX_BASE_URL, `${LDP}inbox`, null, null);
    expect(inbox.length).toBe(1);
    expect(inbox[0].object.value).toBe(DATASET_DESCRIPTION_IRIS.inbox);
  });

  it("emits a dcat:DataService for search and TPF", async () => {
    const store = await toStore(
      buildRootCatalogQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    const services = store
      .getQuads(DATASET_DESCRIPTION_IRIS.catalog, `${DCAT}service`, null, null)
      .map((q) => q.object.value);
    expect(services).toContain(DATASET_DESCRIPTION_IRIS.searchService);
    expect(services).toContain(DATASET_DESCRIPTION_IRIS.tpfService);
    // Each is a dcat:DataService.
    expect(
      store.getQuads(
        DATASET_DESCRIPTION_IRIS.tpfService,
        `${RDF}type`,
        `${DCAT}DataService`,
        null
      ).length
    ).toBe(1);
  });

  it("does NOT advertise a SPARQL DataService when the flag is OFF", async () => {
    const store = await toStore(
      buildRootCatalogQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    const services = store
      .getQuads(DATASET_DESCRIPTION_IRIS.catalog, `${DCAT}service`, null, null)
      .map((q) => q.object.value);
    expect(services).not.toContain(DATASET_DESCRIPTION_IRIS.sparqlService);
  });

  it("emits a hydra:search IriTemplate entrypoint with one mapping → idx:searchText", async () => {
    const store = await toStore(
      buildRootCatalogQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    const tmpl = store.getQuads(INDEX_BASE_URL, `${HYDRA}search`, null, null)[0]
      ?.object;
    expect(tmpl).toBeTruthy();
    if (!tmpl) return;
    expect(
      store.getQuads(tmpl, `${RDF}type`, `${HYDRA}IriTemplate`, null).length
    ).toBe(1);
    const mapping = store.getQuads(tmpl, `${HYDRA}mapping`, null, null)[0]
      ?.object;
    expect(mapping).toBeTruthy();
    if (!mapping) return;
    expect(
      store.getQuads(
        mapping,
        `${HYDRA}property`,
        `${INDEX_BASE_URL}/ns#searchText`,
        null
      ).length
    ).toBe(1);
  });

  it("carries the dataset stats so a single GET / gives the headline numbers", async () => {
    const store = await toStore(
      buildRootCatalogQuads(STATS, { sparqlEnabled: false, exampleSlug: null })
    );
    expect(
      store.getQuads(DATASET_IRI, `${VOID}triples`, null, null)[0]?.object.value
    ).toBe("42");
    expect(
      store.getQuads(DATASET_IRI, `${VOID}entities`, null, null)[0]?.object
        .value
    ).toBe("7");
  });
});
