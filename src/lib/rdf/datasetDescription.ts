// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/rdf/datasetDescription.ts — the VoID + DCAT-3 dataset & service description
 * graphs (DESIGN.md §4.2).  SW-conformance: a 5★ Linked-Data dataset.
 *
 * Two builders, both emitting RDF/JS quads via the n3 DataFactory (NEVER
 * hand-concatenated triples — house rule); serialise through lib/http/conneg.ts:
 *
 *   buildVoidQuads(stats, opts)     → GET /.well-known/void
 *     A `void:Dataset` + `dcat:Dataset` describing the index:
 *       - access methods: `void:uriLookupEndpoint` = the TPF endpoint;
 *         `void:dataDump` → a PAGED dump (a dcat:Distribution / Blob URL, NOT a live
 *         function — capped to the 4.5 MB function-body limit; arch H1);
 *       - stats from the incremental `stats` table: void:triples / void:entities /
 *         void:classes / void:properties + void:classPartition / void:propertyPartition;
 *       - `void:vocabulary` for every vocabulary the dataset uses;
 *       - a `void:Linkset` for the outbound `foaf:knows` links (★★★★★);
 *       - `dcterms:rights` clarifying that indexed PII remains the subjects' (the
 *         licence covers the index STRUCTURE only — sw L2);
 *       - the SPARQL service is advertised ONLY when the flag is on (absent by
 *         default — sw M2: never advertise an endpoint that would 404).
 *
 *   buildRootCatalogQuads(stats, opts) → GET / (RDF branch)
 *     A `dcat:Catalog` + `dcat:Dataset` + `dcat:DataService` (search + TPF), the
 *     `</inbox/> ldp:inbox` triple emitted IN THE BODY (the sibling advertises the
 *     same via a root Link header — both are required), and a `hydra:search`
 *     entrypoint pointing at /search.
 *
 * @see docs/DESIGN.md §4.2 / §9
 */

import type { NamedNode, Quad } from "@rdfjs/types";
import { DataFactory } from "n3";

import { INDEX_BASE_URL } from "../config";
import type { DatasetStats } from "../store/ports";
import { DATASET_IRI } from "./vocab";

const { namedNode, literal, blankNode, quad: q } = DataFactory;

// ─── Namespaces ────────────────────────────────────────────────────────────────

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const VOID = "http://rdfs.org/ns/void#";
const DCAT = "http://www.w3.org/ns/dcat#";
const DCT = "http://purl.org/dc/terms/";
const DCTYPE = "http://purl.org/dc/dcmitype/";
const HYDRA = "http://www.w3.org/ns/hydra/core#";
const LDP = "http://www.w3.org/ns/ldp#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const SD = "http://www.w3.org/ns/sparql-service-description#";

const rdf = (l: string) => namedNode(`${RDF}${l}`);
const rdfs = (l: string) => namedNode(`${RDFS}${l}`);
const voidNs = (l: string) => namedNode(`${VOID}${l}`);
const dcat = (l: string) => namedNode(`${DCAT}${l}`);
const dct = (l: string) => namedNode(`${DCT}${l}`);
const hy = (l: string) => namedNode(`${HYDRA}${l}`);
const sd = (l: string) => namedNode(`${SD}${l}`);

const xsdNonNegInt = namedNode(`${XSD}nonNegativeInteger`);

// ─── Resource IRIs (stable; relative to $ORIGIN) ─────────────────────────────────

