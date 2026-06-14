// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * conneg.test.ts — unit tests for src/lib/http/conneg.ts
 *
 * No network calls. All inputs are synthetic quads / fixture strings.
 * Tests cover:
 *   - Accept dispatch: turtle default, json-ld, n-triples, html branch, q-values, star-star
 *   - Turtle + JSON-LD round-trip (serialise then re-parse with @jeswr/fetch-rdf)
 *   - Vary + ETag present on every conneg response
 *   - If-None-Match match → 304
 *   - ETag uniqueness: compacted vs expanded JSON-LD share no validator
 *   - 406 on unsupported Accept
 *   - JSON-LD profile parameter dispatch (expanded, flattened)
 *   - CORS headers on read responses
 */

import { parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore, Quad } from "@rdfjs/types";
import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";
import {
  APP_CONTEXT,
  HTML_SENTINEL,
  buildCachedRdfResponse,
  buildRdfResponse,
  computeETag,
  ifNoneMatchMatches,
  negotiateType,
  parseAcceptHeader,
  parseIfNoneMatch,
  prefersHtml,
  serializeJsonLdCompacted,
  serializeNTriples,
  serializeTurtle,
} from "./conneg";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const { namedNode, literal, quad, defaultGraph } = DataFactory;

const WEBID = "https://alice.example/card#me";
const DOC = "https://alice.example/card";

/** A small sample dataset — one WebID description triple. */
function sampleQuads(): Quad[] {
  return [
    quad(
      namedNode(WEBID),
      namedNode("http://xmlns.com/foaf/0.1/name"),
      literal("Alice Smith"),
      defaultGraph()
    ),
    quad(
      namedNode(WEBID),
      namedNode("http://www.w3.org/ns/solid/terms#oidcIssuer"),
      namedNode("https://idp.example/"),
      defaultGraph()
    ),
    quad(
      namedNode(DOC),
      namedNode("http://xmlns.com/foaf/0.1/primaryTopic"),
      namedNode(WEBID),
      defaultGraph()
    ),
  ];
}

/** Build a Next.js-style `Request` with the given Accept header. */
function req(accept: string, ifNoneMatch?: string): Request {
  const headers: Record<string, string> = { Accept: accept };
  if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
  return new Request("https://example.com/p/test", { headers });
}

// ─── parseAcceptHeader ────────────────────────────────────────────────────────

describe("parseAcceptHeader", () => {
  it("returns empty array for null", () => {
    expect(parseAcceptHeader(null)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseAcceptHeader("")).toEqual([]);
  });

  it("parses a single type with no q", () => {
    const result = parseAcceptHeader("text/turtle");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
    expect(result[0].subtype).toBe("turtle");
    expect(result[0].q).toBe(1.0);
  });

  it("parses multiple types sorted by q-value", () => {
    const result = parseAcceptHeader(
      "text/html, application/ld+json;q=0.9, */*;q=0.1"
    );
    expect(result[0].type).toBe("text");
    expect(result[0].subtype).toBe("html");
    expect(result[0].q).toBe(1.0);
    expect(result[1].q).toBe(0.9);
    expect(result[2].q).toBe(0.1);
  });

  it("handles q=0 (type refusal)", () => {
    const result = parseAcceptHeader("application/rdf+xml;q=0");
    expect(result[0].q).toBe(0);
  });

  it("parses wildcard */*", () => {
    const result = parseAcceptHeader("*/*");
    expect(result[0].type).toBe("*");
    expect(result[0].subtype).toBe("*");
  });

  it("extracts profile parameter", () => {
    const result = parseAcceptHeader('application/ld+json;profile="#expanded"');
    expect(result[0].params).toContain("profile");
  });
});

// ─── prefersHtml ──────────────────────────────────────────────────────────────

