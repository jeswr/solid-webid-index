// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/http/conneg.ts — Linked-Data content negotiation + serialisation layer.
 *
 * Implements RFC 7231 §5.3.2 Accept-header negotiation for the four representations
 * the index serves: text/turtle (default), application/ld+json, application/n-triples,
 * and text/html (browser branch — returns a sentinel so the Next.js page renders HTML).
 *
 * Serialisation:
 *   - Turtle / N-Triples: n3.Writer (NEVER hand-concatenated triples; house rule)
 *   - JSON-LD: jsonld.fromRDF → jsonld.compact with the bundled app @context
 *     (the "house serializeJsonLdCompacted" described in docs/DESIGN.md §4.0)
 *
 * Response helpers set: Content-Type, Vary: Accept, a strong ETag
 * (sha256-{first16hex} over serialised body + media type + profile param), and
 * honour If-None-Match → 304.
 *
 * JSON-LD profile parameter: ?profile=#expanded → skip compaction;
 * ?profile=#flattened → jsonld.flatten.
 *
 * @see docs/DESIGN.md §4.0 (cross-cutting), §8 (conneg conformance matrix)
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Quad } from "@rdfjs/types";
import { Writer } from "n3";
import { INDEX_BASE_URL } from "../config";

// ─── jsonld CJS interop ───────────────────────────────────────────────────────
// jsonld is a CommonJS module; in ESM (Next.js bundler) the named exports sit
// on the `default` object. Use createRequire so we get the runtime object with
// the correct method signatures, avoiding the `void & Promise<...>` intersection
// that @types/jsonld@1.5.x produces on named-import paths.

/** Opaque JSON-LD document type for the compaction pipeline (internal). */
type JsonLdDoc = unknown;

/** Allowlist document loader function type (matches @types/jsonld DocLoader shape). */
type DocLoader = (url: string) => Promise<{
  contextUrl: string | null;
  document: unknown;
  documentUrl: string;
}>;

const _require = createRequire(import.meta.url);
const jsonldLib = _require("jsonld") as {
  fromRDF(
    dataset: string,
    options: { format: string; documentLoader?: DocLoader }
  ): Promise<JsonLdDoc[]>;
  compact(
    input: JsonLdDoc[],
    ctx: Record<string, unknown>,
    options: { documentLoader?: DocLoader }
  ): Promise<Record<string, unknown>>;
  flatten(
    input: JsonLdDoc[],
    ctx: Record<string, unknown>,
    options: { documentLoader?: DocLoader }
  ): Promise<Record<string, unknown>>;
};

/** Aliased for use in makeAllowlistLoader return type annotation. */
type DocumentLoader = DocLoader;

/** Shape of an entry in the allowlist loader cache. */
interface AllowlistEntry {
  contextUrl: string | null;
  document: unknown;
  documentUrl: string;
}

// ─── Supported media types ────────────────────────────────────────────────────

/** The four negotiable representations (ordered: first = server preference). */
export const CONNEG_TYPES = [
  "text/turtle",
  "application/ld+json",
  "application/n-triples",
  "text/html",
] as const;

export type ConnegType = (typeof CONNEG_TYPES)[number];

/**
 * Sentinel value returned from `negotiateType` when a browser Accept header
 * prefers HTML — callers should render via the Next.js page handler instead of
 * serialising RDF.
 */
export const HTML_SENTINEL = "text/html" as const;

// ─── App @context (bundled — never dereference remote; DESIGN.md §4.0) ───────

/**
 * The bundled JSON-LD 1.1 @context for index entries and search results.
 *
 * Vocabs: foaf (agent description), vcard (contact), schema.org (rich metadata),
 * solid (oidcIssuer), pim (storage), dcterms (provenance), prov, skos, LDP, VoID.
 *
 * Design notes:
 *   - @type: @id on IRI-valued terms enables compact IRI representation.
 *   - @container: @set on multi-valued terms preserves the array form on round-trip.
 *   - @protected: true on identity terms prevents context collisions in framing.
 *   - idx: is the minted namespace for index-operational terms (DESIGN.md §4.7).
 */
