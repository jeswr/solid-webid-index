// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/security/guardedFetch.ts — THE SINGLE EGRESS CHOKEPOINT.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * This is the ONLY permitted path for fetching an attacker-influenced URL in this codebase.
 * Inbox candidate WebIDs, crawler-followed links, catalog seeds — every external dereference MUST go
 * through `guardedFetch`. Calling the global `fetch`, `undici.fetch`, or `undici.request` directly
 * for an external/attacker-influenced URL is FORBIDDEN; `scripts/check-no-raw-fetch.mjs`
 * (`npm run check:fetch`) fails the build if any other source file does so. (docs/DESIGN.md §5.)
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Defence-in-depth, every step fails closed (docs/DESIGN.md §5 ordered algorithm):
 *   1. Boot assertion — Node runtime + `node:dns.lookup` present (DNS-pin needs Node; fail at load).
 *   2. Parse URL → scheme gate (https-only in prod; http only under `allowLoopback` for dev/tests).
 *   3. Port gate (443 only; +80 for http under loopback) → reject userinfo.
 *   4. Hostname denylist (cloud-internal names) + alternate-IP-encoding normalisation.
 *   5. DNS resolve ALL records → classify EVERY one as public; pin the first validated IP.
 *   6. undici `Agent({ connect: { lookup: pinnedLookup(ip) } })` so the socket connects to the
 *      PINNED IP — a hostile resolver cannot rebind between the guard and the connect (TOCTOU).
 *   7. Single AbortController + timeout over fetch + redirects + body.
 *   8. `redirect: "manual"` loop (≤ MAX_REDIRECTS); EACH hop is re-classified + re-pinned; a
 *      scheme downgrade (https→http) is rejected; a redirect loop is rejected.
 *   9. Content-type allowlist on the FINAL response (the RDF set; `text/html`/RDFa excluded).
 *  10. Bounded body read (stream + abort past the cap).
 */
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  FETCH_RDF_ACCEPT,
  FETCH_RDF_CONTENT_TYPES,
  FETCH_TIMEOUT_MS,
  FETCH_USER_AGENT,
  MAX_BYTES_PROFILE,
  MAX_REDIRECTS,
} from "../config";
import { BodyTooLargeError, readBoundedBytes } from "./body";
import { type LookupAddress, assertNotSsrf, pinnedLookup } from "./ssrf";

export { SsrfError } from "./ssrf";
export { BodyTooLargeError };

/** Raised by guardedFetch for non-SSRF failures (bad scheme/port, disallowed content-type, redirect
 * cap, redirect loop, scheme downgrade, network error). SSRF failures throw {@link SsrfError}. */
export class GuardedFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GuardedFetchError";
  }
}

export interface GuardedFetchOptions {
  /** Accept header to send. Default: the RDF accept set. */
  readonly accept?: string;
  /** Additional request headers (the guard always sets User-Agent + Accept; these merge over them). */
  readonly headers?: Record<string, string>;
  /** Max response body bytes. Default `MAX_BYTES_PROFILE` from config. */
  readonly maxBytes?: number;
  /** Total timeout (ms) spanning fetch + redirects + body. Default `FETCH_TIMEOUT_MS` from config. */
  readonly timeoutMs?: number;
  /** Max redirects followed. Default `MAX_REDIRECTS` from config. */
  readonly maxRedirects?: number;
  /** Allowed final-response content-types (bare media type). Default: the RDF set. */
  readonly allowedContentTypes?: readonly string[];
  /**
   * TEST/DEV ONLY: permit loopback (127.0.0.1, ::1) targets and `http:` to a loopback host. NEVER
   * set in production — this is the documented test hook so the fixture server on 127.0.0.1 is
   * reachable. Production code MUST leave this false (the default).
   */
  readonly allowLoopback?: boolean;
  /** Inject a DNS lookup (tests — e.g. the rebinding stub). Defaults to `node:dns/promises`. */
  readonly dnsLookup?: (host: string) => Promise<LookupAddress[]>;
  /** Conditional request validators (forwarded as If-None-Match / If-Modified-Since). */
  readonly conditional?: {
    readonly etag?: string;
    readonly lastModified?: string;
  };
  /**
   * Honour `X-Robots-Tag: noindex` on the FINAL 2xx response BEFORE the content-type allowlist and
   * BEFORE reading the body. When set and the final response carries `noindex`, the body is cancelled
   * (never read) and the result is returned with `noindex: true`, empty `text`/`bytes`, and WITHOUT
   * rejecting on content-type. This lets the caller tombstone an opted-out document without ever
   * parsing it — even when the noindex body is malformed, oversized, or a non-RDF content-type that
   * would otherwise be refused. Default false (content-type allowlist applies as before).
   */
  readonly honourNoindexHeader?: boolean;
}