/** The dataset resource — `$ORIGIN/#dataset` (shared with entries' void:inDataset). */
const DATASET = namedNode(DATASET_IRI);
/** The DCAT catalog resource — `$ORIGIN/#catalog`. */
const CATALOG_IRI = `${INDEX_BASE_URL}/#catalog`;
/** The VoID document IRI — `$ORIGIN/.well-known/void`. */
const VOID_DOC_IRI = `${INDEX_BASE_URL}/.well-known/void`;
/** The search DataService — `$ORIGIN/#search-service`. */
const SEARCH_SERVICE_IRI = `${INDEX_BASE_URL}/#search-service`;
/** The TPF DataService — `$ORIGIN/#tpf-service`. */
const TPF_SERVICE_IRI = `${INDEX_BASE_URL}/#tpf-service`;
/** The SPARQL DataService — `$ORIGIN/#sparql-service` (only when the flag is on). */
const SPARQL_SERVICE_IRI = `${INDEX_BASE_URL}/#sparql-service`;
/** The foaf:knows Linkset — `$ORIGIN/#knows-linkset`. */
const KNOWS_LINKSET_IRI = `${INDEX_BASE_URL}/#knows-linkset`;
/** The paged data-dump distribution — `$ORIGIN/dump` (paged; NOT a live full dump). */
const DUMP_IRI = `${INDEX_BASE_URL}/dump`;
/** The TPF endpoint — `$ORIGIN/tpf` (the void:uriLookupEndpoint / DataService access). */
const TPF_ENDPOINT_IRI = `${INDEX_BASE_URL}/tpf`;
/** The search endpoint — `$ORIGIN/search`. */
const SEARCH_ENDPOINT_IRI = `${INDEX_BASE_URL}/search`;
/** The SPARQL endpoint — `$ORIGIN/sparql` (only when the flag is on). */
const SPARQL_ENDPOINT_IRI = `${INDEX_BASE_URL}/sparql`;
/** The LDN inbox — `$ORIGIN/inbox/`. */
const INBOX_IRI = `${INDEX_BASE_URL}/inbox/`;

/** The example resource — a real /p/{slug} that dereferences (void:exampleResource). */
function exampleResourceIri(slug: string): string {
  return `${INDEX_BASE_URL}/p/${slug}`;
}

// ─── Vocabularies declared via void:vocabulary ───────────────────────────────────

/** Namespaces the dataset uses — emitted as `void:vocabulary` (5★ self-description). */
const VOCABULARIES: readonly string[] = [
  FOAF,
  "http://www.w3.org/2006/vcard/ns#",
  "https://schema.org/",
  "http://www.w3.org/ns/solid/terms#",
  "http://www.w3.org/ns/pim/space#",
  DCT,
  "http://www.w3.org/ns/prov#",
  "http://www.w3.org/2004/02/skos/core#",
  LDP,
  VOID,
  DCAT,
  `${INDEX_BASE_URL}/ns#`, // the minted idx: namespace
];

/** The foaf:knows predicate IRI — the Linkset's void:linkPredicate. */
const FOAF_KNOWS = `${FOAF}knows`;

// ─── Shared options ──────────────────────────────────────────────────────────────

/** Common inputs both builders take. */
export interface DatasetDescriptionOptions {
  /**
   * Whether the optional SPARQL endpoint is enabled.  When false (the default on
   * Hobby), NO `void:sparqlEndpoint` / `sd:Service` / SPARQL `dcat:DataService` is
   * emitted — the index never advertises an endpoint that would 404 (sw M2).
   */
  sparqlEnabled: boolean;
  /**
   * The slug of one indexed entry to advertise as `void:exampleResource`
   * (dereferences to a real `/p/{slug}`), or null when the index is empty (the
   * triple is then omitted — a dangling example would not dereference).
   */
  exampleSlug: string | null;
}

// ─── Stats triples (shared by both graphs) ───────────────────────────────────────

/**
 * Emit the VoID statistics for the dataset subject: the four totals plus the
 * class / property partitions.  Read O(1) from the incremental `stats` table by the
 * caller — these triples never trigger a live COUNT (arch M1).
 */
function statsQuads(subject: NamedNode, stats: DatasetStats): Quad[] {
  const quads: Quad[] = [];
  const count = (pred: string, n: number) =>
    quads.push(q(subject, voidNs(pred), literal(String(n), xsdNonNegInt)));

  count("triples", stats.triples);
  count("entities", stats.entities);
  count("classes", stats.classes);
  count("properties", stats.properties);
  // documents = entities here (one served entry document per indexed WebID).
  count("documents", stats.entities);

  for (const cp of stats.classPartitions) {
    const part = blankNode(`classPart_${hashFragment(cp.classIri)}`);
    quads.push(q(subject, voidNs("classPartition"), part));
    quads.push(q(part, voidNs("class"), namedNode(cp.classIri)));
    quads.push(
      q(part, voidNs("entities"), literal(String(cp.entities), xsdNonNegInt))
    );
  }
  for (const pp of stats.propertyPartitions) {
    const part = blankNode(`propPart_${hashFragment(pp.propertyIri)}`);
    quads.push(q(subject, voidNs("propertyPartition"), part));
    quads.push(q(part, voidNs("property"), namedNode(pp.propertyIri)));
    quads.push(
      q(part, voidNs("triples"), literal(String(pp.triples), xsdNonNegInt))
    );
  }
  return quads;
}