export const APP_CONTEXT: Record<string, unknown> = {
  "@version": 1.1,
  "@vocab": "_:",
  // --- prefix declarations ---
  foaf: "http://xmlns.com/foaf/0.1/",
  vcard: "http://www.w3.org/2006/vcard/ns#",
  schema: "https://schema.org/",
  solid: "http://www.w3.org/ns/solid/terms#",
  pim: "http://www.w3.org/ns/pim/space#",
  dcterms: "http://purl.org/dc/terms/",
  prov: "http://www.w3.org/ns/prov#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  ldp: "http://www.w3.org/ns/ldp#",
  void: "http://rdfs.org/ns/void#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  as: "https://www.w3.org/ns/activitystreams#",
  hydra: "http://www.w3.org/ns/hydra/core#",
  idx: `${INDEX_BASE_URL}/ns#`,

  // --- identity / description terms (protected) ---
  "foaf:name": { "@type": "xsd:string", "@protected": true },
  "foaf:img": { "@type": "@id", "@protected": true },
  "foaf:knows": { "@type": "@id", "@container": "@set", "@protected": true },
  "foaf:primaryTopic": { "@type": "@id", "@protected": true },
  "vcard:hasPhoto": { "@type": "@id", "@protected": true },
  "schema:name": { "@type": "xsd:string", "@protected": true },
  "schema:about": { "@type": "@id", "@protected": true },
  "schema:sameAs": { "@type": "@id", "@container": "@set", "@protected": true },

  // --- Solid / Linked Data terms (protected) ---
  "solid:oidcIssuer": {
    "@type": "@id",
    "@container": "@set",
    "@protected": true,
  },
  "pim:storage": { "@type": "@id", "@container": "@set", "@protected": true },
  "dcterms:modified": { "@type": "xsd:dateTime", "@protected": true },
  "dcterms:source": { "@type": "@id", "@protected": true },
  "prov:wasDerivedFrom": { "@type": "@id", "@protected": true },

  // --- index-operational terms (protected) ---
  "idx:crawlState": { "@type": "@id", "@protected": true },
  "idx:noIndex": { "@type": "xsd:boolean", "@protected": true },
  "idx:optOutToken": { "@type": "xsd:string", "@protected": true },

  // --- xsd shorthand (needed for @type references above) ---
  xsd: "http://www.w3.org/2001/XMLSchema#",
};

// ─── JSON-LD profile parameter values (DESIGN.md §4.0) ───────────────────────

const PROFILE_EXPANDED = `${INDEX_BASE_URL}/ns/context.jsonld#expanded`;
const PROFILE_FLATTENED = `${INDEX_BASE_URL}/ns/context.jsonld#flattened`;

// ─── Accept-header parsing ────────────────────────────────────────────────────

/**
 * One parsed entry from an Accept header: `mediaType` + resolved `q` value.
 *
 * q-values default to 1.0 when absent (RFC 7231 §5.3.1).
 */
interface AcceptEntry {
  type: string;
  subtype: string;
  /** Resolved q-value in [0, 1]. */
  q: number;
  /** Raw parameter string (unparsed), e.g. `profile="..."`. */
  params: string;
}

/**
 * Parse an Accept header string into sorted entries (descending q-value).
 *
 * Strips whitespace; handles `*\/*`; ignores malformed tokens.
 * Returns an empty array for a missing/empty header.
 */
export function parseAcceptHeader(
  header: string | null | undefined
): AcceptEntry[] {
  if (!header) return [];

  const entries: AcceptEntry[] = [];

  for (const token of header.split(",")) {
    const parts = token.trim().split(";");
    const rawType = parts[0].trim().toLowerCase();
    if (!rawType) continue;

    const [rawMime, rawSub] = rawType.split("/");
    const type = rawMime?.trim() ?? "";
    const subtype = rawSub?.trim() ?? "";
    if (!type || !subtype) continue;

    let q = 1.0;
    let params = "";

    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].trim();
      const m = p.match(/^q\s*=\s*([\d.]+)$/i);
      if (m) {
        const parsed = Number.parseFloat(m[1]);
        if (!Number.isNaN(parsed)) {
          q = Math.max(0, Math.min(1, parsed));
        }
      } else {
        params += (params ? ";" : "") + p;
      }
    }

    entries.push({ type, subtype, q, params });
  }

  // Sort descending by q-value; stable sort preserves declaration order on ties.
  entries.sort((a, b) => b.q - a.q);
  return entries;
}

/**
 * Returns true if a parsed AcceptEntry matches the given fully-qualified
 * media type string (e.g. `"text/turtle"`), handling wildcard types.
 */
function entryMatches(entry: AcceptEntry, target: ConnegType): boolean {
  const [targetType, targetSub] = target.split("/");
  if (entry.type === "*" && entry.subtype === "*") return true;
  if (entry.type === targetType && entry.subtype === "*") return true;
  return entry.type === targetType && entry.subtype === targetSub;
}

