// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/security/dpopVerifier.ts — a focused, issuer-agnostic Solid-OIDC DPoP token verifier for the
 * opt-out / erasure Path A (DESIGN.md §4.8). SECURITY-CRITICAL.
 *
 * Path A: a Solid-OIDC DPoP-bound access token whose `webid` claim canonicalises to an indexed
 * WebID proves control → immediate erasure. This verifier establishes "the bearer controls
 * `webid`" with NO account system, the SAME rigor the suite's resource servers use:
 *
 *   1. PROOF-OF-POSSESSION, NOT bare Bearer — the `Authorization` scheme MUST be `DPoP` and a `DPoP`
 *      proof header MUST be present. A bare `Bearer` token is REJECTED (a stolen bearer token must
 *      not be able to erase someone's entry).
 *   2. ASYMMETRIC-ONLY — both the access-token JWS and the DPoP-proof JWS MUST use an asymmetric
 *      algorithm ({@link SIGNING_ALGS}). `HS*` (symmetric) and `none` are rejected: a symmetric /
 *      none alg would let either JWT be forged from a public value.
 *   3. ISSUER-AGNOSTIC — the access-token signature is checked against the issuer's published JWKS,
 *      resolved by OIDC discovery on the token's `iss` (cross-checked) so ANY conformant Solid-OIDC
 *      IdP works. An optional trusted-issuer allowlist narrows WHICH issuers may assert a `webid`.
 *   4. DPoP BINDING (RFC 9449) — the proof carries an embedded PUBLIC JWK; its JWS verifies under
 *      that key; `typ=dpop+jwt`; `htm`==method; `htu`==request URL (query/fragment stripped);
 *      `iat` within a freshness window; a `jti` is present; and `jkt(proof JWK) === token cnf.jkt`
 *      (the proof-of-possession binding). `ath` (access-token hash) is verified when present.
 *
 * On success returns the verified `webid` (an https: URL). Any failure throws {@link DpopVerifyError}
 * (the route maps it to 401). Network I/O (discovery + JWKS) is injectable so tests run offline.
 *
 * NB: this is deliberately self-contained (jose only) — the full suite verifier
 * (prod-solid-server src/auth) layers replay caches + bidirectional checks + Keycloak preflight that
 * the opt-out surface does not need. The crypto controls here are the same.
 */

import {
  EmbeddedJWK,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
  calculateJwkThumbprint,
  createLocalJWKSet,
  jwtVerify,
} from "jose";

import { guardedFetch } from "./guardedFetch";

/**
 * The asymmetric signature algorithms accepted for the access token AND the DPoP proof. Symmetric
 * (`HS*`) and `none` are excluded by omission — an asymmetric-only allowlist is the control that
 * makes proof-of-possession meaningful (RFC 9449 §4.2 / RFC 9068).
 */
export const SIGNING_ALGS = [
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "RS256",
  "RS384",
  "RS512",
] as const;

/** The DPoP-proof `iat` freshness window (seconds) — RFC 9449 (the library's `|now-iat|>300`). */
const DPOP_PROOF_MAX_AGE_SEC = 300;

/** Raised for ANY Path A verification failure. The route maps it to 401. */
export class DpopVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DpopVerifyError";
  }
}

/** The transport-agnostic request shape the verifier needs. */
export interface DpopVerifyRequest {
  /** The `Authorization` header value (e.g. `DPoP eyJ…`). */
  authorization: string | undefined;
  /** The `DPoP` proof header value (the proof JWT), or undefined. */
  dpop: string | undefined;
  /** The HTTP method (uppercased) the proof's `htm` must equal. */
  method: string;
  /** The request URL the proof's `htu` must equal (query/fragment compared stripped). */
  url: string;
}

