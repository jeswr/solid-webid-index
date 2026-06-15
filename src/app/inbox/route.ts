// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * app/inbox/route.ts — the LDN suggest inbox (DESIGN.md §4.3). SECURITY-CRITICAL.
 *
 * POST /inbox/ — accept an AS2 (`as:Announce`, leniently `as:Offer`/`as:Add`) notification whose
 * `as:object` is a WebID to index. The ORDERED, fail-closed algorithm (every anti-amplification
 * control runs BEFORE any DB write):
 *
 *   1. Content-Type gate (JSON-LD / activity+json / Turtle) → else 415.
 *   2. 64 KiB body guard BEFORE JSON.parse / parseRdf (parser-bomb guard, C3) → else 413.
 *   3. Parse via the allowlisted AS2 loader (bundled @context, NEVER fetched) → malformed → 400.
 *   4. Extract `as:object` IRIs from EXPANDED quads via a typed accessor; require ≥1, ≤10 → else 422.
 *   5. Per-IP token bucket (immediate-crawl privileged to a LOW budget) → else 429 + Retry-After.
 *   6. For each candidate: SYNTACTIC SSRF gate (NO DNS on the request path) → invalid → skip.
 *   7. Canonicalise + dedup per candidate: tombstoned → 409; known live / cooldown → recorded,
 *      no new enqueue; unknown & valid → admit.
 *   8. Daily admission budget (global ceiling) gates each NEW admission → else degrade (skip enqueue).
 *   9. Per-suggestion node budget seeded; ONE `after()` crawl kick; persist notification (honour
 *      `Slug`) → 201 + Location.
 *
 * Anti-amplification — a fan-out bomb (one suggestion → many children) is provably bounded: the
 * suggestion seeds a SHARED `suggest_budget` of SUGGEST_BUDGET that ALL descendants CONSUME (the
 * crawler decrements it atomically), so at most SUGGEST_BUDGET total descendants are ever enqueued
 * regardless of fan-out — see lib/store/ports.ts tryConsumeSuggestBudget + the crawler.
 *
 * GET /inbox/ — `ldp:BasicContainer` + `as:Collection`, members via `ldp:contains`, Hydra paging,
 * honours `Prefer`. `Accept-Post` (on GET + OPTIONS) advertises exactly the parseable content types.
 * Client PUT/DELETE → 405 (container) — the inbox is append-only via POST.
 *
 * runtime=nodejs — guardedFetch (kicked via triggerCrawl→after) needs Node DNS; boot-asserted.
 */

export const runtime = "nodejs";

// Boot assertion: fail closed if the runtime is not Node (security C1, H8). guardedFetch on the
// crawl path it kicks requires node:dns; the edge runtime would bypass the DNS-pin SSRF guard.
if (
  typeof process === "undefined" ||
  process.env.NEXT_RUNTIME === "edge" ||
  typeof process.env === "undefined"
) {
  throw new Error(
    "[solid-webid-index/inbox] route.ts MUST run on the Node.js runtime (export const runtime = 'nodejs'). " +
      "Running on edge would bypass the DNS-pin SSRF guard on the crawl it kicks."
  );
}

import { after } from "next/server";

import {
  INBOX_PAGE_SIZE,
  INBOX_RATE_LIMIT_PER_IP_PER_HOUR,
  INDEX_BASE_URL,
  MAX_BYTES_INBOX,
  RESUGGEST_COOLDOWN_MS,
  SUGGEST_BUDGET,
} from "@/lib/config";
import { triggerCrawl } from "@/lib/crawl/triggerCrawl";
import { buildRdfResponse, serializeTurtle } from "@/lib/http/conneg";
import { ParseLimitError, RdfFetchError, parseSuggestion } from "@/lib/rdf/as2";
import { buildInboxContainerQuads } from "@/lib/rdf/inbox";
import { syntacticSsrfCheck } from "@/lib/security/syntacticSsrf";
import { makeStore } from "@/lib/store/pgStore";
import {
  CanonicalError,
  canonicalDocUrl,
  canonicalWebId,
} from "@/lib/url/canonical";
import { isUlid, ulid } from "@/lib/url/ulid";
import type { Quad } from "@rdfjs/types";

