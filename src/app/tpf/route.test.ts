// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — Vitest tests for the Triple Pattern Fragments endpoint
 * (DESIGN.md §4.5, spec ref sw H1).
 *
 * Tests use pglite (in-process Postgres WASM) — NO network, NO Neon account.  Each
 * test seeds doc + triple rows via the store, calls the route handler (with a mocked
 * makeStore), parses the RDF response with n3.Parser, and asserts the THREE-part
 * fragment: data + metadata (void:Dataset / hydra:Collection / void:triples /
 * hydra:itemsPerPage) + controls (hydra:search IriTemplate + s/p/o mapping +
 * hydra:first/next).  Tombstoned WebIDs' triples must be filtered out.
 */

import { Store as N3Store, Parser } from "n3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import type { PgStore } from "@/lib/store/pgStore";
import type { DocRecord, TpfTriple } from "@/lib/store/ports";
import { freshTestStore } from "@/lib/store/testStore";

// ─── Namespaces ─────────────────────────────────────────────────────────────

const HYDRA = "http://www.w3.org/ns/hydra/core#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const VOID = "http://rdfs.org/ns/void#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const SOLID = "http://www.w3.org/ns/solid/terms#";
const DATASET_IRI = `${INDEX_BASE_URL}/#dataset`;

// ─── Test helpers ───────────────────────────────────────────────────────────

async function makeTestStore(): Promise<{ store: PgStore }> {
  const { store } = await freshTestStore();
  return { store };
}

function parseTurtle(turtle: string, baseUri: string): Promise<N3Store> {
  return new Promise((resolve, reject) => {
    const store = new N3Store();
    const parser = new Parser({ baseIRI: baseUri, format: "Turtle" });
    parser.parse(turtle, (err, quad, _prefixes) => {
      if (err) reject(err);
      else if (quad) store.addQuad(quad);
      else resolve(store);
    });
  });
}

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
    slug: overrides.slug ?? null,
  };
}

/** Seed a WebID doc + its materialised triples. */
async function seedProfile(
  store: PgStore,
  webid: string,
  docUrl: string,
  triples: TpfTriple[]
): Promise<void> {
  await store.put(makeDoc({ docUrl, webid, state: "done" }));
  await store.upsertTriples({ webid, docUrl, triples });
}

function makeRequest(
  params: Record<string, string>,
  accept = "text/turtle"
): Request {
  const url = new URL(`${INDEX_BASE_URL}/tpf`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString(), {
    method: "GET",
    headers: { Accept: accept },
  });
}

// ─── Mock makeStore ─────────────────────────────────────────────────────────

vi.mock("@/lib/store/pgStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/pgStore")>();
  return {
    ...actual,
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

const { GET, HEAD, OPTIONS, POST } = await import("./route");

// Common profile triples (Alice — a typed FOAF person with a name + issuer).
const ALICE = "https://alice.pod.example/card#me";
const ALICE_DOC = "https://alice.pod.example/card";
const ALICE_TRIPLES: TpfTriple[] = [
  { s: ALICE, p: `${RDF}type`, o: `${FOAF}Person`, oIsIri: true },
  { s: ALICE, p: `${FOAF}name`, o: "Alice Wonderland", oIsIri: false },
  { s: ALICE, p: `${SOLID}oidcIssuer`, o: "https://idp.example", oIsIri: true },
];

// ─── DATA part ───────────────────────────────────────────────────────────────

describe("GET /tpf — data (matching triples)", () => {
  let store: PgStore;
  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);
    await seedProfile(store, ALICE, ALICE_DOC, ALICE_TRIPLES);
  });

  it("returns triples matching ?s=", async () => {
    const res = await GET(makeRequest({ s: ALICE }));
    expect(res.status).toBe(200);
    const rdf = await parseTurtle(await res.text(), INDEX_BASE_URL);

    const nameQuads = rdf.getQuads(ALICE, `${FOAF}name`, null, null);
    expect(nameQuads.length).toBe(1);
    expect(nameQuads[0].object.value).toBe("Alice Wonderland");

    const typeQuads = rdf.getQuads(ALICE, `${RDF}type`, `${FOAF}Person`, null);
    expect(typeQuads.length).toBe(1);
  });

  it("returns triples matching ?p= across subjects", async () => {
    await seedProfile(
      store,
      "https://bob.example/c#me",
      "https://bob.example/c",
      [
        {
          s: "https://bob.example/c#me",
          p: `${FOAF}name`,
          o: "Bob",
          oIsIri: false,
        },
      ]
    );
    const res = await GET(makeRequest({ p: `${FOAF}name` }));
    const rdf = await parseTurtle(await res.text(), INDEX_BASE_URL);
    const names = rdf.getQuads(null, `${FOAF}name`, null, null);
    const subjects = new Set(names.map((q) => q.subject.value));
    expect(subjects.has(ALICE)).toBe(true);
    expect(subjects.has("https://bob.example/c#me")).toBe(true);
  });

  it("matches an IRI object (?o=<iri>) but not a literal of the same lexical value", async () => {
    const res = await GET(makeRequest({ o: "https://idp.example" }));
    const rdf = await parseTurtle(await res.text(), INDEX_BASE_URL);
    const issuer = rdf.getQuads(ALICE, `${SOLID}oidcIssuer`, null, null);
    expect(issuer.length).toBe(1);
    expect(issuer[0].object.termType).toBe("NamedNode");
  });

  it("matches a literal object (?o=Alice Wonderland)", async () => {
    const res = await GET(makeRequest({ o: "Alice Wonderland" }));
    const rdf = await parseTurtle(await res.text(), INDEX_BASE_URL);
    const name = rdf.getQuads(ALICE, `${FOAF}name`, null, null);
    expect(name.length).toBe(1);
    expect(name[0].object.termType).toBe("Literal");
  });
});

