// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — GET /root-rdf, the RDF representation of `/` (DESIGN.md §4.2).
 *
 * Uses pglite + a mocked makeStore.  Asserts the DCAT catalog graph, the ldp:inbox
 * triple IN THE BODY, the hydra:search entrypoint, the ldp:inbox + describedby Link
 * headers, conneg, and HEAD/OPTIONS.
 */

import { PGlite } from "@electric-sql/pglite";
import { Store as N3Store, Parser } from "n3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import { DATASET_DESCRIPTION_IRIS } from "@/lib/rdf/datasetDescription";
import { PgStore, createPgliteExecutor } from "@/lib/store/pgStore";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const DCAT = "http://www.w3.org/ns/dcat#";
const LDP = "http://www.w3.org/ns/ldp#";
const HYDRA = "http://www.w3.org/ns/hydra/core#";

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

async function makeTestStore(): Promise<PgStore> {
  const db = new PGlite();
  const store = new PgStore(createPgliteExecutor(db));
  await store.migrate();
  return store;
}

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

let _mockStore: PgStore | null = null;

const { GET, HEAD, OPTIONS } = await import("./route");

function rootReq(accept = "text/turtle", extra?: HeadersInit): Request {
  // The middleware rewrites `/` to `/root-rdf`; the handler reads Accept off the
  // request regardless of path, so we exercise the handler directly.
  return new Request(`${INDEX_BASE_URL}/`, {
    method: "GET",
    headers: { Accept: accept, ...(extra ?? {}) },
  });
}

beforeEach(async () => {
  _mockStore = await makeTestStore();
});

describe("GET /root-rdf (the RDF view of /)", () => {
  it("200 — serves a dcat:Catalog as Turtle", async () => {
    const res = await GET(rootReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/turtle");
    const store = await parseTurtle(await res.text());
    expect(
      store.getQuads(
        DATASET_DESCRIPTION_IRIS.catalog,
        `${RDF}type`,
        `${DCAT}Catalog`,
        null
      ).length
    ).toBe(1);
  });

  it("emits the </inbox/> ldp:inbox triple IN THE BODY", async () => {
    const store = await parseTurtle(await (await GET(rootReq())).text());
    const inbox = store.getQuads(INDEX_BASE_URL, `${LDP}inbox`, null, null);
    expect(inbox.length).toBe(1);
    expect(inbox[0].object.value).toBe(DATASET_DESCRIPTION_IRIS.inbox);
  });

  it("sets the root ldp:inbox + describedby Link headers", async () => {
    const res = await GET(rootReq());
    const link = res.headers.get("Link") ?? "";
    expect(link).toContain('rel="http://www.w3.org/ns/ldp#inbox"');
    expect(link).toContain('rel="describedby"');
  });

  it("emits a hydra:search entrypoint", async () => {
    const store = await parseTurtle(await (await GET(rootReq())).text());
    const tmpl = store.getQuads(INDEX_BASE_URL, `${HYDRA}search`, null, null);
    expect(tmpl.length).toBe(1);
    expect(
      store.getQuads(tmpl[0].object, `${RDF}type`, `${HYDRA}IriTemplate`, null)
        .length
    ).toBe(1);
  });

  it("serves JSON-LD with a context Link", async () => {
    const res = await GET(rootReq("application/ld+json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/ld+json");
    expect(res.headers.get("Link") ?? "").toContain("json-ld#context");
  });

  it("HEAD → 200 no body; OPTIONS → 204", async () => {
    const head = await HEAD(rootReq());
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const opts = await OPTIONS();
    expect(opts.status).toBe(204);
  });
});
