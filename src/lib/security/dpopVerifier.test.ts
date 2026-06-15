// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * dpopVerifier.test.ts — exhaustive tests for the opt-out Path A DPoP token verifier
 * (lib/security/dpopVerifier.ts). SECURITY-CRITICAL.
 *
 * Mints real ES256 access tokens + DPoP proofs offline with jose and injects an inline JWKS resolver
 * (no network). Asserts the load-bearing controls:
 *   - a valid DPoP-bound token returns the webid;
 *   - a bare Bearer token is REJECTED;
 *   - a symmetric (HS256) access token is REJECTED;
 *   - a missing DPoP proof is REJECTED;
 *   - a cnf.jkt that does not match the proof key is REJECTED (proof-of-possession);
 *   - htm / htu / iat-freshness mismatches are REJECTED;
 *   - a non-https / missing webid claim is REJECTED;
 *   - the trusted-issuer allowlist is enforced.
 */

import {
  type JWK,
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DpopVerifyError,
  localIssuerKeys,
  verifyDpopWebId,
} from "./dpopVerifier";

const ISSUER = "https://idp.example";
const WEBID = "https://alice.example/card#me";
const HTU = "https://index.example/optout";

// ─── Key material (generated once) ──────────────────────────────────────────────

let idpPrivate: CryptoKey; // signs the access token
let idpPublicJwk: JWK; // published JWKS (for verification)
let holderPrivate: CryptoKey; // signs the DPoP proof
let holderPublicJwk: JWK; // embedded in the proof header
let holderJkt: string; // thumbprint → token cnf.jkt
let resolveIssuerKeys: (
  issuer: string
) => Promise<ReturnType<typeof localIssuerKeys>>;

beforeAll(async () => {
  const idp = await generateKeyPair("ES256", { extractable: true });
  idpPrivate = idp.privateKey;
  idpPublicJwk = await exportJWK(idp.publicKey);
  idpPublicJwk.kid = "idp-1";
  idpPublicJwk.alg = "ES256";

  const holder = await generateKeyPair("ES256", { extractable: true });
  holderPrivate = holder.privateKey;
  holderPublicJwk = await exportJWK(holder.publicKey);
  holderPublicJwk.alg = "ES256";
  holderJkt = await calculateJwkThumbprint(holderPublicJwk, "sha256");

  const keys = localIssuerKeys({ keys: [idpPublicJwk] });
  resolveIssuerKeys = async () => keys;
});

// ─── Token + proof factories ─────────────────────────────────────────────────────

async function mintAccessToken(
  overrides: {
    webid?: string;
    omitWebid?: boolean;
    cnfJkt?: string;
    omitCnf?: boolean;
    alg?: "ES256";
  } = {}
): Promise<string> {
  const payload: Record<string, unknown> = {
    client_id: "https://app.example/id",
    sub: "alice",
  };
  if (!overrides.omitWebid) {
    payload.webid = overrides.webid ?? WEBID;
  }
  if (!overrides.omitCnf) {
    payload.cnf = { jkt: overrides.cnfJkt ?? holderJkt };
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "idp-1" })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti("at-jti-1")
    .sign(idpPrivate);
}

async function mintDpopProof(
  overrides: {
    htm?: string;
    htu?: string;
    iat?: number;
    omitJti?: boolean;
    jwk?: JWK;
  } = {}
): Promise<string> {
  const jwk = overrides.jwk ?? holderPublicJwk;
  const builder = new SignJWT({
    htm: overrides.htm ?? "POST",
    htu: overrides.htu ?? HTU,
  }).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk });
  if (overrides.iat !== undefined) builder.setIssuedAt(overrides.iat);
  else builder.setIssuedAt();
  if (!overrides.omitJti) builder.setJti("proof-jti-1");
  return builder.sign(holderPrivate);
}

function req(
  token: string,
  proof: string | undefined,
  scheme = "DPoP"
): Parameters<typeof verifyDpopWebId>[0] {
  return {
    authorization: `${scheme} ${token}`,
    dpop: proof,
    method: "POST",
    url: HTU,
  };
}

const opts = () => ({ resolveIssuerKeys });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("verifyDpopWebId — happy path", () => {
  it("returns the webid for a valid DPoP-bound token + proof", async () => {
    const token = await mintAccessToken();
    const proof = await mintDpopProof();
    const result = await verifyDpopWebId(req(token, proof), opts());
    expect(result.webid).toBe(WEBID);
    expect(result.issuer).toBe(ISSUER);
  });

  it("tolerates an absent ath (key binding still enforced)", async () => {
    // The proof carries no ath; cnf.jkt↔proof-key binding is the proof of possession.
    const token = await mintAccessToken();
    const proof = await mintDpopProof();
    await expect(
      verifyDpopWebId(req(token, proof), opts())
    ).resolves.toBeTruthy();
  });
});

