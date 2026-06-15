// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — the LDN suggest inbox (app/inbox/route.ts). SECURITY-CRITICAL surface.
 *
 * Uses pglite (in-process Postgres WASM) for the real store — NO network, NO Neon. `makeStore` is
 * mocked to return the per-test pglite store; `triggerCrawl` and `next/server`'s `after()` are
 * mocked so we can assert the crawl kick is scheduled via after() (NOT QStash, NOT inline).
 *
 * Asserts the bead acceptance criteria:
 *  - 201 + Location on a valid suggest;
 *  - GET returns ldp:contains members;
 *  - a valid NEW WebID is ENQUEUED and the after() kick crawls it (the scheduled callback fires);
 *  - a fan-out bomb is BOUNDED (the suggestion seeds a SHARED suggest_budget, not per-child);
 *  - tombstoned → 409; rate-limit → 429; body-too-large → 413; bad type → 415; no object → 422.
 */
import { PGlite } from "@electric-sql/pglite";
import { Store as N3Store, Parser } from "n3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import { PgStore, createPgliteExecutor } from "@/lib/store/pgStore";

// ─── Mocks (hoisted) ───────────────────────────────────────────────────────────

// triggerCrawl — capture calls; resolves immediately.
const { triggerCrawlMock } = vi.hoisted(() => ({
  triggerCrawlMock: vi.fn(async () => {}),
}));
vi.mock("@/lib/crawl/triggerCrawl", () => ({
  triggerCrawl: triggerCrawlMock,
}));

// after() — capture the scheduled callback and invoke it immediately so we can assert the kick.
const { afterMock } = vi.hoisted(() => ({
  afterMock: vi.fn(async (task: () => unknown) => {
    await task();
  }),
}));
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: afterMock };
});

// makeStore → the per-test pglite store.
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

import { GET, OPTIONS, POST, PUT } from "./route";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LDP_CONTAINS = "http://www.w3.org/ns/ldp#contains";
const INBOX_IRI = `${INDEX_BASE_URL}/inbox/`;

function announce(webids: string | string[]): string {
  const objs = Array.isArray(webids) ? webids : [webids];
  return JSON.stringify({
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Announce",
    actor: "https://suggester.example/me",
    object: objs.length === 1 ? objs[0] : objs,
  });
}

function postReq(
  body: string,
  opts: {
    contentType?: string;
    ip?: string;
    slug?: string;
    contentLength?: number;
  } = {}
): Request {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/ld+json",
  };
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  if (opts.slug) headers.slug = opts.slug;
  if (opts.contentLength != null) {
    headers["content-length"] = String(opts.contentLength);
  }
  return new Request(INBOX_IRI, { method: "POST", headers, body });
}

async function freshStore(): Promise<PgStore> {
  const db = new PGlite();
  const s = new PgStore(createPgliteExecutor(db));
  await s.migrate();
  return s;
}

// ─── Suite ──────────────────────────────────────────────────────────────────────