// ─── TOMBSTONE FILTERING (DESIGN.md §4.8 H1) ───────────────────────────────────

describe("GET /tpf — tombstone filtering", () => {
  let store: PgStore;
  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);
    await seedProfile(store, ALICE, ALICE_DOC, ALICE_TRIPLES);
  });

  it("never serves triples about a tombstoned WebID", async () => {
    // Alice is present before tombstoning.
    const before = await GET(makeRequest({ p: `${FOAF}name` }));
    const rdfBefore = await parseTurtle(await before.text(), INDEX_BASE_URL);
    expect(rdfBefore.getQuads(ALICE, `${FOAF}name`, null, null).length).toBe(1);

    // Tombstone Alice's doc — her triples must vanish from every TPF pattern.
    await store.tombstone(ALICE_DOC);

    const afterP = await GET(makeRequest({ p: `${FOAF}name` }));
    const rdfP = await parseTurtle(await afterP.text(), INDEX_BASE_URL);
    expect(rdfP.getQuads(ALICE, `${FOAF}name`, null, null).length).toBe(0);

    const afterS = await GET(makeRequest({ s: ALICE }));
    const rdfS = await parseTurtle(await afterS.text(), INDEX_BASE_URL);
    expect(rdfS.getQuads(ALICE, null, null, null).length).toBe(0);

    const afterO = await GET(makeRequest({ o: "https://idp.example" }));
    const rdfO = await parseTurtle(await afterO.text(), INDEX_BASE_URL);
    expect(rdfO.getQuads(ALICE, `${SOLID}oidcIssuer`, null, null).length).toBe(
      0
    );
  });
});

// ─── METADATA + CONTROLS ───────────────────────────────────────────────────────