/** A stable, safe blank-node label fragment derived from an IRI (no special chars). */
function hashFragment(iri: string): string {
  // n3 blank-node labels must be safe identifiers; replace anything non-word.
  return iri.replace(/[^A-Za-z0-9]/g, "_").slice(0, 64);
}

// ─── buildVoidQuads — GET /.well-known/void ──────────────────────────────────────

/**
 * Build the VoID + DCAT-3 dataset description served at `/.well-known/void`.
 */
export function buildVoidQuads(
  stats: DatasetStats,
  opts: DatasetDescriptionOptions
): Quad[] {
  const quads: Quad[] = [];
  const voidDoc = namedNode(VOID_DOC_IRI);

  // ── The VoID document <> describes the dataset (foaf:primaryTopic) ───────────
  quads.push(q(voidDoc, rdf("type"), voidNs("DatasetDescription")));
  quads.push(q(voidDoc, namedNode(`${FOAF}primaryTopic`), DATASET));

  // ── The dataset resource ──────────────────────────────────────────────────────
  quads.push(q(DATASET, rdf("type"), voidNs("Dataset")));
  quads.push(q(DATASET, rdf("type"), dcat("Dataset")));
  quads.push(q(DATASET, dct("title"), literal("Solid WebID Index", "en")));
  quads.push(
    q(
      DATASET,
      dct("description"),
      literal(
        "A public, Linked-Data-native index of Solid WebIDs: name, OIDC issuer, storage, and the foaf:knows graph, derived by crawling published WebID profiles.",
        "en"
      )
    )
  );
  // dct:type → a DCMI Dataset.
  quads.push(q(DATASET, dct("type"), namedNode(`${DCTYPE}Dataset`)));

  // dcterms:rights — clarify PII ownership: the index licenses its STRUCTURE only;
  // each indexed person's data remains theirs (sw L2).
  quads.push(
    q(
      DATASET,
      dct("rights"),
      literal(
        "The structure and metadata of this index are openly available. Personal data describing each indexed WebID remains owned and controlled by that WebID's subject; indexing does not transfer any rights. Subjects may opt out / request erasure (see the opt-out endpoint).",
        "en"
      )
    )
  );

  // ── Stats (from the incremental stats table — O(1)) ─────────────────────────
  quads.push(...statsQuads(DATASET, stats));

  // ── Vocabularies used (5★ self-description) ─────────────────────────────────
  for (const v of VOCABULARIES) {
    quads.push(q(DATASET, voidNs("vocabulary"), namedNode(v)));
  }

  // ── Access methods ──────────────────────────────────────────────────────────
  // void:uriLookupEndpoint = the TPF endpoint (the way to look triples up by URI).
  quads.push(
    q(DATASET, voidNs("uriLookupEndpoint"), namedNode(TPF_ENDPOINT_IRI))
  );
  // void:rootResource — the catalog landing page.
  quads.push(q(DATASET, voidNs("rootResource"), namedNode(INDEX_BASE_URL)));

  // void:exampleResource — a real /p/{slug} that dereferences (when non-empty).
  if (opts.exampleSlug) {
    quads.push(
      q(
        DATASET,
        voidNs("exampleResource"),
        namedNode(exampleResourceIri(opts.exampleSlug))
      )
    );
  }

  // void:dataDump → a PAGED dump distribution (a Blob/file URL, NOT a live function
  // — the 4.5 MB function-body cap means we never serve a live full dump; arch H1).
  quads.push(q(DATASET, voidNs("dataDump"), namedNode(DUMP_IRI)));
  // Describe the dump as a dcat:Distribution so DCAT consumers see it too.
  const dump = namedNode(DUMP_IRI);
  quads.push(q(DATASET, dcat("distribution"), dump));
  quads.push(q(dump, rdf("type"), dcat("Distribution")));
  quads.push(q(dump, dct("title"), literal("Paged N-Triples data dump", "en")));
  quads.push(
    q(
      dump,
      dct("description"),
      literal(
        "A paginated dump of the index (follow hydra:next). NOT a single live full-dump function: each page is capped well under the 4.5 MB serverless function-body limit.",
        "en"
      )
    )
  );
  quads.push(q(dump, dcat("mediaType"), literal("application/n-triples")));
  quads.push(q(dump, dcat("accessURL"), dump));

  // ── foaf:knows Linkset (★★★★★ — the outbound link graph as a first-class VoID
  // Linkset) ──────────────────────────────────────────────────────────────────
  const linkset = namedNode(KNOWS_LINKSET_IRI);
  quads.push(q(DATASET, voidNs("subset"), linkset));
  quads.push(q(linkset, rdf("type"), voidNs("Linkset")));
  quads.push(q(linkset, voidNs("linkPredicate"), namedNode(FOAF_KNOWS)));
  // The linkset's subjects are in THIS dataset; its objects are the linked WebIDs.
  quads.push(q(linkset, voidNs("subjectsTarget"), DATASET));
  quads.push(q(linkset, voidNs("objectsTarget"), DATASET));
  // The triple count of the linkset = the foaf:knows property-partition count (when
  // present in stats) — keeps the Linkset cardinality consistent with the stats.
  const knowsPartition = stats.propertyPartitions.find(
    (p) => p.propertyIri === FOAF_KNOWS
  );
  if (knowsPartition) {
    quads.push(
      q(
        linkset,
        voidNs("triples"),
        literal(String(knowsPartition.triples), xsdNonNegInt)
      )
    );
  }

  // ── SPARQL endpoint — ONLY when the flag is on (sw M2: never advertise a 404) ──
  if (opts.sparqlEnabled) {
    quads.push(
      q(DATASET, voidNs("sparqlEndpoint"), namedNode(SPARQL_ENDPOINT_IRI))
    );
    quads.push(...sparqlServiceQuads());
  }

  return quads;
}

