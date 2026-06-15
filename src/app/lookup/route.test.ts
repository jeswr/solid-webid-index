// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — /lookup?webid= → 303 to /p/{slug} (DESIGN.md §4.1).
 */

import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import { PgStore, createPgliteExecutor } from "@/lib/store/pgStore";
import { slugForWebId } from "@/lib/url/slug";

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

import { GET, HEAD, OPTIONS, PUT } from "./route";

const WEBID = "https://alice.pod/card#me";
const DOC_URL = "https://alice.pod/card";

async function makeStore(): Promise<PgStore> {
  const db = new PGlite();
  const store = new PgStore(createPgliteExecutor(db));
  await store.migrate();
  return store;
}

function req(query: string): Request {
  return new Request(`${INDEX_BASE_URL}/lookup${query}`, { method: "GET" });
}

/** Non-null accessor for the per-test store (avoids non-null assertions). */
function store(): PgStore {
  if (!_mockStore) throw new Error("store not initialised");
  return _mockStore;
}

beforeEach(async () => {
  _mockStore = await makeStore();
});

async function seed(): Promise<void> {
  await store().enqueue(DOC_URL, { webid: WEBID, source: "seed" });
  const claimed = await store().claim("test", 1);
  await store().markDone(
    DOC_URL,
    { state: "done", webid: WEBID, isSolid: true, rawRdf: "x" },
    claimed[0].claimToken
  );
}

describe("GET /lookup?webid=", () => {
  it("303 → /p/{slug} for an indexed WebID", async () => {
    await seed();
    const res = await GET(req(`?webid=${encodeURIComponent(WEBID)}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(
      `${INDEX_BASE_URL}/p/${slugForWebId(WEBID)}`
    );
  });

  it("303 canonicalises the supplied WebID before computing the slug", async () => {
    await seed();
    // Mixed-case host + default port → canonicalises to the same WebID/slug.
    const res = await GET(
      req(`?webid=${encodeURIComponent("https://Alice.pod:443/card#me")}`)
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(
      `${INDEX_BASE_URL}/p/${slugForWebId(WEBID)}`
    );
  });

  it("404 for a well-formed but not-indexed WebID", async () => {
    const res = await GET(
      req(`?webid=${encodeURIComponent("https://nobody.example/card#me")}`)
    );
    expect(res.status).toBe(404);
  });

  it("400 when webid param is missing", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(400);
  });

  it("400 for an un-canonicalisable webid (forbidden scheme)", async () => {
    const res = await GET(
      req(`?webid=${encodeURIComponent("ftp://x.example/card#me")}`)
    );
    expect(res.status).toBe(400);
  });
});

describe("HEAD / OPTIONS / disallowed methods on /lookup", () => {
  it("HEAD mirrors GET status with no body", async () => {
    await seed();
    const res = await HEAD(req(`?webid=${encodeURIComponent(WEBID)}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(
      `${INDEX_BASE_URL}/p/${slugForWebId(WEBID)}`
    );
    expect(await res.text()).toBe("");
  });

  it("OPTIONS → 204 with Allow", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("PUT → 405", () => {
    const res = PUT();
    expect(res.status).toBe(405);
  });
});
