// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * ld-conformance.test.ts — LINKED-DATA conformance suite (pss-q2h): the index behaves as the
 * standards a generic LD client expects — LDN/AS2, TPF + Hydra controls, VoID/DCAT discovery — so a
 * fixture client can DISCOVER the controls, PAGINATE, and the AS2 inbox ROUND-TRIPS. All offline
 * (pglite store; AS2 bodies are local strings; the only "client" is an in-test RDF parser).
 *
 *   - LDN: POST an AS2 `as:Announce` → 201 + Location; the candidate is enqueued; GET the inbox
 *     container → an `ldp:BasicContainer` with `ldp:contains` members + `Accept-Post` discovery.
 *   - TPF + Hydra: a fragment carries the `hydra:search` IriTemplate (s/p/o mapping) + page controls
 *     (hydra:first / hydra:next), and `hydra:next` actually paginates to disjoint data.
 *   - VoID/DCAT: the dataset description carries `void:Dataset` + `dcat:Dataset`, the access endpoints
 *     (TPF uriLookupEndpoint, search service), `void:triples`/`entities`, and an example resource.
 *   - DCAT root catalog: `/` (root-rdf) advertises `dcat:Catalog` + the search/TPF `dcat:DataService`
 *     + `ldp:inbox`.
 */
import { Store as N3Store, Parser } from "n3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import type { PgStore } from "@/lib/store/pgStore";
import { freshTestStore } from "@/lib/store/testStore";
import { slugForWebId } from "@/lib/url/slug";

// ─── Mocks: store + the inbox after()/triggerCrawl plumbing (no real crawl kick) ──
let _store: PgStore | null = null;
vi.mock("@/lib/store/pgStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/pgStore")>();
  return {
    ...actual,
    makeStore: () => {
      if (!_store) throw new Error("no test store");
      return _store;
    },
  };
});
vi.mock("@/lib/crawl/triggerCrawl", () => ({
  triggerCrawl: vi.fn(async () => {}),
}));
const { afterMock } = vi.hoisted(() => ({
  afterMock: vi.fn(async (task: () => unknown) => {
    await task();
  }),
}));
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: afterMock };
});

const { POST: inboxPost, GET: inboxGet } = await import("./inbox/route");
const { GET: tpfGet } = await import("./tpf/route");
const { GET: voidGet } = await import("./.well-known/void/route");
const { GET: rootGet } = await import("./root-rdf/route");

// ─── Vocab IRIs ───────────────────────────────────────────────────────────────
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const LDP = "http://www.w3.org/ns/ldp#";
const AS2 = "https://www.w3.org/ns/activitystreams#";
const HYDRA = "http://www.w3.org/ns/hydra/core#";
const VOID = "http://rdfs.org/ns/void#";
const DCAT = "http://www.w3.org/ns/dcat#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const INBOX_IRI = `${INDEX_BASE_URL}/inbox/`;

function parseTurtle(body: string, baseIri = INDEX_BASE_URL): N3Store {
  const s = new N3Store();
  s.addQuads(new Parser({ format: "Turtle", baseIRI: baseIri }).parse(body));
  return s;
}

function announce(webid: string): string {
  return JSON.stringify({
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Announce",
    actor: "https://suggester.example/me",
    object: webid,
  });
}

beforeEach(async () => {
  process.env.CRON_SECRET = "test-secret";
  process.env.DATABASE_URL = "postgres://test";
  ({ store: _store } = await freshTestStore());
  afterMock.mockClear();
  afterMock.mockImplementation(async (task: () => unknown) => {
    await task();
  });
});

// ════════════════════════════════ LDN / AS2 ════════════════════════════════

