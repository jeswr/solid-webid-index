// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/rdf/as2.ts — parse an LDN suggestion notification (Activity Streams 2.0) and extract its
 * candidate WebID(s) from the EXPANDED RDF — never from raw JSON keys (security M1 / sw M1).
 *
 * The LDN inbox (POST /inbox/) receives an AS2 activity (`as:Announce`, leniently `as:Offer`/
 * `as:Add`) whose `as:object` points at the WebID to index. This helper:
 *
 *   1. Parses the body via `@jeswr/fetch-rdf` `parseRdf` (the ONLY sanctioned parser) with the
 *      shared {@link MAX_QUADS} cap (parser-bomb guard) — Turtle OR JSON-LD.
 *   2. Provides a BUNDLED AS2 `@context` documentLoader so a conformant JSON-LD sender (whose
 *      `@context` is the remote `https://www.w3.org/ns/activitystreams`) parses WITHOUT the parser
 *      ever dereferencing the remote context over the network (SSRF guard, DESIGN.md §4.0/§5). The
 *      bundled context is the minimal subset the inbox needs: `type`, `object`, `actor`, `target`.
 *   3. Extracts from the EXPANDED quads, via typed RDF/JS term matching (NOT JSON key access):
 *        - the activity `rdf:type` IRIs (to verify `as:Announce`/`as:Offer`/`as:Add`);
 *        - every `as:object` IRI (the candidate WebIDs);
 *        - the `as:actor` IRI (provenance, optional).
 *
 * No network I/O — the body text is handed in by the route after the 64KiB size guard. The
 * `check:fetch` script enforces that this module never calls `fetch`.
 */

import { ParseLimitError, RdfFetchError, parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore, Quad } from "@rdfjs/types";
import { DataFactory } from "n3";
import { MAX_QUADS } from "../config";

export { RdfFetchError, ParseLimitError };

const { namedNode } = DataFactory;

// ─── AS2 + RDF vocabulary IRIs ──────────────────────────────────────────────────

const AS2_NS = "https://www.w3.org/ns/activitystreams#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** The canonical accepted activity types (DESIGN.md §4.3): Announce + lenient Offer/Add. */
export const ACCEPTED_ACTIVITY_TYPES: readonly string[] = [
  `${AS2_NS}Announce`,
  `${AS2_NS}Offer`,
  `${AS2_NS}Add`,
];

const AS_OBJECT = `${AS2_NS}object`;
const AS_ACTOR = `${AS2_NS}actor`;

// ─── Bundled AS2 @context loader (SSRF-safe; never fetches remote) ───────────────

/**
 * The minimal bundled AS2 `@context`. AS2 senders set `@context` to the IRI
 * `https://www.w3.org/ns/activitystreams`; `parseRdf`'s default loader REJECTS any remote context
 * fetch. We supply this bundled subset so a conformant notification parses offline. Only the terms
 * the inbox reads are mapped (`type` via `@type`, `object`/`actor`/`target` as `@id`-typed IRIs).
 */
const BUNDLED_AS2_CONTEXT = {
  "@context": {
    as: AS2_NS,
    id: "@id",
    type: "@type",
    Announce: `${AS2_NS}Announce`,
    Offer: `${AS2_NS}Offer`,
    Add: `${AS2_NS}Add`,
    object: { "@id": AS_OBJECT, "@type": "@id" },
    actor: { "@id": AS_ACTOR, "@type": "@id" },
    target: { "@id": `${AS2_NS}target`, "@type": "@id" },
  },
};

/**
 * Allowlist documentLoader for AS2: returns the bundled context for the AS2 context IRI (with and
 * without the trailing `#`/`/`), rejects EVERY other remote-context lookup. Shape matches
 * `@jeswr/fetch-rdf`'s `RemoteContextLoader` (`{ load(url): Promise<unknown> }`).
 */