export interface GuardedFetchResult {
  /** The final (post-redirect) response. Body has NOT been read off it; use `text`/`bytes`. */
  readonly response: Response;
  /** The final resolved URL (after redirects). */
  readonly finalUrl: string;
  /** The bare media type of the final response (lower-cased, no parameters). */
  readonly contentType: string;
  /** The bounded response body as UTF-8 text. */
  readonly text: string;
  /** The bounded response body as raw bytes. */
  readonly bytes: Uint8Array;
  /** HTTP status of the final response. */
  readonly status: number;
  /**
   * True when `honourNoindexHeader` was set AND the final 2xx response carried `X-Robots-Tag:
   * noindex`. In that case the body was NOT read (`text`/`bytes` are empty) and the content-type
   * allowlist was NOT applied — the caller should tombstone the document without parsing it.
   */
  readonly noindex: boolean;
}

/**
 * Boot assertion (docs/DESIGN.md §5 — runtime is load-bearing). Throws at module evaluation if we
 * are NOT on a Node runtime with `node:net#isIP` (a proxy for the DNS-pin-capable runtime). On the
 * Edge runtime `process.env.NEXT_RUNTIME === "edge"`, where undici Agents + `node:dns` are absent,
 * so DNS-pinning is impossible and we MUST fail closed rather than fetch unguarded.
 */
function assertNodeRuntime(): void {
  if (typeof process !== "undefined" && process.env.NEXT_RUNTIME === "edge") {
    throw new GuardedFetchError(
      'guardedFetch requires the Node.js runtime (got the Edge runtime). DNS-pinning needs node:dns; declare `export const runtime = "nodejs"`.'
    );
  }
  if (typeof isIP !== "function") {
    throw new GuardedFetchError(
      "guardedFetch requires node:net#isIP — DNS-pinning is unavailable in this runtime."
    );
  }
}

assertNodeRuntime();

/** Per-hop scheme + port gate (docs/DESIGN.md §5). 443 always; 80 only under loopback (dev/tests).
 * `prevWasHttps` rejects a downgrade redirect (https → http). Exported for exhaustive unit testing
 * of the scheme/port/downgrade branches (the redirect-downgrade path is awkward to exercise e2e
 * without a TLS fixture). */
export function assertSchemeAndPort(
  url: URL,
  allowLoopback: boolean,
  prevWasHttps: boolean
): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GuardedFetchError(
      `URL must be http/https (got ${url.protocol}).`
    );
  }
  if (url.protocol === "http:" && !allowLoopback) {
    throw new GuardedFetchError(
      `URL must be https: (got http: ${url.host}). http: is permitted only under allowLoopback (dev/tests).`
    );
  }
  if (prevWasHttps && url.protocol === "http:") {
    throw new GuardedFetchError(
      `Refusing redirect scheme downgrade (https → http): ${url.host}.`
    );
  }
  // Port gate. In PRODUCTION (allowLoopback=false) an explicit port must be 443 (https) — fetching
  // an internal service on a non-standard port is exactly the SSRF we block. Under allowLoopback
  // (the dev/test hook) any port is permitted: the fixture server binds an ephemeral loopback port,
  // and the SSRF guard has already constrained the resolved address to loopback. `url.port` is ""
  // when the URL uses the scheme default.
  if (!allowLoopback && url.port !== "") {
    const port = Number(url.port);
    if (!(url.protocol === "https:" && port === 443)) {
      throw new GuardedFetchError(
        `URL port not allowed (${url.port}); only 443 (https) is permitted in production.`
      );
    }
  }
}

/** A per-request undici Agent pinned to the validated IP (closes the rebinding TOCTOU). The Agent +
 * `undiciFetch` come from the SAME undici copy (dispatchers only interoperate within one undici). */
function pinningAgent(pinned: LookupAddress): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(pinned) } });
}

