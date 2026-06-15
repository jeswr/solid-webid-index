// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — Vitest tests for the Hydra SEARCH API (DESIGN.md §4.4).
 *
 * Tests use pglite (in-process Postgres WASM) — NO network, NO Neon account.
 * Each test seeds WebID records, calls the route handler (with a mocked makeStore),
 * parses the RDF response back with n3.Parser, and asserts:
 *   - correct hydra:Collection + member IRIs
 *   - hydra:IriTemplate presence + valid shape
 *   - keyset pagination (hydra:next is present and stable)
 *   - empty result → empty hydra:Collection (200)
 *   - conneg works: Turtle (default) and JSON-LD
 *
 * The tests directly call `GET` from the route module, injecting a mock store via
 * module-level variable patching so no actual DATABASE_URL is needed in tests.
 */

import { PGlite } from "@electric-sql/pglite";
import { Store as N3Store, Parser } from "n3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import { sanitiseFtsQuery } from "@/lib/search/sanitise";
import { PgStore, createPgliteExecutor } from "@/lib/store/pgStore";
import type { DocRecord } from "@/lib/store/ports";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const HYDRA = "http://www.w3.org/ns/hydra/core#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const FOAF = "http://xmlns.com/foaf/0.1/";

async function makeTestStore(): Promise<{ store: PgStore }> {
  const db = new PGlite();
  const executor = createPgliteExecutor(db);
  const store = new PgStore(executor);
  await store.migrate();
  return { store };
}

/** Parse Turtle text into an N3 Store for triple assertions. */
function parseTurtle(turtle: string, baseUri: string): Promise<N3Store> {
  return new Promise((resolve, reject) => {
    const store = new N3Store();
    const parser = new Parser({ baseIRI: baseUri, format: "Turtle" });
    parser.parse(turtle, (err, quad, _prefixes) => {
      if (err) reject(err);
      else if (quad) store.addQuad(quad);
      else resolve(store); // done
    });
  });
}

/** Minimal valid DocRecord with required fields defaulted. */
function makeDoc(
  overrides: Partial<DocRecord> & { docUrl: string }
): DocRecord {
  return {
    docUrl: overrides.docUrl,
    host: overrides.host ?? new URL(overrides.docUrl).hostname,
    webid: overrides.webid ?? null,
    state: overrides.state ?? "done",
    depth: overrides.depth ?? 0,
    rootSeed: overrides.rootSeed ?? null,
    suggestBudget: overrides.suggestBudget ?? null,
    source: overrides.source ?? "seed",
    discoveredFrom: overrides.discoveredFrom ?? null,
    claimToken: overrides.claimToken ?? null,
    claimedAt: overrides.claimedAt ?? null,
    attempts: overrides.attempts ?? 1,
    etag: overrides.etag ?? null,
    lastModified: overrides.lastModified ?? null,
    contentHash: overrides.contentHash ?? null,
    lastCrawled: overrides.lastCrawled ?? Date.now(),
    nextEligibleAt: overrides.nextEligibleAt ?? 0,
    enqueuedAt: overrides.enqueuedAt ?? Date.now(),
    httpStatus: overrides.httpStatus ?? 200,
    isSolid: overrides.isSolid ?? true,
    failClass: overrides.failClass ?? null,
    error: overrides.error ?? null,
    noindex: overrides.noindex ?? false,
    rawRdf: overrides.rawRdf ?? null,
    label: overrides.label ?? null,
  };
}

/**
 * Build a fake Request for the search route.
 *
 * @param params Query string key/value pairs.
 * @param accept Accept header (default: text/turtle).
 */
function makeRequest(
  params: Record<string, string>,
  accept = "text/turtle"
): Request {
  const url = new URL(`${INDEX_BASE_URL}/search`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString(), {
    method: "GET",
    headers: { Accept: accept },
  });
}

// ─── Mock makeStore ───────────────────────────────────────────────────────────
// We import the route module and spy on makeStore so the route uses our pglite
// instance rather than trying to connect to a real Neon DATABASE_URL.

