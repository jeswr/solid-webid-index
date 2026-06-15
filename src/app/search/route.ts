// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/search/route.ts — Linked-Data SEARCH API (DESIGN.md §4.4).
 *
 * GET /search?q=<query>[&cursor=<opaque>][&limit=<n>]
 *
 * Returns a hydra:Collection whose members are matched WebID resources
 * (foaf:Person / Agent entries), with:
 *   - hydra:PartialCollectionView paging (next/previous via keyset cursor)
 *   - hydra:IriTemplate describing the search entrypoint on the root resource
 *   - CORS for public read access
 *
 * Content-negotiated via conneg.ts (Turtle default, JSON-LD, N-Triples).
 *
 * FTS: delegates to SearchIndex.search() (pgStore — label_fts weighted tsvector).
 * Query sanitisation: lowercase → strip non-[a-z0-9 ] → split → cap tokens.
 * Empty/blank query returns an empty hydra:Collection (200 OK, not an error).
 *
 * runtime=nodejs — required: conneg uses Node crypto (ETag hash).
 */

export const runtime = "nodejs";

import type { Quad } from "@rdfjs/types";
import { DataFactory } from "n3";

import { INDEX_BASE_URL, SEARCH_PAGE_SIZE } from "@/lib/config";
import { buildRdfResponse } from "@/lib/http/conneg";
import { sanitiseFtsQuery } from "@/lib/search/sanitise";
import { makeStore } from "@/lib/store/pgStore";

// ─── RDF namespace helpers ─────────────────────────────────────────────────────

const { namedNode, literal, quad: q } = DataFactory;

const HYDRA = "http://www.w3.org/ns/hydra/core#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const DCT = "http://purl.org/dc/terms/";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const hn = (localName: string) => namedNode(`${HYDRA}${localName}`);
const rn = (localName: string) => namedNode(`${RDF}${localName}`);

/** Parse ?limit=<n> from the URL, clamped to [1, SEARCH_PAGE_SIZE * 5]. */
function parseLimit(raw: string | null): number {
  if (!raw) return SEARCH_PAGE_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return SEARCH_PAGE_SIZE;
  // Cap at 5× the default page size (anti-DoS; configurable via env).
  return Math.min(n, SEARCH_PAGE_SIZE * 5);
}

// ─── Hydra collection quad builder ────────────────────────────────────────────

/**
 * Build the RDF dataset for a Hydra PartialCollectionView search result.
 *
 * Shape (DESIGN.md §4.4):
 *
 *   <$ORIGIN/search> a hydra:Collection ;
 *     hydra:totalItems <advisory count of members on this page> ;
 *     hydra:search [ a hydra:IriTemplate ;
 *       hydra:template "$ORIGIN/search{?q}" ;
 *       hydra:variableRepresentation hydra:BasicRepresentation ;
 *       hydra:mapping [ hydra:variable "q" ;
 *                       hydra:property idx:searchText ;
 *                       hydra:required true ] ] ;
 *     hydra:view <$ORIGIN/search?q=...&cursor=...> .
 *
 *   <$ORIGIN/search?q=...&cursor=...> a hydra:PartialCollectionView ;
 *     hydra:first  <$ORIGIN/search?q=...> ;
 *     hydra:next   <$ORIGIN/search?q=...&cursor=<nextCursor>> .   (when present)
 *
 *   <$ORIGIN/search?q=...> hydra:member <webid1>, <webid2>, ... .
 *
 *   <webid1> a foaf:Person ;
 *     foaf:name "Alice" ;     (when label is present)
 *     dct:modified "..." .    (when lastCrawled is present)
 *
 * The IriTemplate is asserted on the collection resource (the canonical
 * <$ORIGIN/search>) so consumers can discover it from the landing page's
 * hydra:search link.
 *
 * Keyset cursor is forwarded opaquely — clients MUST NOT reconstruct it.
 */
