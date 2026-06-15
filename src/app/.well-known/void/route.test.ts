// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — GET /.well-known/void (DESIGN.md §4.2).
 *
 * Uses pglite (in-process Postgres) + a mocked makeStore.  Asserts conneg,
 * statuses, HEAD/OPTIONS/405, the VoID/DCAT graph, stats reflecting real inserts,
 * the no-SPARQL-when-off rule, and that void:exampleResource points at a REAL
 * /p/{slug} that the entry route resolves.
 */

import { PGlite } from "@electric-sql/pglite";
import { Store as N3Store, Parser } from "n3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import { DATASET_IRI } from "@/lib/rdf/vocab";
import { PgStore, createPgliteExecutor } from "@/lib/store/pgStore";
import type { TpfTriple } from "@/lib/store/ports";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const VOID = "http://rdfs.org/ns/void#";
const DCAT = "http://www.w3.org/ns/dcat#";
const SD = "http://www.w3.org/ns/sparql-service-description#";
const FOAF = "http://xmlns.com/foaf/0.1/";

const RDF_TYPE = `${RDF}type`;
const FOAF_PERSON = `${FOAF}Person`;
const FOAF_NAME = `${FOAF}name`;
const FOAF_KNOWS = `${FOAF}knows`;

function parseTurtle(ttl: string): Promise<N3Store> {
  return new Promise((resolve, reject) => {
    const s = new N3Store();
    new Parser({ baseIRI: INDEX_BASE_URL }).parse(ttl, (err, q) => {
      if (err) reject(err);
      else if (q) s.addQuad(q);
      else resolve(s);
    });
  });
}

function trip(s: string, p: string, o: string, oIsIri = true): TpfTriple {
  return { s, p, o, oIsIri };
}

async function makeTestStore(): Promise<PgStore> {
  const db = new PGlite();
  const store = new PgStore(createPgliteExecutor(db));
  await store.migrate();
  return store;
}

/**
 * Seed one served entry: enqueue + markDone (so list({state:'done'}) finds it with a
 * slug → void:exampleResource), and upsertTriples (so the stats counters increment).
 */
async function seedEntry(
  store: PgStore,
  webid: string,
  docUrl: string,
  name: string
): Promise<void> {
  await store.enqueue(docUrl, { webid });
  await store.markDone(docUrl, {
    state: "done",
    httpStatus: 200,
    isSolid: true,
    webid,
    rawRdf: `<${webid}> <${FOAF_NAME}> "${name}" .`,
  });
  await store.upsertTriples({
    webid,
    docUrl,
    triples: [
      trip(webid, RDF_TYPE, FOAF_PERSON),
      trip(webid, FOAF_NAME, name, false),
      trip(webid, FOAF_KNOWS, "https://other.example/#me"),
    ],
  });
}

// ─── Mock makeStore so the route uses our pglite instance ──────────────────────

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

const { GET, HEAD, OPTIONS, POST } = await import("./route");

function voidReq(accept = "text/turtle", extra?: HeadersInit): Request {
  return new Request(`${INDEX_BASE_URL}/.well-known/void`, {
    method: "GET",
    headers: { Accept: accept, ...(extra ?? {}) },
  });
}

beforeEach(async () => {
  _mockStore = await makeTestStore();
});

describe("GET /.well-known/void", () => {
  it("200 — serves the dataset description as Turtle with conneg headers", async () => {
    const res = await GET(voidReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(res.headers.get("ETag")).toBeTruthy();
  });

  it("describes a void:Dataset + dcat:Dataset", async () => {
    const store = await parseTurtle(await (await GET(voidReq())).text());
    const types = store
      .getQuads(DATASET_IRI, RDF_TYPE, null, null)
      .map((q) => q.object.value);
    expect(types).toContain(`${VOID}Dataset`);
    expect(types).toContain(`${DCAT}Dataset`);
  });

  it("stats reflect real inserts (entities + triples + partitions)", async () => {
    if (_mockStore) {
      await seedEntry(
        _mockStore,
        "https://alice.example/#me",
        "https://alice.example/card",
        "Alice"
      );
      await seedEntry(
        _mockStore,
        "https://bob.example/#me",
        "https://bob.example/card",
        "Bob"
      );
    }
    const store = await parseTurtle(await (await GET(voidReq())).text());
    expect(
      store.getQuads(DATASET_IRI, `${VOID}entities`, null, null)[0]?.object
        .value
    ).toBe("2");
    expect(
      store.getQuads(DATASET_IRI, `${VOID}triples`, null, null)[0]?.object.value
    ).toBe("6");
    // foaf:Person class partition → 2 entities.
    const classParts = store.getQuads(
      DATASET_IRI,
      `${VOID}classPartition`,
      null,
      null
    );
    const personPart = classParts.find(
      (cp) =>
        store.getQuads(cp.object, `${VOID}class`, FOAF_PERSON, null).length > 0
    );
    expect(personPart).toBeTruthy();
  });

  it("does NOT advertise a SPARQL endpoint by default (no 404 advertised)", async () => {
    const store = await parseTurtle(await (await GET(voidReq())).text());
    expect(
      store.getQuads(DATASET_IRI, `${VOID}sparqlEndpoint`, null, null).length
    ).toBe(0);
    expect(store.getQuads(null, RDF_TYPE, `${SD}Service`, null).length).toBe(0);
  });

  it("void:exampleResource points at a real /p/{slug} that the entry route resolves", async () => {
    const webid = "https://alice.example/#me";
    const docUrl = "https://alice.example/card";
    if (_mockStore) await seedEntry(_mockStore, webid, docUrl, "Alice");

    const store = await parseTurtle(await (await GET(voidReq())).text());
    const example = store.getQuads(
      DATASET_IRI,
      `${VOID}exampleResource`,
      null,
      null
    );
    expect(example.length).toBe(1);
    const exampleIri = example[0].object.value;
    expect(exampleIri.startsWith(`${INDEX_BASE_URL}/p/`)).toBe(true);

    // It must DEREFERENCE: the slug resolves to a served entry in the store.
    const slug = exampleIri.slice(`${INDEX_BASE_URL}/p/`.length);
    const entry = await _mockStore?.getEntryBySlug(slug);
    expect(entry).not.toBeNull();
    expect(entry).not.toBe("tombstoned");
  });

  it("serves Turtle to a browser Accept (htmlBranch=turtle, never 406)", async () => {
    const res = await GET(voidReq("text/html,application/xhtml+xml"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
  });

  it("serves JSON-LD with a context Link", async () => {
    const res = await GET(voidReq("application/ld+json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/ld+json");
    expect(res.headers.get("Link") ?? "").toContain("json-ld#context");
  });

  it("304 on matching If-None-Match", async () => {
    const first = await GET(voidReq());
    const etag = first.headers.get("ETag") ?? "";
    const res = await GET(voidReq("text/turtle", { "If-None-Match": etag }));
    expect(res.status).toBe(304);
  });

  it("HEAD → 200 no body; OPTIONS → 204; POST → 405", async () => {
    const head = await HEAD(voidReq());
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const opts = await OPTIONS();
    expect(opts.status).toBe(204);
    expect(opts.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    const post = POST();
    expect(post.status).toBe(405);
  });
});
