// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/.well-known/health/route.ts — liveness + readiness probe (DESIGN.md §4.9).
 *
 * GET /.well-known/health → 200 JSON
 *   { status, entries, triples, queueDepth, version }
 *
 * The RDF dataset stats (§4.2 VoID) remain the single canonical source for the
 * counts — this endpoint surfaces a SUBSET of them as plain JSON for cheap
 * machine probes (uptime monitors, the consumer client's `checkHealth()`), and
 * advertises the RDF description via `Link: <…/void>; rel="describedby"` so a
 * client that wants the full, content-negotiated stats follows the link rather
 * than parsing this JSON (DESIGN.md §4.9 sw L4).
 *
 * `status` is "ok" when the store responds, "degraded" when a stats read throws
 * (the function is up but the database is unreachable) — a probe distinguishes
 * "function cold/erroring" from "DB down" without a 5xx that trips alerting on a
 * transient blip.  Either way the body is JSON and the HTTP status is 200 (the
 * function answered); a monitor keys on the `status` field, not the HTTP code,
 * so a DB blip never pages as a hard outage.
 *
 * `no-store` — never cache a liveness probe (DESIGN.md §4.0).
 *
 * runtime=nodejs — makeStore needs Node (the Neon/pglite driver).
 */

export const runtime = "nodejs";

import { INDEX_BASE_URL } from "@/lib/config";
import { makeStore } from "@/lib/store/pgStore";

const ALLOW = "GET, HEAD, OPTIONS";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOW,
  "Access-Control-Allow-Headers": "Accept",
};

/** App version — surfaced so a probe can confirm which build is live. */
const VERSION = process.env.npm_package_version ?? "0.1.0";

interface HealthBody {
  status: "ok" | "degraded";
  /** void:entities — number of served WebID entries. */
  entries: number;
  /** void:triples — total served triples. */
  triples: number;
  /** Live crawl frontier depth (pending + claimed). */
  queueDepth: number;
  version: string;
}

/**
 * Gather the health snapshot.  A store/DB failure degrades gracefully to
 * `status: "degraded"` with zeroed counts rather than throwing a 5xx — the
 * function is alive even when the database is briefly unreachable.
 */
async function snapshot(): Promise<HealthBody> {
  try {
    const store = makeStore();
    // Both reads are O(1)/O(few-rows): getStats reads pre-aggregated counters,
    // countFrontier is a single indexed COUNT over the small pending/claimed set.
    const [stats, queueDepth] = await Promise.all([
      store.getStats(),
      store.countFrontier(),
    ]);
    return {
      status: "ok",
      entries: stats.entities,
      triples: stats.triples,
      queueDepth,
      version: VERSION,
    };
  } catch {
    // DB unreachable / cold — the function answered, so this is a 200 with a
    // "degraded" status field (a monitor keys on the field, not the HTTP code).
    return {
      status: "degraded",
      entries: 0,
      triples: 0,
      queueDepth: 0,
      version: VERSION,
    };
  }
}

function jsonHeaders(): Record<string, string> {
  return {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    // The RDF dataset description is the canonical source for the stats.
    Link: `<${INDEX_BASE_URL}/.well-known/void>; rel="describedby"`,
    "Cache-Control": "no-store",
  };
}

async function handle(isHead: boolean): Promise<Response> {
  const body = await snapshot();
  return new Response(isHead ? null : JSON.stringify(body), {
    status: 200,
    headers: jsonHeaders(),
  });
}

export async function GET(): Promise<Response> {
  return handle(false);
}

export async function HEAD(): Promise<Response> {
  return handle(true);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, Allow: ALLOW },
  });
}

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      ...CORS_HEADERS,
      Allow: ALLOW,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
