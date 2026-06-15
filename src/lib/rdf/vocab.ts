// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/rdf/vocab.ts — the minted `idx:` ontology (DESIGN.md §4.7) as RDF/JS quads.
 *
 * SINGLE SOURCE OF TRUTH for the index-operational vocabulary. Both the `/ns`
 * ontology document AND every entry document (`/p/{slug}` `idx:crawlState`) read
 * their term IRIs from here, so a term referenced from an entry ALWAYS dereferences
 * to a definition served by `/ns` (the term-dereference round-trip the bead requires).
 *
 * Terms (each with rdfs:label / rdfs:comment / rdfs:isDefinedBy <…/ns>):
 *   idx:Entry        (rdfs:Class)        — an index entry / description document
 *   idx:crawlState   (rdf:Property)      — range a skos:Concept (the three states)
 *   idx:Live         (skos:Concept)      — last crawl reachable + parsed
 *   idx:Unreachable  (skos:Concept)      — last crawl failed (4xx/5xx/network)
 *   idx:Stale        (skos:Concept)      — past its recrawl interval, not re-verified
 *   idx:noIndex      (rdf:Property)      — opt-out flag on a profile
 *   idx:optOutToken  (rdf:Property)      — challenge nonce for opt-out Path B
 *   idx:reason       (rdf:Property)      — tombstone / opt-out reason
 *   idx:searchText   (rdf:Property)      — the Hydra search variable property
 *   idx:suggestInbox (rdf:Property)      — the global suggest-inbox link
 *
 * The three crawl states are members of one skos:ConceptScheme (idx:CrawlStateScheme).
 *
 * NB: `idx:lastCrawl` is intentionally DROPPED — use dcterms:modified +
 * prov:generatedAtTime instead (DESIGN.md §4.7 / sw C3).
 *
 * Built with the n3 DataFactory (RDF/JS); serialised through lib/http/conneg.ts —
 * NEVER hand-concatenated Turtle (house rule).
 */

import type { NamedNode, Quad } from "@rdfjs/types";
import { DataFactory } from "n3";

import { INDEX_BASE_URL } from "../config";

const { namedNode, literal, quad: q } = DataFactory;

// ─── Namespaces ────────────────────────────────────────────────────────────────

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";
const DCT = "http://purl.org/dc/terms/";

/** The minted namespace IRI base (hash namespace) — `$ORIGIN/ns#`. */
export const IDX_NS = `${INDEX_BASE_URL}/ns#`;

/** The ontology document IRI — `$ORIGIN/ns` (what `rdfs:isDefinedBy` points to). */
export const NS_DOC_IRI = `${INDEX_BASE_URL}/ns`;

/** The dataset IRI (`void:inDataset` target on entries) — `$ORIGIN/#dataset`. */
export const DATASET_IRI = `${INDEX_BASE_URL}/#dataset`;

/** Build a minted `idx:` term named node. */
export function idx(localName: string): NamedNode {
  return namedNode(`${IDX_NS}${localName}`);
}

const rdf = (l: string) => namedNode(`${RDF}${l}`);
const rdfs = (l: string) => namedNode(`${RDFS}${l}`);
const skos = (l: string) => namedNode(`${SKOS}${l}`);
const dct = (l: string) => namedNode(`${DCT}${l}`);

// ─── Crawl-state IRIs (referenced from entry docs — keep stable) ─────────────────

/** `idx:Live` — last crawl reachable + parsed. */
export const IDX_LIVE = idx("Live");
/** `idx:Unreachable` — last crawl failed (HTTP error / network / parse refusal). */
export const IDX_UNREACHABLE = idx("Unreachable");
/** `idx:Stale` — past its recrawl interval, not re-verified. */
export const IDX_STALE = idx("Stale");
/** The skos:ConceptScheme the three states belong to. */
export const IDX_CRAWLSTATE_SCHEME = idx("CrawlStateScheme");

/** `idx:crawlState` property. */
export const IDX_CRAWLSTATE = idx("crawlState");
/** `idx:Entry` class. */
export const IDX_ENTRY = idx("Entry");
/** `idx:suggestInbox` property. */
export const IDX_SUGGEST_INBOX = idx("suggestInbox");

/**
 * Map a doc's crawl state + freshness to the appropriate `idx:` crawl-state Concept.
 *
 * - `done` and within its recrawl window → idx:Live
 * - `done` but past `nextEligibleAt` (overdue re-crawl) → idx:Stale
 * - `failed` / `skipped` / `blocked` → idx:Unreachable
 *
 * (Tombstoned docs never reach this — they are served 410, never described.)
 */
export function crawlStateConcept(opts: {
  state: string;
  nextEligibleAt: number;
  now: number;
}): NamedNode {
  const { state, nextEligibleAt, now } = opts;
  if (state === "done") {
    return nextEligibleAt > 0 && nextEligibleAt <= now ? IDX_STALE : IDX_LIVE;
  }
  // failed / skipped / blocked / pending / claimed — not currently verifiable.
  return IDX_UNREACHABLE;
}

// ─── Ontology document quads ─────────────────────────────────────────────────────

