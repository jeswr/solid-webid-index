// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * SSRF guard: resolve a host once, classify EVERY A/AAAA record as public-or-refused, and return
 * the validated address to **pin** into the connecting socket so the guard and the connection see
 * the same IP (closing the DNS-rebinding TOCTOU). Paired with {@link pinnedLookup}, the callback the
 * consumer feeds into its own undici `Agent({ connect: { lookup } })`.
 *
 * VENDORED from prod-solid-server `packages/guarded-fetch/src/ssrf.ts` (docs/DESIGN.md §5), extended
 * for this repo with:
 *  - a hostname denylist for cloud-internal names (checked BEFORE DNS — security C4); and
 *  - explicit alternate-IP-encoding normalisation (decimal/octal/hex/short-form) before classifying.
 *    WHATWG `new URL()` already canonicalises every numeric IPv4 encoding to dotted-decimal, but we
 *    re-normalise belt-and-braces so a host literal can never reach the classifier in a form `isIP`
 *    fails to recognise.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { FETCH_HOSTNAME_DENYLIST } from "../config";
import { isLoopbackAddress, isPublicAddress } from "./addresses";

/** The shape `node:dns/promises#lookup(host, { all: true })` returns (and what the pin uses). */
export interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

/** The DNS lookup shape; tests inject a stub. Defaults to `node:dns/promises`. */
export type DnsLookup = (host: string) => Promise<LookupAddress[]>;

/** Raised when a URL/host fails the SSRF guard. Consumers map this to their own domain error. */
export class SsrfError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SsrfError";
  }
}

export interface SsrfGuardOptions {
  /** Re-permit loopback (and loopback-only http). Default false. NEVER true in production. */
  readonly allowLoopback: boolean;
  /** Inject a DNS lookup (tests). Defaults to `node:dns/promises` with `{ all: true }`. */
  readonly dnsLookup?: DnsLookup;
  /**
   * Enforce the HTTPS-only-plus-loopback-http nuance:
   *  - reject `http:` unless `allowLoopback` is on, AND
   *  - when `http:` is permitted under `allowLoopback`, require EVERY resolved address to be
   *    loopback (a dev box must not be tricked into HTTP-fetching a public host).
   */
  readonly enforceHttpsExceptLoopback?: boolean;
}

/**
 * Is `hostname` denied by the cloud-internal name denylist (exact match or dot-anchored suffix)?
 * Checked BEFORE DNS so a split-horizon resolver can never map an internal name to an endpoint we
 * connect to. `entry` starting with `.` is a suffix match (`.internal` matches `foo.internal`);
 * otherwise it is an exact match OR a `.entry` suffix match (`metadata.google.internal` also blocks
 * `x.metadata.google.internal`).
 */