describe("verifyDpopWebId — scheme + proof presence", () => {
  it("REJECTS a bare Bearer token", async () => {
    const token = await mintAccessToken();
    const proof = await mintDpopProof();
    await expect(
      verifyDpopWebId(req(token, proof, "Bearer"), opts())
    ).rejects.toBeInstanceOf(DpopVerifyError);
  });

  it("REJECTS a DPoP scheme with no proof header", async () => {
    const token = await mintAccessToken();
    await expect(
      verifyDpopWebId(req(token, undefined), opts())
    ).rejects.toThrow(/proof/i);
  });

  it("REJECTS a missing Authorization header", async () => {
    await expect(
      verifyDpopWebId(
        { authorization: undefined, dpop: "x", method: "POST", url: HTU },
        opts()
      )
    ).rejects.toBeInstanceOf(DpopVerifyError);
  });
});

describe("verifyDpopWebId — asymmetric-only", () => {
  it("REJECTS a symmetric (HS256) access token", async () => {
    const secret = new TextEncoder().encode("a".repeat(48));
    const token = await new SignJWT({
      webid: WEBID,
      sub: "alice",
      client_id: "c",
      cnf: { jkt: holderJkt },
    })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti("at-jti-hs")
      .sign(secret);
    const proof = await mintDpopProof();
    await expect(
      verifyDpopWebId(req(token, proof), opts())
    ).rejects.toBeInstanceOf(DpopVerifyError);
  });
});

describe("verifyDpopWebId — proof-of-possession binding", () => {
  it("REJECTS when cnf.jkt does not match the proof key", async () => {
    // Token bound to a DIFFERENT key's thumbprint than the proof carries.
    const token = await mintAccessToken({ cnfJkt: "wrong-thumbprint" });
    const proof = await mintDpopProof();
    await expect(verifyDpopWebId(req(token, proof), opts())).rejects.toThrow(
      /confirmation mismatch|thumbprint/i
    );
  });

  it("REJECTS a token with no cnf.jkt (not DPoP-bound)", async () => {
    const token = await mintAccessToken({ omitCnf: true });
    const proof = await mintDpopProof();
    await expect(verifyDpopWebId(req(token, proof), opts())).rejects.toThrow(
      /not DPoP-bound|cnf/i
    );
  });

  it("REJECTS a proof signed by a key not matching its embedded jwk", async () => {
    // Embed the IDP's public key in the proof header but sign with the holder key → signature fails.
    const proof = await mintDpopProof({ jwk: idpPublicJwk });
    const token = await mintAccessToken();
    await expect(
      verifyDpopWebId(req(token, proof), opts())
    ).rejects.toBeInstanceOf(DpopVerifyError);
  });
});

describe("verifyDpopWebId — proof claims", () => {
  it("REJECTS an htm mismatch", async () => {
    const token = await mintAccessToken();
    const proof = await mintDpopProof({ htm: "GET" });
    await expect(verifyDpopWebId(req(token, proof), opts())).rejects.toThrow(
      /htm/i
    );
  });

  it("REJECTS an htu mismatch", async () => {
    const token = await mintAccessToken();
    const proof = await mintDpopProof({ htu: "https://evil.example/optout" });
    await expect(verifyDpopWebId(req(token, proof), opts())).rejects.toThrow(
      /htu/i
    );
  });

  it("REJECTS a stale proof (iat far in the past)", async () => {
    const token = await mintAccessToken();
    const stale = Math.floor(Date.now() / 1000) - 10_000;
    const proof = await mintDpopProof({ iat: stale });
    await expect(verifyDpopWebId(req(token, proof), opts())).rejects.toThrow(
      /iat/i
    );
  });

  it("REJECTS a proof with no jti", async () => {
    const token = await mintAccessToken();
    const proof = await mintDpopProof({ omitJti: true });
    await expect(verifyDpopWebId(req(token, proof), opts())).rejects.toThrow(
      /jti/i
    );
  });
});

describe("verifyDpopWebId — webid claim", () => {
  it("REJECTS a missing webid claim", async () => {
    const token = await mintAccessToken({ omitWebid: true });
    const proof = await mintDpopProof();
    await expect(verifyDpopWebId(req(token, proof), opts())).rejects.toThrow(
      /webid/i
    );
  });

  it("REJECTS a non-https webid claim", async () => {
    const token = await mintAccessToken({
      webid: "http://alice.example/card#me",
    });
    const proof = await mintDpopProof();
    await expect(verifyDpopWebId(req(token, proof), opts())).rejects.toThrow(
      /https/i
    );
  });
});

describe("verifyDpopWebId — trusted-issuer allowlist", () => {
  it("REJECTS an issuer outside the allowlist (before discovery)", async () => {
    const token = await mintAccessToken();
    const proof = await mintDpopProof();
    await expect(
      verifyDpopWebId(req(token, proof), {
        ...opts(),
        trustedIssuers: ["https://other.example"],
      })
    ).rejects.toThrow(/not trusted/i);
  });

  it("ACCEPTS an issuer in the allowlist", async () => {
    const token = await mintAccessToken();
    const proof = await mintDpopProof();
    const result = await verifyDpopWebId(req(token, proof), {
      ...opts(),
      trustedIssuers: [ISSUER],
    });
    expect(result.webid).toBe(WEBID);
  });
});