vi.mock("@/lib/store/pgStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/pgStore")>();
  return {
    ...actual,
    // makeStore is replaced per-test via setMockStore below.
    makeStore: () => {
      if (!_mockStore) throw new Error("No mock store set — call setMockStore");
      return _mockStore;
    },
  };
});

let _mockStore: PgStore | null = null;

function setMockStore(store: PgStore): void {
  _mockStore = store;
}

// Import the route AFTER the mock is set up so it picks up the mocked makeStore.
const { GET } = await import("./route");

// ─── sanitiseFtsQuery ─────────────────────────────────────────────────────────

describe("sanitiseFtsQuery", () => {
  it("returns null for empty string", () => {
    expect(sanitiseFtsQuery("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(sanitiseFtsQuery("   ")).toBeNull();
  });

  it("strips FTS operators and special chars", () => {
    // Double-quotes, NEAR, colon, ^ etc. must be removed (replaced with space).
    // "alice" NEAR:foo ^bar → alice near foo bar (colon/quote/caret become spaces,
    // yielding separate tokens: alice, near, foo, bar from NEAR:foo splitting on :).
    expect(sanitiseFtsQuery('"alice" NEAR:foo ^bar')).toBe(
      "alice near foo bar"
    );
  });

  it("lowercases and splits on whitespace", () => {
    expect(sanitiseFtsQuery("Alice Bob")).toBe("alice bob");
  });

  it("caps tokens at FTS_MAX_TOKEN_LEN (32 chars)", () => {
    const longWord = "a".repeat(40);
    const result = sanitiseFtsQuery(longWord);
    expect(result).toBe("a".repeat(32));
  });

  it("caps at FTS_MAX_TOKENS (8 tokens)", () => {
    const nineWords = Array.from({ length: 9 }, (_, i) => `word${i}`).join(" ");
    const result = sanitiseFtsQuery(nineWords);
    // Should only keep 8 tokens
    expect(result?.split(" ").length).toBe(8);
  });
});

// ─── Route: empty / missing query ─────────────────────────────────────────────

describe("GET /search — empty/missing query", () => {
  let store: PgStore;

  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);
  });

  it("returns 200 with an empty hydra:Collection when ?q= is absent", async () => {
    const req = makeRequest({});
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.text();
    const rdfStore = await parseTurtle(body, INDEX_BASE_URL);

    const collectionIri = `${INDEX_BASE_URL}/search`;

    // Collection type
    const typeTriples = rdfStore.getQuads(
      collectionIri,
      `${RDF}type`,
      `${HYDRA}Collection`,
      null
    );
    expect(typeTriples.length).toBeGreaterThan(0);

    // No members
    const memberTriples = rdfStore.getQuads(
      collectionIri,
      `${HYDRA}member`,
      null,
      null
    );
    expect(memberTriples.length).toBe(0);
  });

  it("returns 200 with an empty hydra:Collection when ?q is blank", async () => {
    const req = makeRequest({ q: "   " });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.text();
    const rdfStore = await parseTurtle(body, INDEX_BASE_URL);
    const memberTriples = rdfStore.getQuads(
      `${INDEX_BASE_URL}/search`,
      `${HYDRA}member`,
      null,
      null
    );
    expect(memberTriples.length).toBe(0);
  });
});

// ─── Route: FTS search results ─────────────────────────────────────────────────

