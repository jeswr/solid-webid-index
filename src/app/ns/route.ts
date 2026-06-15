// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/ns/route.ts — the minted `idx:` ontology document (DESIGN.md §4.7).
 *
 * GET /ns → the operational vocabulary, conneg'd (Turtle / JSON-LD / N-Triples;
 * a browser Accept gets Turtle so a human visiting the URL still sees a valid,
 * correctly-headed RDF body — htmlBranch="turtle").
 *
 * Every term referenced from an entry document (idx:Entry, idx:crawlState, and the
 * three crawl-state Concepts idx:Live / idx:Unreachable / idx:Stale) is DEFINED here,
 * so the term-dereference round-trip holds: a term IRI → /ns serves its definition.
 *
 * The graph is built from lib/rdf/vocab.ts (the single source of truth shared with
 * the entry route) — never hand-concatenated.
 *
 * Statuses: 200 / 304 / 406 / 405.  HEAD + OPTIONS implemented.
 *
 * runtime=nodejs — conneg uses Node crypto (ETag hash).
 */

export const runtime = "nodejs";

import { INDEX_BASE_URL } from "@/lib/config";
import { buildRdfResponse } from "@/lib/http/conneg";
import { NS_DOC_IRI, buildNamespaceQuads } from "@/lib/rdf/vocab";

const ALLOW = "GET, HEAD, OPTIONS";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOW,
  "Access-Control-Allow-Headers": "Accept, If-None-Match",
};

/** Link header: rel="type" → owl:Ontology, JSON-LD context link added by conneg. */
function nsLinkHeader(): string {
  return [
    `<${NS_DOC_IRI}>; rel="canonical"`,
    `<${INDEX_BASE_URL}/ns/context.jsonld>; rel="http://www.w3.org/ns/json-ld#context"`,
  ].join(", ");
}

async function handle(request: Request, isHead: boolean): Promise<Response> {
  const quads = buildNamespaceQuads();
  const response = (await buildRdfResponse({
    request,
    quads,
    status: 200,
    // The ontology is RDF; a browser gets Turtle (friendly) rather than a 406.
    htmlBranch: "turtle",
    extraHeaders: {
      // biome-ignore lint/complexity/useLiteralKeys: HTTP header name
      ["Link"]: nsLinkHeader(),
      // Vocabulary changes rarely — cache aggressively.
      "Cache-Control": "public, max-age=3600, s-maxage=86400, immutable",
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
