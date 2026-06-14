// AUTHORED-BY Claude Opus 4.8
/**
 * lib/rdf/profile.ts — offline RDF profile parse + extract helpers.
 *
 * Parsing is done via `@jeswr/fetch-rdf` `parseRdf` (never inline `new Parser().parse`).
 * Field extraction is done via `@solid/object` `WebIdDataset` + `Agent` typed accessors
 * (never hand-match quads).
 *
 * This module does NOT call `fetch` — network I/O belongs in the caller
 * (`guardedFetch` → hand body+contentType here). The check:fetch script enforces this.
 *
 * @see docs/DESIGN.md §RDF libraries decision addendum
 */
import { ParseLimitError, RdfFetchError, parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore } from "@rdfjs/types";
import { Agent, WebIdDataset } from "@solid/object";
import { DataFactory } from "n3";
import { MAX_QUADS } from "../config";

export { RdfFetchError, ParseLimitError };

// ─── Types ────────────────────────────────────────────────────────────────────

/** The extracted fields from a WebID profile document. */
export interface WebIdProfile {
  /** The WebID IRI (subject URI). */
  webId: string;
  /** Best-effort display name (vcard:fn → foaf:name → undefined). */
  name?: string;
  /** Avatar/photo URL, or undefined if not present. */
  photoUrl?: string;
  /** All `solid:oidcIssuer` values. Empty array = not a Solid WebID. */
  oidcIssuers: string[];
  /** All `pim:storage` / `solid:storage` URLs. */
  storageUrls: string[];
  /** All `foaf:knows` IRIs. */
  knows: string[];
}

// ─── parseProfile ─────────────────────────────────────────────────────────────

/**
 * Parse a raw RDF profile body into an in-memory dataset.
 *
 * Uses `@jeswr/fetch-rdf` `parseRdf` — the only sanctioned parser.  The
 * `maxQuads` cap from `config.ts` is forwarded so oversized / hostile
 * documents are rejected before they exhaust memory. The safe (no-remote-
 * network) JSON-LD documentLoader is the library default — we do NOT override
 * it here, so remote `@context` IRIs are never fetched.
 *
 * @throws {RdfFetchError}    For unsupported content-type or parse errors.
 * @throws {ParseLimitError}  When the body exceeds `MAX_QUADS` statements.
 */
export async function parseProfile({
  text,
  contentType,
  baseIri,
}: {
  text: string;
  contentType: string | null;
  baseIri: string;
}): Promise<DatasetCore> {
  return parseRdf(text, contentType, {
    baseIRI: baseIri,
    maxQuads: MAX_QUADS,
    // documentLoader is intentionally omitted — the library default rejects all
    // remote @context fetches (SSRF guard). Do NOT pass a permissive loader here.
  });
}

// ─── extractWebIdProfile ──────────────────────────────────────────────────────

/**
 * Extract the typed profile fields from a parsed dataset.
 *
 * Uses `@solid/object` `WebIdDataset` + `Agent` typed accessors. When the
 * profile does not carry `solid:oidcIssuer` on the given subject, `oidcIssuers`
 * will be empty (`isSolidWebId` will return `false`).
 */
export function extractWebIdProfile(
  dataset: DatasetCore,
  webIdIri: string
): WebIdProfile {
  // Prefer mainSubject (the subject carrying solid:oidcIssuer as detected by
  // WebIdDataset) when it matches the requested webIdIri. For non-Solid profiles
  // (no oidcIssuer) mainSubject is undefined, so we fall through to a direct
  // Agent construction on the given IRI.
  const webIdDataset = new WebIdDataset(dataset, DataFactory);
  const main = webIdDataset.mainSubject;

  // Construct the subject agent. For Solid profiles mainSubject is canonical;
  // for non-Solid profiles (name/photo only) we construct directly on the IRI.
  const subject: Agent =
    main !== undefined && main.value === webIdIri
      ? main
      : new Agent(webIdIri, dataset, DataFactory);

  const name = subject.name ?? undefined;
  const photoUrl = subject.photoUrl ?? undefined;
  const oidcIssuers = [...subject.oidcIssuer];
  const storageUrls = [...subject.storageUrls];
  const knows = [...subject.knows];

  return {
    webId: webIdIri,
    name,
    photoUrl,
    oidcIssuers,
    storageUrls,
    knows,
  };
}

// ─── isSolidWebId ─────────────────────────────────────────────────────────────

/**
 * Returns `true` when the dataset carries at least one `solid:oidcIssuer`
 * triple on `webIdIri` — the canonical "this is a Solid WebID" gate used
 * throughout the crawler (docs/DESIGN.md §3.3 `isSolid` check).
 */
export function isSolidWebId(dataset: DatasetCore, webIdIri: string): boolean {
  return extractWebIdProfile(dataset, webIdIri).oidcIssuers.length > 0;
}