describe("POST /inbox/", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    process.env.CRON_SECRET = "test-secret";
    process.env.DATABASE_URL = "postgres://test";
    _store = await freshStore();
    triggerCrawlMock.mockClear();
    afterMock.mockClear();
    afterMock.mockImplementation(async (task: () => unknown) => {
      await task();
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    _store = null;
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns 201 + Location for a valid new suggestion", async () => {
    const res = await POST(postReq(announce("https://alice.pod/card#me")));
    expect(res.status).toBe(201);
    const loc = res.headers.get("Location");
    expect(loc).toBeTruthy();
    expect(loc?.startsWith(INBOX_IRI)).toBe(true);
  });

  it("ENQUEUES the new WebID and the after() kick crawls it", async () => {
    const res = await POST(postReq(announce("https://bob.pod/card#me")));
    expect(res.status).toBe(201);

    // The doc was enqueued (frontier holds it as 'pending').
    const store = _store as PgStore;
    const doc = await store.get("https://bob.pod/card");
    expect(doc).not.toBeNull();
    expect(doc?.state).toBe("pending");
    expect(doc?.source).toBe("inbox");
    expect(doc?.webid).toBe("https://bob.pod/card#me");

    // The crawl kick was scheduled via after() (NOT inline, NOT QStash) and fired.
    expect(afterMock).toHaveBeenCalledOnce();
    expect(typeof afterMock.mock.calls[0][0]).toBe("function");
    expect(triggerCrawlMock).toHaveBeenCalledOnce();
  });

  it("honours a valid ULID Slug as the notification id", async () => {
    const slug = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const res = await POST(
      postReq(announce("https://dave.pod/card#me"), { slug })
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toBe(`${INBOX_IRI}${slug}`);
  });

  // ── Dedup / status outcomes ──────────────────────────────────────────────────

  it("returns 200 (not 201) when the WebID is already indexed", async () => {
    const store = _store as PgStore;
    await store.enqueue("https://eve.pod/card", {
      webid: "https://eve.pod/card#me",
      source: "inbox",
    });
    const claimed = await store.claim("w", 1);
    await store.markDone(
      claimed[0].docUrl,
      {
        state: "done",
        webid: "https://eve.pod/card#me",
        isSolid: true,
        nextEligibleAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
      },
      claimed[0].claimToken
    );

    const res = await POST(postReq(announce("https://eve.pod/card#me")));
    expect(res.status).toBe(200);
    // No new crawl kick for an already-live WebID.
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the WebID is tombstoned/opted-out", async () => {
    const store = _store as PgStore;
    await store.tombstone("https://gone.pod/card");
    const res = await POST(postReq(announce("https://gone.pod/card#me")));
    expect(res.status).toBe(409);
    expect(afterMock).not.toHaveBeenCalled();
  });

  // ── Validation / guards ──────────────────────────────────────────────────────

  it("returns 415 for an unsupported Content-Type", async () => {
    const res = await POST(
      postReq(announce("https://x.pod/card#me"), { contentType: "text/plain" })
    );
    expect(res.status).toBe(415);
    expect(res.headers.get("Accept-Post")).toContain("application/ld+json");
  });

  it("returns 413 when Content-Length exceeds 64 KiB (before parse)", async () => {
    const res = await POST(
      postReq(announce("https://x.pod/card#me"), {
        contentLength: 64 * 1024 + 1,
      })
    );
    expect(res.status).toBe(413);
  });

  it("returns 413 when the actual body exceeds 64 KiB (lying Content-Length)", async () => {
    // A body padded past the cap; Content-Length omitted so the byte check catches it.
    const big = `${announce("https://x.pod/card#me")}${" ".repeat(70 * 1024)}`;
    const res = await POST(
      new Request(INBOX_IRI, {
        method: "POST",
        headers: { "content-type": "application/ld+json" },
        body: big,
      })
    );
    expect(res.status).toBe(413);
  });

  it("STREAMS the body with a hard cap: a large stream returns 413 and is NOT fully buffered", async () => {
    // Build a ReadableStream that would emit ~1 MiB in 16 KiB chunks, with NO Content-Length declared
    // (and an understated one is irrelevant — the cap is on the actually-read bytes). We count how
    // many chunks the reader pulls: the capped reader must abort (cancel) after exceeding 64 KiB,
    // so it pulls FAR fewer chunks than the full stream — proving the rest is never buffered (H).
    const CHUNK = new Uint8Array(16 * 1024).fill(0x20); // 16 KiB of spaces
    const TOTAL_CHUNKS = 64; // would be 1 MiB if fully read
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= TOTAL_CHUNKS) {
          controller.close();
          return;
        }
        pulled++;
        controller.enqueue(CHUNK);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request(INBOX_IRI, {
      method: "POST",
      headers: { "content-type": "application/ld+json" },
      body: stream,
      // `duplex` is required by the Fetch spec when streaming a request body.
      // @ts-expect-error — duplex is not yet in the lib.dom Request typings.
      duplex: "half",
    });

    const res = await POST(req);
    expect(res.status).toBe(413);
    // The reader stopped well before draining the whole stream: 64 KiB / 16 KiB = 4 chunks to first
    // exceed the cap (the 5th read crosses it). Far fewer than the 64 chunks of the full body.
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(TOTAL_CHUNKS);
    expect(pulled).toBeLessThanOrEqual(8);
    // Nothing was parsed/enqueued.
    expect(triggerCrawlMock).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed RDF", async () => {
    const res = await POST(postReq("{ not json"));
    expect(res.status).toBe(400);
  });

  it("returns 422 when the notification carries no as:object", async () => {
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Announce",
    });
    const res = await POST(postReq(body));
    expect(res.status).toBe(422);
  });

  it("returns 422 + enqueues NOTHING for an UNTYPED as:object payload (AS2 type bypass guard, M2)", async () => {
    // An untyped subject carrying as:object must NOT enqueue a crawl — the route rejects when no
    // accepted AS2 activity type is present, and extractSuggestion harvests no untyped candidate.
    const turtle = `@prefix as: <https://www.w3.org/ns/activitystreams#> .
<urn:untyped> as:object <https://attacker.pod/card#me> .`;
    const res = await POST(postReq(turtle, { contentType: "text/turtle" }));
    expect(res.status).toBe(422);
    // No crawl enqueued, no notification recorded.
    expect(triggerCrawlMock).not.toHaveBeenCalled();
    const store = _store as PgStore;
    expect(await store.get("https://attacker.pod/card")).toBeNull();
  });

  it("returns 422 for a NON-accepted activity type (e.g. as:Like) — no enqueue", async () => {
    const turtle = `@prefix as: <https://www.w3.org/ns/activitystreams#> .
<urn:act> a as:Like ; as:object <https://attacker.pod/card#me> .`;
    const res = await POST(postReq(turtle, { contentType: "text/turtle" }));
    expect(res.status).toBe(422);
    expect(triggerCrawlMock).not.toHaveBeenCalled();
  });

  it("returns 422 when more than 10 as:object candidates are present", async () => {
    const many = Array.from(
      { length: 11 },
      (_, i) => `https://p${i}.pod/card#me`
    );
    const res = await POST(postReq(announce(many)));
    expect(res.status).toBe(422);
  });

  it("returns 422 when the only candidate is a non-public host literal (syntactic SSRF)", async () => {
    const res = await POST(postReq(announce("https://127.0.0.1/card#me")));
    expect(res.status).toBe(422);
    // Nothing enqueued.
    expect(triggerCrawlMock).not.toHaveBeenCalled();
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────────

  it("returns 429 after the per-IP limit is exhausted", async () => {
    const ip = "9.9.9.9";
    // Default INBOX_RATE_LIMIT_PER_IP_PER_HOUR = 3.
    for (let i = 0; i < 3; i++) {
      const r = await POST(
        postReq(announce(`https://r${i}.pod/card#me`), { ip })
      );
      expect(r.status).toBe(201);
    }
    const over = await POST(
      postReq(announce("https://r4.pod/card#me"), { ip })
    );
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBeTruthy();
  });

  // ── Daily admission budget (deferred, not dropped) ───────────────────────────

  it("DEFERS a valid suggestion when the daily admission budget is exhausted (202, not 422)", async () => {
    // Budget = 1: the first valid suggestion is admitted (201); the second is DEFERRED — recorded
    // with processed=FALSE for the daily drain, answered 202 (NOT a misleading 422), NOT enqueued.
    process.env.INBOX_DAILY_ADMISSION_BUDGET = "1";
    const store = _store as PgStore;

    const first = await POST(postReq(announce("https://one.pod/card#me")));
    expect(first.status).toBe(201);
    triggerCrawlMock.mockClear();
    afterMock.mockClear();

    const second = await POST(postReq(announce("https://two.pod/card#me")));
    expect(second.status).toBe(202);
    expect(second.headers.get("Location")).toBeTruthy();
    expect(second.headers.get("Retry-After")).toBeTruthy();

    // The deferred candidate was NOT enqueued (the daily drain will admit it later).
    expect(await store.get("https://two.pod/card")).toBeNull();
    // No crawl kick for a deferred suggestion.
    expect(triggerCrawlMock).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();

    // The notification IS persisted, marked processed=FALSE so the daily drain picks it up.
    const loc = second.headers.get("Location") as string;
    const id = loc.slice(INBOX_IRI.length);
    const notif = await store.getNotification(id);
    expect(notif).not.toBeNull();
    expect(notif?.processed).toBe(false);
  });

  // ── Fan-out bomb is BOUNDED ──────────────────────────────────────────────────

  it("a fan-out bomb is bounded: the suggestion seeds ONE shared suggest_budget", async () => {
    // One suggestion → its doc gets a SHARED suggest_budget keyed on the root (its own doc URL). The
    // crawler consumes that one budget across ALL descendants, so total descendants ≤ SUGGEST_BUDGET
    // regardless of fan-out. We assert the shared budget exists with the configured cap, then drain
    // it: exactly SUGGEST_BUDGET consumptions succeed, the rest fail (provably bounded).
    const { SUGGEST_BUDGET } = await import("@/lib/config");
    const res = await POST(postReq(announce("https://root.pod/card#me")));
    expect(res.status).toBe(201);

    const store = _store as PgStore;
    const root = "https://root.pod/card";
    // Drain the shared budget: SUGGEST_BUDGET grants, then refusals — independent of fan-out.
    let granted = 0;
    for (let i = 0; i < SUGGEST_BUDGET + 25; i++) {
      // eslint-disable-next-line no-await-in-loop
      if (await store.tryConsumeSuggestBudget(root)) granted++;
    }
    expect(granted).toBe(SUGGEST_BUDGET);
  });
});

