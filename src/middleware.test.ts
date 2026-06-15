// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * middleware.test.ts — the `/` content-negotiation rewrite (DESIGN.md §4.2).
 *
 * A browser Accept (HTML-preferring) falls through to the HTML page (no rewrite);
 * a machine / RDF Accept is internally rewritten to /root-rdf (the URL stays `/`).
 */

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { middleware } from "./middleware.js";

function reqWithAccept(accept: string | null): NextRequest {
  const headers = new Headers();
  if (accept !== null) headers.set("accept", accept);
  return new NextRequest("https://webid-index.example/", { headers });
}

/** The rewrite destination path encoded by NextResponse.rewrite (x-middleware-rewrite). */
function rewriteTarget(res: ReturnType<typeof middleware>): string | null {
  const loc = res.headers.get("x-middleware-rewrite");
  if (!loc) return null;
  return new URL(loc).pathname;
}

describe("middleware — / conneg", () => {
  it("a browser Accept (text/html) falls through to the HTML page (no rewrite)", () => {
    const res = middleware(
      reqWithAccept(
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      )
    );
    expect(rewriteTarget(res)).toBeNull();
  });

  it("an RDF Accept (text/turtle) is rewritten to /root-rdf", () => {
    const res = middleware(reqWithAccept("text/turtle"));
    expect(rewriteTarget(res)).toBe("/root-rdf");
  });

  it("application/ld+json is rewritten to /root-rdf", () => {
    const res = middleware(reqWithAccept("application/ld+json"));
    expect(rewriteTarget(res)).toBe("/root-rdf");
  });

  it("a bare wildcard Accept (machine) gets RDF (rewrite)", () => {
    const res = middleware(reqWithAccept("*/*"));
    expect(rewriteTarget(res)).toBe("/root-rdf");
  });

  it("a missing Accept (machine default) gets RDF (rewrite)", () => {
    const res = middleware(reqWithAccept(null));
    expect(rewriteTarget(res)).toBe("/root-rdf");
  });

  it("HTML with a lower-q RDF alternative still prefers HTML (no rewrite)", () => {
    const res = middleware(reqWithAccept("text/html,text/turtle;q=0.5"));
    expect(rewriteTarget(res)).toBeNull();
  });

  it("explicit RDF q above HTML q gets RDF (rewrite)", () => {
    const res = middleware(reqWithAccept("text/html;q=0.5,text/turtle;q=0.9"));
    expect(rewriteTarget(res)).toBe("/root-rdf");
  });
});