describe("prefersHtml", () => {
  it("returns false for null", () => {
    expect(prefersHtml(null)).toBe(false);
  });

  it("returns false for */*", () => {
    expect(prefersHtml("*/*")).toBe(false);
  });

  it("returns false for text/turtle", () => {
    expect(prefersHtml("text/turtle")).toBe(false);
  });

  it("returns true for a typical browser Accept", () => {
    // Chrome-style browser Accept
    expect(
      prefersHtml(
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      )
    ).toBe(true);
  });

  it("returns true when html is present and no RDF type has higher q", () => {
    expect(prefersHtml("text/html;q=0.9, */*;q=0.5")).toBe(true);
  });

  it("returns false when application/ld+json has equal-or-higher q than text/html", () => {
    expect(prefersHtml("application/ld+json, text/html;q=0.5")).toBe(false);
  });

  it("returns false when text/turtle is prioritised over text/html", () => {
    expect(prefersHtml("text/turtle;q=1.0, text/html;q=0.9")).toBe(false);
  });
});

// ─── negotiateType ────────────────────────────────────────────────────────────

describe("negotiateType", () => {
  it("defaults to text/turtle for null Accept", () => {
    const { type } = negotiateType(null);
    expect(type).toBe("text/turtle");
  });

  it("defaults to text/turtle for empty Accept", () => {
    const { type } = negotiateType("");
    expect(type).toBe("text/turtle");
  });

  it("defaults to text/turtle for */*", () => {
    const { type } = negotiateType("*/*");
    expect(type).toBe("text/turtle");
  });

  it("returns html sentinel for browser Accept", () => {
    const { type } = negotiateType(
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    );
    expect(type).toBe(HTML_SENTINEL);
  });

  it("returns application/ld+json when requested", () => {
    const { type } = negotiateType("application/ld+json");
    expect(type).toBe("application/ld+json");
  });

  it("returns application/n-triples when requested", () => {
    const { type } = negotiateType("application/n-triples");
    expect(type).toBe("application/n-triples");
  });

  it("returns text/turtle when requested explicitly", () => {
    const { type } = negotiateType("text/turtle");
    expect(type).toBe("text/turtle");
  });

  it("honours q-values: picks higher-q type first", () => {
    // turtle at 0.9, json-ld at 1.0 → json-ld wins
    const { type } = negotiateType(
      "application/ld+json;q=1.0, text/turtle;q=0.9"
    );
    expect(type).toBe("application/ld+json");
  });

  it("extracts profile parameter for application/ld+json", () => {
    // Use the actual profile IRI the design mandates
    const expandedProfile = "http://localhost:3000/ns/context.jsonld#expanded";
    const { type, profile } = negotiateType(
      `application/ld+json;profile="${expandedProfile}"`
    );
    expect(type).toBe("application/ld+json");
    expect(profile).toBe(expandedProfile);
  });

  it("returns null (406) for unsatisfiable Accept", () => {
    const { type } = negotiateType("application/rdf+xml");
    expect(type).toBeNull();
  });

  it("returns null (406) when */* has q=0", () => {
    const { type } = negotiateType("*/*;q=0");
    expect(type).toBeNull();
  });

  it("ignores text/turtle with q=0 and falls through to next type", () => {
    const { type } = negotiateType("text/turtle;q=0, application/ld+json");
    expect(type).toBe("application/ld+json");
  });

  // ── Finding 1: q=0 + media-range specificity ────────────────────────────────

  it("text/turtle;q=0, */*;q=1 does NOT return Turtle — returns next acceptable type", () => {
    // Turtle is explicitly refused (q=0 takes precedence over */*);
    // server preference order picks application/ld+json next.
    const { type } = negotiateType("text/turtle;q=0, */*;q=1");
    expect(type).not.toBe("text/turtle");
    expect(type).toBe("application/ld+json");
  });

  it("a type with q=0 is never chosen even when */* has higher q", () => {
    // All RDF types explicitly refused — nothing left to serve.
    const { type } = negotiateType(
      "text/turtle;q=0, application/ld+json;q=0, application/n-triples;q=0, */*;q=1"
    );
    // */* has q=1 but server prefers Turtle and all explicit RDF types are q=0;
    // the specific q=0 range beats the wildcard for those types → 406.
    expect(type).toBeNull();
  });

  it("most-specific range wins over */*: exact type match takes precedence", () => {
    // */* at q=1, but application/ld+json is specifically at q=0.8.
    // For ld+json, the exact match (q=0.8) is more specific than */* (q=1).
    // For turtle, */* applies (q=1). So turtle wins.
    const { type } = negotiateType("*/*;q=1, application/ld+json;q=0.8");
    // turtle has effective q=1 (from */*); ld+json has q=0.8 (exact match);
    // n-triples has q=1 (from */*). Turtle is most preferred server type at q=1.
    expect(type).toBe("text/turtle");
  });

  it("most-specific range wins: explicit lower-q beats wildcard higher-q for that type", () => {
    // turtle is pinned at q=0.5 via exact match, */* at q=0.9.
    // turtle's effective q = 0.5 (exact > wildcard); ld+json's effective q = 0.9 (*/*).
    const { type } = negotiateType("text/turtle;q=0.5, */*;q=0.9");
    expect(type).toBe("application/ld+json");
  });

  it("nothing-acceptable → 406 when all supported types are refused", () => {
    const { type } = negotiateType("application/rdf+xml");
    expect(type).toBeNull();
  });

  it("*/* with q=0 yields 406 (no fallback)", () => {
    const { type } = negotiateType("*/*;q=0");
    expect(type).toBeNull();
  });
});

