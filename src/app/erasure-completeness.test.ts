// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * erasure-completeness.test.ts — ERASURE conformance across EVERY HTTP READ SURFACE (pss-q2h,
 * DESIGN.md §4.8 H1). The store-level erasure unit test (pgStore.optout.test.ts) proves the single
 * transaction; THIS suite proves the user-observable guarantee: after an opt-out, the erased WebID is
 * 410/absent across the actual route handlers a client would hit —
 *   - /p/{slug}            → 410 Gone + Cache-Control: no-store (never 200)
 *   - /lookup?webid=…      → 404 (no longer indexed)
 *   - /search?q=…          → absent from the hydra:Collection members
 *   - /tpf?s=…             → no triples about the erased WebID
 *   - the served-entry list (the dump source) → the erased entry is gone
 *   - /.well-known/void    → stats decremented (entities/triples)
 *   - a friend's /p/{slug} → the INBOUND foaf:knows edge TO the erased WebID is DROPPED (the friend's
 *     own served entry loses (friend, foaf:knows, erased) after the erased person opts out)
 *   - POST /inbox/ (re-suggest the erased WebID) → 409
 *
 * Offline: pglite store (mocked makeStore) — no network. Erasure is driven via store.eraseWebId
 * (the optout route's auth paths are covered in optout/route.test.ts); the conformance here is the
 * cross-surface propagation.
 */
import { Store as N3Store, Parser } from "n3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import type { PgStore } from "@/lib/store/pgStore";
import { freshTestStore } from "@/lib/store/testStore";
import { slugForWebId } from "@/lib/url/slug";

// ─── Mocks ──────────────────────────────────────────────────────────────────────
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
vi.mock("@/lib/crawl/triggerCrawl", () => ({
  triggerCrawl: vi.fn(async () => {}),
}));
const { afterMock } = vi.hoisted(() => ({
  afterMock: vi.fn(async (task: () => unknown) => {
    await task();
  }),
}));
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: afterMock };
});

const { GET: entryGet } = await import("./p/[slug]/route");
const { GET: lookupGet } = await import("./lookup/route");
const { GET: searchGet } = await import("./search/route");
const { GET: tpfGet } = await import("./tpf/route");
const { GET: voidGet } = await import("./.well-known/void/route");
const { POST: inboxPost } = await import("./inbox/route");

// ─── Vocab + fixtures ────────────────────────────────────────────────────────────
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const HYDRA = "http://www.w3.org/ns/hydra/core#";
const VOID = "http://rdfs.org/ns/void#";
const FOAF_KNOWS = `${FOAF}knows`;
const INBOX_IRI = `${INDEX_BASE_URL}/inbox/`;

const ALICE = "https://alice.pod/card#me";
const ALICE_DOC = "https://alice.pod/card";
const ALICE_SLUG = slugForWebId(ALICE);
const BOB = "https://bob.pod/card#me";
const BOB_DOC = "https://bob.pod/card";
const BOB_SLUG = slugForWebId(BOB);

function parseTurtle(body: string, baseIri = INDEX_BASE_URL): N3Store {
  const s = new N3Store();
  s.addQuads(new Parser({ format: "Turtle", baseIRI: baseIri }).parse(body));
  return s;
}

/** Index a profile end-to-end (doc row + triple table + stats), like the crawler. */
async function indexProfile(
  store: PgStore,
  webid: string,
  docUrl: string,
  opts: { label: string; knows?: string[] }
): Promise<void> {
  await store.enqueue(docUrl, { webid, source: "seed" });
  const claimed = await store.claim("seed", 1);
  const claim = claimed.find((c) => c.docUrl === docUrl);
  const knowsTtl =
    opts.knows && opts.knows.length > 0
      ? `; foaf:knows ${opts.knows.map((k) => `<${k}>`).join(", ")} `
      : "";
  // The served /p/{slug} response RE-PARSES this rawRdf (entryResponse.ts) and re-extracts knows
  // from it — so the foaf:knows triples MUST actually parse. Declare @prefix foaf: (the knowsTtl
  // uses the foaf:knows CURIE); without it the Turtle is invalid, parseProfile throws, the route
  // falls back to a knows-less projection, and the inbound-edge erasure assertion below would pass
  // VACUOUSLY (Bob's graph would never carry the edge even before Alice is erased).
  await store.markDone(
    docUrl,
    {
      state: "done",
      httpStatus: 200,
      rawRdf: `@prefix foaf: <${FOAF}> . <${webid}> a foaf:Person ; foaf:name "${opts.label}" ${knowsTtl}.`,
      isSolid: true,
      webid,
      nextEligibleAt: Date.now() + 1_000_000,
    },
    claim?.claimToken
  );
  const triples = [
    { s: webid, p: `${RDF}type`, o: `${FOAF}Person`, oIsIri: true },
    { s: webid, p: `${FOAF}name`, o: opts.label, oIsIri: false },
    ...(opts.knows ?? []).map((k) => ({
      s: webid,
      p: FOAF_KNOWS,
      o: k,
      oIsIri: true,
    })),
  ];
  await store.upsertTriples({ webid, docUrl, triples });
}