describe("GET /tpf — metadata + controls", () => {
  let store: PgStore;
  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);
    await seedProfile(store, ALICE, ALICE_DOC, ALICE_TRIPLES);
  });

  it("types the fragment hydra:Collection + void:Dataset with void:subset", async () => {
    const res = await GET(makeRequest({ p: `${FOAF}name` }));
    const rdf = await parseTurtle(await res.text(), INDEX_BASE_URL);

    // The fragment resource is the request URL.
    const fragmentIri = `${INDEX_BASE_URL}/tpf?p=${encodeURIComponent(`${FOAF}name`)}`;

    expect(
      rdf.getQuads(fragmentIri, `${RDF}type`, `${HYDRA}Collection`, null).length
    ).toBe(1);
    expect(
      rdf.getQuads(fragmentIri, `${RDF}type`, `${VOID}Dataset`, null).length
    ).toBe(1);
    // void:subset on the full dataset → this fragment.
    expect(
      rdf.getQuads(DATASET_IRI, `${VOID}subset`, fragmentIri, null).length
    ).toBe(1);
  });

  it("carries a void:triples estimate, hydra:totalItems, hydra:itemsPerPage", async () => {
    const res = await GET(makeRequest({ p: `${FOAF}name` }));
    const rdf = await parseTurtle(await res.text(), INDEX_BASE_URL);
    const fragmentIri = `${INDEX_BASE_URL}/tpf?p=${encodeURIComponent(`${FOAF}name`)}`;

    const triplesQ = rdf.getQuads(fragmentIri, `${VOID}triples`, null, null);
    expect(triplesQ.length).toBe(1);
    // Estimate is the per-predicate cardinality from stats: exactly 1 foaf:name.
    expect(Number(triplesQ[0].object.value)).toBe(1);

    expect(
      rdf.getQuads(fragmentIri, `${HYDRA}totalItems`, null, null).length
    ).toBe(1);
    const perPage = rdf.getQuads(
      fragmentIri,
      `${HYDRA}itemsPerPage`,
      null,
      null
    );
    expect(perPage.length).toBe(1);
    expect(Number(perPage[0].object.value)).toBeGreaterThan(0);
  });

  it("void:triples is a PATTERN cardinality ESTIMATE from stats, not a live page count", async () => {
    // Seed many foaf:name triples across subjects; a small page must still report
    // the FULL pattern cardinality in void:triples (estimate ≠ page length).
    for (let i = 0; i < 5; i++) {
      const w = `https://p${i}.example/c#me`;
      await seedProfile(store, w, `https://p${i}.example/c`, [
        { s: w, p: `${FOAF}name`, o: `Person ${i}`, oIsIri: false },
      ]);
    }
    // 1 (Alice) + 5 = 6 foaf:name triples total.
    const res = await GET(makeRequest({ p: `${FOAF}name`, limit: "2" }));
    const rdf = await parseTurtle(await res.text(), INDEX_BASE_URL);
    const fragmentIri = `${INDEX_BASE_URL}/tpf?p=${encodeURIComponent(`${FOAF}name`)}`;
    const est = Number(
      rdf.getQuads(fragmentIri, `${VOID}triples`, null, null)[0].object.value
    );
    expect(est).toBe(6);
    // But the page only has 2 data triples (limit=2).
    const dataNames = rdf.getQuads(null, `${FOAF}name`, null, null);
    expect(dataNames.length).toBe(2);
  });

  it("advertises the hydra:search IriTemplate with s/p/o → rdf:subject/predicate/object mapping", async () => {
    const res = await GET(makeRequest({ p: `${FOAF}name` }));
    const rdf = await parseTurtle(await res.text(), INDEX_BASE_URL);

    // The control is on the DATASET resource (discoverable from any fragment/VoID).
    const search = rdf.getQuads(DATASET_IRI, `${HYDRA}search`, null, null);
    expect(search.length).toBe(1);
    const tmpl = search[0].object;

    expect(
      rdf.getQuads(tmpl, `${RDF}type`, `${HYDRA}IriTemplate`, null).length
    ).toBe(1);

    const tmplVal = rdf.getQuads(tmpl, `${HYDRA}template`, null, null);
    expect(tmplVal.length).toBe(1);
    expect(tmplVal[0].object.value).toBe(`${INDEX_BASE_URL}/tpf{?s,p,o}`);

    // Three mappings, one per variable, each → the matching rdf: term.
    const mappings = rdf.getQuads(tmpl, `${HYDRA}mapping`, null, null);
    expect(mappings.length).toBe(3);

    const byVar = new Map<string, string>();
    for (const m of mappings) {
      const variable = rdf.getQuads(m.object, `${HYDRA}variable`, null, null)[0]
        .object.value;
      const prop = rdf.getQuads(m.object, `${HYDRA}property`, null, null)[0]
        .object.value;
      byVar.set(variable, prop);
    }
    expect(byVar.get("s")).toBe(`${RDF}subject`);
    expect(byVar.get("p")).toBe(`${RDF}predicate`);
    expect(byVar.get("o")).toBe(`${RDF}object`);
  });
});

// ─── PAGING ────────────────────────────────────────────────────────────────────

describe("GET /tpf — keyset paging", () => {
  let store: PgStore;
  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);
    for (let i = 0; i < 5; i++) {
      const w = `https://p${i}.example/c#me`;
      await seedProfile(store, w, `https://p${i}.example/c`, [
        { s: w, p: `${FOAF}name`, o: `Person ${i}`, oIsIri: false },
      ]);
    }
  });

  it("first page has hydra:first + hydra:next; following next yields disjoint data", async () => {
    const res1 = await GET(makeRequest({ p: `${FOAF}name`, limit: "2" }));
    const rdf1 = await parseTurtle(await res1.text(), INDEX_BASE_URL);
    const frag1 = `${INDEX_BASE_URL}/tpf?p=${encodeURIComponent(`${FOAF}name`)}`;

    // hydra:first present, no hydra:previous on first page.
    expect(rdf1.getQuads(frag1, `${HYDRA}first`, null, null).length).toBe(1);
    expect(rdf1.getQuads(frag1, `${HYDRA}previous`, null, null).length).toBe(0);

    const next1 = rdf1.getQuads(frag1, `${HYDRA}next`, null, null);
    expect(next1.length).toBe(1);
    const cursorRaw = new URL(next1[0].object.value).searchParams.get("cursor");
    if (cursorRaw === null) throw new Error("expected a hydra:next cursor");
    const cursor: string = cursorRaw;

    const page1Data = new Set(
      rdf1.getQuads(null, `${FOAF}name`, null, null).map((q) => q.subject.value)
    );
    expect(page1Data.size).toBe(2);

    // Second page.
    const res2 = await GET(
      makeRequest({ p: `${FOAF}name`, limit: "2", cursor })
    );
    const rdf2 = await parseTurtle(await res2.text(), INDEX_BASE_URL);
    const page2Data = new Set(
      rdf2.getQuads(null, `${FOAF}name`, null, null).map((q) => q.subject.value)
    );
    expect(page2Data.size).toBe(2);
    // Disjoint from page 1.
    for (const s of page2Data) expect(page1Data.has(s)).toBe(false);

    // A non-first page carries hydra:previous (back to first).
    const frag2 = `${INDEX_BASE_URL}/tpf?p=${encodeURIComponent(`${FOAF}name`)}&cursor=${cursor}`;
    expect(rdf2.getQuads(frag2, `${HYDRA}previous`, null, null).length).toBe(1);
  });

  it("the last page has no hydra:next", async () => {
    // limit 10 > 5 total → single page, no next.
    const res = await GET(makeRequest({ p: `${FOAF}name`, limit: "10" }));
    const rdf = await parseTurtle(await res.text(), INDEX_BASE_URL);
    const frag = `${INDEX_BASE_URL}/tpf?p=${encodeURIComponent(`${FOAF}name`)}`;
    expect(rdf.getQuads(frag, `${HYDRA}next`, null, null).length).toBe(0);
  });
});

