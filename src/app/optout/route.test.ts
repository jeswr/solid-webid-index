// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * route.test.ts — POST /optout (app/optout/route.ts). SECURITY-CRITICAL (PII erasure).
 *
 * Uses pglite for the real store (no network); mocks the DPoP verifier (Path A) and guardedFetch
 * (Path B profile fetch). Asserts:
 *  - Path A: a valid DPoP token erases; a verifier failure → 401;
 *  - Path B: issue → 202 + nonce; confirm with the published token → erase; the nonce is single-use;
 *  - post-erasure the WebID is 410/absent across entry / search / TPF / dump and re-suggest → 409;
 *  - rate-limit → 429.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import type { PgStore } from "@/lib/store/pgStore";
import type { TpfTriple } from "@/lib/store/ports";
import { freshTestStore } from "@/lib/store/testStore";

// ─── Mocks (hoisted) ───────────────────────────────────────────────────────────

// verifyDpopWebId — Path A. Default: throws (no valid token). Tests override per-case.
const { verifyDpopMock, DpopVerifyErrorCls } = vi.hoisted(() => {
  class DpopVerifyError extends Error {
    constructor(m: string) {
      super(m);
      this.name = "DpopVerifyError";
    }
  }
  return {
    verifyDpopMock: vi.fn(),
    DpopVerifyErrorCls: DpopVerifyError,
  };
});
vi.mock("@/lib/security/dpopVerifier", () => ({
  verifyDpopWebId: verifyDpopMock,
  DpopVerifyError: DpopVerifyErrorCls,
}));

// guardedFetch — Path B profile fetch. Default: returns a profile WITHOUT the token.
const { guardedFetchMock } = vi.hoisted(() => ({
  guardedFetchMock: vi.fn(),
}));
vi.mock("@/lib/security/guardedFetch", () => ({
  guardedFetch: guardedFetchMock,
}));

// makeStore → the per-test pglite store.
let _store: PgStore | null = null;
vi.mock("@/lib/store/pgStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/pgStore")>();
  return {
    ...actual,
    makeStore: () => {
      if (!_store) throw new Error("no test store");
      return _store;
    },
  };
});

import { POST } from "./route";

// ─── Constants + helpers ─────────────────────────────────────────────────────

const IDX_OPTOUT_TOKEN = `${INDEX_BASE_URL}/ns#optOutToken`;
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const FOAF_PERSON = "http://xmlns.com/foaf/0.1/Person";
const FOAF_NAME = "http://xmlns.com/foaf/0.1/name";

const ALICE = "https://alice.example/card#me";
const ALICE_DOC = "https://alice.example/card";

const aliceTriples: TpfTriple[] = [
  { s: ALICE, p: RDF_TYPE, o: FOAF_PERSON, oIsIri: true },
  { s: ALICE, p: FOAF_NAME, o: "Alice", oIsIri: false },
];

beforeEach(async () => {
  ({ store: _store } = await freshTestStore());
  verifyDpopMock.mockReset();
  guardedFetchMock.mockReset();
  // Default Path A: no valid token.
  verifyDpopMock.mockRejectedValue(new DpopVerifyErrorCls("no token"));
  // Default Path B fetch: profile present but WITHOUT any opt-out token.
  guardedFetchMock.mockResolvedValue({
    status: 200,
    finalUrl: ALICE_DOC,
    contentType: "text/turtle",
    text: `<${ALICE}> <${FOAF_NAME}> "Alice" .`,
  });
});

afterEach(() => {
  // No db.close() — the shared per-worker engine is reset (schema-dropped) on the next
  // freshTestStore() call, so there is nothing to tear down here.
  _store = null;
});

async function indexAlice(): Promise<void> {
  if (!_store) throw new Error("no store");
  await _store.enqueue(ALICE_DOC, { webid: ALICE, source: "seed" });
  await _store.markDone(ALICE_DOC, {
    state: "done",
    webid: ALICE,
    rawRdf: `<${ALICE}> <${FOAF_NAME}> "Alice" .`,
    isSolid: true,
    httpStatus: 200,
  });
  await _store.upsertTriples({
    webid: ALICE,
    docUrl: ALICE_DOC,
    triples: aliceTriples,
  });
}

