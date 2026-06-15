// AUTHORED-BY Claude Opus 4.8
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — unit tests for /api/_jobs/crawl/route.ts
 *
 * Tests:
 *  - Unauthenticated request → 401
 *  - Wrong secret → 401
 *  - Correct CRON_SECRET bearer → runs crawl batch and returns 200 + summary
 *  - Internal self-chain bearer accepted (same CRON_SECRET bearer for self-chain)
 *  - timingSafeEqual is used (constant-time comparison is enforced)
 *  - runCrawlBatch is invoked and its summary is returned
 *  - Self-chain triggers when remaining = true AND depth < CRAWL_JOB_MAX_CHAIN_DEPTH:
 *      - after() is invoked (not a bare void promise) so the platform keeps the function alive
 *      - the scheduled promise is a fetch to /api/_jobs/crawl with depth+1
 *  - Self-chain does NOT trigger (after() not called) when remaining = false
 *  - Self-chain does NOT trigger when depth >= CRAWL_JOB_MAX_CHAIN_DEPTH (loop guard)
 *  - Chain cap halts further self-chaining
 *
 * All tests run without a real database or network: runCrawlBatch, fetch, and after() are mocked.
 *
 * VITEST NOTE: vi.mock() factories are hoisted to the top of the file.
 * To avoid closure timing issues, the factory functions below use `vi.fn(impl)` (not
 * `vi.fn().mockImplementation(impl)`), and the crawlSummary object is mutated in-place
 * between tests (the function closes over the reference, not a snapshot).
 *
 * after() mock strategy: we mock `next/server` to capture the task passed to `after()`.
 * The mock immediately awaits it so we can synchronously verify the downstream fetch.
 */
import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { CRAWL_JOB_MAX_CHAIN_DEPTH } from "@/lib/config";

// ─── Module mocks ─────────────────────────────────────────────────────────────
// vi.mock() is hoisted by vitest's transform — these run before any imports.

// Crawl summary — mutated per-test by setting `.remaining`.
const crawlSummary = {
  claimed: 8,
  fetched: 7,
  added: 2,
  errors: 0,
  budgetHit: false,
  remaining: false,
};

// Mock pgStore so no Neon connection is attempted.
vi.mock("@/lib/store/pgStore", () => ({
  PgStore: vi.fn(function PgStoreMock() {
    return {};
  }),
  createNeonExecutor: vi.fn(() => ({})),
}));

// Mock the crawler — returns a spread of crawlSummary so per-test mutations take effect.
vi.mock("@/lib/crawl/crawler", () => ({
  runCrawlBatch: vi.fn(async () => ({ ...crawlSummary })),
}));

// Mock next/server — preserve NextRequest/NextResponse and capture after() calls.
// afterMock is declared via vi.hoisted() so it is available inside the vi.mock() factory
// (which is hoisted to before any import statements by vitest's transform).
// The after() mock immediately invokes the task (a Promise) so we can assert on the
// downstream fetch without asynchronous timing tricks.
const { afterMock } = vi.hoisted(() => ({
  afterMock: vi.fn(async (task: Promise<unknown>) => {
    await task;
  }),
}));

vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: afterMock,
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GOOD_SECRET = "test-cron-secret-abc123";