// ─── parseIfNoneMatch + ifNoneMatchMatches ───────────────────────────────────

describe("parseIfNoneMatch", () => {
  it("returns empty array for null", () => {
    expect(parseIfNoneMatch(null)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseIfNoneMatch("")).toEqual([]);
  });

  it("parses a single ETag", () => {
    expect(parseIfNoneMatch('"abc123"')).toEqual(['"abc123"']);
  });

  it("parses a comma-separated list of ETags", () => {
    const tags = parseIfNoneMatch('"tag1", "tag2", "tag3"');
    expect(tags).toHaveLength(3);
    expect(tags).toContain('"tag1"');
    expect(tags).toContain('"tag2"');
    expect(tags).toContain('"tag3"');
  });

  it("returns ['*'] for the wildcard", () => {
    expect(parseIfNoneMatch("*")).toEqual(["*"]);
  });

  it("trims whitespace around tags", () => {
    const tags = parseIfNoneMatch('  "tag1" ,  "tag2"  ');
    expect(tags).toContain('"tag1"');
    expect(tags).toContain('"tag2"');
  });
});

describe("ifNoneMatchMatches", () => {
  it("returns false for null header", () => {
    expect(ifNoneMatchMatches(null, '"sha256-abc"')).toBe(false);
  });

  it("returns false when ETag is not in the list", () => {
    expect(ifNoneMatchMatches('"sha256-other"', '"sha256-abc"')).toBe(false);
  });

  it("returns true for exact single match", () => {
    expect(ifNoneMatchMatches('"sha256-abc"', '"sha256-abc"')).toBe(true);
  });

  it("returns true when ETag appears in a multi-value list", () => {
    // Finding 3: multi-value If-None-Match
    expect(
      ifNoneMatchMatches('"sha256-old", "sha256-abc"', '"sha256-abc"')
    ).toBe(true);
  });

  it("returns false when ETag does not appear in a multi-value list", () => {
    expect(
      ifNoneMatchMatches('"sha256-old1", "sha256-old2"', '"sha256-abc"')
    ).toBe(false);
  });

  it("returns true for wildcard *", () => {
    // Finding 3: If-None-Match: * matches any existing representation
    expect(ifNoneMatchMatches("*", '"sha256-anything"')).toBe(true);
  });

  it("handles W/ weak ETag prefix in the header", () => {
    // Weak comparison strips W/ prefix
    expect(ifNoneMatchMatches('W/"sha256-abc"', '"sha256-abc"')).toBe(true);
  });
});