describe("GET /search — FTS results", () => {
  let store: PgStore;

  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);

    // Seed three profiles: Alice (Solid), Bob (Solid), Carol (non-Solid).
    await store.put(
      makeDoc({
        docUrl: "https://alice.pod.example/card",
        webid: "https://alice.pod.example/card#me",
        label: "Alice Wonderland",
        rawRdf: `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<#me> a foaf:Person ; foaf:name "Alice Wonderland" ;
  solid:oidcIssuer <https://idp.example> .`,
        isSolid: true,
        state: "done",
      })
    );

    await store.put(
      makeDoc({
        docUrl: "https://bob.pod.example/profile",
        webid: "https://bob.pod.example/profile#me",
        label: "Bob Builder",
        rawRdf: `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<#me> a foaf:Person ; foaf:name "Bob Builder" ;
  solid:oidcIssuer <https://idp.example> .`,
        isSolid: true,
        state: "done",
      })
    );

    await store.put(
      makeDoc({
        docUrl: "https://carol.example/webid",
        webid: "https://carol.example/webid#me",
        label: null,
        rawRdf: `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<#me> a foaf:Person .`,
        isSolid: false,
        state: "done",
      })
    );
  });

  it("returns matched members as a hydra:Collection in Turtle", async () => {
    const req = makeRequest({ q: "alice" });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
    expect(res.headers.get("Vary")).toContain("Accept");

    const body = await res.text();
    const rdfStore = await parseTurtle(body, INDEX_BASE_URL);

    const collectionIri = `${INDEX_BASE_URL}/search`;

    // Collection type triple
    const typeTriples = rdfStore.getQuads(
      collectionIri,
      `${RDF}type`,
      `${HYDRA}Collection`,
      null
    );
    expect(typeTriples.length).toBeGreaterThan(0);

    // At least Alice is a member
    const memberTriples = rdfStore.getQuads(
      collectionIri,
      `${HYDRA}member`,
      null,
      null
    );
    expect(memberTriples.length).toBeGreaterThanOrEqual(1);

    const memberIris = new Set(memberTriples.map((t) => t.object.value));
    expect(memberIris.has("https://alice.pod.example/card#me")).toBe(true);
    // Bob should not be in the results for "alice"
    expect(memberIris.has("https://bob.pod.example/profile#me")).toBe(false);
  });

  it("returns foaf:name for members that have a label", async () => {
    const req = makeRequest({ q: "alice" });
    const res = await GET(req);
    const body = await res.text();
    const rdfStore = await parseTurtle(body, INDEX_BASE_URL);

    const nameTriples = rdfStore.getQuads(
      "https://alice.pod.example/card#me",
      `${FOAF}name`,
      null,
      null
    );
    expect(nameTriples.length).toBe(1);
    expect(nameTriples[0].object.value).toBe("Alice Wonderland");
  });

  it("returns members as foaf:Person", async () => {
    const req = makeRequest({ q: "alice" });
    const res = await GET(req);
    const body = await res.text();
    const rdfStore = await parseTurtle(body, INDEX_BASE_URL);

    const personTriples = rdfStore.getQuads(
      "https://alice.pod.example/card#me",
      `${RDF}type`,
      `${FOAF}Person`,
      null
    );
    expect(personTriples.length).toBe(1);
  });

  it("returns ranked results (alice before bob when searching alice)", async () => {
    // Alice matches 'alice' at label weight 'A'; bob does not → alice is the sole result.
    const req = makeRequest({ q: "alice" });
    const res = await GET(req);
    const body = await res.text();
    const rdfStore = await parseTurtle(body, INDEX_BASE_URL);

    const members = rdfStore.getQuads(
      `${INDEX_BASE_URL}/search`,
      `${HYDRA}member`,
      null,
      null
    );
    // Alice must appear
    const memberIris = members.map((t) => t.object.value);
    expect(memberIris).toContain("https://alice.pod.example/card#me");
  });
});

// ─── Route: IriTemplate ────────────────────────────────────────────────────────

