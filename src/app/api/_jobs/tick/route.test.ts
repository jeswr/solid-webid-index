// AUTHORED-BY Claude Opus 4.8
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — unit tests for /api/_jobs/tick/route.ts
 *
 * Tests:
 *  - Unauthenticated request → 401 (auth still rejects unauthenticated)
 *  - Wrong bearer token → 401 (fail-closed, no info leak)
 *  - Correct CRON_SECRET bearer → 202 Accepted returned immediately
 *  - /tick does NOT await the full crawl batch (returns before crawl resolves)
 *  - /tick schedules the crawl via after() (not by awaiting the fetch directly)
 *  - CRON_SECRET not configured → 500 (fail-closed)
 *  - timingSafeEqual: mismatched-length token → 401, not throw
 *
 * All tests run without a real network: global fetch and after() are mocked.
 *
 * VITEST NOTE: vi.mock() factories are hoisted to the top of the file.
 *
 * after() mock strategy: we mock `next/server` to capture the task passed to `after()`.
 * The mock can be configured per-test to either resolve immediately or block, letting us
 * verify that the route returns before the crawl completes.
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

// ─── Module mocks ─────────────────────────────────────────────────────────────

// afterMock is declared via vi.hoisted() so it is available inside the vi.mock() factory
// (which is hoisted to before any import statements by vitest's transform).
// The after() mock records the task and resolves it so downstream assertions can observe it.
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

const GOOD_SECRET = "tick-cron-secret-xyz789";

function makeReq(opts: { secret?: string | null }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.secret != null) {
    headers.authorization = `Bearer ${opts.secret}`;
  }
  return new NextRequest("http://localhost/api/_jobs/tick", {
    method: "GET",
    headers,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/api/_jobs/tick route", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let fetchMock: MockInstance;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CRON_SECRET = GOOD_SECRET;
    fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    afterMock.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it("rejects an unauthenticated request with 401", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeReq({ secret: null }));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token with 401", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeReq({ secret: "wrong-secret" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 for a mismatched-length token without throwing (timingSafeEqual guard)", async () => {
    // Validates the constant-time compare handles length mismatch gracefully.
    const aBuf = Buffer.from("abc");
    const bBuf = Buffer.from("abc");
    expect(timingSafeEqual(aBuf, bBuf)).toBe(true); // sanity: timingSafeEqual works
    const { GET } = await import("./route");
    const res = await GET(makeReq({ secret: "short" }));
    expect(res.status).toBe(401);
  });

  it("returns 500 when CRON_SECRET is not configured (fail-closed)", async () => {
    process.env.CRON_SECRET = undefined;
    const { GET } = await import("./route");
    const res = await GET(makeReq({ secret: GOOD_SECRET }));
    expect(res.status).toBe(500);
  });

  // ── Prompt return ─────────────────────────────────────────────────────────

  it("returns 202 Accepted immediately after a valid request", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeReq({ secret: GOOD_SECRET }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.scheduled).toBe(true);
  });

  it("does NOT await the full crawl batch before returning (prompt return)", async () => {
    // The key correctness property: /tick must return 202 immediately without blocking on
    // the crawl-batch response.  We simulate a never-resolving crawl to prove the route
    // returns before the crawl completes.

    let crawlStarted = false;
    let crawlResolved = false;

    // after() mock: records that the task started; does NOT await it (simulates platform
    // behaviour — the platform keeps the function alive asynchronously).
    afterMock.mockImplementation(async (task: Promise<unknown>) => {
      crawlStarted = true;
      // Intentionally do not await task here — we want to verify the route returns
      // before the task resolves.
      void task.then(() => {
        crawlResolved = true;
      });
    });

    // Fetch never resolves (simulates a long crawl).
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));

    const { GET } = await import("./route");
    const res = await GET(makeReq({ secret: GOOD_SECRET }));

    // Route returned with 202 even though the crawl is still pending.
    expect(res.status).toBe(202);
    // after() was called (crawl was scheduled).
    expect(afterMock).toHaveBeenCalledOnce();
    expect(crawlStarted).toBe(true);
    // The crawl has NOT resolved yet (we never-resolved the fetch above).
    expect(crawlResolved).toBe(false);
  });

  // ── after() is invoked for the crawl ─────────────────────────────────────

  it("schedules the crawl via after() (not by awaiting fetch directly)", async () => {
    const { GET } = await import("./route");
    await GET(makeReq({ secret: GOOD_SECRET }));
    // after() must be called exactly once with the crawl promise.
    expect(afterMock).toHaveBeenCalledOnce();
    // The afterMock (default impl) awaits the task, so fetch should have been called.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/_jobs\/crawl$/);
    expect((init.headers as Record<string, string>)["x-chain-depth"]).toBe("0");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${GOOD_SECRET}`
    );
  });

  it("unauthenticated requests do not schedule any crawl", async () => {
    const { GET } = await import("./route");
    await GET(makeReq({ secret: null }));
    expect(afterMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