// ─── serializeTurtle ─────────────────────────────────────────────────────────

describe("serializeTurtle", () => {
  it("serialises quads to non-empty Turtle", async () => {
    const ttl = await serializeTurtle(sampleQuads());
    expect(ttl.length).toBeGreaterThan(0);
    expect(ttl).toContain("Alice Smith");
  });

  it("round-trips through @jeswr/fetch-rdf parseRdf", async () => {
    const quads = sampleQuads();
    const ttl = await serializeTurtle(quads);

    // Re-parse with the sanctioned parser (no inline new Parser() — skill rule).
    // parseRdf returns a DatasetCore — use has() with a concrete quad.
    const dataset = (await parseRdf(ttl, "text/turtle", {
      baseIRI: DOC,
    })) as DatasetCore;

    // Collect quads matching the foaf:name triple via the DatasetCore iterator.
    const nameTriples = [...dataset].filter(
      (q) =>
        q.subject.value === WEBID &&
        q.predicate.value === "http://xmlns.com/foaf/0.1/name"
    );
    expect(nameTriples).toHaveLength(1);
    expect(nameTriples[0].object.value).toBe("Alice Smith");
  });

  it("round-trips solid:oidcIssuer IRI", async () => {
    const quads = sampleQuads();
    const ttl = await serializeTurtle(quads);

    const dataset = (await parseRdf(ttl, "text/turtle", {
      baseIRI: DOC,
    })) as DatasetCore;
    const issuerTriples = [...dataset].filter(
      (q) =>
        q.subject.value === WEBID &&
        q.predicate.value === "http://www.w3.org/ns/solid/terms#oidcIssuer"
    );
    expect(issuerTriples).toHaveLength(1);
    expect(issuerTriples[0].object.value).toBe("https://idp.example/");
  });
});

// ─── serializeNTriples ────────────────────────────────────────────────────────

describe("serializeNTriples", () => {
  it("serialises quads to N-Triples", async () => {
    const nt = await serializeNTriples(sampleQuads());
    expect(nt.length).toBeGreaterThan(0);
    // N-Triples ends each triple with " .\n"
    expect(nt).toMatch(/ \.\n/);
  });

  it("round-trips through @jeswr/fetch-rdf parseRdf", async () => {
    const quads = sampleQuads();
    const nt = await serializeNTriples(quads);

    const dataset = (await parseRdf(nt, "application/n-triples", {
      baseIRI: DOC,
    })) as DatasetCore;

    const nameTriples = [...dataset].filter(
      (q) =>
        q.subject.value === WEBID &&
        q.predicate.value === "http://xmlns.com/foaf/0.1/name"
    );
    expect(nameTriples).toHaveLength(1);
  });
});

// ─── serializeJsonLdCompacted ─────────────────────────────────────────────────