describe("LDN/AS2 conformance — the inbox round-trips an Announce", () => {
  it("POST as:Announce (JSON-LD) → 201 + Location under the inbox; candidate enqueued", async () => {
    const res = await inboxPost(
      new Request(INBOX_IRI, {
        method: "POST",
        headers: { "content-type": "application/ld+json" },
        body: announce("https://newperson.pod/card#me"),
      })
    );
    expect(res.status).toBe(201);
    const loc = res.headers.get("Location");
    expect(loc?.startsWith(INBOX_IRI)).toBe(true);
    // The candidate is in the frontier (source=inbox), proving the AS2 as:object was extracted.
    const doc = await (_store as PgStore).get("https://newperson.pod/card");
    expect(doc?.state).toBe("pending");
    expect(doc?.source).toBe("inbox");
  });

  it("POST as:Announce as TURTLE round-trips identically (content-type negotiation on the inbox)", async () => {
    const ttl = `@prefix as: <${AS2}> .
<urn:act> a as:Announce ; as:object <https://ttlperson.pod/card#me> .`;
    const res = await inboxPost(
      new Request(INBOX_IRI, {
        method: "POST",
        headers: { "content-type": "text/turtle" },
        body: ttl,
      })
    );
    expect(res.status).toBe(201);
    expect(
      await (_store as PgStore).get("https://ttlperson.pod/card")
    ).not.toBeNull();
  });

  it("GET the inbox container → ldp:BasicContainer + ldp:contains an as:Activity member + Accept-Post", async () => {
    await inboxPost(
      new Request(INBOX_IRI, {
        method: "POST",
        headers: { "content-type": "application/ld+json" },
        body: announce("https://listed.pod/card#me"),
      })
    );
    const res = await inboxGet(
      new Request(INBOX_IRI, { headers: { Accept: "text/turtle" } })
    );
    expect(res.status).toBe(200);
    const g = parseTurtle(await res.text());

    // ldp:BasicContainer typing.
    const types = g
      .getQuads(INBOX_IRI, `${RDF}type`, null, null)
      .map((q) => q.object.value);
    expect(types).toContain(`${LDP}BasicContainer`);
    // ldp:contains ≥ 1 member, each under the inbox IRI.
    const contains = g.getQuads(INBOX_IRI, `${LDP}contains`, null, null);
    expect(contains.length).toBeGreaterThanOrEqual(1);
    expect(contains[0].object.value.startsWith(INBOX_IRI)).toBe(true);
    // Accept-Post discovery header lists the parseable set.
    const ap = res.headers.get("Accept-Post") ?? "";
    expect(ap).toContain("application/ld+json");
    expect(ap).toContain("text/turtle");
  });

  it("an UNTYPED AS2 payload enqueues NOTHING (the type gate — security M2)", async () => {
    const untyped = `@prefix as: <${AS2}> .
<urn:x> as:object <https://sneaky.pod/card#me> .`; // no rdf:type Announce/Offer/Add
    const res = await inboxPost(
      new Request(INBOX_IRI, {
        method: "POST",
        headers: { "content-type": "text/turtle" },
        body: untyped,
      })
    );
    // The route rejects an empty activity-type set (422) and never enqueues.
    expect(res.status).toBe(422);
    expect(await (_store as PgStore).get("https://sneaky.pod/card")).toBeNull();
  });
});

// ════════════════════════════════ TPF + Hydra ════════════════════════════════

/** Seed `n` people each with a foaf:name + rdf:type, projected into TPF + stats. */
async function seedPeople(store: PgStore, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const docUrl = `https://person${i}.pod/card`;
    const webid = `${docUrl}#me`;
    await store.enqueue(docUrl, { webid, source: "seed" });
    const claimed = await store.claim(`seed${i}`, 1);
    await store.markDone(
      docUrl,
      {
        state: "done",
        httpStatus: 200,
        rawRdf: `<${webid}> <${FOAF}name> "Person ${i}" .`,
        isSolid: true,
        webid,
        nextEligibleAt: Date.now() + 1_000_000,
      },
      claimed[0].claimToken
    );
    await store.upsertTriples({
      webid,
      docUrl,
      triples: [
        { s: webid, p: `${RDF}type`, o: `${FOAF}Person`, oIsIri: true },
        { s: webid, p: `${FOAF}name`, o: `Person ${i}`, oIsIri: false },
      ],
    });
  }
}

