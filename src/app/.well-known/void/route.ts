// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/.well-known/void/route.ts — the VoID + DCAT-3 dataset description (DESIGN.md §4.2).
 *
 * GET /.well-known/void → a `void:Dataset` + `dcat:Dataset` describing the index:
 *   - access methods (void:uriLookupEndpoint = the TPF endpoint; void:dataDump → a
 *     PAGED dump distribution, NOT a live function);
 *   - stats read O(1) from the incremental `stats` table (void:triples / entities /
 *     classes / properties + class & property partitions);
 *   - void:vocabulary per vocab used + a void:Linkset for foaf:knows;
 *   - dcterms:rights clarifying indexed-PII ownership;
 *   - void:exampleResource → a REAL /p/{slug} that dereferences;
 *   - the SPARQL endpoint advertised ONLY when SPARQL_ENABLED (absent by default —
 *     never advertise a 404).
 *
 * Content-negotiated via conneg.ts (Turtle default, JSON-LD, N-Triples).  RDF-only
 * endpoint: a browser Accept is served Turtle (htmlBranch="turtle"), never a bare 200.
 *
 * Statuses: 200 / 304 / 406 / 405.  HEAD + OPTIONS implemented.
 *
 * runtime=nodejs — conneg uses Node crypto (ETag) and makeStore needs Node.
 */

export const runtime = "nodejs";

import { INDEX_BASE_URL, SPARQL_ENABLED } from "@/lib/config";
import { buildRdfResponse } from "@/lib/http/conneg";
import {
  type DatasetDescriptionOptions,
  buildVoidQuads,
} from "@/lib/rdf/datasetDescription";
import { makeStore } from "@/lib/store/pgStore";

const ALLOW = "GET, HEAD, OPTIONS";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOW,
  "Access-Control-Allow-Headers": "Accept, If-None-Match",
};

/**
 * Build the description options: the SPARQL flag + an example slug (a real indexed
 * entry so `void:exampleResource` dereferences).  When the index is empty, the
 * example slug is null and the triple is omitted (a dangling example would not
 * dereference).
 */
async function descriptionOptions(): Promise<{
  stats: Awaited<ReturnType<ReturnType<typeof makeStore>["getStats"]>>;
  opts: DatasetDescriptionOptions;
}> {
  const store = makeStore();
  // Both reads are O(1)/O(1-row): getStats reads pre-aggregated counters; the
  // example lookup is a single LIMIT 1 over a served entry.
  const [stats, page] = await Promise.all([
    store.getStats(),
    store.list({ state: "done", limit: 1 }),
  ]);
  const exampleSlug = page.rows[0]?.slug ?? null;
  return {
    stats,
    opts: { sparqlEnabled: SPARQL_ENABLED, exampleSlug },
  };
}

async function handle(request: Request, isHead: boolean): Promise<Response> {
  const { stats, opts } = await descriptionOptions();
  const quads = buildVoidQuads(stats, opts);

  const response = (await buildRdfResponse({
    request,
    quads,
    status: 200,
    // RDF dataset description; a browser gets Turtle (friendly), never a 406.
    htmlBranch: "turtle",
    extraHeaders: {
      // biome-ignore lint/complexity/useLiteralKeys: HTTP header name
      ["Link"]: `<${INDEX_BASE_URL}/.well-known/void>; rel="canonical"`,
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
    headers: { ...CORS_HEADERS, Allow: ALLOW },
  });
}

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      ...CORS_HEADERS,
      Allow: ALLOW,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