/**
 * Detect whether the Accept header is from a browser that prefers HTML.
 *
 * A browser Accept is one that contains `text/html` (or `application/xhtml+xml`)
 * with a q-value ≥ the best RDF type's q-value, AND no explicit RDF type is
 * requested at equal-or-higher priority.
 *
 * This mirrors the logic in `src/rdf/conneg.ts` in the prod-solid-server
 * (referenced in DESIGN.md §4.0 as the canonical `prefersHtml` implementation):
 * `Sec-Fetch-Dest: document` is a supplement, not a gate — the Accept q-value
 * comparison is the authoritative signal.
 *
 * `*\/*` alone (a machine `Accept: *\/*`) does NOT trigger the HTML branch
 * — machines get Turtle.
 */
export function prefersHtml(header: string | null | undefined): boolean {
  const entries = parseAcceptHeader(header);
  if (entries.length === 0) return false;

  // Find the best q-value for an HTML media type.
  const htmlTypes = new Set(["text/html", "application/xhtml+xml"]);
  let htmlQ = 0;
  for (const e of entries) {
    const mt = `${e.type}/${e.subtype}`;
    if (htmlTypes.has(mt)) {
      htmlQ = Math.max(htmlQ, e.q);
    }
  }
  if (htmlQ === 0) return false;

  // Find the best q-value for an RDF type (not wildcard).
  const rdfTypes = new Set<string>([
    "text/turtle",
    "application/ld+json",
    "application/n-triples",
  ]);
  let rdfQ = 0;
  for (const e of entries) {
    const mt = `${e.type}/${e.subtype}`;
    if (rdfTypes.has(mt)) {
      rdfQ = Math.max(rdfQ, e.q);
    }
  }

  // Prefer HTML when HTML q ≥ any explicit RDF q (i.e. no RDF override).
  return htmlQ >= rdfQ;
}

/**
 * Negotiate the best content type for the given Accept header.
 *
 * Returns `HTML_SENTINEL` ("text/html") when a browser prefers HTML.
 * Returns `null` when no supported type can satisfy the request (406).
 * Returns `"text/turtle"` for `Accept: *\/*` or a missing header (machine default).
 *
 * Also returns the `profile` parameter value extracted from the winning
 * `application/ld+json` entry (for JSON-LD profile negotiation per DESIGN.md §4.0).
 */
export function negotiateType(header: string | null | undefined): {
  type: ConnegType | null;
  profile: string | null;
} {
  // Browser detection takes priority.
  if (prefersHtml(header)) return { type: HTML_SENTINEL, profile: null };

  const entries = parseAcceptHeader(header);

  // Empty / missing Accept → default to Turtle (machine default per DESIGN.md §4.0).
  if (entries.length === 0) return { type: "text/turtle", profile: null };

  // Walk entries in q-value order; the first matching supported type wins.
  for (const entry of entries) {
    // Wildcard: serve our preferred type (Turtle for machines).
    if (entry.type === "*" && entry.subtype === "*") {
      if (entry.q === 0) return { type: null, profile: null }; // */* with q=0 → 406
      return { type: "text/turtle", profile: null };
    }

    for (const candidate of CONNEG_TYPES) {
      if (candidate === "text/html") continue; // handled by prefersHtml above
      if (entryMatches(entry, candidate)) {
        if (entry.q === 0) {
          // This type is explicitly refused; continue to next entry.
          break;
        }
        // Extract profile parameter for JSON-LD (media type parameter).
        let profile: string | null = null;
        if (candidate === "application/ld+json" && entry.params) {
          const m = entry.params.match(/profile\s*=\s*"?([^";,\s]+)"?/i);
          if (m) profile = m[1];
        }
        return { type: candidate, profile };
      }
    }
  }

  // Nothing matched → 406.
  return { type: null, profile: null };
}

// ─── Serialisation helpers ────────────────────────────────────────────────────

/**
 * Serialise an array of RDF/JS quads to Turtle using n3.Writer.
 *
 * Uses the optional prefix map for more readable output. Returns the serialised
 * string. Rejects on writer errors.
 *
 * NEVER hand-concatenates triples — house invariant.
 */
export async function serializeTurtle(
  quads: Quad[],
  prefixes?: Record<string, string>
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const writer = new Writer({
      format: "Turtle",
      prefixes: prefixes ?? TURTLE_PREFIXES,
    });
    writer.addQuads(quads);
    writer.end((err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result ?? "");
      }
    });
  });
}