/**
 * Fetch an attacker-influenced URL with full SSRF defence-in-depth. Returns the final response, the
 * resolved URL, the content-type, and the bounded body. Throws {@link SsrfError} for an SSRF refusal
 * (private/loopback/denied target, rebinding), {@link GuardedFetchError} for any other guard failure
 * (bad scheme/port, redirect cap/loop/downgrade, disallowed content-type, network/timeout), or
 * {@link BodyTooLargeError} for an over-cap body.
 */
export async function guardedFetch(
  rawUrl: string,
  opts: GuardedFetchOptions = {}
): Promise<GuardedFetchResult> {
  assertNodeRuntime();

  const allowLoopback = opts.allowLoopback ?? false;
  const maxBytes = opts.maxBytes ?? MAX_BYTES_PROFILE;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const accept = opts.accept ?? FETCH_RDF_ACCEPT;
  const allowedContentTypes = (
    opts.allowedContentTypes ?? FETCH_RDF_CONTENT_TYPES
  ).map((t) => t.toLowerCase());
  const honourNoindexHeader = opts.honourNoindexHeader ?? false;

  const headers: Record<string, string> = {
    accept,
    "user-agent": FETCH_USER_AGENT,
    ...(opts.conditional?.etag
      ? { "if-none-match": opts.conditional.etag }
      : {}),
    ...(opts.conditional?.lastModified
      ? { "if-modified-since": opts.conditional.lastModified }
      : {}),
    ...(opts.headers ?? {}),
  };

  // ONE controller + ONE timer for the whole operation (fetch + redirects + body). Cleared in the
  // finally so a slow redirect chain or slow body can never exceed `timeoutMs`.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = rawUrl;
    let prevWasHttps = false;
    const seen = new Set<string>();

    for (let hop = 0; ; hop += 1) {
      if (hop > maxRedirects) {
        throw new GuardedFetchError(
          `Exceeded max redirects (${maxRedirects}); last URL: ${currentUrl}.`
        );
      }

      const parsed = parseUrl(currentUrl);
      assertSchemeAndPort(parsed, allowLoopback, prevWasHttps);
      // SSRF guard: resolve + classify all records, pin the first validated IP. Throws SsrfError.
      const pinned = await assertNotSsrf(parsed.toString(), {
        allowLoopback,
        dnsLookup: opts.dnsLookup,
        enforceHttpsExceptLoopback: true,
      });

      const agent = pinningAgent(pinned);
      let res: Response;
      try {
        res = (await undiciFetch(parsed.toString(), {
          method: "GET",
          headers,
          redirect: "manual",
          signal: controller.signal,
          dispatcher: agent,
        })) as unknown as Response;
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          throw new GuardedFetchError(
            `Fetch timed out after ${timeoutMs}ms: ${currentUrl}.`,
            {
              cause: error,
            }
          );
        }
        throw new GuardedFetchError(
          `Fetch failed for ${currentUrl}: ${reason(error)}`,
          {
            cause: error,
          }
        );
      } finally {
        // Close the per-hop Agent (a redirect spawns a fresh one for the next hop).
        void agent.close().catch(() => {});
      }

      // Redirect?
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          // A 3xx without Location — treat as final (atypical) and fall through to validation.
        } else {
          const nextUrl = new URL(location, parsed).toString();
          if (seen.has(nextUrl)) {
            throw new GuardedFetchError(`Redirect loop at ${nextUrl}.`);
          }
          seen.add(nextUrl);
          prevWasHttps = parsed.protocol === "https:";
          currentUrl = nextUrl;
          // Drain/cancel the redirect response body so the socket is released.
          void res.body?.cancel().catch(() => {});
          continue;
        }
      }

      // Final response: enforce content-type allowlist, then read the bounded body.
      const finalUrl = parsed.toString();
      const status = res.status;
      const contentType =
        (res.headers.get("content-type") ?? "")
          .split(";")[0]
          ?.trim()
          .toLowerCase() ?? "";

      // Body-irrelevant statuses bypass the content-type allowlist and return an empty bounded body,
      // letting the caller act on `status`:
      //   - 304 Not Modified (conditional request), 204/205 No Content — carry no body and commonly
      //     omit Content-Type.
      //   - Any error status >= 400 — the body is an error page (HTML/plain), never RDF we would
      //     parse, so reading/allowlisting it is pointless. The crawler classifies by status
      //     (5xx/429 transient vs other 4xx deterministic). The body is cancelled, not read, so this
      //     does NOT widen the SSRF surface (no attacker-controlled bytes are ingested).
      if (status === 304 || status === 204 || status === 205 || status >= 400) {
        void res.body?.cancel().catch(() => {});
        return {
          response: res,
          finalUrl,
          contentType,
          text: "",
          bytes: new Uint8Array(0),
          status,
          noindex: false,
        };
      }

      // noindex short-circuit (DESIGN.md §4.8 H2): when the caller opted in and the FINAL response
      // carries `X-Robots-Tag: noindex`, the document is opted out of indexing. Honour it BEFORE the
      // content-type allowlist and BEFORE reading the body — cancel the body, never parse it. This is
      // why an opted-out doc with a malformed / oversized / non-RDF body is still tombstoned (returned
      // with noindex:true) rather than rejected on content-type or read into memory.
      if (honourNoindexHeader && responseHasNoindex(res)) {
        void res.body?.cancel().catch(() => {});
        return {
          response: res,
          finalUrl,
          contentType,
          text: "",
          bytes: new Uint8Array(0),
          status,
          noindex: true,
        };
      }

      if (!allowedContentTypes.includes(contentType)) {
        void res.body?.cancel().catch(() => {});
        throw new GuardedFetchError(
          `Disallowed content-type "${contentType || "(none)"}" for ${finalUrl}; expected one of ${allowedContentTypes.join(", ")}.`
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBytes(res, { maxBytes, controller });
      } catch (error: unknown) {
        // Preserve the body-too-large contract; convert an abort during body streaming
        // (the shared timeout fired mid-read) into the guardedFetch timeout error shape.
        if (error instanceof BodyTooLargeError) throw error;
        if (controller.signal.aborted) {
          throw new GuardedFetchError(
            `Fetch body timed out after ${timeoutMs}ms: ${finalUrl}.`,
            { cause: error }
          );
        }
        throw new GuardedFetchError(
          `Failed reading body for ${finalUrl}: ${reason(error)}`,
          { cause: error }
        );
      }
      const text = new TextDecoder("utf-8").decode(bytes);

      return {
        response: res,
        finalUrl,
        contentType,
        text,
        bytes,
        status,
        noindex: false,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new GuardedFetchError(`URL is malformed: ${raw}.`);
  }
}