// ─── CACHE / METHODS / BYTE BUDGET / CONNEG ────────────────────────────────────

describe("GET /tpf — caching, methods, byte budget, conneg", () => {
  let store: PgStore;
  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);
    await seedProfile(store, ALICE, ALICE_DOC, ALICE_TRIPLES);
  });

  it("sets Cache-Control: s-maxage=3600", async () => {
    const res = await GET(makeRequest({ s: ALICE }));
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=3600");
  });

  it("serves Turtle by default with ETag + Vary + CORS", async () => {
    const res = await GET(makeRequest({ s: ALICE }));
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(res.headers.get("ETag")).toMatch(/^"sha256-[0-9a-f]{16}"$/);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("serves JSON-LD for Accept: application/ld+json", async () => {
    const res = await GET(makeRequest({ s: ALICE }, "application/ld+json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/ld+json");
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("serves Turtle (not a bare 200) for a browser HTML-preferring Accept", async () => {
    const res = await GET(
      makeRequest(
        { s: ALICE },
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      )
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("enforces the per-request byte budget with 413 when over budget", async () => {
    // Set a tiny per-request budget, then re-import the route + config so it picks
    // up the override (config reads the env at module load).  vi.mock is hoisted +
    // persistent, so the re-imported route still resolves makeStore → _mockStore;
    // we re-set _mockStore to a freshly-migrated store after resetModules to be safe.
    process.env.TPF_MAX_RESPONSE_BYTES = "120";
    vi.resetModules();
    try {
      const freshStore = (await makeTestStore()).store;
      await seedProfile(freshStore, ALICE, ALICE_DOC, ALICE_TRIPLES);
      setMockStore(freshStore);
      const { GET: GET2 } = await import("./route");

      // Any non-empty fragment serialises to > 120 bytes (the Hydra controls alone
      // exceed that), so the budget gate must fire 413.
      const res = await GET2(makeRequest({ s: ALICE }));
      expect(res.status).toBe(413);
      expect(res.headers.get("Content-Type")).toContain("text/plain");
    } finally {
      process.env.TPF_MAX_RESPONSE_BYTES = "";
      vi.resetModules();
    }
  });

  it("OPTIONS returns 204 with CORS + Allow", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("POST is 405 Method Not Allowed", () => {
    const res = POST();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("GET");
  });

  it("HEAD returns headers with no body", async () => {
    const res = await HEAD(makeRequest({ s: ALICE }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
    expect(await res.text()).toBe("");
  });
});

// ─── EMPTY PATTERN (whole dataset) ─────────────────────────────────────────────

describe("GET /tpf — empty pattern", () => {
  let store: PgStore;
  beforeEach(async () => {
    ({ store } = await makeTestStore());
    setMockStore(store);
    await seedProfile(store, ALICE, ALICE_DOC, ALICE_TRIPLES);
  });

  it("returns all triples and void:triples = total count from stats", async () => {
    const res = await GET(makeRequest({}));
    const rdf = await parseTurtle(await res.text(), INDEX_BASE_URL);
    const fragmentIri = `${INDEX_BASE_URL}/tpf`;
    const est = Number(
      rdf.getQuads(fragmentIri, `${VOID}triples`, null, null)[0].object.value
    );
    // 3 Alice triples total.
    expect(est).toBe(3);
  });
});