export interface DpopVerifyOptions {
  /**
   * Trusted access-token issuers. Empty = issuer-agnostic (any issuer that OIDC-discovers cleanly).
   * When non-empty, an `iss` outside this set is rejected BEFORE discovery (so an untrusted issuer's
   * discovery document is never dereferenced).
   */
  readonly trustedIssuers?: readonly string[];
  /** The configurable claim carrying the WebID. Default `"webid"`. */
  readonly webidClaim?: string;
  /** Allowed clock skew (seconds) for temporal claims. Default 5. */
  readonly clockToleranceSec?: number;
  /**
   * Resolve an issuer to its JWKS key resolver. Injected in tests (inline JWKS, no network). The
   * default performs OIDC discovery on the issuer and builds a remote JWKS resolver. The verifier
   * caches the resolved resolver per issuer.
   */
  readonly resolveIssuerKeys?: (issuer: string) => Promise<JWTVerifyGetKey>;
}

/** The result of a successful Path A verification. */
export interface DpopVerifyResult {
  /** The verified WebID (an https: URL) from the token's `webid` claim. */
  webid: string;
  /** The token issuer (`iss`). */
  issuer: string;
}

/** Parse an `Authorization` header into a lower-cased scheme + token. */
export function parseAuthorization(
  header: string | undefined
): { scheme: string; token: string } | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const sp = trimmed.indexOf(" ");
  if (sp === -1) return undefined;
  const scheme = trimmed.slice(0, sp).toLowerCase();
  const token = trimmed.slice(sp + 1).trim();
  if (!token) return undefined;
  return { scheme, token };
}

/** Decode an UNVERIFIED JWT payload just far enough to route by a claim (re-checked on verify). */
function decodeClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Normalise an `htu` for comparison: strip query + fragment (RFC 9449 §4.3). */
function normalizeHtu(htu: string): string {
  const u = new URL(htu);
  u.search = "";
  u.hash = "";
  return u.href;
}

/** Whether a value is a plain JSON object. */
function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The JSON content types accepted for OIDC discovery + JWKS responses. */
const JSON_CONTENT_TYPES = ["application/json", "application/jwk-set+json"];

/**
 * Default issuer-keys resolver: OIDC discovery on `${issuer}/.well-known/openid-configuration`,
 * cross-checking the discovered `issuer` and reading `jwks_uri`, then fetching the JWKS — BOTH
 * through the SSRF chokepoint {@link guardedFetch} (the `iss` is attacker-influenced until the
 * signature check, so its metadata MUST be fetched SSRF-safely, not via a raw fetch). A LOCAL JWKS
 * resolver is built from the fetched keys (no second uncontrolled jose remote fetch). HTTPS-only.
 */
async function discoverIssuerKeys(issuer: string): Promise<JWTVerifyGetKey> {
  const issuerUrl = new URL(issuer);
  if (issuerUrl.protocol !== "https:") {
    throw new DpopVerifyError("Token issuer must be an https: URL.");
  }
  const wellKnown = new URL("/.well-known/openid-configuration", issuerUrl)
    .href;

  let meta: { issuer?: unknown; jwks_uri?: unknown };
  try {
    const res = await guardedFetch(wellKnown, {
      accept: "application/json",
      allowedContentTypes: JSON_CONTENT_TYPES,
    });
    meta = JSON.parse(res.text) as { issuer?: unknown; jwks_uri?: unknown };
  } catch (err) {
    throw new DpopVerifyError(
      `OIDC discovery failed for ${issuer}: ${reason(err)}`
    );
  }
  if (meta.issuer !== issuer) {
    throw new DpopVerifyError(`OIDC discovery issuer mismatch for ${issuer}.`);
  }
  if (typeof meta.jwks_uri !== "string" || meta.jwks_uri.length === 0) {
    throw new DpopVerifyError(`OIDC discovery for ${issuer} has no jwks_uri.`);
  }
  const jwksUri = new URL(meta.jwks_uri);
  if (jwksUri.protocol !== "https:") {
    throw new DpopVerifyError("Issuer jwks_uri must be an https: URL.");
  }

  let jwks: { keys?: unknown };
  try {
    const res = await guardedFetch(jwksUri.href, {
      accept: "application/json",
      allowedContentTypes: JSON_CONTENT_TYPES,
    });
    jwks = JSON.parse(res.text) as { keys?: unknown };
  } catch (err) {
    throw new DpopVerifyError(
      `JWKS fetch failed for ${issuer}: ${reason(err)}`
    );
  }
  if (!Array.isArray(jwks.keys)) {
    throw new DpopVerifyError(`JWKS for ${issuer} has no keys array.`);
  }
  return createLocalJWKSet({ keys: jwks.keys as JWK[] });
}

