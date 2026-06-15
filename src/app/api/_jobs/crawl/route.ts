// AUTHORED-BY Claude Opus 4.8
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * /api/_jobs/crawl — bounded crawl batch job.
 *
 * Authentication (security H5 — DESIGN.md §5):
 *   Accepts one of two valid credentials:
 *   1. `Authorization: Bearer <CRON_SECRET>` — Vercel Cron or the /tick relay sends this.
 *   2. `X-Chain-Depth: N` + `Authorization: Bearer <CRON_SECRET>` — self-chain invocations
 *      pass the same bearer token (the URL is always HTTPS on Vercel; the token is never
 *      attacker-controlled).  The chain-depth header caps cascade depth.
 *
 *   Both paths use `timingSafeEqual` for constant-time comparison (DESIGN.md §5 security H5).
 *   A missing / wrong credential → 401 (no body to avoid info leak).
 *   An absent CRON_SECRET env var → 500 at boot (fail-closed invariant).
 *
 * Self-chaining (DESIGN.md §3.5):
 *   When the batch summary signals `remaining === true` AND the current chain depth is below
 *   `CRAWL_JOB_MAX_CHAIN_DEPTH`, this handler schedules a follow-on fetch to itself via
 *   Next.js `after()` before returning, passing `X-Chain-Depth: N+1`.  This drains the
 *   frontier across invocations without requiring QStash (which is the simplified scheduling
 *   model — see DECISION ADDENDUM 2026-06-14 in docs/DESIGN.md).  The daily Vercel Cron
 *   (→ /api/_jobs/tick) resets the chain.
 *
 *   IMPORTANT — `after()` is the platform-correct mechanism here (not a bare `void` call).
 *   Vercel (and compatible runtimes) honour `after()` / `waitUntil` so the serverless
 *   function is kept alive until the scheduled callback completes.  A bare `void` promise
 *   would be eligible for cancellation the moment the HTTP response is flushed, meaning the
 *   frontier could silently stall after the first batch.
 *
 * Runtime: nodejs (load-bearing — guardedFetch requires Node DNS; boot assertion enforces this).
 */
export const runtime = "nodejs";

// Boot assertion: fail closed if the runtime is not Node (security C1, H8).
if (
  typeof process === "undefined" ||
  process.env.NEXT_RUNTIME === "edge" ||
  typeof process.env === "undefined"
) {
  throw new Error(
    "[solid-webid-index/crawl] route.ts MUST run on the Node.js runtime (export const runtime = 'nodejs'). " +
      "Running on edge would bypass the DNS-pin SSRF guard."
  );
}

import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse, after } from "next/server";

import {
  CRAWL_JOB_MAX_CHAIN_DEPTH,
  CRON_SECRET_ENV,
  INDEX_BASE_URL,
  getCronSecret,
} from "@/lib/config";
import { runCrawlBatch } from "@/lib/crawl/crawler";
import { PgStore, createNeonExecutor } from "@/lib/store/pgStore";

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/** Constant-time comparison of two ASCII strings (prevents timing oracle on the secret). */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Lengths differ — still do a comparison to avoid short-circuit timing leak.
    // We pad with the same string so timingSafeEqual doesn't throw on mismatched lengths.
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(a); // same as a — result is always true but we discard it
    timingSafeEqual(aBuf, bBuf);
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Verify a request bears a valid CRON_SECRET bearer token.
 * Returns true when the `Authorization: Bearer <secret>` header matches.
 * Uses constant-time compare; fails closed on any error.
 */
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

// ─── Store singleton (per cold-start, not per request) ───────────────────────

let _store: PgStore | null = null;

function getStore(): PgStore {
  if (_store) return _store;
  const connectionString = process.env.DATABASE_URL ?? "";
  if (!connectionString) {
    throw new Error(
      "[solid-webid-index/crawl] DATABASE_URL env var is not set"
    );
  }
  _store = new PgStore(createNeonExecutor(connectionString));
  return _store;
}

// ─── Self-chain trigger ───────────────────────────────────────────────────────

/**
 * Fire-and-forget a follow-on crawl invocation to drain remaining frontier work.
 *
 * This is an INTERNAL trusted call to our own deployment URL over HTTPS.
 * It is NOT an attacker-influenced URL and does NOT go through guardedFetch
 * (which is for crawling external WebID documents — see DESIGN.md §5).
 *
 * The allowlist in scripts/check-no-raw-fetch.mjs permits this file to call
 * `fetch(` for exactly this internal self-chain use.
 *
 * Security properties:
 *  - Target URL is always the same deployment (VERCEL_URL / INDEX_BASE_URL) — not attacker-supplied.
 *  - The same CRON_SECRET bearer token is used, so only our own handler can process the request.
 *  - HTTPS is always in play on Vercel deployments.
 *  - Depth cap (CRAWL_JOB_MAX_CHAIN_DEPTH) prevents unbounded cascades.
 */
async function triggerSelfChain(
  secret: string,
  nextDepth: number,
  baseUrl: string
): Promise<void> {
  const url = `${baseUrl}/api/_jobs/crawl`;
  try {
    // internal self-chain: trusted call to own deployment URL
    await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-chain-depth": String(nextDepth),
        "content-type": "application/json",
      },
      body: "{}",
    });
  } catch {
    // Fire-and-forget: ignore failures — the daily cron is the fallback (§3.5).
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth ──
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

  // ── Chain depth ──
  const depthHeader = req.headers.get("x-chain-depth");
  const chainDepth = depthHeader != null ? Number.parseInt(depthHeader, 10) : 0;
  const depth = Number.isFinite(chainDepth) && chainDepth >= 0 ? chainDepth : 0;

  // ── Run crawl batch ──
  let summary: Awaited<ReturnType<typeof runCrawlBatch>>;
  try {
    const store = getStore();
    summary = await runCrawlBatch(store);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // ── Self-chain if more work remains and chain depth has not hit the cap ──
  if (summary.remaining && depth < CRAWL_JOB_MAX_CHAIN_DEPTH) {
    const baseUrl =
      process.env.VERCEL_URL != null
        ? `https://${process.env.VERCEL_URL}`
        : INDEX_BASE_URL;
    // Schedule the follow-on crawl via next/server `after()`.
    // `after()` registers work with the platform's waitUntil mechanism so the serverless
    // function is kept alive until the callback completes even after the HTTP response is
    // sent.  A bare `void` promise would be eligible for cancellation the moment the
    // response is flushed, causing the frontier to stall silently after the first batch.
    after(() => triggerSelfChain(secret, depth + 1, baseUrl));
  }

  return NextResponse.json({ ok: true, chainDepth: depth, summary });
}
