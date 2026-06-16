// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — /lookup?webid= → 303 to /p/{slug} (DESIGN.md §4.1).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import type { PgStore } from "@/lib/store/pgStore";
import { freshTestStore } from "@/lib/store/testStore";
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
  const { store } = await freshTestStore();
  return store;
}

function req(query: string): Request {
  return new Request(`${INDEX_BASE_URL}/lookup${query}`, { method: "GET" });
}

/** A GET with an explicit Accept header (for the JSON-mode tests). */
function reqAccept(query: string, accept: string): Request {
  return new Request(`${INDEX_BASE_URL}/lookup${query}`, {
    method: "GET",
    headers: { Accept: accept },
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

describe("GET /lookup — non-redirecting JSON mode", () => {
  it("?format=json → 200 indexed:true with slug + entry (no redirect)", async () => {
    await seed();
    const res = await GET(
      req(`?webid=${encodeURIComponent(WEBID)}&format=json`)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Location")).toBeNull();
    const body = await res.json();
    expect(body.indexed).toBe(true);
    expect(body.webid).toBe(WEBID);
    expect(body.slug).toBe(slugForWebId(WEBID));
    expect(body.entry).toBe(`${INDEX_BASE_URL}/p/${slugForWebId(WEBID)}`);
  });

  it("Accept: application/json → 200 indexed:true (no redirect)", async () => {
    await seed();
    const res = await GET(
      reqAccept(`?webid=${encodeURIComponent(WEBID)}`, "application/json")
    );
    expect(res.status).toBe(200);
    expect((await res.json()).indexed).toBe(true);
  });

  it("200 indexed:false (NOT 404) for a not-indexed WebID in JSON mode", async () => {
    const res = await GET(
      req(
        `?webid=${encodeURIComponent("https://nobody.example/card#me")}&format=json`
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indexed).toBe(false);
    expect(body.webid).toBe("https://nobody.example/card#me");
    expect(body.slug).toBeUndefined();
  });

  it("400 JSON error for a missing/malformed webid in JSON mode", async () => {
    const missing = await GET(req("?format=json"));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/webid/);

    const bad = await GET(
      req(`?webid=${encodeURIComponent("ftp://x.example/card#me")}&format=json`)
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/WebID/);
  });

  it("a bare Accept: */* still gets the 303 redirect (machine default)", async () => {
    await seed();
    const res = await GET(
      reqAccept(`?webid=${encodeURIComponent(WEBID)}`, "*/*")
    );
    expect(res.status).toBe(303);
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