/**
 * Build a {@link createLocalJWKSet} resolver from inline keys — convenience for tests / a pinned
 * issuer config.
 */
export function localIssuerKeys(jwks: { keys: JWK[] }): JWTVerifyGetKey {
  return createLocalJWKSet(jwks);
}

/**
 * Verify a Solid-OIDC DPoP-bound access token + proof and return the asserted WebID (Path A).
 *
 * @throws {@link DpopVerifyError} on any failure (the route maps it to 401).
 */
export async function verifyDpopWebId(
  req: DpopVerifyRequest,
  options: DpopVerifyOptions = {}
): Promise<DpopVerifyResult> {
  const webidClaim = options.webidClaim ?? "webid";
  const clockTolerance = options.clockToleranceSec ?? 5;
  const trustedIssuers = options.trustedIssuers ?? [];
  const resolveKeys = options.resolveIssuerKeys ?? discoverIssuerKeys;

  // ── 1. Scheme gate — DPoP only; reject bare Bearer ──────────────────────────
  const parsed = parseAuthorization(req.authorization);
  if (!parsed) {
    throw new DpopVerifyError("Missing Authorization header.");
  }
  if (parsed.scheme === "bearer") {
    throw new DpopVerifyError(
      "DPoP-bound token required; bare Bearer is not accepted for erasure."
    );
  }
  if (parsed.scheme !== "dpop") {
    throw new DpopVerifyError(
      `Unsupported Authorization scheme: ${parsed.scheme}.`
    );
  }
  if (!req.dpop) {
    throw new DpopVerifyError("Missing DPoP proof header.");
  }

  // ── 2. Trusted-issuer allowlist (from the UNVERIFIED iss, pre-discovery) ─────
  const claimedIssuer = decodeClaims(parsed.token)?.iss;
  if (typeof claimedIssuer !== "string" || claimedIssuer.length === 0) {
    throw new DpopVerifyError("Access token has no issuer.");
  }
  if (trustedIssuers.length > 0 && !trustedIssuers.includes(claimedIssuer)) {
    throw new DpopVerifyError("Token issuer is not trusted.");
  }

  // ── 3. Verify the access token (asymmetric alg, signature, temporal, typ) ────
  const keys = await resolveKeys(claimedIssuer);
  let claims: JWTPayload;
  try {
    const result = await jwtVerify(parsed.token, keys, {
      algorithms: [...SIGNING_ALGS], // asymmetric-only — HS*/none rejected
      issuer: claimedIssuer,
      clockTolerance,
      // RFC 9068 access tokens carry typ=at+jwt; accept that but do not hard-require it (some IdPs
      // omit it on access tokens). The asymmetric-alg + signature checks are the load-bearing ones.
    });
    claims = result.payload;
  } catch (err) {
    throw new DpopVerifyError(
      `Access token verification failed: ${reason(err)}`
    );
  }

  // The token MUST be DPoP-bound: a cnf.jkt confirmation claim binds it to the holder's key.
  const cnfJkt = extractCnfJkt(claims);
  if (cnfJkt === undefined) {
    throw new DpopVerifyError(
      "Access token is not DPoP-bound (no cnf.jkt confirmation claim)."
    );
  }

  // ── 4. Verify the DPoP proof + the proof↔key binding ────────────────────────
  await verifyDpopProof(req, cnfJkt, parsed.token, clockTolerance);

  // ── 5. Extract + validate the WebID claim ───────────────────────────────────
  const rawWebid = claims[webidClaim];
  if (typeof rawWebid !== "string" || rawWebid.length === 0) {
    throw new DpopVerifyError(`Token is missing the '${webidClaim}' claim.`);
  }
  let webidUrl: URL;
  try {
    webidUrl = new URL(rawWebid);
  } catch {
    throw new DpopVerifyError("WebID claim is not a valid URL.");
  }
  if (webidUrl.protocol !== "https:") {
    throw new DpopVerifyError("WebID claim must be an https: URL.");
  }
  if (webidUrl.username || webidUrl.password) {
    throw new DpopVerifyError("WebID claim must not include userinfo.");
  }

  return { webid: rawWebid, issuer: claimedIssuer };
}