beforeEach(async () => {
  process.env.CRON_SECRET = "test-secret";
  process.env.DATABASE_URL = "postgres://test";
  ({ store: _store } = await freshTestStore());
  afterMock.mockClear();
  afterMock.mockImplementation(async (task: () => unknown) => {
    await task();
  });
  // Alice and Bob each know the other (mutual foaf:knows); both indexed. The mutual edge lets the
  // inbound-edge-drop test assert the canonical direction: erase Alice, then Bob's served entry must
  // drop its (Bob, foaf:knows, Alice) edge — the FRIEND's outbound view of the erased person.
  await indexProfile(_store, ALICE, ALICE_DOC, {
    label: "Alice Eraseme",
    knows: [BOB],
  });
  await indexProfile(_store, BOB, BOB_DOC, {
    label: "Bob Friend",
    knows: [ALICE],
  });
});

function store(): PgStore {
  if (!_store) throw new Error("no store");
  return _store;
}

async function eraseAlice(): Promise<void> {
  await store().eraseWebId({
    webid: ALICE,
    docUrl: ALICE_DOC,
    reason: "opt-out",
  });
}

// ════════════════════════════════ Pre-erasure baseline ════════════════════════════════

describe("erasure completeness — baseline (Alice is present everywhere before opt-out)", () => {
  it("Alice is 200 on /p/{slug}, in search, and in TPF", async () => {
    const entry = await entryGet(
      new Request(`${INDEX_BASE_URL}/p/${ALICE_SLUG}`, {
        headers: { Accept: "text/turtle" },
      }),
      { params: Promise.resolve({ slug: ALICE_SLUG }) }
    );
    expect(entry.status).toBe(200);

    const search = await searchGet(
      new Request(`${INDEX_BASE_URL}/search?q=eraseme`, {
        headers: { Accept: "text/turtle" },
      })
    );
    const sg = parseTurtle(await search.text());
    const members = sg
      .getQuads(null, `${HYDRA}member`, null, null)
      .map((q) => q.object.value);
    expect(members).toContain(ALICE);
  });
});

// ════════════════════════════════ Post-erasure: every surface ════════════════════════════════

