// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/tpf/route.ts — Triple Pattern Fragments (DESIGN.md §4.5, spec ref sw H1).
 *
 * GET /tpf?s=&p=&o=[&cursor=<opaque>]
 *
 * Returns ONE RDF graph with three parts (data + metadata + controls — see
 * lib/rdf/tpf.ts):
 *   - DATA      : matching triples from the materialised `triple` table, with
 *                 tombstoned WebIDs' triples FILTERED OUT (store.tpf — DESIGN.md §4.8 H1).
 *   - METADATA  : the fragment typed hydra:Collection + void:Dataset; void:subset;
 *                 void:triples = a PATTERN cardinality ESTIMATE (store.estimatePatternCardinality —
 *                 from the stats table, NOT a live COUNT); hydra:totalItems; hydra:itemsPerPage.
 *   - CONTROLS  : <#dataset> hydra:search [ a hydra:IriTemplate ; hydra:template
 *                 "$ORIGIN/tpf{?s,p,o}" ; mapping s→rdf:subject p→rdf:predicate o→rdf:object ],
 *                 plus hydra:first / hydra:next / hydra:previous page controls.
 *
 * Page-capped (TPF_PAGE_SIZE), Cache-Control: s-maxage=3600 (fragments cache
 * perfectly), per-IP/per-request response byte budget (413 when exceeded —
 * DESIGN.md §4.5 security M3).
 *
 * Content-negotiated via conneg.ts (Turtle default, JSON-LD, N-Triples).  RDF-only
 * endpoint (no HTML page): an HTML-preferring browser Accept is served Turtle with
 * full headers (htmlBranch="turtle"), never a bare empty 200.
 *
 * runtime=nodejs — conneg uses Node crypto (ETag hash) and n3/jsonld.
 */

export const runtime = "nodejs";

import { TPF_MAX_RESPONSE_BYTES, TPF_PAGE_SIZE } from "@/lib/config";
import type { Quad } from "@rdfjs/types";

import {
  type ConnegType,
  buildRdfResponse,
  negotiateType,
  serializeToType,
} from "@/lib/http/conneg";
import { buildFragmentQuads } from "@/lib/rdf/tpf";
import { makeStore } from "@/lib/store/pgStore";
import type { TpfPattern } from "@/lib/store/ports";

const ALLOW = "GET, HEAD, OPTIONS";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOW,
  "Access-Control-Allow-Headers": "Accept, If-None-Match",
};

/**
 * Parse a raw query-param term into a bound pattern term or undefined (variable).
 *
 * An ABSENT param OR an EMPTY-string param is a variable (TPF convention: `?s=`
 * with no value means "any subject").  A present non-empty value is a bound term.
 */
function parseTerm(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  if (raw === "") return undefined;
  return raw;
}

/**
 * Disambiguate whether a bound object term is an IRI or a literal.
 *
 * Heuristic (matches how the materialised `triple.o_is_iri` was set at projection):
 * a value that parses as an absolute IRI with an http(s) or urn scheme is treated
 * as an IRI; everything else is a literal lexical form.  This lets a TPF client
 * query both `?o=<https://idp.example>` (IRI) and `?o=Alice` (literal).
 */
function objectIsIri(o: string): boolean {
  try {
    const u = new URL(o);
    return (
      u.protocol === "https:" || u.protocol === "http:" || u.protocol === "urn:"
    );
  } catch {
    return false;
  }
}

/** Parse ?limit, clamped to [1, TPF_PAGE_SIZE] (TPF pages are server-capped). */
function parsePageSize(raw: string | null): number {
  if (!raw) return TPF_PAGE_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return TPF_PAGE_SIZE;
  return Math.min(n, TPF_PAGE_SIZE);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request, false);
}

export async function HEAD(request: Request): Promise<Response> {
  return handle(request, true);
}

async function handle(request: Request, isHead: boolean): Promise<Response> {
  const url = new URL(request.url);

  const s = parseTerm(url.searchParams.get("s"));
  const p = parseTerm(url.searchParams.get("p"));
  const o = parseTerm(url.searchParams.get("o"));
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const itemsPerPage = parsePageSize(url.searchParams.get("limit"));

  const pattern: TpfPattern = {
    s,
    p,
    o,
    oIsIri: o !== undefined ? objectIsIri(o) : undefined,
  };

  const store = makeStore();

  // DATA (tombstone-filtered, page-capped) + METADATA estimate (from stats — not a COUNT).
  const [{ triples, nextCursor }, estimate] = await Promise.all([
    store.tpf({ pattern, limit: itemsPerPage, cursor }),
    store.estimatePatternCardinality(pattern),
  ]);

  const quads = buildFragmentQuads({
    pattern: { s, p, o },
    triples,
    estimate,
    itemsPerPage,
    cursor,
    nextCursor,
  });

  const extraHeaders: Record<string, string> = {
    // Fragments cache perfectly — a long shared cache TTL (DESIGN.md §4.5).
    "Cache-Control": "public, s-maxage=3600",
  };

  // ── Per-request response byte budget (security M3) ───────────────────────────
  // Negotiate + serialise once, check the byte size against the budget, and only
  // then hand off to buildRdfResponse (which serialises again for the final body +
  // ETag).  Over-budget → 413, never a giant body.  Page-cap already bounds the
  // triple count; this guards a pathological many-long-IRIs page.
  const probe = await probeSerialisedBytes(request, quads);
  if (probe > TPF_MAX_RESPONSE_BYTES) {
    return new Response(
      isHead
        ? null
        : `Payload Too Large: TPF fragment exceeds the ${TPF_MAX_RESPONSE_BYTES}-byte per-request budget; narrow the pattern or follow hydra:next`,
      {
        status: 413,
        headers: {
          ...CORS_HEADERS,
          Vary: "Accept",
          "Content-Type": "text/plain; charset=utf-8",
        },
      }
    );
  }

  const response = (await buildRdfResponse({
    request,
    quads,
    status: 200,
    htmlBranch: "turtle",
    extraHeaders,
  })) as Response;

  if (isHead) {
    return new Response(null, {
      status: response.status,
      headers: response.headers,
    });
  }
  return response;
}

/**
 * Serialise the quads to the negotiated RDF type once to measure the byte size for
 * the response-budget check.  Returns null when the negotiated type is HTML/406
 * (no RDF body to measure) — the budget gate is skipped and buildRdfResponse takes
 * over (it serves Turtle for a browser Accept via htmlBranch="turtle").
 */
async function probeSerialisedBytes(
  request: Request,
  quads: Quad[]
): Promise<number> {
  const { type, profile } = negotiateType(request.headers.get("Accept"));
  // HTML branch (browser) or 406: buildRdfResponse will serve Turtle (htmlBranch=
  // "turtle"), so budget the Turtle body as the proxy for the eventual response.
  const measuredType: Exclude<ConnegType, "text/html"> =
    type === null || type === "text/html"
      ? "text/turtle"
      : (type as Exclude<ConnegType, "text/html">);
  const measuredProfile = measuredType === type ? profile : null;
  const { body } = await serializeToType(quads, measuredType, measuredProfile);
  return Buffer.byteLength(body, "utf-8");
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