/**
 * Serialise an array of RDF/JS quads to N-Triples using n3.Writer.
 *
 * N-Triples is the canonical normalised form — no prefix expansion needed.
 */
export async function serializeNTriples(quads: Quad[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const writer = new Writer({ format: "N-Triples" });
    writer.addQuads(quads);
    writer.end((err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result ?? "");
      }
    });
  });
}

/**
 * Serialise an array of RDF/JS quads to N-Triples (canonical form used
 * for ETag hashing). N-Triples is chosen for ETag because it is
 * normalised: same triples → same bytes regardless of serialisation order
 * within the n3 writer (n3 Writer emits N-Triples deterministically by
 * insertion order, which is stable for cached serialisations).
 */
async function serializeNTriplesForHash(quads: Quad[]): Promise<string> {
  return serializeNTriples(quads);
}

/**
 * Allowlist document loader for jsonld — returns the bundled APP_CONTEXT for the
 * index context URL, rejects all other remote-context lookups (SSRF guard,
 * DESIGN.md §4.0 / §5).
 *
 * We do NOT call out to the network here — ever. This is the "allowlistLoader"
 * from the design doc, ported to this project.
 */
function makeAllowlistLoader(): DocumentLoader {
  const contextUrl = `${INDEX_BASE_URL}/ns/context.jsonld`;
  const allowlist: Record<string, AllowlistEntry> = {
    [contextUrl]: {
      contextUrl: null,
      document: { "@context": APP_CONTEXT },
      documentUrl: contextUrl,
    },
    // AS2 context — bundled to avoid remote fetch from LDN inbox processing.
    "https://www.w3.org/ns/activitystreams": {
      contextUrl: null,
      document: {
        "@context": { as: "https://www.w3.org/ns/activitystreams#" },
      },
      documentUrl: "https://www.w3.org/ns/activitystreams",
    },
  };

  return (url: string): Promise<AllowlistEntry> => {
    const entry = allowlist[url];
    if (entry) {
      return Promise.resolve(entry);
    }
    return Promise.reject(
      new Error(
        `conneg allowlistLoader: remote context fetch refused (SSRF guard): ${url}`
      )
    );
  };
}

const ALLOWLIST_LOADER = makeAllowlistLoader();

/**
 * Serialise RDF/JS quads to a compacted JSON-LD document using the app @context.
 *
 * Algorithm (DESIGN.md §4.0):
 *   1. Serialise quads to N-Quads string (n3.Writer format:"N-Quads").
 *   2. `jsonld.fromRDF(nquads)` → expanded JSON-LD array.
 *   3. `jsonld.compact(expanded, APP_CONTEXT, { documentLoader: allowlistLoader })`.
 *
 * The `profile` parameter controls optional variants:
 *   - `#expanded`:  skip compaction, return expanded form.
 *   - `#flattened`: run `jsonld.flatten` instead of `jsonld.compact`.
 *   - default (null / anything else): compacted form.
 *
 * The allowlistLoader ensures no remote context is ever fetched — all
 * context resolution is in-process (SSRF guard).
 *
 * @throws if n3 serialisation or jsonld processing fails.
 */
export async function serializeJsonLdCompacted(
  quads: Quad[],
  profile?: string | null
): Promise<string> {
  // Step 1: serialise quads to N-Quads for jsonld.fromRDF input.
  const nquads = await new Promise<string>((resolve, reject) => {
    const writer = new Writer({ format: "N-Quads" });
    writer.addQuads(quads);
    writer.end((err, result) => {
      if (err) reject(err);
      else resolve(result ?? "");
    });
  });

  // Step 2: parse N-Quads into expanded JSON-LD.
  const expanded = await jsonldLib.fromRDF(nquads, {
    format: "application/n-quads",
    documentLoader: ALLOWLIST_LOADER,
  });

  // Step 3: apply profile-requested transformation.
  if (profile === PROFILE_EXPANDED) {
    return JSON.stringify(expanded, null, 2);
  }

  if (profile === PROFILE_FLATTENED) {
    const flattened = await jsonldLib.flatten(expanded, APP_CONTEXT, {
      documentLoader: ALLOWLIST_LOADER,
    });
    return JSON.stringify(flattened, null, 2);
  }

  // Default: compact with the bundled app context.
  const compacted = await jsonldLib.compact(expanded, APP_CONTEXT, {
    documentLoader: ALLOWLIST_LOADER,
  });
  return JSON.stringify(compacted, null, 2);
}