describe("serializeJsonLdCompacted", () => {
  it("serialises quads to valid JSON", async () => {
    const json = await serializeJsonLdCompacted(sampleQuads());
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("output contains @context", async () => {
    const json = await serializeJsonLdCompacted(sampleQuads());
    const doc = JSON.parse(json) as Record<string, unknown>;
    expect(doc).toHaveProperty("@context");
  });

  it("round-trips name literal through @jeswr/fetch-rdf parseRdf", async () => {
    const quads = sampleQuads();
    const json = await serializeJsonLdCompacted(quads);

    // parseRdf handles application/ld+json via jsonld-streaming-parser.
    const dataset = (await parseRdf(json, "application/ld+json", {
      baseIRI: DOC,
    })) as DatasetCore;

    const nameTriples = [...dataset].filter(
      (q) =>
        q.subject.value === WEBID &&
        q.predicate.value === "http://xmlns.com/foaf/0.1/name"
    );
    expect(nameTriples).toHaveLength(1);
    expect(nameTriples[0].object.value).toBe("Alice Smith");
  });

  it("produces expanded JSON-LD for profile #expanded", async () => {
    const expandedProfile = "http://localhost:3000/ns/context.jsonld#expanded";
    const json = await serializeJsonLdCompacted(sampleQuads(), expandedProfile);
    const doc = JSON.parse(json) as unknown;
    // Expanded JSON-LD is an array.
    expect(Array.isArray(doc)).toBe(true);
  });

  it("produces flattened JSON-LD for profile #flattened", async () => {
    const flatProfile = "http://localhost:3000/ns/context.jsonld#flattened";
    const json = await serializeJsonLdCompacted(sampleQuads(), flatProfile);
    const doc = JSON.parse(json) as Record<string, unknown>;
    // Flattened JSON-LD has a @graph key.
    expect(doc).toHaveProperty("@graph");
  });

  it("APP_CONTEXT has @version 1.1", () => {
    expect(APP_CONTEXT["@version"]).toBe(1.1);
  });

  it("APP_CONTEXT has solid:oidcIssuer as @id with @container @set", () => {
    const term = APP_CONTEXT["solid:oidcIssuer"] as Record<string, unknown>;
    expect(term["@type"]).toBe("@id");
    expect(term["@container"]).toBe("@set");
  });
});

// ─── computeETag ─────────────────────────────────────────────────────────────

describe("computeETag", () => {
  it("returns a strong ETag (double-quoted)", () => {
    const etag = computeETag("body", "text/turtle");
    expect(etag).toMatch(/^"sha256-[0-9a-f]{16}"$/);
  });

  it("different bodies produce different ETags", () => {
    const a = computeETag("body-a", "text/turtle");
    const b = computeETag("body-b", "text/turtle");
    expect(a).not.toBe(b);
  });

  it("same body + different media type → different ETag", () => {
    const a = computeETag("body", "text/turtle");
    const b = computeETag("body", "application/ld+json");
    expect(a).not.toBe(b);
  });

  it("same body + different profile → different ETag", () => {
    const a = computeETag("body", "application/ld+json", null);
    const b = computeETag("body", "application/ld+json", "#expanded");
    expect(a).not.toBe(b);
  });

  it("same inputs → same ETag (deterministic)", () => {
    const a = computeETag("body", "text/turtle");
    const b = computeETag("body", "text/turtle");
    expect(a).toBe(b);
  });
});

// ─── buildRdfResponse ─────────────────────────────────────────────────────────

describe("buildRdfResponse", () => {
  it("returns null for a browser Accept header", async () => {
    const result = await buildRdfResponse({
      request: req(
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      ),
      quads: sampleQuads(),
    });
    expect(result).toBeNull();
  });

  it("returns 200 with text/turtle for */*", async () => {
    const resp = await buildRdfResponse({
      request: req("*/*"),
      quads: sampleQuads(),
    });
    if (resp === null) throw new Error("expected non-null response");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/turtle");
  });

  it("returns 200 with application/ld+json when requested", async () => {
    const resp = await buildRdfResponse({
      request: req("application/ld+json"),
      quads: sampleQuads(),
    });
    if (resp === null) throw new Error("expected non-null response");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/ld+json");
  });

  it("returns 200 with application/n-triples when requested", async () => {
    const resp = await buildRdfResponse({
      request: req("application/n-triples"),
      quads: sampleQuads(),
    });
    if (resp === null) throw new Error("expected non-null response");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/n-triples");
  });

  it("sets Vary: Accept on every response", async () => {
    const resp = await buildRdfResponse({
      request: req("text/turtle"),
      quads: sampleQuads(),
    });
    if (resp === null) throw new Error("expected non-null response");
    expect(resp.headers.get("Vary")).toBe("Accept");
  });

  it("sets a strong ETag", async () => {
    const resp = await buildRdfResponse({
      request: req("text/turtle"),
      quads: sampleQuads(),
    });
    if (resp === null) throw new Error("expected non-null response");
    const etag = resp.headers.get("ETag");
    expect(etag).toMatch(/^"sha256-[0-9a-f]{16}"$/);
  });

  it("returns 304 when If-None-Match matches ETag", async () => {
    // First request to get the ETag.
    const first = await buildRdfResponse({
      request: req("text/turtle"),
      quads: sampleQuads(),
    });
    if (first === null) throw new Error("expected non-null first response");
    const etag = first.headers.get("ETag");
    if (etag === null) throw new Error("expected ETag header");

    // Second request with matching If-None-Match.
    const second = await buildRdfResponse({
      request: req("text/turtle", etag),
      quads: sampleQuads(),
    });
    if (second === null) throw new Error("expected non-null second response");
    expect(second.status).toBe(304);
    // 304 must have no body.
    const text = await second.text();
    expect(text).toBe("");
  });

  it("returns 304 with Vary and ETag headers", async () => {
    const first = await buildRdfResponse({
      request: req("text/turtle"),
      quads: sampleQuads(),
    });
    if (first === null) throw new Error("expected non-null first response");
    const etag = first.headers.get("ETag");
    if (etag === null) throw new Error("expected ETag header");

    const second = await buildRdfResponse({
      request: req("text/turtle", etag),
      quads: sampleQuads(),
    });
    if (second === null) throw new Error("expected non-null second response");
    expect(second.headers.get("Vary")).toBe("Accept");
    expect(second.headers.get("ETag")).toBe(etag);
  });

  it("returns 406 for unsupported Accept type", async () => {
    const resp = await buildRdfResponse({
      request: req("application/rdf+xml"),
      quads: sampleQuads(),
    });
    if (resp === null) throw new Error("expected non-null response");
    expect(resp.status).toBe(406);
    expect(resp.headers.get("Vary")).toBe("Accept");
  });

  it("sets CORS headers on 200", async () => {
    const resp = await buildRdfResponse({
      request: req("text/turtle"),
      quads: sampleQuads(),
    });
    if (resp === null) throw new Error("expected non-null response");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("merges extraHeaders into the response", async () => {
    const resp = await buildRdfResponse({
      request: req("text/turtle"),
      quads: sampleQuads(),
      extraHeaders: { "Cache-Control": "public, max-age=60" },
    });
    if (resp === null) throw new Error("expected non-null response");
    expect(resp.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("JSON-LD response has Link rel context header", async () => {
    const resp = await buildRdfResponse({
      request: req("application/ld+json"),
      quads: sampleQuads(),
    });
    if (resp === null) throw new Error("expected non-null response");
    const link = resp.headers.get("Link");
    expect(link).toContain("json-ld#context");
  });

  // ── Finding 3: multi-value If-None-Match in buildRdfResponse ──────────────

  it("multi-value If-None-Match containing the current ETag → 304", async () => {
    // Get the ETag from an initial response.
    const first = await buildRdfResponse({
      request: req("text/turtle"),
      quads: sampleQuads(),
    });
    if (first === null) throw new Error("expected non-null first response");
    const etag = first.headers.get("ETag");
    if (etag === null) throw new Error("expected ETag header");

    // Send If-None-Match with multiple tags, including the current one.
    const second = await buildRdfResponse({
      request: req("text/turtle", `"sha256-old1", ${etag}, "sha256-old2"`),
      quads: sampleQuads(),
    });
    if (second === null) throw new Error("expected non-null second response");
    expect(second.status).toBe(304);
  });

  it("If-None-Match: * → 304 (wildcard matches any representation)", async () => {
    const resp = await buildRdfResponse({
      request: req("text/turtle", "*"),
      quads: sampleQuads(),
    });
    if (resp === null) throw new Error("expected non-null response");
    expect(resp.status).toBe(304);
  });

  it("compacted vs expanded JSON-LD produce different ETags", async () => {
    const resp1 = await buildRdfResponse({
      request: req("application/ld+json"),
      quads: sampleQuads(),
    });
    // Expanded profile (using actual profile IRI pattern)
    const expandedProfile = "http://localhost:3000/ns/context.jsonld#expanded";
    const resp2 = await buildRdfResponse({
      request: req(`application/ld+json;profile="${expandedProfile}"`),
      quads: sampleQuads(),
    });
    if (resp1 === null || resp2 === null)
      throw new Error("expected non-null responses");
    expect(resp1.headers.get("ETag")).not.toBe(resp2.headers.get("ETag"));
  });
});

// ─── buildCachedRdfResponse ───────────────────────────────────────────────────

describe("buildCachedRdfResponse", () => {
  it("returns 200 with the given body and media type", () => {
    const body =
      '<https://alice.example/card#me> <http://xmlns.com/foaf/0.1/name> "Alice" .\n';
    const resp = buildCachedRdfResponse({
      request: req("application/n-triples"),
      body,
      mediaType: "application/n-triples",
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/n-triples");
  });

  it("returns 304 for matching If-None-Match", () => {
    const body = "some turtle";
    const etag = computeETag(body, "text/turtle");
    const resp = buildCachedRdfResponse({
      request: req("text/turtle", etag),
      body,
      mediaType: "text/turtle",
    });
    expect(resp.status).toBe(304);
  });

  it("sets Vary: Accept and ETag", () => {
    const resp = buildCachedRdfResponse({
      request: req("text/turtle"),
      body: "some turtle",
      mediaType: "text/turtle",
    });
    expect(resp.headers.get("Vary")).toBe("Accept");
    expect(resp.headers.get("ETag")).toMatch(/^"sha256-[0-9a-f]{16}"$/);
  });

  // ── Finding 2: buildCachedRdfResponse must negotiate Accept ───────────────

  it("returns 406 when cached mediaType is not acceptable per Accept header", () => {
    // Client wants application/rdf+xml; cached body is text/turtle → 406.
    const resp = buildCachedRdfResponse({
      request: req("application/rdf+xml"),
      body: "some turtle",
      mediaType: "text/turtle",
    });
    expect(resp.status).toBe(406);
    expect(resp.headers.get("Vary")).toBe("Accept");
  });

  it("returns 406 when cached mediaType is explicitly refused with q=0", () => {
    // text/turtle;q=0, */*;q=1 — turtle refused by name.
    const resp = buildCachedRdfResponse({
      request: req("text/turtle;q=0, */*;q=1"),
      body: "some turtle",
      mediaType: "text/turtle",
    });
    expect(resp.status).toBe(406);
  });

  it("returns 200 when cached mediaType is acceptable", () => {
    const resp = buildCachedRdfResponse({
      request: req("text/turtle"),
      body: "some turtle",
      mediaType: "text/turtle",
    });
    expect(resp.status).toBe(200);
  });

  it("returns 200 when */* matches the cached mediaType", () => {
    const resp = buildCachedRdfResponse({
      request: req("*/*"),
      body: "some turtle",
      mediaType: "text/turtle",
    });
    expect(resp.status).toBe(200);
  });

  // ── Finding 3: multi-value If-None-Match in buildCachedRdfResponse ─────────

  it("multi-value If-None-Match containing the current ETag → 304", () => {
    const body = "some turtle";
    const etag = computeETag(body, "text/turtle");
    const resp = buildCachedRdfResponse({
      request: req("text/turtle", `"sha256-old", ${etag}`),
      body,
      mediaType: "text/turtle",
    });
    expect(resp.status).toBe(304);
  });

  it("If-None-Match: * → 304 in cached path (wildcard)", () => {
    const resp = buildCachedRdfResponse({
      request: req("text/turtle", "*"),
      body: "some turtle",
      mediaType: "text/turtle",
    });
    expect(resp.status).toBe(304);
  });

  // ── Profile-aware JSON-LD cache validation (roborev finding) ───────────────
  // A cached expanded JSON-LD body must NOT be served when the Accept header
  // negotiates compacted (or any other profile).  The media-type check alone
  // is insufficient — profile must also match.

  it("cached expanded JSON-LD is NOT served when Accept negotiates compacted (no profile) → 406", () => {
    const expandedProfile = "http://localhost:3000/ns/context.jsonld#expanded";
    const body = '["some","expanded","json-ld"]';
    // Cache holds an expanded representation; client sends Accept: application/ld+json
    // with no profile → negotiates compacted (profile=null).  Must return 406.
    const resp = buildCachedRdfResponse({
      request: req("application/ld+json"),
      body,
      mediaType: "application/ld+json",
      profile: expandedProfile,
    });
    expect(resp.status).toBe(406);
    expect(resp.headers.get("Vary")).toBe("Accept");
  });

  it("cached compacted JSON-LD IS served when Accept negotiates compacted (profile match) → 200", () => {
    // Cache holds compacted (profile=null); client requests with no profile.
    const body = '{"@context":{},"@id":"https://alice.example/card#me"}';
    const resp = buildCachedRdfResponse({
      request: req("application/ld+json"),
      body,
      mediaType: "application/ld+json",
      profile: null,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/ld+json");
  });

  it("cached compacted JSON-LD is NOT served when Accept negotiates expanded → 406", () => {
    const expandedProfile = "http://localhost:3000/ns/context.jsonld#expanded";
    const body = '{"@context":{},"@id":"https://alice.example/card#me"}';
    // Cache = compacted (profile=null); client wants expanded.
    const resp = buildCachedRdfResponse({
      request: req(`application/ld+json;profile="${expandedProfile}"`),
      body,
      mediaType: "application/ld+json",
      profile: null,
    });
    expect(resp.status).toBe(406);
  });

  it("cached expanded JSON-LD IS served when Accept explicitly requests that profile → 200", () => {
    const expandedProfile = "http://localhost:3000/ns/context.jsonld#expanded";
    const body = '["some","expanded","json-ld"]';
    const resp = buildCachedRdfResponse({
      request: req(`application/ld+json;profile="${expandedProfile}"`),
      body,
      mediaType: "application/ld+json",
      profile: expandedProfile,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/ld+json");
  });

  it("cached flattened JSON-LD is NOT served when Accept requests compacted → 406", () => {
    const flatProfile = "http://localhost:3000/ns/context.jsonld#flattened";
    const body = '{"@context":{},"@graph":[]}';
    // Cache = flattened; client wants compacted (no profile).
    const resp = buildCachedRdfResponse({
      request: req("application/ld+json"),
      body,
      mediaType: "application/ld+json",
      profile: flatProfile,
    });
    expect(resp.status).toBe(406);
  });

  it("profile check does not affect non-JSON-LD cached types (turtle path unchanged)", () => {
    // Turtle has no profile concept; any cached turtle should serve when type matches.
    const body = "@prefix foaf: <http://xmlns.com/foaf/0.1/> .";
    const resp = buildCachedRdfResponse({
      request: req("text/turtle"),
      body,
      mediaType: "text/turtle",
      // profile is irrelevant for turtle; passing one must not cause a 406
      profile: null,
    });
    expect(resp.status).toBe(200);
  });

  it("profile check does not affect n-triples cached type", () => {
    const body =
      '<https://alice.example/card#me> <http://xmlns.com/foaf/0.1/name> "Alice" .\n';
    const resp = buildCachedRdfResponse({
      request: req("application/n-triples"),
      body,
      mediaType: "application/n-triples",
      profile: null,
    });
    expect(resp.status).toBe(200);
  });
});
