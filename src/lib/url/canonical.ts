// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/url/canonical.ts — WebID / URI canonicalisation + dedup helpers.
 *
 * SECURITY / CORRECTNESS CRITICAL — wrong canonicalisation either re-crawls duplicates
 * forever (performance bomb) or treats distinct WebIDs as one (privacy violation + data loss).
 * See docs/DESIGN.md §2.2 for the full specification.
 *
 * Rules applied (in order, every function):
 *  1. Parse with WHATWG `URL` — rejects malformed URIs.
 *  2. Scheme gate: only `https:` in production; `http:` allowed only under `allowLoopback` (dev).
 *     http and https of the SAME host+path are treated as DISTINCT keys (different origins; one is
 *     not a canonical alias of the other). The crawler may *follow* an http→https redirect and then
 *     key on the post-redirect URL, but the canonicaliser never silently upgrades http to https.
 *  3. Reject userinfo (username or password present → throw).
 *  4. Host normalisation: WHATWG URL already lowercases and Punycode-encodes; we additionally
 *     NFC-normalise the pre-URL hostname for robustness (homograph defence).
 *  5. Default-port removal: strip `:443` for https, `:80` for http.
 *  6. Path percent-encoding normalisation: WHATWG URL does this; we rely on it.
 *  7. Trailing-slash policy (path only — never the origin):
 *       - Empty path → normalise to `/`.
 *       - A path of exactly `/` is kept as `/`.
 *       - A longer path with a trailing slash has the slash stripped (e.g. `/card/` → `/card`).
 *       This is the "collapse single trailing slash" policy from DESIGN.md §2.2. The content-hash
 *       comparison that may override this is a *runtime* concern in the crawler; the pure
 *       canonicaliser always strips.
 *  8. Fragment handling:
 *       - `canonicalDocUrl` STRIPS the fragment (the document is the crawl-frontier key).
 *       - `canonicalWebId`  KEEPS the fragment (the WebID identifies the RDF subject).
 *  9. Query string: preserved as-is (some profile documents include query params).
 *
 * No I/O. No imports from outside this module.
 */

/** Options shared by both canonicalisation functions. */
export interface CanonicalOptions {
  /**
   * TEST / DEV ONLY: allow `http:` scheme (normally forbidden). The guardedFetch also exposes this
   * flag; set both together in tests. NEVER set in production.
   */
  allowLoopback?: boolean;
}

/** Thrown when a URL cannot be canonicalised (malformed, forbidden scheme, userinfo present). */
export class CanonicalError extends Error {
  constructor(
    public readonly raw: string,
    message: string
  ) {
    super(`CanonicalError [${raw}]: ${message}`);
    this.name = "CanonicalError";
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Loopback-only host check. `http:` is cleartext, so even under `allowLoopback` (dev/tests) it is
 * accepted ONLY for loopback hosts — never for a real origin like `http://alice.example`.
 * Mirrors the SSRF loopback set: `localhost`, `127.0.0.0/8`, and IPv6 `::1`.
 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/**
 * Parse `raw` with WHATWG `URL`, normalise userinfo rejection and default-port stripping, apply
 * the trailing-slash policy, and return the result as a mutable URL object.
 * The fragment is NOT touched here — callers decide what to do with it.
 */
function parseAndNormalise(raw: string, allowLoopback: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CanonicalError(raw, "URL is malformed and cannot be parsed.");
  }

  // Scheme gate — DESIGN.md §2.2 "require u.protocol ∈ {https:} (prod)"
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new CanonicalError(
      raw,
      `Unsupported scheme "${u.protocol}"; only https: (and http: in dev) are accepted.`
    );
  }
  if (u.protocol === "http:") {
    if (!allowLoopback) {
      throw new CanonicalError(
        raw,
        "http: is not permitted in production; use https: (set allowLoopback for dev/tests)."
      );
    }
    if (!isLoopbackHost(u.hostname)) {
      throw new CanonicalError(
        raw,
        `http: under allowLoopback is permitted only for loopback hosts; "${u.hostname}" is not loopback.`
      );
    }
  }

  // Reject userinfo — DESIGN.md §2.2 "reject u.username || u.password"
  if (u.username || u.password) {
    throw new CanonicalError(
      raw,
      "URL must not contain userinfo (username/password)."
    );
  }

  // Default-port removal — DESIGN.md §2.2 "strip default ports (:443/:80)"
  // WHATWG URL may or may not include the default port depending on whether the input had it.
  // Force-clear it so the serialised form is always port-free for default ports.
  if (
    (u.protocol === "https:" && u.port === "443") ||
    (u.protocol === "http:" && u.port === "80")
  ) {
    u.port = "";
  }

