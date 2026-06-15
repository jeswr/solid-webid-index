// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/http/entryResponse.ts — shared logic for the /p/{slug} entry document
 * (DESIGN.md §4.1).  Resolves a slug → describe-only RDF response with the full
 * set of LDP / Solid headers, reusing the conneg middleware for serialisation,
 * Vary/ETag/304/406.
 *
 * Statuses:
 *   200 — entry found, conneg'd RDF body (describe-only graph from lib/rdf/entry.ts)
 *   304 — conditional (If-None-Match) — handled inside buildRdfResponse
 *   404 — unknown slug
 *   410 — tombstoned/erased (+ Cache-Control: no-store)
 *   406 — unacceptable Accept — handled inside buildRdfResponse (htmlBranch "406")
 *
 * Link headers (DESIGN.md §4.0 / §4.1):
 *   rel="type"        → idx:Entry + ldp#Resource
 *   rel="describedby" → the dataset VoID description
 *   JSON-LD context   → added by buildRdfResponse for application/ld+json
 *
 * Build runtime-independent: callers (the route) declare runtime + import this.
 */

import { INDEX_BASE_URL } from "@/lib/config";
import { buildRdfResponse } from "@/lib/http/conneg";
import { type EntryProjection, buildEntryQuads } from "@/lib/rdf/entry";
import { extractWebIdProfile, parseProfile } from "@/lib/rdf/profile";
import { IDX_ENTRY, NS_DOC_IRI } from "@/lib/rdf/vocab";
import type { ReadStore } from "@/lib/store/ports";
import { isValidSlug, slugForWebId } from "@/lib/url/slug";

const LDP_RESOURCE = "http://www.w3.org/ns/ldp#Resource";

/**
 * The Link header value for an entry resource: rel="type" → idx:Entry + ldp:Resource,
 * rel="describedby" → the dataset VoID doc.
 */
function entryLinkHeader(): string {
  return [
    `<${IDX_ENTRY.value}>; rel="type"`,
    `<${LDP_RESOURCE}>; rel="type"`,
    `<${INDEX_BASE_URL}/.well-known/void>; rel="describedby"`,
  ].join(", ");
}

/**
 * Cross-cutting headers stamped on every entry response (including 404/410/406/405)
 * so a browser or cache never sees a bare response without conneg/CORS hints.
 */
function commonHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, If-None-Match",
    Vary: "Accept",
    ...extra,
  };
}

/**
 * Build the entry-document Response for a slug.
 *
 * @param store  A ReadStore (PgStore) to resolve the slug.
 * @param slug   The path slug.
 * @param request  The incoming request (Accept / If-None-Match).
 * @param isHead   When true, a 200/304 body is omitted (HEAD).
 */
export async function buildEntryResponse(opts: {
  store: Pick<ReadStore, "getEntryBySlug">;
  slug: string;
  request: Request;
  isHead?: boolean;
}): Promise<Response> {
  const { store, slug, request, isHead = false } = opts;

  // A malformed slug can never match a stored slug → 404 without a DB round-trip.
  if (!isValidSlug(slug)) {
    return new Response(isHead ? null : "Not Found: unknown entry slug", {
      status: 404,
      headers: commonHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  }

  const result = await store.getEntryBySlug(slug);

  // 410 Gone — tombstoned/erased.  no-store so a cache never re-serves it.
  if (result === "tombstoned") {
    return new Response(
      isHead ? null : "Gone: this entry has been removed from the index",
      {
        status: 410,
        headers: commonHeaders({
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        }),
      }
    );
  }

  // 404 — unknown slug.
  if (result === null) {
    return new Response(isHead ? null : "Not Found: unknown entry slug", {
      status: 404,
      headers: commonHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  }

  // Defensive: a row may exist with a slug but no webid (should not happen since
  // slug is derived from webid, but guard anyway) → 404.
  if (!result.webid) {
    return new Response(isHead ? null : "Not Found: unknown entry slug", {
      status: 404,
      headers: commonHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  }

  const entryUrl = `${INDEX_BASE_URL}/p/${slug}`;

  // Re-parse the stored canonical RDF (raw_rdf) via the sanctioned parser to
  // recover the projected fields (name/photo/issuers/storage/knows).  The knows
  // objects are already upstream WebIDs in raw_rdf — they are NEVER index URLs.
  let projection: EntryProjection = {
    webId: result.webid,
    oidcIssuers: [],
    storageUrls: [],
    knows: [],
  };
  if (result.rawRdf) {
    try {
      const dataset = await parseProfile({
        text: result.rawRdf,
        contentType: "text/turtle",
        baseIri: result.docUrl,
      });
      const p = extractWebIdProfile(dataset, result.webid);
      projection = {
        webId: result.webid,
        name: p.name,
        photoUrl: p.photoUrl,
        oidcIssuers: p.oidcIssuers,
        storageUrls: p.storageUrls,
        knows: p.knows,
      };
    } catch {
      // A parse failure of our own reserialised body is non-fatal — emit the
      // minimal describe-only graph (provenance + crawl state) so the entry still
      // dereferences.  (label remains the stored label if any.)
      if (result.label) projection.name = result.label;
    }
  } else if (result.label) {
    projection.name = result.label;
  }

  const quads = buildEntryQuads({
    entryUrl,
    docUrl: result.docUrl,
    projection,
    lastCrawled: result.lastCrawled ?? Date.now(),
    state: result.state,
    nextEligibleAt: result.nextEligibleAt,
    now: Date.now(),
  });

  // buildRdfResponse handles conneg, Vary, ETag, 304, and 406 (htmlBranch="406":
  // an entry is RDF-only — a browser-Accept gets a proper 406, never a bare 200).
  const response = await buildRdfResponse({
    request,
    quads,
    status: 200,
    htmlBranch: "406",
    extraHeaders: {
      // biome-ignore lint/complexity/useLiteralKeys: HTTP header name
      ["Link"]: entryLinkHeader(),
      "Cache-Control":
        "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
    },
  });

  // buildRdfResponse never returns null when htmlBranch !== "page".
  const res = response as Response;

  // HEAD: same headers + status, no body (200 and 304 alike).
  if (isHead) {
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return res;
}

/** Re-exported so /lookup can compute the slug forward. */
export { slugForWebId, NS_DOC_IRI };
