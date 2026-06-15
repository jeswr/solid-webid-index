// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/ns/context.jsonld/route.ts — the published JSON-LD 1.1 @context (DESIGN.md §4.0 / §4.7).
 *
 * GET /ns/context.jsonld → `{ "@context": { … } }` — the SINGLE context the index's
 * served JSON-LD documents reference (consumers fetch it; the index never dereferences
 * a remote context).  The context body is APP_CONTEXT from lib/http/conneg.ts — the
 * same object the conneg compaction pipeline uses — so the served docs and this
 * published context can never drift.
 *
 * Statuses: 200 / 304 / 405.  HEAD + OPTIONS implemented.
 * Content-Type: application/ld+json.  Immutable cache (the context is versioned).
 *
 * runtime=nodejs — ETag uses Node crypto.
 */

export const runtime = "nodejs";

import { createHash } from "node:crypto";

import { APP_CONTEXT } from "@/lib/http/conneg";

const ALLOW = "GET, HEAD, OPTIONS";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOW,
  "Access-Control-Allow-Headers": "Accept, If-None-Match",
};

const CONTEXT_BODY = JSON.stringify({ "@context": APP_CONTEXT }, null, 2);

function computeETag(body: string): string {
  const hex = createHash("sha256")
    .update(body, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `"sha256-${hex}"`;
}

const ETAG = computeETag(CONTEXT_BODY);

function ifNoneMatchHit(request: Request): boolean {
  const header = request.headers.get("If-None-Match");
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim())
    .some(
      (t) => (t.startsWith("W/") ? t.slice(2).trim() : t) === ETAG || t === "*"
    );
}

function handle(request: Request, isHead: boolean): Response {
  const baseHeaders: Record<string, string> = {
    ...CORS_HEADERS,
    Vary: "Accept",
    ETag: ETAG,
  };

  if (ifNoneMatchHit(request)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  return new Response(isHead ? null : CONTEXT_BODY, {
    status: 200,
    headers: {
      ...baseHeaders,
      "Content-Type": "application/ld+json",
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
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