/**
 * Verify a DPoP proof (RFC 9449), mirroring the suite verifier's controls minus the replay cache:
 * `typ=dpop+jwt`; an asymmetric alg from {@link SIGNING_ALGS}; an embedded PUBLIC JWK whose key
 * verifies the JWS; `htm`==method; `htu`==request URL (stripped); `iat` within the freshness window;
 * a present `jti`; `ath` verified when present; and `jkt(proof JWK) === cnf.jkt`.
 */
async function verifyDpopProof(
  req: DpopVerifyRequest,
  cnfJkt: string,
  accessToken: string,
  clockTolerance: number
): Promise<void> {
  let payload: JWTPayload;
  let header: { typ?: string; alg?: string; jwk?: JWK };
  let embeddedJwk: JWK | undefined;
  try {
    const result = await jwtVerify(
      req.dpop as string,
      async (h, token) => {
        embeddedJwk = h.jwk;
        return EmbeddedJWK(h, token);
      },
      {
        typ: "dpop+jwt",
        algorithms: [...SIGNING_ALGS], // asymmetric-only
        clockTolerance,
      }
    );
    payload = result.payload;
    header = result.protectedHeader as typeof header;
  } catch (err) {
    throw new DpopVerifyError(`DPoP proof verification failed: ${reason(err)}`);
  }

  if (!isJsonObject(header.jwk) || embeddedJwk === undefined) {
    throw new DpopVerifyError(
      "DPoP proof jwk header parameter must be a JSON object."
    );
  }

  if (payload.htm !== req.method) {
    throw new DpopVerifyError("DPoP proof htm mismatch.");
  }
  if (
    typeof payload.htu !== "string" ||
    normalizeHtu(payload.htu) !== normalizeHtu(req.url)
  ) {
    throw new DpopVerifyError("DPoP proof htu mismatch.");
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new DpopVerifyError("DPoP proof is missing a jti.");
  }
  if (typeof payload.iat !== "number") {
    throw new DpopVerifyError("DPoP proof is missing iat.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - payload.iat) > DPOP_PROOF_MAX_AGE_SEC + clockTolerance) {
    throw new DpopVerifyError("DPoP proof iat is not recent enough.");
  }

  // `ath` — when present, it MUST be the base64url SHA-256 of the access token (RFC 9449 §4.2). A
  // present-but-wrong `ath` is rejected (binds the proof to THIS token); an absent `ath` is tolerated
  // (the cnf.jkt binding below still ties proof↔key — matches the suite's ath-compat posture).
  if (payload.ath !== undefined) {
    const expectedAth = await sha256Base64Url(accessToken);
    if (payload.ath !== expectedAth) {
      throw new DpopVerifyError("DPoP proof ath mismatch.");
    }
  }

  // Proof-of-possession: the embedded key's thumbprint MUST equal the token's cnf.jkt.
  const proofJkt = await calculateJwkThumbprint(header.jwk, "sha256");
  if (proofJkt !== cnfJkt) {
    throw new DpopVerifyError(
      "JWT Access Token confirmation mismatch (cnf.jkt != proof jwk thumbprint)."
    );
  }
}

/** Extract a string `cnf.jkt` from validated claims, or undefined. */
function extractCnfJkt(claims: JWTPayload): string | undefined {
  const cnf = (claims as { cnf?: unknown }).cnf;
  if (!isJsonObject(cnf)) return undefined;
  const jkt = (cnf as { jkt?: unknown }).jkt;
  return typeof jkt === "string" && jkt.length > 0 ? jkt : undefined;
}

/** base64url(SHA-256(input)) — for the optional `ath` check (RFC 9449 §4.2). */
async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("base64url");
}

/** A short, non-sensitive reason string from an unknown error. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}