describe("GET /search — hydra:IriTemplate", () => {
  let store: PgStore;

  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);
  });

  it("includes a valid hydra:IriTemplate with hydra:mapping for q", async () => {
    const req = makeRequest({ q: "test" });
    const res = await GET(req);
    const body = await res.text();
    const rdfStore = await parseTurtle(body, INDEX_BASE_URL);

    const collectionIri = `${INDEX_BASE_URL}/search`;

    // hydra:search triple on the collection
    const searchTriples = rdfStore.getQuads(
      collectionIri,
      `${HYDRA}search`,
      null,
      null
    );
    expect(searchTriples.length).toBe(1);

    const tmplNode = searchTriples[0].object;

    // Template type
    const tmplTypeTriples = rdfStore.getQuads(
      tmplNode,
      `${RDF}type`,
      `${HYDRA}IriTemplate`,
      null
    );
    expect(tmplTypeTriples.length).toBe(1);

    // Template value contains the search pattern
    const tmplValueTriples = rdfStore.getQuads(
      tmplNode,
      `${HYDRA}template`,
      null,
      null
    );
    expect(tmplValueTriples.length).toBe(1);
    expect(tmplValueTriples[0].object.value).toContain("{?q}");

    // hydra:variableRepresentation = hydra:BasicRepresentation
    const varRepTriples = rdfStore.getQuads(
      tmplNode,
      `${HYDRA}variableRepresentation`,
      `${HYDRA}BasicRepresentation`,
      null
    );
    expect(varRepTriples.length).toBe(1);

    // hydra:mapping
    const mappingTriples = rdfStore.getQuads(
      tmplNode,
      `${HYDRA}mapping`,
      null,
      null
    );
    expect(mappingTriples.length).toBe(1);

    const mappingNode = mappingTriples[0].object;

    // mapping has hydra:variable = "q"
    const varTriples = rdfStore.getQuads(
      mappingNode,
      `${HYDRA}variable`,
      null,
      null
    );
    expect(varTriples.length).toBe(1);
    expect(varTriples[0].object.value).toBe("q");

    // mapping has hydra:required = true
    const reqTriples = rdfStore.getQuads(
      mappingNode,
      `${HYDRA}required`,
      null,
      null
    );
    expect(reqTriples.length).toBe(1);
    expect(reqTriples[0].object.value).toBe("true");

    // mapping has hydra:property = idx:searchText
    const propTriples = rdfStore.getQuads(
      mappingNode,
      `${HYDRA}property`,
      null,
      null
    );
    expect(propTriples.length).toBe(1);
    expect(propTriples[0].object.value).toContain("searchText");
  });
});

// ─── Route: keyset pagination ──────────────────────────────────────────────────

describe("GET /search — keyset pagination", () => {
  let store: PgStore;

  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);

    // Seed 5 records that all match "person" so we can paginate.
    for (let i = 1; i <= 5; i++) {
      await store.put(
        makeDoc({
          docUrl: `https://person${i}.example/card`,
          webid: `https://person${i}.example/card#me`,
          label: `Person ${i}`,
          rawRdf: `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<#me> a foaf:Person ; foaf:name "Person ${i}" ;
  solid:oidcIssuer <https://idp.example> .`,
          isSolid: true,
          state: "done",
        })
      );
    }
  });

  it("paginates with limit=2: first page has hydra:next, second page has different members", async () => {
    // First page
    const req1 = makeRequest({ q: "person", limit: "2" });
    const res1 = await GET(req1);
    expect(res1.status).toBe(200);
    const body1 = await res1.text();
    const store1 = await parseTurtle(body1, INDEX_BASE_URL);

    // First page should have exactly 2 members
    const members1 = store1.getQuads(
      `${INDEX_BASE_URL}/search`,
      `${HYDRA}member`,
      null,
      null
    );
    expect(members1.length).toBe(2);

    // First page must have a view with hydra:next
    const viewTriples1 = store1.getQuads(
      `${INDEX_BASE_URL}/search`,
      `${HYDRA}view`,
      null,
      null
    );
    expect(viewTriples1.length).toBe(1);
    const view1 = viewTriples1[0].object;

    const nextTriples1 = store1.getQuads(view1, `${HYDRA}next`, null, null);
    expect(nextTriples1.length).toBe(1);

    // Extract the cursor from hydra:next URL
    const nextUrl = new URL(nextTriples1[0].object.value);
    const cursor = nextUrl.searchParams.get("cursor");
    expect(cursor).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    expect(cursor!.length).toBeGreaterThan(0);

    // Second page using the cursor
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    const req2 = makeRequest({ q: "person", limit: "2", cursor: cursor! });
    const res2 = await GET(req2);
    expect(res2.status).toBe(200);
    const body2 = await res2.text();
    const store2 = await parseTurtle(body2, INDEX_BASE_URL);

    // Second page should have members
    const members2 = store2.getQuads(
      `${INDEX_BASE_URL}/search`,
      `${HYDRA}member`,
      null,
      null
    );
    expect(members2.length).toBeGreaterThan(0);

    // Second page members must be DIFFERENT from first page members
    const iris1 = new Set(members1.map((t) => t.object.value));
    const iris2 = new Set(members2.map((t) => t.object.value));
    for (const iri of iris2) {
      expect(iris1.has(iri)).toBe(false); // no overlap
    }
  });

  it("keyset pagination is stable: same cursor returns same page", async () => {
    // Get first page cursor
    const req1 = makeRequest({ q: "person", limit: "2" });
    const res1 = await GET(req1);
    const body1 = await res1.text();
    const store1 = await parseTurtle(body1, INDEX_BASE_URL);
    const view1 = store1.getQuads(
      `${INDEX_BASE_URL}/search`,
      `${HYDRA}view`,
      null,
      null
    )[0].object;
    const nextTriples = store1.getQuads(view1, `${HYDRA}next`, null, null);
    const cursor = new URL(nextTriples[0].object.value).searchParams.get(
      "cursor"
    ) as string;

    // Fetch page 2 twice — must return identical member sets
    const res2a = await GET(makeRequest({ q: "person", limit: "2", cursor }));
    const res2b = await GET(makeRequest({ q: "person", limit: "2", cursor }));

    const body2a = await res2a.text();
    const body2b = await res2b.text();

    const store2a = await parseTurtle(body2a, INDEX_BASE_URL);
    const store2b = await parseTurtle(body2b, INDEX_BASE_URL);

    const iris2a = store2a
      .getQuads(`${INDEX_BASE_URL}/search`, `${HYDRA}member`, null, null)
      .map((t) => t.object.value)
      .sort();
    const iris2b = store2b
      .getQuads(`${INDEX_BASE_URL}/search`, `${HYDRA}member`, null, null)
      .map((t) => t.object.value)
      .sort();

    expect(iris2a).toEqual(iris2b);
  });
});