/**
 * The directives we recognise as NOT requesting de-indexing in an `X-Robots-Tag` value. If a present
 * header parses entirely into known-safe directives we treat it as "may index"; anything we do NOT
 * recognise (or `noindex`/`none`) defaults to DENY (treat as noindex) so an unparseable / novel
 * directive can never silently re-admit an opted-out document (DESIGN.md §4.8 H2 — default-deny).
 */
const ROBOTS_SAFE_DIRECTIVES = new Set([
  "index",
  "follow",
  "all",
  "nofollow",
  "noarchive",
  "nosnippet",
  "noimageindex",
  "notranslate",
  "indexifembedded",
]);

/**
 * Returns true when the response's `X-Robots-Tag` requests that the document NOT be indexed —
 * including the DEFAULT-DENY case where the header is present but does not parse cleanly into
 * known-safe directives (DESIGN.md §4.8 H2). An ABSENT header → false (no opt-out signal).
 *
 * Parsing (lenient, per Google's X-Robots-Tag grammar): the value is a comma-separated list of
 * directives; a directive may be bot-scoped (`botname: directive`) — we take the part after the last
 * colon as the directive token. `noindex` / `none` → deny. A token we do not recognise as safe →
 * deny (the unparseable default-deny). Only when EVERY token is a recognised safe directive do we
 * allow indexing.
 */
function responseHasNoindex(res: Response): boolean {
  const tag = res.headers.get("x-robots-tag");
  if (tag == null) return false; // no header → no opt-out signal
  const value = tag.trim().toLowerCase();
  if (value === "") return true; // present-but-empty is not parseable → default-deny
  const directives = value
    .split(",")
    .map((d) => {
      // Strip an optional `botname:` prefix — take the token after the LAST colon.
      const colon = d.lastIndexOf(":");
      return (colon === -1 ? d : d.slice(colon + 1)).trim();
    })
    .filter((d) => d.length > 0);
  if (directives.length === 0) return true; // only separators / colons → default-deny
  for (const d of directives) {
    if (d === "noindex" || d === "none") return true; // explicit de-index
    if (!ROBOTS_SAFE_DIRECTIVES.has(d)) return true; // unrecognised → default-deny
  }
  return false; // every directive recognised as safe → may index
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
