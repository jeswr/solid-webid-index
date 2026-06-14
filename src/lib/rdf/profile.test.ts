// AUTHORED-BY Claude Opus 4.8
/**
 * profile.test.ts — unit tests for src/lib/rdf/profile.ts
 *
 * No network calls. All RDF is supplied as inline fixture strings.
 * Uses vitest.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ParseLimitError,
  RdfFetchError,
  extractWebIdProfile,
  isSolidWebId,
  parseProfile,
} from "./profile";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WEBID = "https://alice.example/card#me";
const BASE_IRI = "https://alice.example/card";

const TURTLE_PROFILE = `
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix vcard: <http://www.w3.org/2006/vcard/ns#> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix pim: <http://www.w3.org/ns/pim/space#> .

<${WEBID}>
    a foaf:Person ;
    foaf:name "Alice Smith" ;
    vcard:hasPhoto <https://alice.example/avatar.png> ;
    solid:oidcIssuer <https://idp.example/> ;
    pim:storage <https://alice.example/storage/> ;
    foaf:knows <https://bob.example/card#me> .
`;

const JSONLD_PROFILE = JSON.stringify({
  "@context": {
    foaf: "http://xmlns.com/foaf/0.1/",
    solid: "http://www.w3.org/ns/solid/terms#",
    pim: "http://www.w3.org/ns/pim/space#",
    vcard: "http://www.w3.org/2006/vcard/ns#",
    "@base": BASE_IRI,
  },
  "@id": WEBID,
  "@type": "foaf:Person",
  "foaf:name": "Alice Smith",
  "vcard:hasPhoto": { "@id": "https://alice.example/avatar.png" },
  "solid:oidcIssuer": { "@id": "https://idp.example/" },
  "pim:storage": { "@id": "https://alice.example/storage/" },
  "foaf:knows": { "@id": "https://bob.example/card#me" },
});

// A profile without solid:oidcIssuer
const TURTLE_NON_SOLID = `
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix vcard: <http://www.w3.org/2006/vcard/ns#> .

<${WEBID}>
    a foaf:Person ;
    foaf:name "Bob Jones" .
`;

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Build an over-cap Turtle body with `n` distinct triples (using blank predicate URIs). */
function overCapTurtle(n: number): string {
  const lines: string[] = ["@prefix ex: <https://ex.example/> ."];
  for (let i = 0; i < n; i++) {
    lines.push(`ex:s ex:p${i} ex:o${i} .`);
  }
  return lines.join("\n");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("parseProfile", () => {
  it("parses a Turtle profile without error", async () => {
    const dataset = await parseProfile({
      text: TURTLE_PROFILE,
      contentType: "text/turtle",
      baseIri: BASE_IRI,
    });
    // The dataset should contain quads — at minimum the oidcIssuer triple
    expect(dataset.size).toBeGreaterThan(0);
  });

  it("parses a JSON-LD profile without error", async () => {
    const dataset = await parseProfile({
      text: JSONLD_PROFILE,
      contentType: "application/ld+json",
      baseIri: BASE_IRI,
    });
    expect(dataset.size).toBeGreaterThan(0);
  });

  it("rejects malformed Turtle with an RdfFetchError", async () => {
    await expect(
      parseProfile({
        text: "this is not valid RDF !!@@##",
        contentType: "text/turtle",
        baseIri: BASE_IRI,
      })
    ).rejects.toBeInstanceOf(RdfFetchError);
  });

  it("rejects an unsupported content-type with an RdfFetchError", async () => {
    await expect(
      parseProfile({
        text: "<html>not rdf</html>",
        contentType: "text/html",
        baseIri: BASE_IRI,
      })
    ).rejects.toBeInstanceOf(RdfFetchError);
  });

  it("rejects an over-cap document with a ParseLimitError", async () => {
    // parseProfile forwards MAX_QUADS from config to parseRdf. To test the
    // ParseLimitError path without generating 50 000 triples we use
    // vitest's module reset: set PARSE_MAX_QUADS=5, reload config + profile,
    // then call the freshly-loaded parseProfile with a 10-triple body.
    const origEnv = process.env.PARSE_MAX_QUADS;
    process.env.PARSE_MAX_QUADS = "5";
    try {
      vi.resetModules();
      // Dynamically import after env var is set so config.ts is re-evaluated
      const { parseProfile: cappedParseProfile } = await import("./profile");
      const capTurtle = overCapTurtle(10);
      await expect(
        cappedParseProfile({
          text: capTurtle,
          contentType: "text/turtle",
          baseIri: BASE_IRI,
        })
      ).rejects.toBeInstanceOf(ParseLimitError);
    } finally {
      process.env.PARSE_MAX_QUADS = origEnv;
      vi.resetModules();
    }
  });

  it("JSON-LD with a remote @context does not call fetch", async () => {
    // Create a JSON-LD body referencing a remote @context URL.
    // The library default SSRF-safe documentLoader must reject this
    // without making any outbound network call.
    const fetchMock = vi.fn();
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      await expect(
        parseProfile({
          text: JSON.stringify({
            "@context": "https://remote.example/context.jsonld",
            "@id": WEBID,
            "@type": "http://xmlns.com/foaf/0.1/Person",
          }),
          contentType: "application/ld+json",
          baseIri: BASE_IRI,
        })
      ).rejects.toBeInstanceOf(RdfFetchError);
    } finally {
      globalThis.fetch = origFetch;
    }

    // The mock must never have been called — no outbound fetch for @context
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("extractWebIdProfile (Turtle)", () => {
  it("extracts name, photoUrl, oidcIssuers, storageUrls, and knows from a Turtle profile", async () => {
    const dataset = await parseProfile({
      text: TURTLE_PROFILE,
      contentType: "text/turtle",
      baseIri: BASE_IRI,
    });
    const profile = extractWebIdProfile(dataset, WEBID);

    expect(profile.webId).toBe(WEBID);
    expect(profile.name).toBe("Alice Smith");
    expect(profile.photoUrl).toBe("https://alice.example/avatar.png");
    expect(profile.oidcIssuers).toContain("https://idp.example/");
    expect(profile.storageUrls).toContain("https://alice.example/storage/");
    expect(profile.knows).toContain("https://bob.example/card#me");
  });
});

describe("extractWebIdProfile (JSON-LD)", () => {
  it("extracts name, photoUrl, oidcIssuers, storageUrls, and knows from a JSON-LD profile", async () => {
    const dataset = await parseProfile({
      text: JSONLD_PROFILE,
      contentType: "application/ld+json",
      baseIri: BASE_IRI,
    });
    const profile = extractWebIdProfile(dataset, WEBID);

    expect(profile.webId).toBe(WEBID);
    expect(profile.name).toBe("Alice Smith");
    expect(profile.oidcIssuers).toContain("https://idp.example/");
    expect(profile.storageUrls).toContain("https://alice.example/storage/");
    expect(profile.knows).toContain("https://bob.example/card#me");
  });
});

describe("isSolidWebId", () => {
  it("returns true when solid:oidcIssuer is present", async () => {
    const dataset = await parseProfile({
      text: TURTLE_PROFILE,
      contentType: "text/turtle",
      baseIri: BASE_IRI,
    });
    expect(isSolidWebId(dataset, WEBID)).toBe(true);
  });

  it("returns false when solid:oidcIssuer is absent", async () => {
    const dataset = await parseProfile({
      text: TURTLE_NON_SOLID,
      contentType: "text/turtle",
      baseIri: BASE_IRI,
    });
    expect(isSolidWebId(dataset, WEBID)).toBe(false);
  });
});
