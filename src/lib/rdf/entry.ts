// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/rdf/entry.ts — build the DESCRIBE-ONLY entry document graph for /p/{slug}.
 *
 * HOUSE INVARIANT (sw H3 / DESIGN.md §2.3): the agent's ONLY identity is the
 * UPSTREAM WebID (e.g. https://alice.pod/card#me). This document describes that
 * WebID BY REFERENCE — it MUST NEVER mint `$ORIGIN/p/{slug}#me a foaf:Person`
 * (that would create a duplicate, competing identity). The entry resource `<>`
 * (the description document URL) carries the provenance; the upstream WebID is
 * the foaf:primaryTopic.
 *
 * Triples emitted (all via @rdfjs/wrapper-style typed DataFactory accessors —
 * NEVER hand-concatenated):
 *   <entryUrl> a idx:Entry, foaf:PersonalProfileDocument ;
 *     foaf:primaryTopic <webid> ;
 *     foaf:topic        <webid> ;
 *     dcterms:source        <docUrl> ;
 *     prov:wasDerivedFrom   <docUrl> ;
 *     dcterms:modified      "…"^^xsd:dateTime ;
 *     prov:generatedAtTime  "…"^^xsd:dateTime ;
 *     void:inDataset        <$ORIGIN/#dataset> ;
 *     idx:crawlState        <…/ns#Live|Unreachable|Stale> .   (a skos:Concept IRI)
 *
 *   <webid> foaf:isPrimaryTopicOf <entryUrl> ;
 *     rdfs:seeAlso <docUrl> ;
 *     foaf:name "…" ;                 (when known — describing the upstream subject)
 *     foaf:img <…> ;                  (when known, https only)
 *     solid:oidcIssuer <…> ;          (when known)
 *     pim:storage <…> ;               (when known)
 *     foaf:knows <upstream-webid> … . (upstream WebIDs ONLY — never index URLs; sw M4)
 *
 * Source of the projected fields: the doc's reserialised canonical Turtle
 * (`raw_rdf`) re-parsed via the sanctioned parseProfile + extractWebIdProfile.
 * `idx:lastCrawl` is intentionally NOT emitted (dcterms:modified + prov:generatedAtTime
 * replace it — DESIGN.md §4.7).
 */

import type { NamedNode, Quad } from "@rdfjs/types";
import { DataFactory } from "n3";

import {
  DATASET_IRI,
  IDX_CRAWLSTATE,
  IDX_ENTRY,
  crawlStateConcept,
} from "./vocab";

const { namedNode, literal, quad: q } = DataFactory;

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const SOLID = "http://www.w3.org/ns/solid/terms#";
const PIM = "http://www.w3.org/ns/pim/space#";
const DCT = "http://purl.org/dc/terms/";
const PROV = "http://www.w3.org/ns/prov#";
const VOID = "http://rdfs.org/ns/void#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const foaf = (l: string) => namedNode(`${FOAF}${l}`);
const dct = (l: string) => namedNode(`${DCT}${l}`);
const prov = (l: string) => namedNode(`${PROV}${l}`);

const rdfType = namedNode(`${RDF}type`);
const xsdDateTime = namedNode(`${XSD}dateTime`);

/** The projected fields used to describe the upstream WebID. */
export interface EntryProjection {
  /** The upstream WebID IRI (the agent's only identity). */
  webId: string;
  /** Best-effort display name. */
  name?: string;
  /** Avatar/photo IRI (https only — non-https values must be dropped by the caller). */
  photoUrl?: string;
  /** solid:oidcIssuer values. */
  oidcIssuers: string[];
  /** pim:storage values. */
  storageUrls: string[];
  /** foaf:knows objects — ALWAYS upstream WebIDs (sw M4). */
  knows: string[];
}

/** Inputs to {@link buildEntryQuads}. */
export interface BuildEntryOptions {
  /** The entry document URL — `$ORIGIN/p/{slug}` (the `<>` resource). */
  entryUrl: string;
  /** The source profile document URL (dcterms:source / prov:wasDerivedFrom). */
  docUrl: string;
  /** The projected description of the upstream WebID. */
  projection: EntryProjection;
  /** epoch ms of the last crawl (→ dcterms:modified / prov:generatedAtTime). */
  lastCrawled: number;
  /** The doc's crawl state string (done/failed/…). */
  state: string;
  /** epoch ms — the doc's next-eligible recrawl instant (drives Live vs Stale). */
  nextEligibleAt: number;
  /** epoch ms — current time (drives Live vs Stale freshness). */
  now: number;
}

/**
 * Returns true when `iri` is a syntactically valid https IRI (the only photo/img
 * scheme served — defends against `javascript:` / `data:` avatar payloads).
 */
function isHttpsIri(iri: string): boolean {
  try {
    return new URL(iri).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build the describe-only entry graph.
 *
 * @returns the quad array (serialise via lib/http/conneg.ts).
 */
export function buildEntryQuads(opts: BuildEntryOptions): Quad[] {
  const {
    entryUrl,
    docUrl,
    projection,
    lastCrawled,
    state,
    nextEligibleAt,
    now,
  } = opts;

  const entry: NamedNode = namedNode(entryUrl);
  const webid: NamedNode = namedNode(projection.webId);
  const source: NamedNode = namedNode(docUrl);

  const quads: Quad[] = [];

  // ── The entry resource <> (the DESCRIPTION DOCUMENT — NOT the person) ─────────
  quads.push(q(entry, rdfType, IDX_ENTRY));
  // foaf:PersonalProfileDocument: this <> is a document about a person, by reference.
  quads.push(q(entry, rdfType, foaf("PersonalProfileDocument")));

  // primaryTopic / topic → the upstream WebID (the agent's only identity).
  quads.push(q(entry, foaf("primaryTopic"), webid));
  quads.push(q(entry, foaf("topic"), webid));

  // Provenance: where this description was derived from.
  quads.push(q(entry, dct("source"), source));
  quads.push(q(entry, prov("wasDerivedFrom"), source));

  // Freshness (dcterms:modified + prov:generatedAtTime — NOT idx:lastCrawl).
  const ts = new Date(lastCrawled).toISOString();
  quads.push(q(entry, dct("modified"), literal(ts, xsdDateTime)));
  quads.push(q(entry, prov("generatedAtTime"), literal(ts, xsdDateTime)));

  // Dataset membership + crawl state (a skos:Concept IRI — never a string literal).
  quads.push(q(entry, namedNode(`${VOID}inDataset`), namedNode(DATASET_IRI)));
  quads.push(
    q(entry, IDX_CRAWLSTATE, crawlStateConcept({ state, nextEligibleAt, now }))
  );

  // ── The upstream WebID, described BY REFERENCE (no minted #me) ────────────────
  // The inverse link back to this description document (cool-URI symmetry).
  quads.push(q(webid, foaf("isPrimaryTopicOf"), entry));
  // Link to the upstream profile document itself.
  quads.push(q(webid, namedNode(`${RDFS}seeAlso`), source));

  if (projection.name) {
    quads.push(q(webid, foaf("name"), literal(projection.name)));
  }
  if (projection.photoUrl && isHttpsIri(projection.photoUrl)) {
    quads.push(q(webid, foaf("img"), namedNode(projection.photoUrl)));
  }
  for (const issuer of projection.oidcIssuers) {
    quads.push(q(webid, namedNode(`${SOLID}oidcIssuer`), namedNode(issuer)));
  }
  for (const storage of projection.storageUrls) {
    quads.push(q(webid, namedNode(`${PIM}storage`), namedNode(storage)));
  }
  // foaf:knows objects are ALWAYS the upstream WebIDs — NEVER rewritten to
  // $ORIGIN/p/{slug} index URLs (sw M4). The crawler already canonicalises these
  // to upstream WebIDs in raw_rdf, so they pass through unchanged.
  for (const k of projection.knows) {
    quads.push(q(webid, foaf("knows"), namedNode(k)));
  }

  return quads;
}