// ─── Constants ──────────────────────────────────────────────────────────────────

const INBOX_IRI = `${INDEX_BASE_URL}/inbox/`;

/** Max `as:object` candidates accepted per notification (DESIGN.md §4.3 step 3). */
const MAX_CANDIDATES = 10;

/** Default AS2 activity IRI for a stored notification when the parsed type is somehow absent. */
const AS2_ANNOUNCE = "https://www.w3.org/ns/activitystreams#Announce";

/** The parseable POST content types — advertised verbatim in `Accept-Post`. */
const ACCEPT_POST_TYPES = [
  "application/ld+json",
  "application/activity+json",
  "text/turtle",
] as const;
const ACCEPT_POST_HEADER = ACCEPT_POST_TYPES.join(", ");

/** Re-suggest cooldown window length (per-IP token bucket window = 1 hour). */
const IP_WINDOW_MS = 60 * 60 * 1000;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const ALLOW_CONTAINER = "GET, HEAD, OPTIONS, POST";

const WRITE_CORS_ORIGINS = new Set(
  [process.env.PM_ORIGIN, INDEX_BASE_URL].filter(Boolean) as string[]
);

// ─── CORS helpers ─────────────────────────────────────────────────────────────

/** CORS headers for the write surface — reflect an allowlisted Origin (DESIGN.md §4.0). */
function writeCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": ALLOW_CONTAINER,
    "Access-Control-Allow-Headers": "Accept, Content-Type, Slug",
    Vary: "Origin",
  };
  if (origin && WRITE_CORS_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Bare media type (no parameters), lowercased. */
function bareType(contentType: string | null): string {
  return contentType?.split(";")[0].trim().toLowerCase() ?? "";
}

/** True when the request advertises a parseable POST content type. */
function isParseablePostType(contentType: string | null): boolean {
  const t = bareType(contentType);
  return (ACCEPT_POST_TYPES as readonly string[]).includes(t);
}

/** Best-effort client IP for the per-IP token bucket (Vercel sets x-forwarded-for / x-real-ip). */
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** Today's UTC date key for the daily admission budget. */
function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** A plain-text refusal with status + write CORS, no body parsing leak. */
function refuse(
  req: Request,
  status: number,
  message: string,
  extra: Record<string, string> = {}
): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...writeCorsHeaders(req),
      ...extra,
    },
  });
}

/**
 * Read the request body as a CAPPED STREAM (security-critical — pre-buffer DoS guard, H).
 *
 * Reads from `req.body` (the ReadableStream) one chunk at a time, accumulating bytes. As SOON as the
 * running total would exceed `maxBytes`, it cancels the reader (releasing the underlying stream) and
 * returns `{ overLimit: true }` WITHOUT buffering the remainder — so a client that omits/understates
 * `Content-Length` and streams an arbitrarily large body can never force an unbounded read into
 * memory. The Content-Length header is never trusted as the bound.
 *
 * Only when the stream completes within the cap are the collected bytes decoded to UTF-8 text. The
 * byte count is exact (UTF-8 multibyte chars count fully). When `req.body` is null (no stream — some
 * runtimes/tests buffer eagerly), it falls back to `req.text()` and re-checks the byte length so the
 * cap still holds.
 */