interface TermDef {
  /** The term local name under the idx: namespace. */
  name: string;
  /** rdf:type of the term (e.g. rdfs:Class, rdf:Property, skos:Concept). */
  types: NamedNode[];
  /** rdfs:label literal. */
  label: string;
  /** rdfs:comment literal. */
  comment: string;
  /** Optional extra quads (e.g. rdfs:range, skos:inScheme, skos:prefLabel). */
  extra?: (subject: NamedNode) => Quad[];
}

const TERMS: TermDef[] = [
  {
    name: "Entry",
    types: [rdfs("Class")],
    label: "Index Entry",
    comment:
      "An index description document that describes (by reference) an upstream WebID; the agent's identity remains the upstream WebID.",
  },
  {
    name: "crawlState",
    types: [rdf("Property")],
    label: "crawl state",
    comment:
      "The freshness/reachability state of the indexed source, as a skos:Concept (idx:Live, idx:Unreachable, or idx:Stale).",
    extra: (s) => [
      q(s, rdfs("range"), skos("Concept")),
      q(s, rdfs("domain"), IDX_ENTRY),
    ],
  },
  {
    name: "CrawlStateScheme",
    types: [skos("ConceptScheme")],
    label: "Crawl State scheme",
    comment:
      "The concept scheme enumerating the crawl-state values (Live, Unreachable, Stale).",
  },
  {
    name: "Live",
    types: [skos("Concept")],
    label: "Live",
    comment:
      "The source profile was reachable and successfully parsed at the last crawl, and is within its recrawl window.",
    extra: (s) => [
      q(s, skos("inScheme"), IDX_CRAWLSTATE_SCHEME),
      q(s, skos("prefLabel"), literal("Live", "en")),
    ],
  },
  {
    name: "Unreachable",
    types: [skos("Concept")],
    label: "Unreachable",
    comment:
      "The source profile could not be fetched or parsed at the last crawl (HTTP error, network failure, or content refused).",
    extra: (s) => [
      q(s, skos("inScheme"), IDX_CRAWLSTATE_SCHEME),
      q(s, skos("prefLabel"), literal("Unreachable", "en")),
    ],
  },
  {
    name: "Stale",
    types: [skos("Concept")],
    label: "Stale",
    comment:
      "The source profile is past its recrawl interval and has not yet been re-verified.",
    extra: (s) => [
      q(s, skos("inScheme"), IDX_CRAWLSTATE_SCHEME),
      q(s, skos("prefLabel"), literal("Stale", "en")),
    ],
  },
  {
    name: "noIndex",
    types: [rdf("Property")],
    label: "no index",
    comment:
      "When true on a source profile, requests that the WebID is not indexed (opt-out signal honoured at crawl time).",
  },
  {
    name: "optOutToken",
    types: [rdf("Property")],
    label: "opt-out token",
    comment:
      "A one-time challenge nonce published in an upstream profile to prove control for the challenge-response opt-out flow.",
  },
  {
    name: "reason",
    types: [rdf("Property")],
    label: "reason",
    comment:
      "A machine-readable reason for a tombstone or opt-out (e.g. opt-out, erasure, abuse, noindex).",
  },
  {
    name: "searchText",
    types: [rdf("Property")],
    label: "search text",
    comment:
      "The free-text query property bound by the Hydra search IriTemplate; the server matches it across name, WebID, and issuer.",
  },
  {
    name: "suggestInbox",
    types: [rdf("Property")],
    label: "suggest inbox",
    comment:
      "Links a resource to the LDN inbox where new WebIDs may be suggested for indexing (distinct from ldp:inbox).",
  },
];

/**
 * Build the full `idx:` ontology graph as RDF/JS quads.
 *
 * Emits, per term: rdf:type(s), rdfs:label, rdfs:comment, rdfs:isDefinedBy <…/ns>,
 * plus any term-specific extras (range/domain, skos:inScheme, skos:prefLabel).
 * The ontology document itself (`<…/ns>`) is typed owl:Ontology with a label and
 * dcterms:title so it is a self-describing resource.
 */
export function buildNamespaceQuads(): Quad[] {
  const quads: Quad[] = [];
  const nsDoc = namedNode(NS_DOC_IRI);

  // The ontology document resource.
  quads.push(q(nsDoc, rdf("type"), namedNode(`${OWL}Ontology`)));
  quads.push(
    q(nsDoc, rdfs("label"), literal("solid-webid-index operational vocabulary"))
  );
  quads.push(
    q(nsDoc, dct("title"), literal("solid-webid-index operational vocabulary"))
  );
  quads.push(
    q(
      nsDoc,
      dct("description"),
      literal(
        "Minted terms for index-operational metadata: entry typing, crawl state, opt-out, and search controls."
      )
    )
  );

  for (const term of TERMS) {
    const s = idx(term.name);
    for (const t of term.types) {
      quads.push(q(s, rdf("type"), t));
    }
    quads.push(q(s, rdfs("label"), literal(term.label)));
    quads.push(q(s, rdfs("comment"), literal(term.comment)));
    quads.push(q(s, rdfs("isDefinedBy"), nsDoc));
    if (term.extra) {
      quads.push(...term.extra(s));
    }
  }

  return quads;
}

/**
 * The list of every minted term IRI (full IRIs) — used by the round-trip test to
 * assert that every term the vocabulary mints is actually defined by `/ns`.
 */
export function mintedTermIris(): string[] {
  return TERMS.map((t) => `${IDX_NS}${t.name}`);
}
