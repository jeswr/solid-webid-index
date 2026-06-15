// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/p/[slug]/route.ts — the entry DESCRIPTION document (DESIGN.md §4.1).
 *
 * GET /p/{slug} → an LDP-RS that DESCRIBES an indexed upstream WebID by reference.
 *
 * DESCRIBE-ONLY INVARIANT (sw H3): this document NEVER mints `<>#me a foaf:Person`.
 * The agent's only identity is the upstream WebID (foaf:primaryTopic of `<>`); see
 * lib/rdf/entry.ts.
 *
 * Statuses: 200 (found) / 304 (conditional) / 404 (unknown slug) /
 *           410 + no-store (tombstoned) / 406 (unacceptable Accept) /
 *           405 (non GET/HEAD/OPTIONS).  HEAD + OPTIONS implemented.
 *
 * Conneg (Turtle/JSON-LD/N-Triples), Vary, ETag, and 304 are handled by the shared
 * conneg middleware via lib/http/entryResponse.ts.
 *
 * runtime=nodejs — conneg uses Node crypto (ETag hash) and parseProfile.
 */

export const runtime = "nodejs";

import { buildEntryResponse } from "@/lib/http/entryResponse";
import { makeStore } from "@/lib/store/pgStore";

/** The methods this resource supports (for the Allow header + OPTIONS). */
const ALLOW = "GET, HEAD, OPTIONS";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOW,
  "Access-Control-Allow-Headers": "Accept, If-None-Match",
};

type RouteContext = { params: Promise<{ slug: string }> };

export async function GET(
  request: Request,
  ctx: RouteContext
): Promise<Response> {
  const { slug } = await ctx.params;
  const store = makeStore();
  return buildEntryResponse({ store, slug, request });
}

export async function HEAD(
  request: Request,
  ctx: RouteContext
): Promise<Response> {
  const { slug } = await ctx.params;
  const store = makeStore();
  return buildEntryResponse({ store, slug, request, isHead: true });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, Allow: ALLOW },
  });
}

// ── Method guards — any other verb is 405 with an Allow header ────────────────

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
