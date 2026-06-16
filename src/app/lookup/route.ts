// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/lookup/route.ts — reverse lookup (DESIGN.md §4.1 / §2.3).
 *
 * GET /lookup?webid=<iri> → 303 See Other → /p/{slug}   (the httpRange-14 redirect)
 *
 * The WebID is a client-supplied query param.  We canonicalise it, compute the
 * deterministic slug, and confirm the WebID is actually indexed before redirecting.
 *
 * Default (cool-URI) statuses:
 *   303 — indexed → Location: /p/{slug}
 *   400 — missing/blank or un-canonicalisable webid param
 *   404 — well-formed webid that is not indexed
 *   405 — non GET/HEAD/OPTIONS
 *
 * NON-REDIRECTING JSON mode (`?format=json` OR `Accept: application/json`): a
 * programmatic existence check that works identically in Node AND browser fetch
 * with NO redirect (so a browser client never hits the manual-redirect opaque
 * ambiguity, and the client never follows a redirect to a possibly-foreign
 * origin). Always `200` (never a 404 redirect dance) with a JSON body:
 *   - indexed:     `{ "indexed": true,  "webid": <canonical>, "slug": <slug>, "entry": <$ORIGIN/p/{slug}> }`
 *   - not indexed: `{ "indexed": false, "webid": <canonical> }`
 *   - bad webid:   `400 { "error": "..." }`
 * `Vary: Accept` + `no-store`. The consumer client's `isIndexed()` uses this mode.
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

/**
 * Whether the client wants the NON-redirecting JSON existence answer rather than
 * the httpRange-14 `303` redirect.  Two signals (either suffices):
 *   - `?format=json`
 *   - `Accept: application/json` (an explicit JSON preference)
 *
 * This is the programmatic "is this WebID indexed?" mode (the consumer client's
 * {@link IndexClient.isIndexed} uses it): a single `200 {indexed: bool, ...}` that
 * works identically in Node AND browser fetch, with NO redirect — so a browser
 * caller never hits the `redirect:"manual"` opaque-redirect ambiguity and the
 * client never has to follow a redirect to a possibly-foreign origin. The default
 * (no JSON signal) keeps the `303 → /p/{slug}` cool-URI redirect for humans/RDF
 * consumers.
 */
function wantsJson(request: Request, url: URL): boolean {
  if (url.searchParams.get("format") === "json") return true;
  const accept = request.headers.get("Accept") ?? "";
  // Explicit application/json preference (not a bare */* — that still gets the 303).
  return /\bapplication\/json\b/i.test(accept);
}

/** A JSON response with the standard read CORS + no-store headers. */
function jsonResponse(
  body: unknown,
  status: number,
  isHead: boolean
): Response {
  return new Response(isHead ? null : JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      Vary: "Accept",
      "Cache-Control": "no-store",
    },
  });
}

async function handle(request: Request, isHead: boolean): Promise<Response> {
  const url = new URL(request.url);
  const rawWebid = url.searchParams.get("webid");
  const json = wantsJson(request, url);

  if (!rawWebid || rawWebid.trim() === "") {
    if (json) {
      return jsonResponse(
        { error: "missing required 'webid' query parameter" },
        400,
        isHead
      );
    }
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
      if (json) {
        return jsonResponse(
          { error: "'webid' is not a valid WebID IRI" },
          400,
          isHead
        );
      }
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
  const slug = slugForWebId(canonical);

  if (!entry) {
    if (json) {
      // Non-redirecting existence answer: a 200 with indexed:false (NOT a 404) so
      // a browser caller reads it cleanly without redirect/opaque ambiguity.
      return jsonResponse({ indexed: false, webid: canonical }, 200, isHead);
    }
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

  if (json) {
    return jsonResponse(
      {
        indexed: true,
        webid: canonical,
        slug,
        entry: `${INDEX_BASE_URL}/p/${slug}`,
      },
      200,
      isHead
    );
  }

  // 303 See Other → the canonical entry document (slug derived from the canonical
  // WebID; matches the slug the crawler stored).
  const location = `${INDEX_BASE_URL}/p/${slug}`;
  return new Response(isHead ? null : `See Other: ${location}`, {
    status: 303,
    headers: {
      ...CORS_HEADERS,
      Location: location,
      "Content-Type": "text/plain; charset=utf-8",
      Vary: "Accept",
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
