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
 * After auth, this handler triggers a crawl batch by POSTing to /api/_jobs/crawl on the
 * same deployment.  The crawl route handles self-chaining from there.  This tick is the
 * daily floor (DESIGN.md §3.5 "Vercel Cron (Hobby = once/day floor)").
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
import { type NextRequest, NextResponse } from "next/server";

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

  // ── Trigger a crawl batch by calling the crawl route ──
  const baseUrl =
    process.env.VERCEL_URL != null
      ? `https://${process.env.VERCEL_URL}`
      : INDEX_BASE_URL;
  const crawlUrl = `${baseUrl}/api/_jobs/crawl`;

  let crawlStatus: number;
  let crawlBody: unknown;
  try {
    // internal tick→crawl relay: trusted call to own deployment URL
    const res = await fetch(crawlUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-chain-depth": "0",
        "content-type": "application/json",
      },
      body: "{}",
    });
    crawlStatus = res.status;
    crawlBody = await res.json().catch(() => null);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `crawl relay failed: ${message}` },
      { status: 502 }
    );
  }

  if (crawlStatus !== 200) {
    return NextResponse.json(
      { ok: false, crawlStatus, crawlBody },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, crawlStatus, crawlBody });
}