async function readBodyCapped(
  req: Request,
  maxBytes: number
): Promise<{ text: string; overLimit: boolean }> {
  const body = req.body;
  if (!body) {
    // No stream available — fall back to a buffered read, but still enforce the byte cap.
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      return { text: "", overLimit: true };
    }
    return { text, overLimit: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Over the cap — stop reading and release the stream WITHOUT buffering the rest.
        await reader.cancel().catch(() => {});
        return { text: "", overLimit: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return { text: Buffer.concat(chunks).toString("utf8"), overLimit: false };
}

/**
 * Re-serialise the parsed dataset to a CANONICAL Turtle body for storage — never echo the attacker's
 * raw bytes (DESIGN.md §2.3 M5). Built from the parsed quads via the house serialiser (never
 * hand-concatenated). Returns "" if serialisation fails (the notification is still recorded).
 */
async function canonicalSerialise(dataset: Iterable<unknown>): Promise<string> {
  try {
    const quads: Quad[] = [];
    for (const quad of dataset) quads.push(quad as Quad);
    return await serializeTurtle(quads);
  } catch {
    return "";
  }
}

// ─── POST /inbox/ ─────────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  const now = Date.now();
  const allowLoopback = process.env.PSS_ALLOW_LOOPBACK === "1";

  // ── 1. Content-Type gate → 415 ──────────────────────────────────────────────
  const contentType = req.headers.get("content-type");
  if (!isParseablePostType(contentType)) {
    return refuse(
      req,
      415,
      `Unsupported Media Type. Accept-Post: ${ACCEPT_POST_HEADER}`,
      { "Accept-Post": ACCEPT_POST_HEADER }
    );
  }

  // ── 2. 64 KiB body guard BEFORE parse (parser-bomb guard, C3) → 413 ─────────
  // The Content-Length header is advisory only — a client may understate or omit it. We do NOT trust
  // it as the size bound. Instead read the body as a CAPPED STREAM: accumulate chunks and abort the
  // moment the running total exceeds MAX_BYTES_INBOX, releasing the reader so the rest of the body is
  // NEVER buffered (a lying/absent Content-Length cannot force an unbounded read into memory — H).
  // A grossly-overstated Content-Length is still rejected up-front as a cheap early-out.
  const declaredLen = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BYTES_INBOX) {
    return refuse(req, 413, "Payload Too Large (Content-Length over 64 KiB).");
  }
  let bodyText: string;
  try {
    const capped = await readBodyCapped(req, MAX_BYTES_INBOX);
    if (capped.overLimit) {
      return refuse(req, 413, "Payload Too Large (body over 64 KiB).");
    }
    bodyText = capped.text;
  } catch {
    return refuse(req, 400, "Could not read request body.");
  }

  // ── 3. Parse via the allowlisted AS2 loader (NEVER fetch remote @context) → 400 ──
  let parsed: Awaited<ReturnType<typeof parseSuggestion>>;
  try {
    parsed = await parseSuggestion({
      text: bodyText,
      contentType,
      baseIri: INBOX_IRI,
    });
  } catch (err) {
    if (err instanceof ParseLimitError) {
      return refuse(req, 413, "Notification exceeds the parser quad cap.");
    }
    if (err instanceof RdfFetchError) {
      return refuse(req, 400, `Malformed notification: ${err.message}`);
    }
    return refuse(req, 400, "Malformed notification (could not parse RDF).");
  }

  // ── 3b. AS2 activity-type gate (M2 — type bypass) → 422 ─────────────────────
  // Reject BEFORE processing any candidate when the parsed payload carries NONE of the accepted AS2
  // activity types (as:Announce / as:Offer / as:Add). extractSuggestion only harvests as:object from
  // accepted-activity subjects, so an untyped payload also yields zero candidates — but we gate on
  // the type explicitly so the refusal is unambiguous (arbitrary non-activity RDF cannot enqueue).
  if (parsed.activityTypes.length === 0) {
    return refuse(
      req,
      422,
      "Unprocessable: notification is not a recognised AS2 activity (expected as:Announce / as:Offer / as:Add)."
    );
  }

  // ── 4. Extract `as:object` candidates → require ≥1, ≤10 → 422 ────────────────
  const candidates = parsed.objectIris;
  if (candidates.length === 0) {
    return refuse(
      req,
      422,
      "Unprocessable: notification carries no `as:object` WebID."
    );
  }
  if (candidates.length > MAX_CANDIDATES) {
    return refuse(
      req,
      422,
      `Unprocessable: too many as:object candidates (max ${MAX_CANDIDATES}).`
    );
  }

  const store = makeStore();

  // ── 5. Per-IP token bucket (immediate-crawl privileged to a LOW budget) → 429 ──
  // Consumed BEFORE any per-candidate work / DB write — a flood from one IP is shed at the door.
  const ip = clientIp(req);
  const ipGranted = await store.consumeRateBucket({
    key: `ip:${ip}`,
    limit: INBOX_RATE_LIMIT_PER_IP_PER_HOUR,
    windowMs: IP_WINDOW_MS,
    nowMs: now,
  });
  if (!ipGranted) {
    const retryAfter = Math.ceil(IP_WINDOW_MS / 1000);
    return refuse(req, 429, "Too Many Requests (per-IP suggestion limit).", {
      "Retry-After": String(retryAfter),
    });
  }

  // ── 6–9. Per-candidate: syntactic SSRF → canonicalise → dedup → admit ───────
  const accepted: string[] = []; // canonical WebIDs newly admitted (→ enqueued)
  const alreadyLive: string[] = []; // canonical WebIDs already indexed (→ 200 hint)
  const deferred: string[] = []; // valid+unknown WebIDs NOT enqueued (daily budget spent → drained later)
  let sawTombstoned = false;

  for (const raw of candidates) {
    // 6. SYNTACTIC SSRF gate — NO DNS on the request path (M4).
    const ssrf = syntacticSsrfCheck(raw, { allowLoopback });
    if (!ssrf.ok) continue; // a non-public / malformed candidate is silently dropped

    // 7. Canonicalise (the dedup key). canonicalWebId keeps #fragment; canonicalDocUrl strips it.
    let webid: string;
    let docUrl: string;
    try {
      webid = canonicalWebId(raw, { allowLoopback });
      docUrl = canonicalDocUrl(raw, { allowLoopback });
    } catch (err) {
      if (err instanceof CanonicalError) continue;
      throw err;
    }

    const status = await store.suggestionStatus({
      webid,
      docUrl,
      nowMs: now,
      cooldownMs: RESUGGEST_COOLDOWN_MS,
    });

    if (status === "tombstoned") {
      sawTombstoned = true;
      continue; // opted-out / erased — never re-crawl
    }
    if (status === "live") {
      alreadyLive.push(webid);
      continue; // already indexed — record but do not re-enqueue
    }
    if (status === "cooldown") {
      // Freshly-terminal within the 7-day cooldown — neither error nor re-enqueue.
      alreadyLive.push(webid);
      continue;
    }

    // 8. Daily admission budget — global ceiling on NEW admissions (graceful degradation: when the
    //    budget is spent the candidate is recorded in the notification but not enqueued today; the
    //    daily cron re-drains). Consumed atomically so concurrent invocations cannot over-admit.
    const dailyGranted = await store.consumeRateBucket({
      key: `admit:${dayKey(now)}`,
      limit: dailyAdmissionLimit(),
      windowMs: ONE_DAY_MS,
      nowMs: now,
    });
    if (!dailyGranted) {
      // Budget exhausted — do NOT enqueue (anti-amplification global ceiling). The candidate is
      // valid + unknown, so we DEFER it: it is persisted (below) on a notification marked
      // processed=FALSE, and the daily drain (the cron) admits it later. Tracked separately from
      // "no valid candidate" so the response is an honest deferred status, not a misleading 422.
      deferred.push(webid);
      continue;
    }

    // 9. Admit: enqueue the doc with a SHARED suggestion-root budget so the whole subtree is bounded.
    //    root_seed = the canonical doc URL of THIS suggestion; the crawler consumes the shared
    //    budget atomically on every descendant enqueue → at most SUGGEST_BUDGET total descendants.
    await store.enqueue(docUrl, {
      depth: 0,
      rootSeed: docUrl,
      suggestBudget: SUGGEST_BUDGET,
      webid,
      source: "inbox",
      nextEligibleAt: 0,
    });
    accepted.push(webid);
  }

  // ── No new admissions: deferred-budget / dedup-only / no-valid-candidate outcomes ───────────────
  if (accepted.length === 0) {
    // Daily admission budget was exhausted but there ARE valid, unknown candidates → DEFER, do not
    // drop. Persist the notification with its candidates marked NON-enqueued (processed=FALSE) so the
    // daily drain admits them later, and answer with an explicit deferred status (202 Accepted). This
    // matches the documented graceful-degradation behaviour (no misleading 422, no silent drop).
    if (deferred.length > 0) {
      const id = pickNotificationId(req, now);
      const activity = parsed.activityTypes[0] ?? AS2_ANNOUNCE;
      const canonicalBody = await canonicalSerialise(parsed.dataset);
      await store.recordNotification({
        id,
        receivedAt: now,
        actor: parsed.actor,
        activity,
        body: canonicalBody,
        objectIris: deferred,
        processed: false,
      });
      const location = `${INBOX_IRI}${id}`;
      const retryAfter = Math.ceil(ONE_DAY_MS / 1000);
      return new Response(
        "Accepted (deferred): the daily admission budget is exhausted; the suggestion is recorded and will be admitted by the daily drain.",
        {
          status: 202,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Location: location,
            "Retry-After": String(retryAfter),
            "Cache-Control": "no-store",
            ...writeCorsHeaders(req),
          },
        }
      );
    }
    if (sawTombstoned && alreadyLive.length === 0) {
      // Every valid candidate was tombstoned/opted-out → 409 Conflict (DESIGN.md §4.3).
      return refuse(
        req,
        409,
        "Conflict: the suggested WebID has opted out of indexing."
      );
    }
    if (alreadyLive.length > 0) {
      // Already indexed (or in cooldown) → 200 with a related link, no new resource.
      return new Response(null, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          Link: alreadyLive.map((w) => `<${w}>; rel="related"`).join(", "),
          ...writeCorsHeaders(req),
        },
      });
    }
    // No candidate survived the syntactic SSRF gate → 422 (none was a public https WebID).
    return refuse(
      req,
      422,
      "Unprocessable: no `as:object` was a public https WebID-shaped IRI."
    );
  }

  // ── Persist the notification (honour Slug) + ONE after() crawl kick → 201 ───
  const id = pickNotificationId(req, now);
  const activity = parsed.activityTypes[0] ?? AS2_ANNOUNCE;
  const canonicalBody = await canonicalSerialise(parsed.dataset);

  await store.recordNotification({
    id,
    receivedAt: now,
    actor: parsed.actor,
    activity,
    body: canonicalBody,
    objectIris: accepted,
  });

  // ONE crawl kick via next/server `after()` — NOT QStash, NOT a blocking inline waitUntil. `after()`
  // keeps the function alive until the kick fires after the 201 is flushed (a bare `void` could be
  // cancelled the moment the response is sent). triggerCrawl posts to /api/_jobs/crawl on this
  // deployment (an internal trusted HTTPS relay; allowlisted in check:fetch). Errors are swallowed —
  // the daily Vercel Cron is the fallback drain (§3.5).
  after(async () => {
    try {
      await triggerCrawl();
    } catch {
      // fire-and-forget; daily cron is the fallback.
    }
  });

  const location = `${INBOX_IRI}${id}`;
  return new Response(null, {
    status: 201,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      ...writeCorsHeaders(req),
    },
  });
}