// ─── GET /inbox/ ──────────────────────────────────────────────────────────────

describe("GET /inbox/", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    process.env.DATABASE_URL = "postgres://test";
    process.env.CRON_SECRET = "test-secret";
    _store = await freshStore();
    afterMock.mockImplementation(async (task: () => unknown) => {
      await task();
    });
  });
  afterEach(() => {
    process.env = originalEnv;
    _store = null;
  });

  function parseTurtle(body: string): N3Store {
    const store = new N3Store();
    store.addQuads(new Parser({ format: "Turtle" }).parse(body));
    return store;
  }

  it("returns an ldp:BasicContainer with ldp:contains members", async () => {
    // Post a suggestion first so there is a notification to list.
    await POST(postReq(announce("https://alice.pod/card#me")));

    const res = await GET(
      new Request(INBOX_IRI, { headers: { Accept: "text/turtle" } })
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    const g = parseTurtle(body);
    // The container contains at least one member.
    const contains = g.getQuads(INBOX_IRI, LDP_CONTAINS, null, null);
    expect(contains.length).toBeGreaterThanOrEqual(1);
    // Member is an as:Activity.
    const memberIri = contains[0].object.value;
    expect(memberIri.startsWith(INBOX_IRI)).toBe(true);
  });

  it("advertises Accept-Post matching the parseable set", async () => {
    const res = await GET(
      new Request(INBOX_IRI, { headers: { Accept: "text/turtle" } })
    );
    const ap = res.headers.get("Accept-Post") ?? "";
    expect(ap).toContain("application/ld+json");
    expect(ap).toContain("text/turtle");
  });

  it("honours Prefer: minimal container (omits ldp:contains)", async () => {
    await POST(postReq(announce("https://alice.pod/card#me")));
    const res = await GET(
      new Request(INBOX_IRI, {
        headers: {
          Accept: "text/turtle",
          Prefer:
            'return=representation; include="http://www.w3.org/ns/ldp#PreferMinimalContainer"',
        },
      })
    );
    const g = parseTurtle(await res.text());
    expect(g.getQuads(INBOX_IRI, LDP_CONTAINS, null, null).length).toBe(0);
  });
});

// ─── Method guards ──────────────────────────────────────────────────────────────

describe("inbox method guards", () => {
  it("PUT → 405 (append-only container)", async () => {
    const res = await PUT(new Request(INBOX_IRI, { method: "PUT" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("POST");
  });

  it("OPTIONS → 204 with Accept-Post + Allow", async () => {
    const res = await OPTIONS(new Request(INBOX_IRI, { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Accept-Post")).toContain("application/ld+json");
    expect(res.headers.get("Allow")).toContain("POST");
  });
});
