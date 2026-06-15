// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/root-rdf/route.ts — the RDF representation of the landing page `/`.
 *
 * Next.js App Router cannot host both a `page.tsx` (the HTML landing page) AND a
 * `route.ts` at the same `/` segment, so conneg on `/` is split: `src/middleware.ts`
 * inspects the Accept header on a request to `/` and REWRITES (internal, URL stays
 * `/`) to THIS route when the client prefers RDF; a browser falls through to the
 * HTML page.  (The folder is NOT underscore-prefixed: App Router treats `_`-folders
 * as PRIVATE and excludes them from routing, so an `_`-name would never build.)
 * The RDF describes the resource `$ORIGIN/` (not /root-rdf), so a direct GET of
 * /root-rdf still yields a valid, correctly-subjected catalog description.
 *
 * The body (DESIGN.md §4.2):
 *   - `dcat:Catalog` + `dcat:Dataset` + `dcat:DataService` (search + TPF; SPARQL only
 *     when SPARQL_ENABLED);
 *   - the `</inbox/> ldp:inbox` triple IN THE BODY (the suggest-inbox sibling
 *     advertises ldp:inbox via the root Link header — BOTH are required; the header
 *     is set here too so a HEAD/cache sees it without parsing the graph);
 *   - a `hydra:search` entrypoint → /search;
 *   - the dataset stats (read O(1) from the incremental `stats` table).
 *
 * runtime=nodejs — conneg uses Node crypto (ETag); makeStore needs Node.
 */

export const runtime = "nodejs";

import { INDEX_BASE_URL, SPARQL_ENABLED } from "@/lib/config";
import { buildRdfResponse } from "@/lib/http/conneg";
import {
  DATASET_DESCRIPTION_IRIS,
  buildRootCatalogQuads,
} from "@/lib/rdf/datasetDescription";
import { makeStore } from "@/lib/store/pgStore";

const ALLOW = "GET, HEAD, OPTIONS";

/**
 * The root Link header: rel="http://www.w3.org/ns/ldp#inbox" (the LDN discovery
 * link the suggest-inbox sibling advertises) + rel="describedby" → the VoID doc.
 * The ldp:inbox triple is ALSO in the RDF body (see buildRootCatalogQuads) — the
 * header is for discovery / HEAD; the body triple is for an RDF graph consumer.
 */
function rootLinkHeader(): string {
  return [
    `<${DATASET_DESCRIPTION_IRIS.inbox}>; rel="http://www.w3.org/ns/ldp#inbox"`,
    `<${INDEX_BASE_URL}/.well-known/void>; rel="describedby"`,
  ].join(", ");
}

async function handle(request: Request, isHead: boolean): Promise<Response> {
  const store = makeStore();
  const stats = await store.getStats();
  const quads = buildRootCatalogQuads(stats, {
    sparqlEnabled: SPARQL_ENABLED,
    // The catalog doesn't need a void:exampleResource; that lives in /.well-known/void.
    exampleSlug: null,
  });

  const response = (await buildRdfResponse({
    request,
    quads,
    status: 200,
    // Defensive: this route is only reached for an RDF Accept (the middleware
    // routes browsers to the HTML page), but if a browser hits it directly serve
    // Turtle rather than a bare 200.
    htmlBranch: "turtle",
    extraHeaders: {
      // biome-ignore lint/complexity/useLiteralKeys: HTTP header name
      ["Link"]: rootLinkHeader(),
      "Cache-Control":
        "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
    },
  })) as Response;

  if (isHead) {
    return new Response(null, {
      status: response.status,
      headers: response.headers,
    });
  }
  return response;
}

export async function GET(request: Request): Promise<Response> {
  return handle(request, false);
}

export async function HEAD(request: Request): Promise<Response> {
  return handle(request, true);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": ALLOW,
      "Access-Control-Allow-Headers": "Accept, If-None-Match",
      Allow: ALLOW,
    },
  });
}
