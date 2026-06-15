// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — the /p/{slug} entry DESCRIPTION document (DESIGN.md §4.1).
 *
 * Uses pglite (in-process Postgres WASM) — NO network, NO Neon account.  Seeds a
 * crawled `done` doc (raw_rdf = a real Turtle profile), computes its slug, and
 * exercises every status + HEAD/OPTIONS + the describe-only invariant on the body.
 */

import { PGlite } from "@electric-sql/pglite";
import { Store as N3Store, Parser } from "n3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import { PgStore, createPgliteExecutor } from "@/lib/store/pgStore";
import { slugForWebId } from "@/lib/url/slug";

const FOAF = "http://xmlns.com/foaf/0.1/";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const IDX_NS = `${INDEX_BASE_URL}/ns#`;

// ─── Mock makeStore so the route uses our pglite instance ──────────────────────
let _mockStore: PgStore | null = null;
vi.mock("@/lib/store/pgStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/pgStore")>();
  return {
    ...actual,
    makeStore: () => {
      if (!_mockStore) throw new Error("No mock store set");
      return _mockStore;
    },
  };
});

import { GET, HEAD, OPTIONS, POST } from "./route";

const WEBID = "https://alice.pod/card#me";
const DOC_URL = "https://alice.pod/card";
const SLUG = slugForWebId(WEBID);

const PROFILE_TTL = `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix pim: <http://www.w3.org/ns/pim/space#> .
<${WEBID}> a foaf:Person ;
  foaf:name "Alice" ;
  foaf:img <https://alice.pod/avatar.png> ;
  solid:oidcIssuer <https://idp.example> ;
  pim:storage <https://alice.pod/> ;
  foaf:knows <https://bob.pod/card#me> .`;

async function makeStore(): Promise<PgStore> {
  const db = new PGlite();
  const store = new PgStore(createPgliteExecutor(db));
  await store.migrate();
  return store;
}

function req(
  slug: string,
  accept = "text/turtle",
  extra?: HeadersInit
): Request {
  return new Request(`${INDEX_BASE_URL}/p/${slug}`, {
    method: "GET",
    headers: { Accept: accept, ...(extra ?? {}) },
  });
}

function ctx(slug: string): { params: Promise<{ slug: string }> } {
  return { params: Promise.resolve({ slug }) };
}

function parseTurtle(ttl: string): Promise<N3Store> {
  return new Promise((resolve, reject) => {
    const s = new N3Store();
    new Parser({ baseIRI: `${INDEX_BASE_URL}/p/${SLUG}` }).parse(
      ttl,
      (err, q) => {
        if (err) reject(err);
        else if (q) s.addQuad(q);
        else resolve(s);
      }
    );
  });
}

/** Non-null accessor for the per-test store (avoids non-null assertions). */
function store(): PgStore {
  if (!_mockStore) throw new Error("store not initialised");
  return _mockStore;
}

beforeEach(async () => {
  _mockStore = await makeStore();
});

async function seedDone(): Promise<void> {
  // Crawl path: enqueue then markDone with the canonical webid + raw_rdf.
  await store().enqueue(DOC_URL, { webid: WEBID, source: "seed" });
  const claimed = await store().claim("test", 1);
  await store().markDone(
    DOC_URL,
    {
      state: "done",
      httpStatus: 200,
      etag: '"v1"',
      rawRdf: PROFILE_TTL,
      isSolid: true,
      webid: WEBID,
      nextEligibleAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
    },
    claimed[0].claimToken
  );
}