  // Host NFC normalisation (DESIGN.md §2.2 "NFC-normalise + lowercase").
  // WHATWG URL already lowercases and Punycode-encodes; NFC is belt-and-braces for homographs.
  // We can only set the hostname, not the already-encoded host. Reassigning hostname re-encodes.
  const nfcHost = u.hostname.normalize("NFC");
  if (nfcHost !== u.hostname) {
    u.hostname = nfcHost;
  }

  // Trailing-slash policy — DESIGN.md §2.2:
  //   "collapse a single trailing slash on the path UNLESS the two forms return different
  //   content-hashes"  (the content-hash branch is a runtime concern; we always strip here)
  //
  // Rules:
  //   - Empty path       → set to "/"  (WHATWG URL ensures this anyway, but be explicit)
  //   - Path === "/"     → leave as "/"
  //   - Path ends with "/" AND longer than "/" → strip the trailing slash
  if (u.pathname === "") {
    u.pathname = "/";
  } else if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Canonical DOCUMENT URL — the crawl-frontier primary key.
 *
 * The fragment is stripped: a profile document (`/card`, `/card#me`, `/card#`) all map to the
 * same document key (`/card`). The row in the `doc` table is keyed on this value.
 *
 * @param raw          The raw URL string (any valid https/http IRI).
 * @param opts.allowLoopback  DEV/TEST: permit http: scheme.
 * @returns The canonical document URL string (no fragment).
 * @throws  {@link CanonicalError} for unparseable, forbidden-scheme, or userinfo-bearing URLs.
 *
 * @example
 * canonicalDocUrl("https://Alice.example/card#me")  // → "https://alice.example/card"
 * canonicalDocUrl("https://alice.example:443/card/") // → "https://alice.example/card"
 * canonicalDocUrl("https://alice.example/card#")     // → "https://alice.example/card"
 */
export function canonicalDocUrl(
  raw: string,
  opts: CanonicalOptions = {}
): string {
  const u = parseAndNormalise(raw, opts.allowLoopback ?? false);
  u.hash = ""; // strip fragment — this is the document key
  return u.toString();
}

/**
 * Canonical WebID URI — the subject identifier.
 *
 * The WebID is the RDF subject that describes the person/agent. Unlike the document key, the
 * fragment MUST be preserved (`/card#me` and `/card` are distinct resources).
 *
 * All other normalisation rules (scheme gate, userinfo, host case, default ports,
 * trailing-slash on path, percent-encoding) are identical to {@link canonicalDocUrl}.
 *
 * @param raw          The raw WebID URI string.
 * @param opts.allowLoopback  DEV/TEST: permit http: scheme.
 * @returns The canonical WebID URI string (fragment preserved).
 * @throws  {@link CanonicalError} for unparseable, forbidden-scheme, or userinfo-bearing URIs.
 *
 * @example
 * canonicalWebId("https://Alice.example/card#me")   // → "https://alice.example/card#me"
 * canonicalWebId("https://alice.example:443/profile/card#me") // → "https://alice.example/profile/card#me"
 * canonicalWebId("https://alice.example/card")      // → "https://alice.example/card"  (no fragment — valid)
 */
export function canonicalWebId(
  raw: string,
  opts: CanonicalOptions = {}
): string {
  const u = parseAndNormalise(raw, opts.allowLoopback ?? false);
  // Fragment is preserved — do NOT touch u.hash.
  return u.toString();
}

/**
 * Returns `true` when two WebID URIs canonicalise to the same URI.
 *
 * Use this instead of a raw string comparison to ensure normalisation is applied on both sides.
 * Throws {@link CanonicalError} if either input cannot be canonicalised.
 *
 * @param a  First WebID URI.
 * @param b  Second WebID URI.
 * @param opts  Shared options passed to both canonicalisations.
 */
export function sameWebId(
  a: string,
  b: string,
  opts: CanonicalOptions = {}
): boolean {
  return canonicalWebId(a, opts) === canonicalWebId(b, opts);
}

/**
 * Returns `true` when two document URLs canonicalise to the same document key.
 *
 * Fragments are stripped before comparison — `/card#me` and `/card#you` map to the same document.
 *
 * @param a  First document URL.
 * @param b  Second document URL.
 * @param opts  Shared options passed to both canonicalisations.
 */
export function sameDocUrl(
  a: string,
  b: string,
  opts: CanonicalOptions = {}
): boolean {
  return canonicalDocUrl(a, opts) === canonicalDocUrl(b, opts);
}