function buildCollectionQuads(opts: {
  q: string;
  limit: number;
  cursor: string | undefined;
  members: Array<{
    webid: string | null;
    docUrl: string;
    label: string | null;
    isSolid: boolean;
    lastCrawled: number | null;
  }>;
  nextCursor: string | null;
}): Quad[] {
  const { q: queryStr, cursor, members, nextCursor } = opts;

  const collectionIri = `${INDEX_BASE_URL}/search`;
  const idxNs = `${INDEX_BASE_URL}/ns#`;

  // Current view URL — the URL for THIS page (parameterised by q + cursor).
  const viewUrl = new URL(`${INDEX_BASE_URL}/search`);
  if (queryStr) viewUrl.searchParams.set("q", queryStr);
  if (cursor) viewUrl.searchParams.set("cursor", cursor);

  // First-page URL — same q, no cursor.
  const firstUrl = new URL(`${INDEX_BASE_URL}/search`);
  if (queryStr) firstUrl.searchParams.set("q", queryStr);

  const collection = namedNode(collectionIri);
  const view = namedNode(viewUrl.toString());
  const first = namedNode(firstUrl.toString());

  const quads: Quad[] = [];

  // ── hydra:Collection ────────────────────────────────────────────────────────
  quads.push(q(collection, rn("type"), hn("Collection")));
  quads.push(
    q(
      collection,
      hn("totalItems"),
      // Advisory: the count of members on THIS page (keyset pagination does not
      // count total hits; DESIGN.md §4.4 M6 — clients terminate on absent hydra:next).
      literal(String(members.length), namedNode(`${XSD}nonNegativeInteger`))
    )
  );

  // ── hydra:view → PartialCollectionView ─────────────────────────────────────
  quads.push(q(collection, hn("view"), view));
  quads.push(q(view, rn("type"), hn("PartialCollectionView")));
  quads.push(q(view, hn("first"), first));

  // hydra:next (forward-only keyset pagination)
  if (nextCursor !== null) {
    const nextUrl = new URL(`${INDEX_BASE_URL}/search`);
    if (queryStr) nextUrl.searchParams.set("q", queryStr);
    nextUrl.searchParams.set("cursor", nextCursor);
    quads.push(q(view, hn("next"), namedNode(nextUrl.toString())));
  }

  // ── hydra:IriTemplate (search form) on the collection resource ─────────────
  // Blank nodes for the template and mapping.
  const tmplNode = DataFactory.blankNode("searchTemplate");
  const mappingNode = DataFactory.blankNode("searchMapping");

  quads.push(q(collection, hn("search"), tmplNode));
  quads.push(q(tmplNode, rn("type"), hn("IriTemplate")));
  quads.push(
    q(tmplNode, hn("template"), literal(`${INDEX_BASE_URL}/search{?q}`))
  );
  quads.push(
    q(tmplNode, hn("variableRepresentation"), hn("BasicRepresentation"))
  );
  quads.push(q(tmplNode, hn("mapping"), mappingNode));
  quads.push(q(mappingNode, rn("type"), hn("IriTemplateMapping")));
  quads.push(q(mappingNode, hn("variable"), literal("q")));
  quads.push(q(mappingNode, hn("property"), namedNode(`${idxNs}searchText`)));
  quads.push(
    q(mappingNode, hn("required"), literal("true", namedNode(`${XSD}boolean`)))
  );

  // ── Members ─────────────────────────────────────────────────────────────────
  for (const member of members) {
    // The member IRI is the WebID when available; fall back to the doc URL.
    const memberIri = member.webid ?? member.docUrl;
    const memberNode = namedNode(memberIri);

    // Assert membership on the collection (not the view — per Hydra spec the
    // members are on the Collection, views are navigation).
    quads.push(q(collection, hn("member"), memberNode));

    // Describe the member resource.
    quads.push(q(memberNode, rn("type"), namedNode(`${FOAF}Person`)));

    if (member.label) {
      quads.push(
        q(memberNode, namedNode(`${FOAF}name`), literal(member.label))
      );
    }

    if (member.lastCrawled !== null) {
      // dcterms:modified — ISO-8601 xsd:dateTime
      const dt = new Date(member.lastCrawled).toISOString();
      quads.push(
        q(
          memberNode,
          namedNode(`${DCT}modified`),
          literal(dt, namedNode(`${XSD}dateTime`))
        )
      );
    }
  }

  return quads;
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rawQ = url.searchParams.get("q") ?? "";
  const rawCursor = url.searchParams.get("cursor") ?? undefined;
  const rawLimit = url.searchParams.get("limit");

  const limit = parseLimit(rawLimit);
  const sanitised = sanitiseFtsQuery(rawQ);

  // Empty / blank query → empty collection (200, not an error; DESIGN.md §4.4).
  if (!sanitised) {
    const emptyQuads = buildCollectionQuads({
      q: rawQ,
      limit,
      cursor: rawCursor,
      members: [],
      nextCursor: null,
    });

    const rdfResponse = await buildRdfResponse({
      request,
      quads: emptyQuads,
      status: 200,
      extraHeaders: {
        "Cache-Control":
          "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
      },
    });

    // buildRdfResponse returns null for browser HTML branch — search has no HTML
    // page component yet so we fall back to a minimal 200 Turtle response.
    return rdfResponse ?? new Response("", { status: 200 });
  }

  const store = makeStore();
  const { rows, nextCursor } = await store.search({
    query: sanitised,
    limit,
    cursor: rawCursor,
  });

  const members = rows.map((r) => ({
    webid: r.webid,
    docUrl: r.docUrl,
    label: r.label,
    isSolid: r.isSolid,
    lastCrawled: r.lastCrawled,
  }));

  const quads = buildCollectionQuads({
    q: rawQ,
    limit,
    cursor: rawCursor,
    members,
    nextCursor,
  });

  const rdfResponse = await buildRdfResponse({
    request,
    quads,
    status: 200,
    extraHeaders: {
      "Cache-Control":
        "public, max-age=60, s-maxage=300, stale-while-revalidate=86400",
    },
  });

  return rdfResponse ?? new Response("", { status: 200 });
}

// Handle OPTIONS (CORS preflight) — CORS headers are already set by buildRdfResponse
// via READ_CORS_HEADERS; this OPTIONS handler ensures preflight also responds 204.
export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, If-None-Match",
    },
  });
}