describe("GET /p/{slug}", () => {
  it("200 — serves a describe-only entry graph for a known slug", async () => {
    await seedDone();
    const res = await GET(req(SLUG), ctx(SLUG));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(res.headers.get("Link") ?? "").toContain('rel="type"');
    expect(res.headers.get("Link") ?? "").toContain("describedby");

    const store = await parseTurtle(await res.text());
    const entryUrl = `${INDEX_BASE_URL}/p/${SLUG}`;
    // primaryTopic → upstream WebID
    const topic = store.getQuads(entryUrl, `${FOAF}primaryTopic`, null, null);
    expect(topic[0].object.value).toBe(WEBID);
    // describe-only: no minted foaf:Person under the index origin
    const persons = store.getQuads(null, `${RDF}type`, `${FOAF}Person`, null);
    for (const q of persons) {
      expect(q.subject.value.startsWith(`${INDEX_BASE_URL}/p/`)).toBe(false);
    }
    // idx:crawlState present as an IRI
    const cs = store.getQuads(entryUrl, `${IDX_NS}crawlState`, null, null);
    expect(cs.length).toBe(1);
    expect(cs[0].object.termType).toBe("NamedNode");
    // foaf:knows is the upstream WebID, not an index URL
    const knows = store.getQuads(WEBID, `${FOAF}knows`, null, null);
    expect(knows.length).toBe(1);
    expect(knows[0].object.value).toBe("https://bob.pod/card#me");
  });

  it("conneg: serves JSON-LD with a context Link when asked", async () => {
    await seedDone();
    const res = await GET(req(SLUG, "application/ld+json"), ctx(SLUG));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/ld+json");
    expect(res.headers.get("Link") ?? "").toContain("json-ld#context");
    const body = JSON.parse(await res.text());
    expect(body).toHaveProperty("@context");
  });

  // ── roborev MEDIUM: the JSON-LD context Link must be APPENDED, not overwrite ──
  //
  // buildRdfResponse previously OVERWROTE the caller-supplied Link header when it
  // added the JSON-LD context link, so a JSON-LD /p/{slug} lost the required
  // rel="type" + rel="describedby" links.  All three must now ride together
  // (comma-joined per RFC 8288).
  it("conneg: JSON-LD Link carries rel=type, rel=describedby AND the context link together", async () => {
    await seedDone();
    const res = await GET(req(SLUG, "application/ld+json"), ctx(SLUG));
    expect(res.status).toBe(200);
    const link = res.headers.get("Link") ?? "";
    // The entry's required links survive the JSON-LD context append…
    expect(link).toContain('rel="type"');
    expect(link).toContain("describedby");
    // …alongside the JSON-LD context link.
    expect(link).toContain("json-ld#context");
    // Sanity: it is genuinely a comma-joined multi-link header (RFC 8288), not
    // just the bare context link replacing everything.
    expect(link.split(",").length).toBeGreaterThanOrEqual(3);
  });

  it("conneg: the Turtle branch keeps its rel=type + rel=describedby links (no context link)", async () => {
    await seedDone();
    const res = await GET(req(SLUG, "text/turtle"), ctx(SLUG));
    expect(res.status).toBe(200);
    const link = res.headers.get("Link") ?? "";
    expect(link).toContain('rel="type"');
    expect(link).toContain("describedby");
    // Turtle is not JSON-LD → no context link is appended.
    expect(link).not.toContain("json-ld#context");
  });

  it("304 — conditional via If-None-Match echoes the ETag", async () => {
    await seedDone();
    const first = await GET(req(SLUG), ctx(SLUG));
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();
    const res = await GET(
      req(SLUG, "text/turtle", { "If-None-Match": etag ?? "" }),
      ctx(SLUG)
    );
    expect(res.status).toBe(304);
  });

  it("404 — unknown (but well-formed) slug", async () => {
    const unknown = slugForWebId("https://nobody.example/card#me");
    const res = await GET(req(unknown), ctx(unknown));
    expect(res.status).toBe(404);
  });

  it("404 — malformed slug short-circuits (no DB row)", async () => {
    const res = await GET(req("not-a-valid-slug"), ctx("not-a-valid-slug"));
    expect(res.status).toBe(404);
  });

  it("410 + no-store — tombstoned slug", async () => {
    await seedDone();
    // Tombstone the doc; slug stays attached to the (now-tombstoned) row.
    await store().tombstone(DOC_URL);
    // tombstone() resets some columns; re-attach slug via put to simulate a real
    // erasure that keeps the slug row for 410 distinction.
    await store().put({
      docUrl: DOC_URL,
      host: "alice.pod",
      webid: WEBID,
      state: "tombstone",
      depth: 0,
      rootSeed: null,
      suggestBudget: null,
      source: "seed",
      discoveredFrom: null,
      claimToken: null,
      claimedAt: null,
      attempts: 1,
      etag: null,
      lastModified: null,
      contentHash: null,
      lastCrawled: Date.now(),
      nextEligibleAt: 0,
      enqueuedAt: Date.now(),
      httpStatus: null,
      isSolid: true,
      failClass: null,
      error: null,
      noindex: false,
      rawRdf: null,
      label: null,
      slug: SLUG,
    });
    const res = await GET(req(SLUG), ctx(SLUG));
    expect(res.status).toBe(410);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("406 — unacceptable Accept (HTML / unsupported type)", async () => {
    await seedDone();
    const res = await GET(req(SLUG, "image/png"), ctx(SLUG));
    expect(res.status).toBe(406);
  });

  it("406 — a browser HTML Accept (entry is RDF-only)", async () => {
    await seedDone();
    const res = await GET(
      req(SLUG, "text/html,application/xhtml+xml"),
      ctx(SLUG)
    );
    expect(res.status).toBe(406);
  });
});

describe("HEAD /p/{slug}", () => {
  it("200 with headers and no body", async () => {
    await seedDone();
    const res = await HEAD(req(SLUG), ctx(SLUG));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(await res.text()).toBe("");
  });

  it("404 for an unknown slug, no body", async () => {
    const unknown = slugForWebId("https://nobody.example/card#me");
    const res = await HEAD(req(unknown), ctx(unknown));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

describe("OPTIONS /p/{slug}", () => {
  it("204 with Allow: GET, HEAD, OPTIONS", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("disallowed methods on /p/{slug}", () => {
  it("405 with Allow header for POST", () => {
    const res = POST();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });
});