// ─── ETag computation ─────────────────────────────────────────────────────────

/**
 * Compute a strong ETag for a serialised representation.
 *
 * The ETag input is `serialisedBody + "\0" + mediaType + "\0" + (profile ?? "")`.
 * Including media type and profile in the hash ensures compacted vs expanded
 * JSON-LD never share a validator (DESIGN.md §4.0 sw H4).
 *
 * Format: `"sha256-{first16hexchars}"` (a strong ETag, double-quoted per RFC 7232).
 */
export function computeETag(
  body: string,
  mediaType: string,
  profile?: string | null
): string {
  const input = `${body}\0${mediaType}\0${profile ?? ""}`;
  const hex = createHash("sha256")
    .update(input, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `"sha256-${hex}"`;
}

// ─── Well-known Turtle prefixes ───────────────────────────────────────────────

/**
 * Prefix map for Turtle serialisation — the standard vocabs used in entry
 * descriptions plus the minted `idx:` namespace.
 */
export const TURTLE_PREFIXES: Record<string, string> = {
  foaf: "http://xmlns.com/foaf/0.1/",
  vcard: "http://www.w3.org/2006/vcard/ns#",
  schema: "https://schema.org/",
  solid: "http://www.w3.org/ns/solid/terms#",
  pim: "http://www.w3.org/ns/pim/space#",
  dcterms: "http://purl.org/dc/terms/",
  prov: "http://www.w3.org/ns/prov#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  ldp: "http://www.w3.org/ns/ldp#",
  void: "http://rdfs.org/ns/void#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  as: "https://www.w3.org/ns/activitystreams#",
  hydra: "http://www.w3.org/ns/hydra/core#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  idx: `${INDEX_BASE_URL}/ns#`,
};

// ─── Serialise to the negotiated type ────────────────────────────────────────

/**
 * Serialise a quad array to the given negotiated content type.
 *
 * Returns the serialised string and the media type string to use in the
 * Content-Type header (with charset for text types).
 */
export async function serializeToType(
  quads: Quad[],
  type: Exclude<ConnegType, "text/html">,
  profile?: string | null
): Promise<{ body: string; contentType: string }> {
  switch (type) {
    case "text/turtle": {
      const body = await serializeTurtle(quads);
      return { body, contentType: "text/turtle; charset=utf-8" };
    }
    case "application/n-triples": {
      const body = await serializeNTriples(quads);
      return { body, contentType: "application/n-triples; charset=utf-8" };
    }
    case "application/ld+json": {
      const body = await serializeJsonLdCompacted(quads, profile);
      return { body, contentType: "application/ld+json" };
    }
  }
}

// ─── Next.js response helpers ─────────────────────────────────────────────────

/**
 * CORS origin(s) allowed on read endpoints (GET/HEAD/OPTIONS, no credentials).
 *
 * All origins are permitted for a public read-only index (`Access-Control-Allow-Origin: *`).
 * Write surfaces (inbox, optout) use a narrower allowlist — those are handled in their
 * own route handlers.
 */
const READ_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, If-None-Match",
};

/**
 * Options for `buildRdfResponse`.
 */
export interface BuildRdfResponseOptions {
  /** Incoming request (used to read `Accept`, `If-None-Match` headers). */
  request: Request;
  /** The RDF quads to serialise. */
  quads: Quad[];
  /** HTTP status code for a cache miss (default 200). */
  status?: number;
  /** Extra response headers to merge in (e.g. Link, Cache-Control). */
  extraHeaders?: Record<string, string>;
}

/**
 * Build a Next.js `Response` for an RDF read endpoint.
 *
 * Behaviour:
 *   1. Negotiate the best representation from the `Accept` header.
 *      - Returns `null` when the caller should render the HTML page
 *        (browser detect); the caller must return a `null` check and
 *        let Next.js serve the page component.
 *      - Returns a `Response` with status 406 when no type is satisfiable.
 *   2. Serialise the quads to the winning type (Turtle / JSON-LD / N-Triples).
 *   3. Compute an ETag (sha256-{16hex} over body + media type + profile).
 *   4. If `If-None-Match` matches the ETag → return 304 (no body).
 *   5. Set `Vary: Accept`, `Content-Type`, `ETag`, CORS headers, and any
 *      caller-supplied `extraHeaders`.
 *
 * @returns `null` when the HTML branch is taken (caller renders page);
 *          otherwise a `Response` (200/304/406).
 */