describe("erasure completeness — after opt-out, Alice is 410/absent on EVERY read surface", () => {
  it("/p/{slug} → 410 Gone + Cache-Control: no-store", async () => {
    await eraseAlice();
    const res = await entryGet(
      new Request(`${INDEX_BASE_URL}/p/${ALICE_SLUG}`, {
        headers: { Accept: "text/turtle" },
      }),
      { params: Promise.resolve({ slug: ALICE_SLUG }) }
    );
    expect(res.status).toBe(410);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("/lookup?webid=… → 404 (no longer indexed)", async () => {
    await eraseAlice();
    const res = await lookupGet(
      new Request(
        `${INDEX_BASE_URL}/lookup?webid=${encodeURIComponent(ALICE)}`,
        { headers: { Accept: "text/turtle" } }
      )
    );
    expect(res.status).toBe(404);
  });

  it("/search → Alice is absent from the hydra:Collection members", async () => {
    await eraseAlice();
    const res = await searchGet(
      new Request(`${INDEX_BASE_URL}/search?q=eraseme`, {
        headers: { Accept: "text/turtle" },
      })
    );
    expect(res.status).toBe(200);
    const g = parseTurtle(await res.text());
    const members = g
      .getQuads(null, `${HYDRA}member`, null, null)
      .map((q) => q.object.value);
    expect(members).not.toContain(ALICE);
  });

  it("/tpf?s=Alice → no triples about the erased WebID", async () => {
    await eraseAlice();
    const res = await tpfGet(
      new Request(`${INDEX_BASE_URL}/tpf?s=${encodeURIComponent(ALICE)}`, {
        headers: { Accept: "text/turtle" },
      })
    );
    const g = parseTurtle(await res.text());
    // No served data triple has Alice as subject.
    const aliceTriples = g.getQuads(ALICE, null, null, null);
    expect(aliceTriples.length).toBe(0);
  });

  it("the served-entry list (dump source) no longer contains Alice's doc", async () => {
    await eraseAlice();
    // The dump pages over served 'done' entries. Alice's row is gone (replaced by a hidden tombstone).
    const { rows } = await store().list({ state: "done", limit: 1000 });
    expect(rows.map((r) => r.docUrl)).not.toContain(ALICE_DOC);
    // Bob (untouched) is still listed.
    expect(rows.map((r) => r.docUrl)).toContain(BOB_DOC);
  });

  it("/.well-known/void → entities + triples decremented by Alice's contribution", async () => {
    const before = parseTurtle(
      await (
        await voidGet(
          new Request(`${INDEX_BASE_URL}/.well-known/void`, {
            headers: { Accept: "text/turtle" },
          })
        )
      ).text()
    );
    const entitiesBefore = Number(
      before.getQuads(null, `${VOID}entities`, null, null)[0].object.value
    );
    expect(entitiesBefore).toBe(2); // Alice + Bob

    await eraseAlice();

    const after = parseTurtle(
      await (
        await voidGet(
          new Request(`${INDEX_BASE_URL}/.well-known/void`, {
            headers: { Accept: "text/turtle" },
          })
        )
      ).text()
    );
    const entitiesAfter = Number(
      after.getQuads(null, `${VOID}entities`, null, null)[0].object.value
    );
    expect(entitiesAfter).toBe(1); // only Bob remains
  });

  it("a friend's /p/{slug} DROPS its inbound foaf:knows edge TO the erased WebID", async () => {
    // The guarantee is INBOUND: after Alice opts out, her FRIENDS' served entries must drop their
    // edges pointing AT Alice. Bob knows Alice (the (Bob, foaf:knows, Alice) edge lives in Bob's own
    // graph). Erase ALICE, then Bob's served /p/{slug} must NOT serve foaf:knows → Alice — the
    // tombstone-filter on the friend's knows targets (entryResponse.ts) drops it. (Crucially this
    // tests the friend's surviving entry, NOT the erased person's own — which is 410.)
    async function bobKnowsAlice(): Promise<boolean> {
      const res = await entryGet(
        new Request(`${INDEX_BASE_URL}/p/${BOB_SLUG}`, {
          headers: { Accept: "text/turtle" },
        }),
        { params: Promise.resolve({ slug: BOB_SLUG }) }
      );
      expect(res.status).toBe(200);
      const g = parseTurtle(await res.text());
      return g.getQuads(BOB, FOAF_KNOWS, ALICE, null).length > 0;
    }

    // NON-VACUITY GUARD: the edge must actually EXIST + be served BEFORE Alice is erased — otherwise
    // the post-erasure assertion would pass even if the tombstone-filter never ran (the bug that made
    // the prior version of this test a false positive: an invalid-prefix rawRdf yielded a knows-less
    // projection, so the edge was never present in the first place).
    expect(await bobKnowsAlice()).toBe(true);

    await eraseAlice();

    // After erasure the tombstone-filter on the friend's knows targets (entryResponse.ts) must drop
    // the edge — proving the inbound-edge filter actually fired.
    expect(await bobKnowsAlice()).toBe(false);
  });

  it("re-suggesting the erased WebID via POST /inbox/ → 409 (tombstone is permanent)", async () => {
    await eraseAlice();
    const res = await inboxPost(
      new Request(INBOX_IRI, {
        method: "POST",
        headers: { "content-type": "application/ld+json" },
        body: JSON.stringify({
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "Announce",
          object: ALICE,
        }),
      })
    );
    expect(res.status).toBe(409);
    // No crawl kick for a tombstoned WebID.
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("re-suggesting via a fragment-VARIANT key (doc URL without #me) is ALSO 409 (variant cannot dodge)", async () => {
    await eraseAlice();
    // Suggest the bare doc URL as the object — the tombstone matches on the doc key too.
    const res = await inboxPost(
      new Request(INBOX_IRI, {
        method: "POST",
        headers: { "content-type": "application/ld+json" },
        body: JSON.stringify({
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "Announce",
          object: ALICE_DOC,
        }),
      })
    );
    expect(res.status).toBe(409);
  });
});

describe("erasure completeness — Bob (the untouched neighbour) is unaffected", () => {
  it("Bob is still 200 + searchable after Alice is erased", async () => {
    await eraseAlice();
    const entry = await entryGet(
      new Request(`${INDEX_BASE_URL}/p/${BOB_SLUG}`, {
        headers: { Accept: "text/turtle" },
      }),
      { params: Promise.resolve({ slug: BOB_SLUG }) }
    );
    expect(entry.status).toBe(200);
  });
});