const AS2_DOCUMENT_LOADER = {
  load(url: string): Promise<unknown> {
    const u = url.replace(/[#/]$/, "");
    if (u === "https://www.w3.org/ns/activitystreams") {
      return Promise.resolve(BUNDLED_AS2_CONTEXT);
    }
    return Promise.reject(
      new RdfFetchError(
        `AS2 documentLoader: remote @context fetch refused (SSRF guard): ${url}`
      )
    );
  },
};

// ─── Result ──────────────────────────────────────────────────────────────────────

/** The typed extraction from a parsed AS2 suggestion notification. */
export interface ParsedSuggestion {
  /** The activity `rdf:type` IRIs found (expanded). */
  activityTypes: string[];
  /** Every `as:object` IRI (the candidate WebIDs) — IRI objects only, deduped. */
  objectIris: string[];
  /** The first `as:actor` IRI, if any (provenance). */
  actor: string | null;
  /** The parsed dataset (so the caller can re-serialise canonical body for storage). */
  dataset: DatasetCore;
}

// ─── parse ───────────────────────────────────────────────────────────────────────

/**
 * Parse + extract an AS2 suggestion notification.
 *
 * @param text         The raw request body (already size-guarded by the route).
 * @param contentType  The request `Content-Type` (null → text/turtle per Solid Protocol default).
 * @param baseIri      Base IRI for relative-reference resolution (the inbox URL).
 * @throws {RdfFetchError}   unsupported content-type / malformed RDF.
 * @throws {ParseLimitError} body exceeds {@link MAX_QUADS}.
 */
export async function parseSuggestion({
  text,
  contentType,
  baseIri,
}: {
  text: string;
  contentType: string | null;
  baseIri: string;
}): Promise<ParsedSuggestion> {
  // `application/activity+json` is JSON-LD with the AS2 context (AS2 §2). `parseRdf` only recognises
  // `application/ld+json` for the JSON-LD path, so normalise the activity+json media type to it
  // (preserving any charset parameter) before dispatch.
  const normalizedContentType = normalizeActivityJson(contentType);

  const dataset = await parseRdf(text, normalizedContentType, {
    baseIRI: baseIri,
    maxQuads: MAX_QUADS,
    documentLoader: AS2_DOCUMENT_LOADER,
  });

  return extractSuggestion(dataset);
}

/**
 * Extract activity types, `as:object` IRIs, and the actor from a parsed AS2 dataset using typed
 * RDF/JS term matching — NEVER JSON key access (the house "never hand-read JSON keys" rule mirrors
 * "never hand-build triples"). Only IRI (`NamedNode`) objects are collected for `as:object`/`as:actor`
 * — a blank-node or literal object is not a dereferenceable WebID and is ignored.
 *
 * STRICT typing (security M2 — AS2 type bypass): candidates are ONLY collected from subjects that
 * bear an ACCEPTED activity `rdf:type` (`as:Announce`/`as:Offer`/`as:Add`). An UNTYPED (or
 * non-accepted-type) payload yields NO candidates — there is no "harvest any as:object" fallback, so
 * arbitrary non-Announce/Offer/Add RDF can never enqueue a crawl. The route additionally rejects
 * (422) when `activityTypes` is empty, so the failure is explicit rather than a silent empty result.
 */
export function extractSuggestion(dataset: DatasetCore): ParsedSuggestion {
  const activityTypes = new Set<string>();
  const objectIris = new Set<string>();
  let actor: string | null = null;

  // Identify activity subjects = subjects bearing rdf:type ∈ ACCEPTED_ACTIVITY_TYPES. Collect the
  // as:object / as:actor of THOSE subjects only, so a nested/secondary resource's object link is not
  // harvested as a candidate.
  const activitySubjects = new Set<string>();

  // First pass: activity types + their subjects.
  for (const q of matchP(dataset, RDF_TYPE)) {
    if (q.object.termType === "NamedNode") {
      const t = q.object.value;
      if (ACCEPTED_ACTIVITY_TYPES.includes(t)) {
        activityTypes.add(t);
        activitySubjects.add(q.subject.value);
      }
    }
  }

  // No "harvest any as:object" fallback: when NO accepted activity type is present there are no
  // activity subjects, so the passes below collect NOTHING (objectIris stays empty). An untyped
  // payload therefore cannot enqueue a crawl — see the route's empty-activityTypes 422 gate.

  // Second pass: as:object (candidate WebIDs) — only on accepted-activity subjects.
  for (const q of matchP(dataset, AS_OBJECT)) {
    if (q.object.termType !== "NamedNode") continue;
    if (!activitySubjects.has(q.subject.value)) continue;
    objectIris.add(q.object.value);
  }

  // Third pass: as:actor (first IRI actor, for provenance) — only on accepted-activity subjects.
  for (const q of matchP(dataset, AS_ACTOR)) {
    if (q.object.termType !== "NamedNode") continue;
    if (!activitySubjects.has(q.subject.value)) continue;
    actor = q.object.value;
    break;
  }

  return {
    activityTypes: [...activityTypes],
    objectIris: [...objectIris],
    actor,
    dataset,
  };
}

/** Iterate quads with a given predicate IRI. Uses DatasetCore.match (RDF/JS) — never key access. */
function matchP(dataset: DatasetCore, predicate: string): Iterable<Quad> {
  return dataset.match(
    null,
    namedNode(predicate),
    null,
    null
  ) as Iterable<Quad>;
}

/**
 * Map `application/activity+json` (AS2's own media type) to `application/ld+json` for the parser,
 * leaving any other content-type (and the charset parameter) untouched. `null` → null (parseRdf
 * defaults it to text/turtle).
 */
function normalizeActivityJson(contentType: string | null): string | null {
  if (contentType === null) return null;
  const [bare, ...rest] = contentType.split(";");
  if (bare.trim().toLowerCase() === "application/activity+json") {
    const params = rest.length > 0 ? `;${rest.join(";")}` : "";
    return `application/ld+json${params}`;
  }
  return contentType;
}