// ─── buildRootCatalogQuads — GET / (RDF branch) ──────────────────────────────────

/**
 * Build the DCAT catalog + service description served at `/` for machine clients.
 *
 * Emits:
 *   - `<$ORIGIN/#catalog> a dcat:Catalog` with the dataset + the data services;
 *   - the dataset (`dcat:Dataset` + `void:Dataset`) with its stats (so a single GET
 *     of `/` gives a machine the headline numbers without a second request);
 *   - `dcat:DataService` for search + TPF (and SPARQL only when enabled);
 *   - the `</inbox/> ldp:inbox` triple IN THE BODY (the sibling also sets the root
 *     `ldp:inbox` Link header — BOTH are required: header for discovery, body triple
 *     for an RDF consumer that reads the graph);
 *   - a `hydra:search` IriTemplate entrypoint → /search.
 */
export function buildRootCatalogQuads(
  stats: DatasetStats,
  opts: DatasetDescriptionOptions
): Quad[] {
  const quads: Quad[] = [];
  const root = namedNode(INDEX_BASE_URL);
  const catalog = namedNode(CATALOG_IRI);

  // ── The catalog ───────────────────────────────────────────────────────────────
  quads.push(q(catalog, rdf("type"), dcat("Catalog")));
  quads.push(q(catalog, dct("title"), literal("Solid WebID Index", "en")));
  quads.push(
    q(
      catalog,
      dct("description"),
      literal(
        "A public, Linked-Data-native catalog of Solid WebIDs with full-text search and a Triple Pattern Fragments query interface.",
        "en"
      )
    )
  );
  // The landing page <> is the catalog's homepage / identifies it.
  quads.push(q(root, namedNode(`${FOAF}primaryTopic`), catalog));
  quads.push(q(catalog, dcat("dataset"), DATASET));

  // ── ldp:inbox IN THE BODY (DESIGN.md §4.2 / §4.3 — body triple AND header) ────
  quads.push(q(root, namedNode(`${LDP}inbox`), namedNode(INBOX_IRI)));

  // ── The dataset (with stats, so / answers the headline numbers too) ──────────
  quads.push(q(DATASET, rdf("type"), dcat("Dataset")));
  quads.push(q(DATASET, rdf("type"), voidNs("Dataset")));
  quads.push(q(DATASET, dct("title"), literal("Solid WebID Index", "en")));
  quads.push(q(DATASET, rdfs("seeAlso"), namedNode(VOID_DOC_IRI)));
  quads.push(...statsQuads(DATASET, stats));

  // ── DataServices: search + TPF (+ SPARQL only when enabled) ──────────────────
  // Search service.
  const search = namedNode(SEARCH_SERVICE_IRI);
  quads.push(q(catalog, dcat("service"), search));
  quads.push(q(search, rdf("type"), dcat("DataService")));
  quads.push(q(search, dct("title"), literal("WebID full-text search", "en")));
  quads.push(q(search, dcat("endpointURL"), namedNode(SEARCH_ENDPOINT_IRI)));
  quads.push(q(search, dcat("servesDataset"), DATASET));

  // TPF service.
  const tpf = namedNode(TPF_SERVICE_IRI);
  quads.push(q(catalog, dcat("service"), tpf));
  quads.push(q(tpf, rdf("type"), dcat("DataService")));
  quads.push(q(tpf, dct("title"), literal("Triple Pattern Fragments", "en")));
  quads.push(q(tpf, dcat("endpointURL"), namedNode(TPF_ENDPOINT_IRI)));
  quads.push(q(tpf, dcat("servesDataset"), DATASET));
  // The TPF conformance class as the endpoint description.
  quads.push(
    q(
      tpf,
      dcat("endpointDescription"),
      namedNode("http://www.w3.org/ns/hydra/core#")
    )
  );

  if (opts.sparqlEnabled) {
    const sparql = namedNode(SPARQL_SERVICE_IRI);
    quads.push(q(catalog, dcat("service"), sparql));
    quads.push(q(sparql, rdf("type"), dcat("DataService")));
    quads.push(q(sparql, dct("title"), literal("SPARQL query", "en")));
    quads.push(q(sparql, dcat("endpointURL"), namedNode(SPARQL_ENDPOINT_IRI)));
    quads.push(q(sparql, dcat("servesDataset"), DATASET));
  }

  // ── hydra:search entrypoint → /search ───────────────────────────────────────
  // One mapping, one property (idx:searchText), matching the /search route's
  // template so a Hydra client can drive search from the landing page (sw M3).
  const tmpl = blankNode("rootSearchTemplate");
  const mapping = blankNode("rootSearchMapping");
  quads.push(q(root, hy("search"), tmpl));
  quads.push(q(tmpl, rdf("type"), hy("IriTemplate")));
  quads.push(q(tmpl, hy("template"), literal(`${SEARCH_ENDPOINT_IRI}{?q}`)));
  quads.push(q(tmpl, hy("variableRepresentation"), hy("BasicRepresentation")));
  quads.push(q(tmpl, hy("mapping"), mapping));
  quads.push(q(mapping, rdf("type"), hy("IriTemplateMapping")));
  quads.push(q(mapping, hy("variable"), literal("q")));
  quads.push(
    q(mapping, hy("property"), namedNode(`${INDEX_BASE_URL}/ns#searchText`))
  );
  quads.push(
    q(mapping, hy("required"), literal("true", namedNode(`${XSD}boolean`)))
  );

  return quads;
}