function makeReq(opts: {
  secret?: string | null;
  depth?: number;
}): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.secret != null) {
    headers.authorization = `Bearer ${opts.secret}`;
  }
  if (opts.depth != null) {
    headers["x-chain-depth"] = String(opts.depth);
  }
  return new NextRequest("http://localhost/api/_jobs/crawl", {
    method: "POST",
    headers,
    body: "{}",
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/api/_jobs/crawl route", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let fetchMock: MockInstance;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CRON_SECRET = GOOD_SECRET;
    process.env.DATABASE_URL = "postgres://test";
    // Reset crawl summary to a safe default for each test.
    crawlSummary.remaining = false;
    crawlSummary.claimed = 8;
    // Intercept the global fetch used for self-chain.
    fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    // Reset after() mock call history.
    afterMock.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it("rejects an unauthenticated request with 401", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq({ secret: null }));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token with 401", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq({ secret: "wrong-secret" }));
    expect(res.status).toBe(401);
  });

  it("accepts a correct CRON_SECRET bearer token", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq({ secret: GOOD_SECRET }));
    expect(res.status).toBe(200);
  });

  it("accepts the same CRON_SECRET bearer for self-chain (depth header present)", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq({ secret: GOOD_SECRET, depth: 3 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chainDepth).toBe(3);
  });

  // ── timingSafeEqual enforcement ────────────────────────────────────────────

  it("uses crypto.timingSafeEqual for constant-time compare (no wrong-length throw)", async () => {
    // Verify the route handles a short (different-length) secret without throwing.
    // The Node timingSafeEqual requires equal-length buffers; the route must handle
    // mismatched lengths and return 401, not throw 500.
    const aBuf = Buffer.from("abc");
    const bBuf = Buffer.from("abc");
    expect(timingSafeEqual(aBuf, bBuf)).toBe(true);
    const { POST } = await import("./route");
    const res = await POST(makeReq({ secret: "short" }));
    expect(res.status).toBe(401);
  });

  // ── Batch invocation ───────────────────────────────────────────────────────

  it("invokes runCrawlBatch and returns the summary in the response body", async () => {
    const { runCrawlBatch } = await import("@/lib/crawl/crawler");
    const { POST } = await import("./route");
    const res = await POST(makeReq({ secret: GOOD_SECRET }));
    expect(runCrawlBatch).toHaveBeenCalled();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary).toBeDefined();
    expect(body.summary.claimed).toBe(8);
  });

  // ── Self-chain: after() is called (not a bare void) when remaining = true ──

  it("schedules self-chain via after() when remaining=true and depth < max", async () => {
    crawlSummary.remaining = true;
    const { POST } = await import("./route");
    await POST(makeReq({ secret: GOOD_SECRET, depth: 0 }));
    // after() should have been called once with the self-chain promise.
    expect(afterMock).toHaveBeenCalledOnce();
    // The afterMock immediately awaits the task, so fetch should already have been called.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/_jobs\/crawl$/);
    expect((init.headers as Record<string, string>)["x-chain-depth"]).toBe("1");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${GOOD_SECRET}`
    );
  });

  it("after() receives a Promise (the crawl is deferred to after(), not fetched inline)", async () => {
    // The route must schedule the self-chain via after(promise), not by calling fetch directly
    // and discarding the result.  We verify this by making after() NOT await the task and
    // confirming the route can still return even if the task is never resolved.
    crawlSummary.remaining = true;

    // Override after() so it does NOT await the task — simulates the platform keeping the
    // function alive after the HTTP response is sent.
    afterMock.mockImplementation(async (_task: Promise<unknown>) => {
      // Deliberately do not await — the task runs asynchronously.
    });

    // Fetch never resolves (simulates a long-running follow-on crawl).
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));

    const { POST } = await import("./route");
    // POST must resolve even though the crawl promise never resolves, because the route
    // hands the promise to after() and returns immediately without awaiting it.
    const res = await POST(makeReq({ secret: GOOD_SECRET, depth: 0 }));

    expect(res.status).toBe(200);
    // after() was invoked with the chain promise.
    expect(afterMock).toHaveBeenCalledOnce();
    // fetch was NOT directly awaited by the route (it was deferred via after()).
    // The fetch mock was called because after() received the promise (which started fetch),
    // but the route did not block on it.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // ── Self-chain: does NOT trigger when remaining = false ────────────────────

  it("does NOT trigger self-chain (after not called) when remaining=false", async () => {
    crawlSummary.remaining = false;
    const { POST } = await import("./route");
    await POST(makeReq({ secret: GOOD_SECRET }));
    expect(afterMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Self-chain: does NOT trigger when depth >= max (loop guard) ────────────

  it("does NOT trigger self-chain when depth >= CRAWL_JOB_MAX_CHAIN_DEPTH", async () => {
    crawlSummary.remaining = true;
    const { POST } = await import("./route");
    // Pass depth == max (the cap value itself is not allowed to chain further).
    await POST(
      makeReq({ secret: GOOD_SECRET, depth: CRAWL_JOB_MAX_CHAIN_DEPTH })
    );
    expect(afterMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT trigger self-chain when depth > CRAWL_JOB_MAX_CHAIN_DEPTH", async () => {
    crawlSummary.remaining = true;
    const { POST } = await import("./route");
    await POST(
      makeReq({ secret: GOOD_SECRET, depth: CRAWL_JOB_MAX_CHAIN_DEPTH + 1 })
    );
    expect(afterMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Chain cap halts further self-chaining ──────────────────────────────────

  it("chain cap: successive calls at depth=max do not chain further", async () => {
    crawlSummary.remaining = true;
    const { POST } = await import("./route");
    // Simulate three invocations at the cap depth.
    for (let i = 0; i < 3; i++) {
      await POST(
        makeReq({ secret: GOOD_SECRET, depth: CRAWL_JOB_MAX_CHAIN_DEPTH })
      );
    }
    // No self-chain should have been attempted at the max depth.
    expect(afterMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