export async function buildRdfResponse(
  opts: BuildRdfResponseOptions
): Promise<Response | null> {
  const { request, quads, status = 200, extraHeaders = {} } = opts;
  const acceptHeader = request.headers.get("Accept");
  const ifNoneMatch = request.headers.get("If-None-Match");

  // ── 1. Negotiate ────────────────────────────────────────────────────────────
  const { type, profile } = negotiateType(acceptHeader);

  // HTML branch → tell the caller to let Next.js render the page.
  if (type === HTML_SENTINEL) return null;

  // 406 — no satisfiable type.
  if (type === null) {
    return new Response(
      "Not Acceptable: supported types are text/turtle, application/ld+json, application/n-triples, text/html",
      {
        status: 406,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Vary: "Accept",
          ...READ_CORS_HEADERS,
          ...extraHeaders,
        },
      }
    );
  }

  // ── 2. Serialise ────────────────────────────────────────────────────────────
  const { body, contentType } = await serializeToType(quads, type, profile);

  // ── 3. ETag ──────────────────────────────────────────────────────────────────
  const etag = computeETag(body, type, profile);

  // ── 4. Conditional — If-None-Match → 304 ────────────────────────────────────
  if (ifNoneMatch && ifNoneMatch.trim() === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        Vary: "Accept",
        ...READ_CORS_HEADERS,
        ...extraHeaders,
      },
    });
  }

  // ── 5. Full response ─────────────────────────────────────────────────────────
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    Vary: "Accept",
    ETag: etag,
    ...READ_CORS_HEADERS,
    ...extraHeaders,
  };

  // JSON-LD: add Link rel="http://www.w3.org/ns/json-ld#context" (DESIGN.md §4.0).
  if (type === "application/ld+json") {
    // biome-ignore lint/complexity/useLiteralKeys: "Link" key chosen to match HTTP header name
    headers["Link"] =
      `<${INDEX_BASE_URL}/ns/context.jsonld>; rel="http://www.w3.org/ns/json-ld#context"`;
  }

  return new Response(body, { status, headers });
}

// ─── Serialise-with-quads overload (used internally) ─────────────────────────
// Re-export a version that accepts pre-serialised body + media type for cache-hit
// paths (the hot path serves precomputed strings from the DB — no N3/jsonld import
// needed; see DESIGN.md §2.1.c / arch H2).

/**
 * Build a `Response` from a pre-serialised body string (cache-hit path).
 *
 * The body is used as-is; the caller is responsible for ensuring the content
 * matches `mediaType`. ETag is computed from body + mediaType + profile.
 *
 * Returns 304 when If-None-Match matches, otherwise 200 (or `status`).
 */
export function buildCachedRdfResponse(opts: {
  request: Request;
  body: string;
  mediaType: Exclude<ConnegType, "text/html">;
  profile?: string | null;
  status?: number;
  extraHeaders?: Record<string, string>;
}): Response {
  const {
    request,
    body,
    mediaType,
    profile,
    status = 200,
    extraHeaders = {},
  } = opts;
  const ifNoneMatch = request.headers.get("If-None-Match");
  const etag = computeETag(body, mediaType, profile);

  const baseHeaders: Record<string, string> = {
    Vary: "Accept",
    ETag: etag,
    ...READ_CORS_HEADERS,
    ...extraHeaders,
  };

  if (ifNoneMatch && ifNoneMatch.trim() === etag) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  // Choose Content-Type.
  const contentType =
    mediaType === "application/ld+json"
      ? "application/ld+json"
      : `${mediaType}; charset=utf-8`;

  const headers: Record<string, string> = {
    ...baseHeaders,
    "Content-Type": contentType,
  };
  if (mediaType === "application/ld+json") {
    // biome-ignore lint/complexity/useLiteralKeys: "Link" key chosen to match HTTP header name
    headers["Link"] =
      `<${INDEX_BASE_URL}/ns/context.jsonld>; rel="http://www.w3.org/ns/json-ld#context"`;
  }

  return new Response(body, { status, headers });
}

// ─── N-Triples hash helper (exported for ETag precomputation in upsertProjection) ───

/**
 * Compute the canonical N-Triples serialisation of a quad array.
 * Used when precomputing `nt_cache` (DESIGN.md §2.1.c) and for ETag baselines.
 */
export { serializeNTriplesForHash as serializeNTriplesCanonical };