/** The global daily admission ceiling. Kept conservative; configurable via the same env knob path. */
function dailyAdmissionLimit(): number {
  const v = Number(process.env.INBOX_DAILY_ADMISSION_BUDGET ?? "");
  return Number.isFinite(v) && v > 0 ? v : 5_000;
}

/**
 * Pick the notification id, honouring a client `Slug` when it is a syntactically-valid ULID (LDN
 * §SHOULD honour Slug). A malformed/empty Slug falls back to a fresh server-minted ULID — we never
 * trust an arbitrary client string as a path segment (path-traversal / collision guard).
 */
function pickNotificationId(req: Request, now: number): string {
  const slug = req.headers.get("slug")?.trim();
  if (slug && isUlid(slug.toUpperCase())) {
    return slug.toUpperCase();
  }
  return ulid(now);
}

// ─── GET /inbox/ ──────────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  return handleGet(req, false);
}

export async function HEAD(req: Request): Promise<Response> {
  return handleGet(req, true);
}

async function handleGet(req: Request, isHead: boolean): Promise<Response> {
  const url = new URL(req.url);
  const pageParam = url.searchParams.get("page");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);

  // Honour `Prefer` (LDP §7.2): a client may ask for a minimal container (no containment triples).
  const prefer = req.headers.get("prefer") ?? "";
  const includeContainment = !prefersMinimalContainer(prefer);

  const store = makeStore();
  const { rows, nextCursor, total } = await store.listNotifications({
    limit: INBOX_PAGE_SIZE,
    cursor,
  });

  const members = rows.map((r) => ({
    iri: `${INBOX_IRI}${r.id}`,
    activityType: r.activity,
    receivedAt: r.receivedAt,
  }));

  const viewIri = page > 1 ? `${INBOX_IRI}?page=${page}` : INBOX_IRI;
  const firstIri = INBOX_IRI;
  const nextIri = nextCursor
    ? `${INBOX_IRI}?page=${page + 1}&cursor=${encodeURIComponent(nextCursor)}`
    : null;
  const previousIri = page > 1 ? `${INBOX_IRI}?page=${page - 1}` : null;

  const quads = buildInboxContainerQuads({
    inboxIri: INBOX_IRI,
    members,
    totalItems: total,
    viewIri,
    firstIri,
    nextIri,
    previousIri,
    itemsPerPage: INBOX_PAGE_SIZE,
    includeContainment,
  });

  const extraHeaders: Record<string, string> = {
    "Accept-Post": ACCEPT_POST_HEADER,
    Allow: ALLOW_CONTAINER,
    "Cache-Control": "no-store",
    // Advertise that this resource type is an LDP container + the AS2 collection.
    Link: [
      `<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"`,
      `<http://www.w3.org/ns/ldp#Container>; rel="type"`,
    ].join(", "),
    // honouring Prefer changes the body → advertise it in Vary.
    Vary: "Accept, Prefer",
  };

  const response = (await buildRdfResponse({
    request: req,
    quads,
    status: 200,
    htmlBranch: "turtle", // the inbox is RDF-only — a browser gets Turtle, never an empty 200.
    extraHeaders,
  })) as Response;

  if (isHead) {
    return new Response(null, {
      status: response.status,
      headers: response.headers,
    });
  }
  return response;
}

/** True when a `Prefer` header asks for a minimal container (omit containment). */
function prefersMinimalContainer(prefer: string): boolean {
  const p = prefer.toLowerCase();
  // include=PreferMinimalContainer, or omit=PreferContainment / ldp#PreferContainment.
  if (p.includes("preferminimalcontainer")) return true;
  if (p.includes("omit") && p.includes("prefercontainment")) return true;
  return false;
}

// ─── OPTIONS + method guards ────────────────────────────────────────────────────

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      ...writeCorsHeaders(req),
      Allow: ALLOW_CONTAINER,
      "Accept-Post": ACCEPT_POST_HEADER,
    },
  });
}

/** Client PUT/DELETE/PATCH on the append-only container → 405 (DESIGN.md §4.3). */
function containerMethodNotAllowed(req: Request): Response {
  return new Response(
    "Method Not Allowed: the suggest inbox is append-only (POST a notification).",
    {
      status: 405,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Allow: ALLOW_CONTAINER,
        "Accept-Post": ACCEPT_POST_HEADER,
        ...writeCorsHeaders(req),
      },
    }
  );
}

export const PUT = containerMethodNotAllowed;
export const DELETE = containerMethodNotAllowed;
export const PATCH = containerMethodNotAllowed;