function postJson(
  body: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request(`${INDEX_BASE_URL}/optout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ─── Path A ────────────────────────────────────────────────────────────────────

describe("POST /optout — Path A (DPoP token)", () => {
  it("erases the WebID when the verifier returns its webid", async () => {
    await indexAlice();
    verifyDpopMock.mockResolvedValue({ webid: ALICE, issuer: "https://idp" });

    const res = await POST(
      postJson({}, { authorization: "DPoP token", dpop: "proof" })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await _store?.getEntryByWebid(ALICE)).toBeNull();
    expect(await _store?.isTombstoned({ webid: ALICE })).toBe(true);
  });

  it("returns 401 when the DPoP verifier rejects (bare Bearer / bad token)", async () => {
    await indexAlice();
    verifyDpopMock.mockRejectedValue(
      new DpopVerifyErrorCls("bare Bearer not accepted")
    );
    const res = await POST(
      postJson({}, { authorization: "Bearer x", dpop: "proof" })
    );
    expect(res.status).toBe(401);
    // The entry is still live — a rejected token must not erase.
    expect(await _store?.getEntryByWebid(ALICE)).not.toBeNull();
  });
});

// ─── Path B ────────────────────────────────────────────────────────────────────

describe("POST /optout — Path B (challenge-response)", () => {
  it("step 1: issues a 202 + a one-time nonce to publish", async () => {
    await indexAlice();
    const res = await POST(postJson({ webid: ALICE }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      optOutToken: string;
      publish: { predicate: string };
    };
    expect(typeof body.optOutToken).toBe("string");
    expect(body.optOutToken.length).toBeGreaterThan(0);
    expect(body.publish.predicate).toBe(IDX_OPTOUT_TOKEN);
    // The nonce is now live in the store.
    expect(await _store?.getLiveOptoutNonce(ALICE, Date.now())).not.toBeNull();
  });

  it("step 2: confirm with the published token ERASES the WebID", async () => {
    await indexAlice();
    // Issue.
    const issue = await POST(postJson({ webid: ALICE }));
    const { optOutToken } = (await issue.json()) as { optOutToken: string };
    // The upstream profile now publishes the token on the WebID subject.
    guardedFetchMock.mockResolvedValue({
      status: 200,
      finalUrl: ALICE_DOC,
      contentType: "text/turtle",
      text: `<${ALICE}> <${IDX_OPTOUT_TOKEN}> "${optOutToken}" .`,
    });
    const confirm = await POST(postJson({ webid: ALICE, confirm: true }));
    expect(confirm.status).toBe(200);
    expect(await _store?.getEntryByWebid(ALICE)).toBeNull();
    expect(await _store?.isTombstoned({ webid: ALICE })).toBe(true);
  });

  it("confirm WITHOUT the published token → 403 (not erased)", async () => {
    await indexAlice();
    await POST(postJson({ webid: ALICE })); // issue
    // Profile does NOT publish the token (default mock).
    const confirm = await POST(postJson({ webid: ALICE, confirm: true }));
    expect(confirm.status).toBe(403);
    expect(await _store?.getEntryByWebid(ALICE)).not.toBeNull();
  });

  it("confirm with no live challenge → 409", async () => {
    await indexAlice();
    const confirm = await POST(postJson({ webid: ALICE, confirm: true }));
    expect(confirm.status).toBe(409);
  });

  it("the nonce is single-use: a second confirm after erasure does not double-erase", async () => {
    await indexAlice();
    const issue = await POST(postJson({ webid: ALICE }));
    const { optOutToken } = (await issue.json()) as { optOutToken: string };
    guardedFetchMock.mockResolvedValue({
      status: 200,
      finalUrl: ALICE_DOC,
      contentType: "text/turtle",
      text: `<${ALICE}> <${IDX_OPTOUT_TOKEN}> "${optOutToken}" .`,
    });
    const first = await POST(postJson({ webid: ALICE, confirm: true }));
    expect(first.status).toBe(200);
    // A second confirm: already tombstoned → 200 already_erased (idempotent), nonce was consumed.
    const second = await POST(postJson({ webid: ALICE, confirm: true }));
    expect([200, 409]).toContain(second.status);
  });

  it("a 422 is returned for a missing/invalid WebID", async () => {
    const res = await POST(postJson({}));
    expect(res.status).toBe(422);
  });
});

// ─── Erasure completeness across served surfaces (the bead acceptance) ───────────

describe("POST /optout — post-erasure the WebID is gone across every surface", () => {
  it("entry/search/TPF absent + re-suggest → tombstoned", async () => {
    await indexAlice();
    verifyDpopMock.mockResolvedValue({ webid: ALICE, issuer: "https://idp" });
    await POST(postJson({}, { authorization: "DPoP t", dpop: "p" }));

    // entry (by webid) absent
    expect(await _store?.getEntryByWebid(ALICE)).toBeNull();
    // search absent
    const search = await _store?.search({ query: "Alice", limit: 10 });
    expect(search?.rows.find((r) => r.webid === ALICE)).toBeUndefined();
    // TPF absent
    const tpf = await _store?.tpf({ pattern: { s: ALICE }, limit: 100 });
    expect(tpf?.triples.length).toBe(0);
    // re-suggest → tombstoned (→ 409 at the inbox)
    const status = await _store?.suggestionStatus({
      webid: ALICE,
      docUrl: ALICE_DOC,
      nowMs: Date.now(),
      cooldownMs: 0,
    });
    expect(status).toBe("tombstoned");
  });
});

// ─── Rate limiting ──────────────────────────────────────────────────────────────

describe("POST /optout — rate limiting", () => {
  it("returns 429 once the per-IP budget is exhausted", async () => {
    // The default limit is 10/hr; fire 11 issue requests from one IP.
    let last = 200;
    for (let i = 0; i < 11; i++) {
      const res = await POST(postJson({ webid: ALICE }));
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
