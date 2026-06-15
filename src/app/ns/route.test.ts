// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — GET /ns ontology + /ns/context.jsonld (DESIGN.md §4.7).
 *
 * Asserts conneg, status codes, HEAD/OPTIONS/405, and the TERM-DEREFERENCE
 * ROUND-TRIP: every term the vocab mints is served (as a defined subject) by /ns,
 * and the crawl-state IRIs an entry uses resolve here.
 */

import { Store as N3Store, Parser } from "n3";
import { describe, expect, it } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import { NS_DOC_IRI, mintedTermIris } from "@/lib/rdf/vocab";

import {
  GET as ctxGET,
  HEAD as ctxHEAD,
  OPTIONS as ctxOPTIONS,
  PUT as ctxPUT,
} from "./context.jsonld/route";
import {
  GET as nsGET,
  HEAD as nsHEAD,
  OPTIONS as nsOPTIONS,
  POST as nsPOST,
} from "./route";

const RDFS = "http://www.w3.org/2000/01/rdf-schema#";

function nsReq(accept = "text/turtle", extra?: HeadersInit): Request {
  return new Request(`${INDEX_BASE_URL}/ns`, {
    method: "GET",
    headers: { Accept: accept, ...(extra ?? {}) },
  });
}

function parseTurtle(ttl: string): Promise<N3Store> {
  return new Promise((resolve, reject) => {
    const s = new N3Store();
    new Parser({ baseIRI: NS_DOC_IRI }).parse(ttl, (err, q) => {
      if (err) reject(err);
      else if (q) s.addQuad(q);
      else resolve(s);
    });
  });
}

describe("GET /ns", () => {
  it("200 — serves the ontology as Turtle with conneg headers", async () => {
    const res = await nsGET(nsReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(res.headers.get("ETag")).toBeTruthy();
  });

  it("TERM-DEREFERENCE ROUND-TRIP: every minted term is defined by /ns", async () => {
    const res = await nsGET(nsReq());
    const store = await parseTurtle(await res.text());
    for (const iri of mintedTermIris()) {
      const definedBy = store.getQuads(iri, `${RDFS}isDefinedBy`, null, null);
      expect(definedBy.length, `${iri} isDefinedBy`).toBe(1);
      expect(definedBy[0].object.value).toBe(NS_DOC_IRI);
      expect(
        store.getQuads(iri, `${RDFS}label`, null, null).length
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("the crawl-state IRIs an entry references resolve here (cross-route round-trip)", async () => {
    const res = await nsGET(nsReq());
    const store = await parseTurtle(await res.text());
    for (const state of ["Live", "Unreachable", "Stale"]) {
      const iri = `${INDEX_BASE_URL}/ns#${state}`;
      expect(
        store.getQuads(iri, null, null, null).length,
        `${iri} must be defined`
      ).toBeGreaterThan(0);
    }
  });

  it("serves JSON-LD with a context Link", async () => {
    const res = await nsGET(nsReq("application/ld+json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/ld+json");
    expect(res.headers.get("Link") ?? "").toContain("json-ld#context");
  });

  it("serves Turtle to a browser Accept (htmlBranch=turtle, never 406/empty)", async () => {
    const res = await nsGET(nsReq("text/html,application/xhtml+xml"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
  });

  it("304 on matching If-None-Match", async () => {
    const first = await nsGET(nsReq());
    const etag = first.headers.get("ETag") ?? "";
    const res = await nsGET(nsReq("text/turtle", { "If-None-Match": etag }));
    expect(res.status).toBe(304);
  });

  it("HEAD → 200 no body; OPTIONS → 204; POST → 405", async () => {
    const head = await nsHEAD(nsReq());
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const opts = await nsOPTIONS();
    expect(opts.status).toBe(204);
    expect(opts.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    const post = nsPOST();
    expect(post.status).toBe(405);
  });
});

describe("GET /ns/context.jsonld", () => {
  function ctxReq(extra?: HeadersInit): Request {
    return new Request(`${INDEX_BASE_URL}/ns/context.jsonld`, {
      method: "GET",
      headers: { ...(extra ?? {}) },
    });
  }

  it("200 — application/ld+json with an @context", async () => {
    const res = await ctxGET(ctxReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/ld+json");
    const body = JSON.parse(await res.text());
    expect(body).toHaveProperty("@context");
    // The context mints the idx: prefix to $ORIGIN/ns#.
    expect(body["@context"].idx).toBe(`${INDEX_BASE_URL}/ns#`);
  });

  it("304 on matching If-None-Match", async () => {
    const first = await ctxGET(ctxReq());
    const etag = first.headers.get("ETag") ?? "";
    const res = await ctxGET(ctxReq({ "If-None-Match": etag }));
    expect(res.status).toBe(304);
  });

  it("HEAD → 200 no body; OPTIONS → 204; PUT → 405", async () => {
    const head = await ctxHEAD(ctxReq());
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const opts = await ctxOPTIONS();
    expect(opts.status).toBe(204);
    const put = ctxPUT();
    expect(put.status).toBe(405);
  });
});
