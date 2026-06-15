// AUTHORED-BY Claude Opus 4.8
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/crawl/triggerCrawl.ts — immediate bounded crawl trigger for the LDN inbox bead.
 *
 * When a new suggestion arrives via POST /inbox/, this helper fires an immediate crawl
 * by calling /api/_jobs/crawl on the same deployment.  It is a fire-and-forget: the
 * inbox handler returns 201 quickly while the crawl drains in a separate serverless
 * invocation.
 *
 * This is NOT a QStash call — it is a direct HTTP POST to the same deployment
 * (always HTTPS on Vercel) using the shared CRON_SECRET for authentication.  The
 * simplified scheduling model (DECISION ADDENDUM 2026-06-14) drops QStash in favour of
 * Vercel Cron + self-chaining; this helper extends that model to the inbox path.
 *
 * The allowlist in scripts/check-no-raw-fetch.mjs permits this file to call `fetch(`
 * for exactly this internal use (not an attacker-influenced URL).
 */

import { INDEX_BASE_URL, getCronSecret } from "../config.js";

/**
 * Fire a bounded immediate crawl against the current deployment.
 *
 * @param baseUrl  Override the base URL (defaults to INDEX_BASE_URL / VERCEL_URL).
 *                 Injected in tests so the unit test can point at a local mock server.
 *
 * Returns a Promise that resolves once the POST completes (or rejects on network error).
 * Callers that want fire-and-forget should call `void triggerCrawl()` and NOT await.
 */
export async function triggerCrawl(baseUrl?: string): Promise<void> {
  const secret = getCronSecret();
  const base =
    baseUrl ??
    (process.env.VERCEL_URL != null
      ? `https://${process.env.VERCEL_URL}`
      : INDEX_BASE_URL);
  const url = `${base}/api/_jobs/crawl`;

  // internal LDN-inbox→crawl relay: trusted call to own deployment URL
  await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "x-chain-depth": "0",
      "content-type": "application/json",
    },
    body: "{}",
  });
}