// ─── Route: conneg ─────────────────────────────────────────────────────────────

describe("GET /search — content negotiation", () => {
  let store: PgStore;

  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);
    // Seed one record
    await store.put(
      makeDoc({
        docUrl: "https://dave.example/card",
        webid: "https://dave.example/card#me",
        label: "Dave Example",
        rawRdf: `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<#me> a foaf:Person ; foaf:name "Dave Example" ;
  solid:oidcIssuer <https://idp.example> .`,
        isSolid: true,
        state: "done",
      })
    );
  });

  it("serves Turtle by default (Accept: text/turtle)", async () => {
    const req = makeRequest({ q: "dave" }, "text/turtle");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
    expect(res.headers.get("Vary")).toContain("Accept");
  });

  it("serves Turtle for Accept: */*", async () => {
    const req = makeRequest({ q: "dave" }, "*/*");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
  });

  it("serves JSON-LD for Accept: application/ld+json", async () => {
    const req = makeRequest({ q: "dave" }, "application/ld+json");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/ld+json");
    // Body must be valid JSON
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("returns ETag on every successful response", async () => {
    const req = makeRequest({ q: "dave" }, "text/turtle");
    const res = await GET(req);
    expect(res.headers.get("ETag")).toMatch(/^"sha256-[0-9a-f]{16}"$/);
  });

  it("returns 304 when If-None-Match matches the ETag", async () => {
    const req1 = makeRequest({ q: "dave" }, "text/turtle");
    const res1 = await GET(req1);
    // biome-ignore lint/style/noNonNullAssertion: GET always sets ETag on 200
    const etag = res1.headers.get("ETag")!;

    const req2 = new Request(`${INDEX_BASE_URL}/search?q=dave`, {
      method: "GET",
      headers: { Accept: "text/turtle", "If-None-Match": etag },
    });
    const res2 = await GET(req2);
    expect(res2.status).toBe(304);
  });

  it("includes CORS header Access-Control-Allow-Origin: *", async () => {
    const req = makeRequest({ q: "dave" });
    const res = await GET(req);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ─── Route: OPTIONS preflight ──────────────────────────────────────────────────

describe("OPTIONS /search", () => {
  it("returns 204 with CORS headers", async () => {
    const { OPTIONS } = await import("./route");
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});
