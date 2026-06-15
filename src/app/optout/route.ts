// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/optout/route.ts — opt-out / erasure (DESIGN.md §4.8). SECURITY-CRITICAL (PII erasure).
 *
 * POST /optout — erase an indexed WebID from EVERY served surface, with two proof-of-control paths
 * and NO account system:
 *
 *   PATH A (token) — present `Authorization: DPoP <access-token>` + a `DPoP: <proof>` header. When
 *     the DPoP-bound, asymmetric-only, proof-of-possession-verified token's `webid` claim
 *     canonicalises to the target WebID → IMMEDIATE erasure. A bare Bearer / symmetric token is
 *     rejected (lib/security/dpopVerifier.ts).
 *
 *   PATH B (challenge-response) — no token:
 *     1. POST { webid }            → 202 + a one-time `idx:optOutToken` nonce (TTL 24h, single-use).
 *        The user publishes `<webid> idx:optOutToken "<nonce>"` in their UPSTREAM profile.
 *     2. POST { webid, confirm:true } → the server fetches the profile via guardedFetch, and if the
 *        published token matches the live nonce, CONSUMES it (single-use) and erases.
 *
 * ERASURE is ONE atomic DB transaction over every surface (store.eraseWebId): the webid + child
 * tables + FTS + triple table + stats (decremented) + the doc/raw_rdf bytes, the inbox body redacted,
 * and a PERMANENT tombstone inserted — checked at all three gates (enqueue, fetch, projection).
 *
 * `no-store` on every response. runtime=nodejs — the verifier + guardedFetch need Node DNS;
 * boot-asserted.
 */

export const runtime = "nodejs";

// Boot assertion: fail closed if the runtime is not Node (security C1, H8). Path A's DPoP-proof
// crypto + Path B's guardedFetch both require node:dns / Node crypto; the edge runtime would bypass
// the DNS-pin SSRF guard on the profile fetch.
if (
  typeof process === "undefined" ||
  process.env.NEXT_RUNTIME === "edge" ||
  typeof process.env === "undefined"
) {
  throw new Error(
    "[solid-webid-index/optout] route.ts MUST run on the Node.js runtime (export const runtime = 'nodejs'). " +
      "Running on edge would bypass the DNS-pin SSRF guard on the opt-out profile fetch."
  );
}

import {
  INDEX_BASE_URL,
  OPTOUT_CLOCK_TOLERANCE_SEC,
  OPTOUT_NONCE_TTL_MS,
  OPTOUT_RATE_LIMIT_PER_IP_PER_HOUR,
  OPTOUT_TRUSTED_ISSUERS,
} from "@/lib/config";
import { parseProfile } from "@/lib/rdf/profile";
import { idx } from "@/lib/rdf/vocab";
import { DpopVerifyError, verifyDpopWebId } from "@/lib/security/dpopVerifier";
import { guardedFetch } from "@/lib/security/guardedFetch";
import { syntacticSsrfCheck } from "@/lib/security/syntacticSsrf";
import { makeStore } from "@/lib/store/pgStore";
import {
  CanonicalError,
  canonicalDocUrl,
  canonicalWebId,
} from "@/lib/url/canonical";

const ALLOW = "POST, OPTIONS";
const ONE_HOUR_MS = 60 * 60 * 1000;

const WRITE_CORS_ORIGINS = new Set(
  [process.env.PM_ORIGIN, INDEX_BASE_URL].filter(Boolean) as string[]
);

/** CORS headers for the write surface — reflect an allowlisted Origin (DESIGN.md §4.0). */
function writeCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": ALLOW,
    "Access-Control-Allow-Headers": "Accept, Content-Type, Authorization, DPoP",
    Vary: "Origin",
  };
  if (origin && WRITE_CORS_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** A JSON response with no-store + write CORS. */
function json(
  req: Request,
  status: number,
  body: unknown,
  extra: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...writeCorsHeaders(req),
      ...extra,
    },
  });
}

/** Best-effort client IP for the per-IP rate bucket (Vercel sets x-forwarded-for / x-real-ip). */
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

interface OptoutBody {
  webid?: unknown;
  confirm?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const now = Date.now();
  const allowLoopback = process.env.PSS_ALLOW_LOOPBACK === "1";
  const store = makeStore();

  // ── Per-IP abuse guard (consumed BEFORE any work / fetch / crypto) ──────────
  const ip = clientIp(req);
  const granted = await store.consumeRateBucket({
    key: `optout:${ip}`,
    limit: OPTOUT_RATE_LIMIT_PER_IP_PER_HOUR,
    windowMs: ONE_HOUR_MS,
    nowMs: now,
  });
  if (!granted) {
    return json(
      req,
      429,
      { error: "rate_limited" },
      { "Retry-After": String(Math.ceil(ONE_HOUR_MS / 1000)) }
    );
  }

  // ── PATH A — DPoP-bound access token ────────────────────────────────────────
  // Presence of an Authorization header selects Path A. The verifier rejects bare Bearer / symmetric
  // tokens and establishes proof-of-possession of the WebID — no challenge needed.
  if (req.headers.get("authorization")) {
    let result: Awaited<ReturnType<typeof verifyDpopWebId>>;
    try {
      result = await verifyDpopWebId(
        {
          authorization: req.headers.get("authorization") ?? undefined,
          dpop: req.headers.get("dpop") ?? undefined,
          // htu compares query/fragment-stripped, so the canonical endpoint URL is correct.
          method: "POST",
          url: `${INDEX_BASE_URL}/optout`,
        },
        {
          trustedIssuers: OPTOUT_TRUSTED_ISSUERS,
          clockToleranceSec: OPTOUT_CLOCK_TOLERANCE_SEC,
        }
      );
    } catch (err) {
      if (err instanceof DpopVerifyError) {
        return json(
          req,
          401,
          { error: "invalid_token", error_description: err.message },
          { "WWW-Authenticate": "DPoP" }
        );
      }
      throw err;
    }

    // Canonicalise the verified WebID → the erasure keys.
    let webid: string;
    let docUrl: string;
    try {
      webid = canonicalWebId(result.webid, { allowLoopback });
      docUrl = canonicalDocUrl(result.webid, { allowLoopback });
    } catch (err) {
      if (err instanceof CanonicalError) {
        return json(req, 400, { error: "invalid_webid" });
      }
      throw err;
    }

    await store.eraseWebId({
      webid,
      docUrl,
      reason: "opt-out",
      proof: "token",
    });
    return json(req, 200, { status: "erased", webid, path: "token" });
  }