export function isDeniedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const raw of FETCH_HOSTNAME_DENYLIST) {
    const entry = raw.toLowerCase();
    if (entry.startsWith(".")) {
      if (host === entry.slice(1) || host.endsWith(entry)) {
        return true;
      }
    } else if (host === entry || host.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalise a URL hostname to a canonical IP literal for classification, covering alternate IPv4
 * encodings. WHATWG `new URL()` already does this for us — but we re-run it defensively so the
 * value the classifier sees is always a form `isIP` recognises. A bracketed IPv6 literal has its
 * brackets stripped. Returns the canonical form (or the input lowercased if it is not an IP).
 */
export function normalizeHostForClassification(hostname: string): string {
  const stripped = hostname.replace(/^\[|\]$/g, "");
  // Already a recognised IP literal — return as-is.
  if (isIP(stripped) !== 0) {
    return stripped;
  }
  // Re-feed through WHATWG URL: this canonicalises decimal (2130706433), hex (0x7f000001),
  // octal (0177.0.0.1), and short-form (127.1) IPv4 encodings to dotted-decimal. If URL rejects
  // it or it round-trips unchanged, it is a real hostname → DNS.
  try {
    const reparsed = new URL(`http://${stripped}/`).hostname.replace(
      /^\[|\]$/g,
      ""
    );
    return reparsed.toLowerCase();
  } catch {
    return stripped.toLowerCase();
  }
}

/**
 * Assert that `rawUrl`'s host resolves only to public addresses (or loopback under `allowLoopback`),
 * returning the **pinned** address the fetch must connect to. Throws {@link SsrfError} on a
 * malformed URL, a non-http(s) scheme, userinfo, a denied hostname, an unresolvable host, or ANY
 * non-public record.
 *
 * DNS-rebinding mitigation: every record must pass; the first validated record is returned to pin.
 */
export async function assertNotSsrf(
  rawUrl: string,
  opts: SsrfGuardOptions
): Promise<LookupAddress> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`URL is malformed: ${rawUrl}.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SsrfError(`URL must be http/https (got ${url.protocol}).`);
  }
  if (
    opts.enforceHttpsExceptLoopback &&
    url.protocol === "http:" &&
    !opts.allowLoopback
  ) {
    throw new SsrfError(
      `URL must be https: (got http: ${url.host}). HTTP is permitted only when allowLoopback=true (dev/IT).`
    );
  }
  if (url.username || url.password) {
    throw new SsrfError("URL must not carry userinfo.");
  }

  // Hostname denylist (cloud-internal names) — BEFORE DNS so a split-horizon resolver can't map an
  // internal name to a reachable endpoint.
  const rawHostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isDeniedHostname(rawHostname)) {
    throw new SsrfError(
      `Host is on the cloud-internal denylist: ${rawHostname}.`
    );
  }

  const hostname = normalizeHostForClassification(url.hostname);
  // After normalisation a denied name could have appeared (defence in depth).
  if (isDeniedHostname(hostname)) {
    throw new SsrfError(`Host is on the cloud-internal denylist: ${hostname}.`);
  }
  const literalKind = isIP(hostname);
  let resolved: LookupAddress[];
  if (literalKind !== 0) {
    resolved = [{ address: hostname, family: literalKind }];
  } else {
    const lookup = opts.dnsLookup ?? ((host) => dnsLookup(host, { all: true }));
    try {
      resolved = await lookup(hostname);
    } catch (error: unknown) {
      throw new SsrfError(
        `Host did not resolve: ${hostname}: ${reason(error)}`,
        { cause: error }
      );
    }
  }
  if (resolved.length === 0) {
    throw new SsrfError(`Host resolved to no addresses: ${hostname}.`);
  }
  // HTTPS-dev override: an http: URL allowed past the scheme gate by `allowLoopback` must resolve
  // EVERY address to loopback — else a dev box could be tricked into HTTP-fetching a public host.
  if (
    opts.enforceHttpsExceptLoopback &&
    url.protocol === "http:" &&
    opts.allowLoopback
  ) {
    for (const r of resolved) {
      if (!isLoopbackAddress(r.address)) {
        throw new SsrfError(
          `URL refused — http: allowed only when ALL resolved addresses are loopback (got ${r.address}). Use https: in production.`
        );
      }
    }
  }
  for (const r of resolved) {
    if (!isPublicAddress(r.address, opts.allowLoopback)) {
      throw new SsrfError(
        `URL refused — ${hostname} resolves to a non-public address (${r.address}).`
      );
    }
  }
  return resolved[0] as LookupAddress;
}

/**
 * The Node `dns.lookup`-shaped callback that pins every connection to a single validated address —
 * fed into undici's `Agent({ connect: { lookup } })`. Returning the pre-validated IP (no second DNS
 * query) makes the SSRF guard and the fetch see the **same** address, closing the rebinding TOCTOU.
 *
 * Honours `options.all`: undici v7 invokes `lookup` with `{ all: true }` and expects the ARRAY form
 * `cb(null, [{ address, family }])`; the classic 3-arg form is `cb(null, address, family)`. Calling
 * the wrong form makes undici throw `ERR_INVALID_IP_ADDRESS`, surfacing as a generic "fetch failed".
 */
export function pinnedLookup(
  pinned: LookupAddress
): (hostname: string, options: unknown, cb: PinnedLookupCallback) => void {
  return (_hostname, options, cb) => {
    const wantsAll =
      typeof options === "object" &&
      options !== null &&
      (options as { all?: unknown }).all === true;
    if (wantsAll) {
      (cb as (err: null, addresses: LookupAddress[]) => void)(null, [
        { address: pinned.address, family: pinned.family },
      ]);
    } else {
      (cb as (err: null, address: string, family: number) => void)(
        null,
        pinned.address,
        pinned.family
      );
    }
  };
}

/** Either lookup-callback contract: classic `(err, address, family)` or undici v7's `(err, [..])`. */
type PinnedLookupCallback =
  | ((
      err: NodeJS.ErrnoException | null,
      address: string,
      family: number
    ) => void)
  | ((err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void);

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
