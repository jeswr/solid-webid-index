// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * middleware.ts — content negotiation for the landing page `/` (DESIGN.md §4.2).
 *
 * Next.js App Router cannot host both a `page.tsx` (HTML) and a `route.ts` (RDF) at
 * `/`.  This middleware splits conneg on `/`: when the Accept header prefers RDF (a
 * machine / Solid client), it REWRITES (internal — the URL the client sees stays `/`)
 * to `/root-rdf`, which serves the DCAT catalog + dataset + service description.  A
 * browser (Accept prefers text/html) falls through to the HTML page unchanged.
 *
 * The HTML-detection logic mirrors `prefersHtml` in `lib/http/conneg.ts` but is
 * INLINED here (no import) so the middleware stays edge-runtime-safe — conneg.ts
 * pulls `node:crypto` / `node:module` at module load, which is not available on the
 * Edge runtime where middleware executes.  The two must agree: a browser Accept
 * gets HTML; "Accept: star/star" or an explicit RDF type gets RDF.
 *
 * Scope: ONLY the exact path `/` (the `matcher` below).  Every other route handles
 * its own conneg in its handler.
 */

import { type NextRequest, NextResponse } from "next/server";

const RDF_TYPES = new Set([
  "text/turtle",
  "application/ld+json",
  "application/n-triples",
  "application/n-quads",
  "application/trig",
  "text/n3",
  "application/rdf+xml",
]);

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * True when the Accept header prefers HTML over RDF (a browser).  Missing/empty
 * Accept returns false (machine default = RDF).  A bare wildcard also returns false
 * (machines get RDF).
 *
 * Mirrors lib/http/conneg.ts `prefersHtml`: HTML wins only when its q-value is ≥ the
 * best explicit RDF q-value.
 */
function prefersHtml(header: string | null): boolean {
  if (!header) return false;

  let htmlQ = 0;
  let rdfQ = 0;

  for (const token of header.split(",")) {
    const parts = token.trim().split(";");
    const mediaType = parts[0]?.trim().toLowerCase();
    if (!mediaType) continue;

    let q = 1.0;
    for (let i = 1; i < parts.length; i++) {
      const m = parts[i].trim().match(/^q\s*=\s*([\d.]+)$/i);
      if (m) {
        const parsed = Number.parseFloat(m[1]);
        if (!Number.isNaN(parsed)) q = Math.max(0, Math.min(1, parsed));
      }
    }

    if (HTML_TYPES.has(mediaType)) htmlQ = Math.max(htmlQ, q);
    else if (RDF_TYPES.has(mediaType)) rdfQ = Math.max(rdfQ, q);
  }

  if (htmlQ === 0) return false;
  return htmlQ >= rdfQ;
}

export function middleware(request: NextRequest): NextResponse {
  const accept = request.headers.get("accept");

  // A browser (HTML-preferring Accept) → the HTML landing page (no rewrite).
  if (prefersHtml(accept)) {
    return NextResponse.next();
  }

  // A machine / RDF client → the DCAT/VoID catalog representation of `/`.
  const url = request.nextUrl.clone();
  url.pathname = "/root-rdf";
  return NextResponse.rewrite(url);
}

export const config = {
  // ONLY the landing page.  The matcher is an exact match on `/`.
  matcher: ["/"],
};
