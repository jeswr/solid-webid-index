// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/security/syntacticSsrf.ts — REQUEST-PATH (no-DNS) SSRF gate for suggestion candidates.
 *
 * The LDN inbox (POST /inbox/) must NOT perform a DNS resolution on the request path
 * (DESIGN.md §4.3 step 4 / §5 anti-amplification M4): a DNS lookup per inbound suggestion is
 * itself an amplification vector (an attacker can drive arbitrary outbound resolver traffic by
 * POSTing crafted hostnames). The DNS-pinned, resolve-and-classify SSRF check happens LATER, on the
 * crawl path, inside {@link guardedFetch}.
 *
 * This module provides the SYNTACTIC, purely-string portion of that defence — everything that can be
 * decided WITHOUT touching the network:
 *
 *   1. Parse with WHATWG `URL` (reject unparseable).
 *   2. Scheme gate — https only. http: is permitted ONLY when `allowLoopback` is set AND the host is
 *      an actual loopback literal (the relaxation is scoped to the loopback fixture, never to any
 *      `http:` URL — a misconfigured `allowLoopback` cannot admit a public http: host).
 *   3. Reject userinfo (username / password).
 *   4. Port gate — 443 only, EXCEPT a loopback fixture host under `allowLoopback` (which binds an
 *      ephemeral port). A non-loopback host always faces the strict https-and-443 gate even when
 *      `allowLoopback` is set (defence in depth; an internal service on an odd port is exactly the
 *      SSRF we never want even to enqueue).
 *   5. Hostname denylist (cloud-internal names) — reuses {@link isDeniedHostname}.
 *   6. Reject host LITERALS that classify as non-public (loopback / private / link-local / etc.) — an
 *      IP-literal candidate is decidable with NO DNS via the vendored {@link isPublicAddress}, after
 *      normalising alternate encodings (decimal/octal/hex/short-form) via
 *      {@link normalizeHostForClassification}. A real hostname (not an IP literal) is left for the
 *      DNS-pinned guardedFetch check at crawl time — this gate never resolves it.
 *
 * Returns a discriminated result rather than throwing, so the route can map a refusal to 422 without
 * a try/catch dance. The check is deterministic and side-effect-free.
 */

import { isIP } from "node:net";
import { isLoopbackAddress, isPublicAddress } from "./addresses";
import { isDeniedHostname, normalizeHostForClassification } from "./ssrf";

/** Outcome of the syntactic gate. */
export type SyntacticSsrfResult = { ok: true } | { ok: false; reason: string };

/** Options mirroring the loopback dev/test hook used elsewhere. */
export interface SyntacticSsrfOptions {
  /** DEV/TEST ONLY: permit http: + loopback host literals. NEVER true in production. */
  allowLoopback?: boolean;
}

/**
 * Syntactically vet a suggestion-candidate IRI WITHOUT any DNS lookup.
 *
 * A real hostname passes the gate here (its addresses are classified later, with DNS pinning, in
 * guardedFetch). An IP-LITERAL host is classified now (no DNS needed) and refused when non-public.
 *
 * @param raw  The candidate WebID/document IRI (attacker-controlled).
 * @param opts.allowLoopback  DEV/TEST: permit http: + loopback literals.
 */
export function syntacticSsrfCheck(
  raw: string,
  opts: SyntacticSsrfOptions = {}
): SyntacticSsrfResult {
  const allowLoopback = opts.allowLoopback ?? false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "candidate is not a valid absolute URL" };
  }

  // ── Classify the host FIRST (no DNS) so the loopback relaxation can be scoped to loopback ONLY.
  // Normalise alternate IPv4 encodings (decimal/octal/hex/short-form) so e.g. http://2130706433/
  // (== 127.0.0.1) classifies as the loopback literal it really is. A real hostname round-trips
  // unchanged and is NOT an IP literal — `isHostLoopback` is therefore false for it, so a hostname
  // never benefits from the loopback relaxation (it always faces the strict https-and-443 gate).
  const normalized = normalizeHostForClassification(url.hostname);
  const isHostLoopback =
    isIP(normalized) !== 0 && isLoopbackAddress(normalized);
  // The dev/test relaxation (http: + arbitrary port) applies ONLY when BOTH the env hook is set AND
  // the host is an actual loopback literal. A misconfigured `allowLoopback` therefore can NEVER admit
  // a public http: URL or a non-443 public host (M4 — over-relaxation fix).
  const relax = allowLoopback && isHostLoopback;

  // 2. Scheme gate. http: is permitted ONLY for a loopback host under the dev/test hook.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      reason: `candidate scheme must be https: (got ${url.protocol})`,
    };
  }
  if (url.protocol === "http:" && !relax) {
    return {
      ok: false,
      reason:
        "candidate scheme must be https: (http: is dev/test loopback only)",
    };
  }

  // 3. Userinfo.
  if (url.username || url.password) {
    return { ok: false, reason: "candidate URL must not carry userinfo" };
  }

  // 4. Port gate. In production (and for ANY non-loopback host even under allowLoopback) only 443 is
  //    permitted. The ephemeral-port relaxation is scoped to a loopback fixture host (`relax`).
  if (!relax && url.port !== "") {
    const port = Number(url.port);
    if (!(url.protocol === "https:" && port === 443)) {
      return {
        ok: false,
        reason: `candidate port not allowed (${url.port}); only 443 is permitted`,
      };
    }
  }

  // 5. Hostname denylist (cloud-internal names) — no DNS, exact/suffix string match.
  const rawHostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isDeniedHostname(rawHostname)) {
    return {
      ok: false,
      reason: `candidate host is on the cloud-internal denylist: ${rawHostname}`,
    };
  }

  // 6. IP-literal classification (NO DNS). Re-check the normalised form against the denylist, then
  //    classify any IP literal (loopback is admitted only via `allowLoopback`, never via `relax`,
  //    which already required the loopback classification — keeping the address classifier the single
  //    authority on public-vs-loopback).
  if (isDeniedHostname(normalized)) {
    return {
      ok: false,
      reason: `candidate host is on the cloud-internal denylist: ${normalized}`,
    };
  }
  if (isIP(normalized) !== 0) {
    // It IS an IP literal — classify now (decidable without DNS).
    if (!isPublicAddress(normalized, allowLoopback)) {
      return {
        ok: false,
        reason: `candidate resolves to a non-public address literal (${normalized})`,
      };
    }
  }
  // Otherwise it is a real hostname — defer to the DNS-pinned guardedFetch check at crawl time.

  return { ok: true };
}