describe("TPF + Hydra conformance — controls discoverable + pagination", () => {
  it("a fragment carries the hydra:search IriTemplate with s/p/o mapping", async () => {
    await seedPeople(_store as PgStore, 1);
    const res = await tpfGet(
      new Request(
        `${INDEX_BASE_URL}/tpf?p=${encodeURIComponent(`${FOAF}name`)}`,
        {
          headers: { Accept: "text/turtle" },
        }
      )
    );
    expect(res.status).toBe(200);
    const g = parseTurtle(await res.text());
    // There is a hydra:search → IriTemplate. Use the TERM (blank node) as the subject for the
    // follow-on lookups — N3.Store treats a bare string subject as an IRI, so a blank-node object
    // must be passed back as its term, not its label string.
    const searches = g.getQuads(null, `${HYDRA}search`, null, null);
    expect(searches.length).toBeGreaterThanOrEqual(1);
    const tmpl = searches[0].object;
    // The template node is a hydra:IriTemplate.
    expect(
      g.getQuads(tmpl, `${RDF}type`, `${HYDRA}IriTemplate`, null).length
    ).toBeGreaterThanOrEqual(1);
    // Its hydra:template string parameterises {?s,p,o}.
    const templStrings = g
      .getQuads(tmpl, `${HYDRA}template`, null, null)
      .map((q) => q.object.value);
    expect(templStrings.length).toBeGreaterThanOrEqual(1);
    expect(templStrings.join(" ")).toContain("{?s,p,o}");
    // The mapping declares the three TPF variables.
    const mappings = g.getQuads(tmpl, `${HYDRA}mapping`, null, null);
    const varNames = mappings.flatMap((m) =>
      g
        .getQuads(m.object, `${HYDRA}variable`, null, null)
        .map((qq) => qq.object.value)
    );
    expect(varNames).toEqual(expect.arrayContaining(["s", "p", "o"]));
  });

  it("hydra:next paginates a ?p= fragment to DISJOINT data (a fixture client can follow it)", async () => {
    await seedPeople(_store as PgStore, 6);
    // Page size 3 over 6 foaf:name triples → two pages.
    const page1 = await tpfGet(
      new Request(
        `${INDEX_BASE_URL}/tpf?p=${encodeURIComponent(`${FOAF}name`)}&limit=3`,
        { headers: { Accept: "text/turtle" } }
      )
    );
    const g1 = parseTurtle(await page1.text());
    const names1 = g1
      .getQuads(null, `${FOAF}name`, null, null)
      .map((q) => `${q.subject.value} ${q.object.value}`);
    expect(names1.length).toBe(3);

    // Discover hydra:next and follow it.
    const next = g1.getQuads(null, `${HYDRA}next`, null, null)[0]?.object.value;
    expect(next, "fragment must expose hydra:next").toBeTruthy();
    const nextUrl = new URL(next as string);
    const page2 = await tpfGet(
      new Request(nextUrl.toString(), { headers: { Accept: "text/turtle" } })
    );
    const g2 = parseTurtle(await page2.text());
    const names2 = g2
      .getQuads(null, `${FOAF}name`, null, null)
      .map((q) => `${q.subject.value} ${q.object.value}`);
    // Disjoint coverage: no overlap between page 1 and page 2.
    for (const n of names2) expect(names1).not.toContain(n);
  });

  it("a fragment is typed hydra:Collection + void:Dataset and reports void:triples", async () => {
    await seedPeople(_store as PgStore, 2);
    const res = await tpfGet(
      new Request(
        `${INDEX_BASE_URL}/tpf?p=${encodeURIComponent(`${FOAF}name`)}`,
        {
          headers: { Accept: "text/turtle" },
        }
      )
    );
    const g = parseTurtle(await res.text());
    const collTypes = g
      .getQuads(null, `${RDF}type`, `${HYDRA}Collection`, null)
      .map((q) => q.subject.value);
    expect(collTypes.length).toBeGreaterThanOrEqual(1);
    // void:triples cardinality estimate is present on the fragment graph.
    const tripleCounts = g.getQuads(null, `${VOID}triples`, null, null);
    expect(tripleCounts.length).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════ VoID / DCAT ════════════════════════════════

describe("VoID/DCAT conformance — discovery of the dataset + access endpoints", () => {
  it("the VoID description is a void:Dataset + dcat:Dataset with stats", async () => {
    await seedPeople(_store as PgStore, 3);
    const res = await voidGet(
      new Request(`${INDEX_BASE_URL}/.well-known/void`, {
        headers: { Accept: "text/turtle" },
      })
    );
    expect(res.status).toBe(200);
    const g = parseTurtle(await res.text());
    const allTypes = g
      .getQuads(null, `${RDF}type`, null, null)
      .map((q) => q.object.value);
    expect(allTypes).toContain(`${VOID}Dataset`);
    expect(allTypes).toContain(`${DCAT}Dataset`);
    // void:entities reflects the 3 indexed people.
    const entities = g.getQuads(null, `${VOID}entities`, null, null);
    expect(entities.length).toBeGreaterThanOrEqual(1);
    expect(Number(entities[0].object.value)).toBe(3);
    // void:triples present.
    expect(
      g.getQuads(null, `${VOID}triples`, null, null).length
    ).toBeGreaterThanOrEqual(1);
  });

  it("the VoID description advertises the TPF + search access endpoints + an example resource", async () => {
    await seedPeople(_store as PgStore, 1);
    const res = await voidGet(
      new Request(`${INDEX_BASE_URL}/.well-known/void`, {
        headers: { Accept: "text/turtle" },
      })
    );
    const body = await res.text();
    // The TPF endpoint is discoverable (uriLookupEndpoint or a dcat distribution pointing at /tpf).
    expect(body).toContain("/tpf");
    // void:exampleResource points at a real /p/{slug} (the seeded person).
    const exampleSlug = slugForWebId("https://person0.pod/card#me");
    const g = parseTurtle(body);
    const examples = g
      .getQuads(null, `${VOID}exampleResource`, null, null)
      .map((q) => q.object.value);
    expect(examples.some((e) => e.includes(exampleSlug))).toBe(true);
  });

  it("does NOT advertise a SPARQL endpoint when SPARQL_ENABLED is off (never a 404 link)", async () => {
    const res = await voidGet(
      new Request(`${INDEX_BASE_URL}/.well-known/void`, {
        headers: { Accept: "text/turtle" },
      })
    );
    const body = await res.text();
    expect(body).not.toContain("sparqlEndpoint");
  });

  it("the root catalog (/root-rdf) advertises dcat:Catalog + the search/TPF DataServices + ldp:inbox", async () => {
    await seedPeople(_store as PgStore, 1);
    const res = await rootGet(
      new Request(`${INDEX_BASE_URL}/root-rdf`, {
        headers: { Accept: "text/turtle" },
      })
    );
    expect(res.status).toBe(200);
    const g = parseTurtle(await res.text());
    const allTypes = g
      .getQuads(null, `${RDF}type`, null, null)
      .map((q) => q.object.value);
    expect(allTypes).toContain(`${DCAT}Catalog`);
    expect(allTypes).toContain(`${DCAT}DataService`);
    // ldp:inbox advertised in the body (LDN discovery) — also in the Link header.
    const inbox = g.getQuads(null, `${LDP}inbox`, null, null);
    expect(inbox.length).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("Link") ?? "").toContain("ldp#inbox");
  });
});