  // ── PATH B — challenge-response (no token) ──────────────────────────────────
  let body: OptoutBody;
  try {
    body = (await req.json()) as OptoutBody;
  } catch {
    return json(req, 400, { error: "invalid_json" });
  }
  if (typeof body.webid !== "string" || body.webid.length === 0) {
    return json(req, 422, { error: "missing_webid" });
  }

  // Syntactic SSRF gate on the candidate WebID BEFORE any network I/O (no DNS on the request path).
  const ssrf = syntacticSsrfCheck(body.webid, { allowLoopback });
  if (!ssrf.ok) {
    return json(req, 422, { error: "invalid_webid", reason: ssrf.reason });
  }

  let webid: string;
  let docUrl: string;
  try {
    webid = canonicalWebId(body.webid, { allowLoopback });
    docUrl = canonicalDocUrl(body.webid, { allowLoopback });
  } catch (err) {
    if (err instanceof CanonicalError) {
      return json(req, 422, { error: "invalid_webid" });
    }
    throw err;
  }

  // Already tombstoned → idempotent success (the person is already erased).
  if (await store.isTombstoned({ webid, docUrl })) {
    return json(req, 200, { status: "already_erased", webid });
  }

  const wantConfirm = body.confirm === true;

  // ── Path B step 1: issue a one-time nonce → 202 ─────────────────────────────
  if (!wantConfirm) {
    const nonce = crypto.randomUUID();
    await store.issueOptoutNonce({
      webid,
      docUrl,
      nonce,
      nowMs: now,
      ttlMs: OPTOUT_NONCE_TTL_MS,
    });
    return json(req, 202, {
      status: "challenge_issued",
      webid,
      optOutToken: nonce,
      // The triple the user must publish on their WebID subject to confirm control.
      publish: {
        subject: webid,
        predicate: idx("optOutToken").value,
        object: nonce,
      },
      expiresInMs: OPTOUT_NONCE_TTL_MS,
      confirmWith: { webid: body.webid, confirm: true },
    });
  }

  // ── Path B step 2: confirm — fetch profile, match the published nonce, erase ─
  const live = await store.getLiveOptoutNonce(webid, now);
  if (!live) {
    return json(req, 409, {
      error: "no_live_challenge",
      error_description:
        "No live opt-out nonce for this WebID (never issued, expired, or already used). Request a new challenge.",
    });
  }

  // Fetch the upstream profile via the SSRF chokepoint and check for the published token.
  let published: boolean;
  try {
    published = await profilePublishesNonce({
      docUrl: live.docUrl,
      webid,
      nonce: live.nonce,
      allowLoopback,
    });
  } catch {
    return json(req, 502, {
      error: "profile_unreachable",
      error_description:
        "Could not fetch or parse the upstream profile to verify the published opt-out token.",
    });
  }
  if (!published) {
    return json(req, 403, {
      error: "token_not_published",
      error_description:
        "The opt-out token was not found on the WebID subject in the upstream profile.",
    });
  }

  // Atomically CONSUME the nonce (single-use) — only the call that wins erases. A concurrent
  // double-confirm grants at most one erasure.
  const consumed = await store.consumeOptoutNonce(webid, now);
  if (!consumed) {
    return json(req, 409, {
      error: "nonce_already_used",
      error_description: "This opt-out challenge has already been consumed.",
    });
  }

  await store.eraseWebId({
    webid,
    docUrl,
    reason: "opt-out",
    proof: "challenge",
  });
  return json(req, 200, { status: "erased", webid, path: "challenge" });
}

/**
 * Fetch the upstream WebID profile via {@link guardedFetch} and return true when it publishes
 * `<webid> idx:optOutToken "<nonce>"` on the WebID subject. The doc URL (fragment-stripped) is
 * fetched; the WebID subject (with #fragment) is the triple subject. Parsing goes through the
 * sanctioned `parseProfile` (capped, SSRF-safe — never a raw parser).
 */
async function profilePublishesNonce(opts: {
  docUrl: string;
  webid: string;
  nonce: string;
  allowLoopback: boolean;
}): Promise<boolean> {
  const { docUrl, webid, nonce, allowLoopback } = opts;
  const res = await guardedFetch(docUrl, { allowLoopback });
  if (res.status < 200 || res.status >= 300) return false;
  const dataset = await parseProfile({
    text: res.text,
    contentType: res.contentType,
    baseIri: res.finalUrl,
  });
  const optOutToken = idx("optOutToken").value;
  for (const quad of dataset) {
    if (
      quad.subject.value === webid &&
      quad.predicate.value === optOutToken &&
      quad.object.termType === "Literal" &&
      quad.object.value === nonce
    ) {
      return true;
    }
  }
  return false;
}

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: { ...writeCorsHeaders(req), Allow: ALLOW },
  });
}

function methodNotAllowed(req: Request): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Allow: ALLOW,
      ...writeCorsHeaders(req),
    },
  });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