// ─── SPARQL service-description quads (only emitted when enabled) ─────────────────

/**
 * The SPARQL 1.1 Service Description for the dataset (sd:Service), emitted ONLY when
 * the SPARQL flag is on.  Never emitted by default — advertising a disabled endpoint
 * would point clients at a 404 (sw M2).
 */
function sparqlServiceQuads(): Quad[] {
  const quads: Quad[] = [];
  const service = namedNode(SPARQL_SERVICE_IRI);
  quads.push(q(service, rdf("type"), sd("Service")));
  quads.push(q(service, sd("endpoint"), namedNode(SPARQL_ENDPOINT_IRI)));
  quads.push(q(service, sd("supportedLanguage"), sd("SPARQL11Query")));
  quads.push(
    q(
      service,
      sd("resultFormat"),
      namedNode("http://www.w3.org/ns/formats/SPARQL_Results_JSON")
    )
  );
  quads.push(q(service, sd("defaultDataset"), DATASET));
  return quads;
}

// ─── exported IRIs for the routes / tests ────────────────────────────────────────

export const DATASET_DESCRIPTION_IRIS = {
  dataset: DATASET_IRI,
  catalog: CATALOG_IRI,
  voidDoc: VOID_DOC_IRI,
  searchService: SEARCH_SERVICE_IRI,
  tpfService: TPF_SERVICE_IRI,
  sparqlService: SPARQL_SERVICE_IRI,
  knowsLinkset: KNOWS_LINKSET_IRI,
  dump: DUMP_IRI,
  tpfEndpoint: TPF_ENDPOINT_IRI,
  searchEndpoint: SEARCH_ENDPOINT_IRI,
  sparqlEndpoint: SPARQL_ENDPOINT_IRI,
  inbox: INBOX_IRI,
} as const;
