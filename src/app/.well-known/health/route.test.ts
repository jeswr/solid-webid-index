// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — GET /.well-known/health (DESIGN.md §4.9).
 *
 * Uses pglite (in-process Postgres) + a mocked makeStore. Asserts the JSON
 * snapshot reflects real inserts (entries/triples/queueDepth), the no-store +
 * describedby-Link headers, HEAD/OPTIONS/405, and graceful degradation to
 * status:"degraded" (HTTP 200) when the store throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import type { PgStore } from "@/lib/store/pgStore";
import type { TpfTriple } from "@/lib/store/ports";
import { freshTestStore } from "@/lib/store/testStore";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const RDF_TYPE = `${RDF}type`;
const FOAF_PERSON = `${FOAF}Person`;
const FOAF_NAME = `${FOAF}name`;

function trip(s: string, p: string, o: string, oIsIri = true): TpfTriple {
  return { s, p, o, oIsIri };
}

async function makeTestStore(): Promise<PgStore> {
  const { store } = await freshTestStore();
  return store;
}

/** Seed one served entry (enqueue → markDone → upsertTriples) so stats increment. */
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

beforeEach(async () => {
  _mockStore = await makeTestStore();
});

describe("GET /.well-known/health", () => {
  it("200 JSON with no-store + describedby Link", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Link")).toContain(
      `${INDEX_BASE_URL}/.well-known/void`
    );
    expect(res.headers.get("Link")).toContain('rel="describedby"');
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("reports ok status + zeroed counts for an empty index", async () => {
    const body = await (await GET()).json();
    expect(body.status).toBe("ok");
    expect(body.entries).toBe(0);
    expect(body.triples).toBe(0);
    expect(body.queueDepth).toBe(0);
    expect(typeof body.version).toBe("string");
  });

  it("reflects real entries + triples counts", async () => {
    const store = _mockStore as PgStore;
    await seedEntry(store, "https://a.pod/card#me", "https://a.pod/card", "A");
    await seedEntry(store, "https://b.pod/card#me", "https://b.pod/card", "B");

    const body = await (await GET()).json();
    expect(body.status).toBe("ok");
    expect(body.entries).toBe(2);
    expect(body.triples).toBeGreaterThan(0);
  });

  it("reports queueDepth = pending + claimed frontier rows", async () => {
    const store = _mockStore as PgStore;
    // Two pending frontier rows (enqueued, not yet crawled).
    await store.enqueue("https://p1.pod/card", {
      webid: "https://p1.pod/card#me",
    });
    await store.enqueue("https://p2.pod/card", {
      webid: "https://p2.pod/card#me",
    });

    const body = await (await GET()).json();
    expect(body.queueDepth).toBe(2);
  });

  it("degrades gracefully (status:degraded, HTTP 200) when the store throws", async () => {
    // Replace the mock store with one whose reads reject.
    _mockStore = {
      getStats: () => Promise.reject(new Error("db down")),
      countFrontier: () => Promise.reject(new Error("db down")),
    } as unknown as PgStore;

    const res = await GET();
    expect(res.status).toBe(200); // the function answered — not a 5xx
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.entries).toBe(0);
    expect(body.queueDepth).toBe(0);
  });
});

describe("HEAD / OPTIONS / disallowed methods", () => {
  it("HEAD → 200 with headers, no body", async () => {
    const res = await HEAD();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.text()).toBe("");
  });

  it("OPTIONS → 204 with Allow + CORS", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("POST → 405", async () => {
    const res = await POST();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });
});
