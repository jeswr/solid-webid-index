// AUTHORED-BY Claude Opus 4.8
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * /api/_jobs/tick — Vercel Cron entry-point (once per day, DESIGN.md §3.5).
 *
 * Vercel Cron invokes this route on the schedule declared in vercel.json:
 *   `{ "path": "/api/_jobs/tick", "schedule": "0 2 * * *" }`
 *
 * Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on each cron invocation
 * (Vercel Cron Authentication — the secret is injected into the deployment at build time).
 * We verify it here with constant-time compare; an invalid or missing secret → 401.
 *
 * After auth, this handler schedules a crawl batch via Next.js `after()` and returns 202
 * Accepted immediately.  The crawl route handles self-chaining from there.  This tick is the
 * daily floor (DESIGN.md §3.5 "Vercel Cron (Hobby = once/day floor)").
 *
 * IMPORTANT — prompt return via `after()`.
 *   The previous design awaited the full crawl-batch response before returning, which meant
 *   the cron HTTP request could time out if the crawl budget ran long.  Instead we now:
 *   1. Verify auth.
 *   2. Schedule the crawl POST via `after()` so the platform keeps the function alive.
 *   3. Return 202 Accepted immediately — the cron caller gets a fast, reliable response.
 *   `after()` is the platform-correct mechanism: Vercel honours it via waitUntil, so the
 *   crawl fires reliably even though the HTTP response has already been sent.
 *
 * Runtime: nodejs (load-bearing — uses Node crypto for constant-time compare; boot assertion
 * enforces this so the route fails closed on misconfiguration).
 */
export const runtime = "nodejs";

// Boot assertion: fail closed if we are somehow running on the edge runtime.
if (
  typeof process === "undefined" ||
  process.env.NEXT_RUNTIME === "edge" ||
  typeof process.env === "undefined"
) {
  throw new Error(
    "[solid-webid-index/tick] route.ts MUST run on the Node.js runtime. " +
      "Edge runtime would bypass the Node crypto constant-time compare."
  );
}

import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse, after } from "next/server";

import { CRON_SECRET_ENV, INDEX_BASE_URL, getCronSecret } from "@/lib/config";

// ─── Auth ─────────────────────────────────────────────────────────────────────

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const buf = Buffer.from(a);
    timingSafeEqual(buf, buf); // constant-time no-op to avoid short-circuit
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function verifyBearer(req: NextRequest, secret: string): boolean {
  try {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return false;
    const token = auth.slice("Bearer ".length);
    return timingSafeStringEqual(token, secret);
  } catch {
    return false;
  }
}

// ─── Crawl trigger ────────────────────────────────────────────────────────────

/**
 * POST to /api/_jobs/crawl on the same deployment to kick off a crawl batch.
 *
 * This is an internal trusted call (own deployment URL over HTTPS — not attacker-influenced).
 * The allowlist in scripts/check-no-raw-fetch.mjs permits this file to call `fetch(` for
 * exactly this internal tick→crawl relay use.
 */
async function fireCrawl(secret: string, baseUrl: string): Promise<void> {
  const crawlUrl = `${baseUrl}/api/_jobs/crawl`;
  try {
    // internal tick→crawl relay: trusted call to own deployment URL
    await fetch(crawlUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-chain-depth": "0",
        "content-type": "application/json",
      },
      body: "{}",
    });
  } catch {
    // after() is fire-and-forget relative to the cron caller; the daily cron is the
    // fallback if this invocation fails (DESIGN.md §3.5).
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── Auth: verify Vercel Cron bearer token ──
  let secret: string;
  try {
    secret = getCronSecret();
  } catch {
    return NextResponse.json(
      { error: `${CRON_SECRET_ENV} not configured` },
      { status: 500 }
    );
  }

  if (!verifyBearer(req, secret)) {
    return new NextResponse(null, { status: 401 });
  }

  // ── Schedule crawl via after() and return promptly ──
  //
  // We do NOT await the crawl here.  Awaiting the full crawl-batch response would block
  // the cron HTTP connection for the entire crawl budget and risk a timeout.  Instead:
  //  - `after()` registers the crawl POST with the platform's waitUntil mechanism so the
  //    function is kept alive until the crawl completes even after the HTTP response is sent.
  //  - We return 202 Accepted immediately so the Vercel Cron scheduler gets a fast response.
  const baseUrl =
    process.env.VERCEL_URL != null
      ? `https://${process.env.VERCEL_URL}`
      : INDEX_BASE_URL;

  after(fireCrawl(secret, baseUrl));

  return NextResponse.json({ ok: true, scheduled: true }, { status: 202 });
}
