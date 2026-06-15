// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/lookup/route.ts — reverse lookup (DESIGN.md §4.1 / §2.3).
 *
 * GET /lookup?webid=<iri> → 303 See Other → /p/{slug}   (the httpRange-14 redirect)
 *
 * The WebID is a client-supplied query param.  We canonicalise it, compute the
 * deterministic slug, and confirm the WebID is actually indexed before redirecting.
 *
 * Statuses:
 *   303 — indexed → Location: /p/{slug}
 *   400 — missing/blank or un-canonicalisable webid param
 *   404 — well-formed webid that is not indexed
 *   405 — non GET/HEAD/OPTIONS
 *
 * runtime=nodejs — slug uses Node crypto (sha256); makeStore needs Node.
 */

export const runtime = "nodejs";

import { INDEX_BASE_URL } from "@/lib/config";
import { makeStore } from "@/lib/store/pgStore";
import { CanonicalError, canonicalWebId } from "@/lib/url/canonical";
import { slugForWebId } from "@/lib/url/slug";

const ALLOW = "GET, HEAD, OPTIONS";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOW,
  "Access-Control-Allow-Headers": "Accept",
};

async function handle(request: Request, isHead: boolean): Promise<Response> {
  const url = new URL(request.url);
  const rawWebid = url.searchParams.get("webid");

  if (!rawWebid || rawWebid.trim() === "") {
    return new Response(
      isHead ? null : "Bad Request: missing required 'webid' query parameter",
      {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
        },
      }
    );
  }

  // Canonicalise the client-supplied WebID (rejects malformed / forbidden scheme).
  let canonical: string;
  try {
    canonical = canonicalWebId(rawWebid);
  } catch (err) {
    if (err instanceof CanonicalError) {
      return new Response(
        isHead ? null : "Bad Request: 'webid' is not a valid WebID IRI",
        {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/plain; charset=utf-8",
          },
        }
      );
    }
    throw err;
  }

  // Confirm the WebID is actually indexed (404 otherwise — do not redirect into a
  // 404 entry route, which would be a misleading 303→404 chain).
  const store = makeStore();
  const entry = await store.getEntryByWebid(canonical);
  if (!entry) {
    return new Response(
      isHead ? null : "Not Found: this WebID is not indexed",
      {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
        },
      }
    );
  }

  // 303 See Other → the canonical entry document (slug derived from the canonical
  // WebID; matches the slug the crawler stored).
  const slug = slugForWebId(canonical);
  const location = `${INDEX_BASE_URL}/p/${slug}`;
  return new Response(isHead ? null : `See Other: ${location}`, {
    status: 303,
    headers: {
      ...CORS_HEADERS,
      Location: location,
      "Content-Type": "text/plain; charset=utf-8",
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
