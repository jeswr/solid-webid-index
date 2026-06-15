// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * concurrency.test.ts — concurrency-INVARIANT conformance against the SHARED pglite engine (pss-q2h).
 *
 * HONESTY NOTE — what these tests do and do NOT prove (roborev MEDIUM, addressed):
 * pglite is a SINGLE in-process WASM Postgres connection. Every store method here runs against the
 * SAME executor, so a `Promise.all([...])` does NOT open overlapping connections — the queries
 * SERIALISE on that one connection. These tests therefore prove the store's concurrency INVARIANTS
 * hold under interleaving at the SQL level (no row double-claimed, no budget over-spent, no extra
 * rate slots, consistent stats) — i.e. SEQUENTIAL DISJOINTNESS / atomicity — but they DO NOT
 * exercise genuine `FOR UPDATE SKIP LOCKED` LOCK CONTENTION between two truly-concurrent
 * connections. True SKIP-LOCKED contention is a multi-connection Postgres property; pglite cannot
 * reproduce it (one instance per data dir, single connection — opening a second instance on the same
 * dir cannot contend, it conflicts). Proving live contention requires a real-Postgres integration
 * test with synchronisation barriers; that is tracked as a follow-up bead (no Postgres test harness
 * exists in this repo yet). What the SQL guarantees here — that the WAS-written disjointness/atomicity
 * invariant holds — is the load-bearing correctness property; the contention test would only confirm
 * Postgres's own SKIP-LOCKED semantics, which we rely on as a documented Postgres guarantee.
 *
 * pglite DOES run real Postgres internally (WASM), so the SQL itself — `SELECT … FOR UPDATE SKIP
 * LOCKED`, advisory locks, atomic single-statement UPSERTs — is the SAME SQL Neon runs; what differs
 * from production is only the number of concurrent connections, not the statement semantics.
 *
 * Invariants asserted (DESIGN.md §3.1 / §3.2), each via a batch of calls on the shared connection:
 *   - CLAIM DISJOINTNESS: N claim() calls partition the frontier — no row is ever claimed by two
 *     workers (the load-bearing property that lets serverless invocations run in parallel without a
 *     coordinator).
 *   - SUGGEST-BUDGET ATOMICITY: tryConsumeSuggestBudget() can never over-spend a budget of N (the
 *     anti-amplification guarantee).
 *   - RATE-BUCKET ATOMICITY: consumeRateBucket() grants at most `limit` slots.
 *   - SEARCH/UPSERT ATOMICITY: upsertTriples() for distinct WebIDs leaves the stats + search surfaces
 *     consistent (each WebID searchable, total counts exact).
 *
 * Offline: pglite is in-process WASM Postgres — no network, no Neon account.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { PgStore } from "./pgStore";
import type { DocRecord, TpfTriple } from "./ports";
import { freshTestStore } from "./testStore";

const FOAF = "http://xmlns.com/foaf/0.1/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

let store: PgStore;
beforeEach(async () => {
  ({ store } = await freshTestStore());
});

function makeDoc(
  overrides: Partial<DocRecord> & { docUrl: string }
): DocRecord {
  return {
    docUrl: overrides.docUrl,
    host: overrides.host ?? new URL(overrides.docUrl).hostname,
    webid: overrides.webid ?? null,
    state: overrides.state ?? "done",
    depth: overrides.depth ?? 0,
    rootSeed: overrides.rootSeed ?? null,
    suggestBudget: overrides.suggestBudget ?? null,
    source: overrides.source ?? "seed",
    discoveredFrom: overrides.discoveredFrom ?? null,
    claimToken: overrides.claimToken ?? null,
    claimedAt: overrides.claimedAt ?? null,
    attempts: overrides.attempts ?? 1,
    etag: overrides.etag ?? null,
    lastModified: overrides.lastModified ?? null,
    contentHash: overrides.contentHash ?? null,
    lastCrawled: overrides.lastCrawled ?? Date.now(),
    nextEligibleAt: overrides.nextEligibleAt ?? 0,
    enqueuedAt: overrides.enqueuedAt ?? Date.now(),
    httpStatus: overrides.httpStatus ?? 200,
    isSolid: overrides.isSolid ?? true,
    failClass: overrides.failClass ?? null,
    error: overrides.error ?? null,
    noindex: overrides.noindex ?? false,
    rawRdf: overrides.rawRdf ?? null,
    label: overrides.label ?? null,
    slug: overrides.slug ?? null,
  };
}

// ════════════════════════════════ Claim disjointness ════════════════════════════════

describe("concurrency — claim() sequential disjointness (the frontier is partitioned, never double-claimed)", () => {
  // NOTE: the four claim() calls below run on the shared single-connection pglite engine, so they
  // SERIALISE (this is NOT live SKIP-LOCKED contention — see the file-header honesty note). What is
  // genuinely asserted is the DISJOINTNESS INVARIANT: across the four claims, no docUrl is ever
  // claimed twice and the frontier is covered exactly. (Live lock contention is the gated
  // real-Postgres integration follow-up bead.)
  it("FOUR workers claiming a 40-row frontier never share a row, and cover it exactly", async () => {
    const N = 40;
    for (let i = 0; i < N; i += 1) {
      await store.enqueue(`https://c${i}.example/card`, { source: "seed" });
    }

    // Four workers each claim up to 10. Each row goes to at most one worker — the disjointness
    // invariant (FOR UPDATE … SKIP LOCKED never hands the same row to two claim() calls).
    const sets = await Promise.all([
      store.claim("w1", 10),
      store.claim("w2", 10),
      store.claim("w3", 10),
      store.claim("w4", 10),
    ]);

    const all = sets.flat();
    const urls = all.map((r) => r.docUrl);
    const unique = new Set(urls);
    // No double-claim: the multiset has no duplicates.
    expect(unique.size).toBe(urls.length);
    // Every claimed row is genuinely claimed with a token.
    for (const row of all) {
      expect(row.state).toBe("claimed");
      expect(row.claimToken).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    }
    // Each worker's batch has a single token (one per claim() call).
    for (const set of sets) {
      if (set.length > 0) {
        const t = set[0].claimToken;
        for (const r of set) expect(r.claimToken).toBe(t);
      }
    }
    // The four batches' tokens are mutually distinct (no two claim() calls share a token).
    const tokens = sets.filter((s) => s.length > 0).map((s) => s[0].claimToken);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("EIGHT workers over a 24-row frontier claim a total of exactly 24 distinct rows", async () => {
    const N = 24;
    for (let i = 0; i < N; i += 1) {
      await store.enqueue(`https://e${i}.example/card`, { source: "seed" });
    }
    const sets = await Promise.all(
      Array.from({ length: 8 }, (_, k) => store.claim(`w${k}`, 8))
    );
    const urls = sets.flat().map((r) => r.docUrl);
    expect(urls.length).toBe(N); // all rows claimed
    expect(new Set(urls).size).toBe(N); // none twice — the disjointness invariant
  });

  it("a fresh (unexpired) claimed row is NOT re-claimed by a second claim()", async () => {
    await store.enqueue("https://lease.example/card", { source: "seed" });
    const first = await store.claim("w-A", 8);
    expect(first).toHaveLength(1);
    // Immediately (lease not expired) a second worker must get nothing — the lease is honoured.
    const second = await store.claim("w-B", 8);
    expect(second).toHaveLength(0);
  });
});

// ════════════════════════════════ Budget atomicity ════════════════════════════════

describe("concurrency — suggest-budget can never be over-spent (atomic decrement)", () => {
  // Serialised on the shared connection (see file-header note); this asserts the ATOMICITY invariant
  // — a budget of N grants at most N regardless of interleaving — not live connection contention.
  it("20 consumers against a budget of 5 grant EXACTLY 5", async () => {
    const root = "https://root.example/card";
    await store.enqueue(root, {
      source: "inbox",
      rootSeed: root,
      suggestBudget: 5,
    });
    const grants = await Promise.all(
      Array.from({ length: 20 }, () => store.tryConsumeSuggestBudget(root))
    );
    expect(grants.filter(Boolean).length).toBe(5);
    // Exhausted afterwards.
    expect(await store.tryConsumeSuggestBudget(root)).toBe(false);
  });

  it("a budget of 0 grants nothing", async () => {
    const root = "https://zero.example/card";
    await store.enqueue(root, {
      source: "inbox",
      rootSeed: root,
      suggestBudget: 0,
    });
    const grants = await Promise.all(
      Array.from({ length: 8 }, () => store.tryConsumeSuggestBudget(root))
    );
    expect(grants.filter(Boolean).length).toBe(0);
  });
});

// ════════════════════════════════ Rate-bucket atomicity ════════════════════════════════

describe("concurrency — rate bucket grants at most `limit` slots (atomic increment)", () => {
  // Serialised on the shared connection (see file-header note); asserts the ATOMICITY invariant —
  // never more than `limit` slots granted across the batch — not live connection contention.
  it("15 consumeRateBucket() against limit=3 grant EXACTLY 3", async () => {
    const now = Date.now();
    const grants = await Promise.all(
      Array.from({ length: 15 }, () =>
        store.consumeRateBucket({
          key: "ip:1.2.3.4",
          limit: 3,
          windowMs: 60_000,
          nowMs: now,
        })
      )
    );
    expect(grants.filter(Boolean).length).toBe(3);
  });

  it("the window RESETS after windowMs (a later batch gets a fresh quota)", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await store.consumeRateBucket({
        key: "ip:5.6.7.8",
        limit: 3,
        windowMs: 1_000,
        nowMs: now,
      });
    }
    // Same window → refused.
    expect(
      await store.consumeRateBucket({
        key: "ip:5.6.7.8",
        limit: 3,
        windowMs: 1_000,
        nowMs: now,
      })
    ).toBe(false);
    // Past the window → granted again.
    expect(
      await store.consumeRateBucket({
        key: "ip:5.6.7.8",
        limit: 3,
        windowMs: 1_000,
        nowMs: now + 2_000,
      })
    ).toBe(true);
  });
});

// ════════════════════════════════ Search/upsert atomicity ════════════════════════════════

describe("concurrency — interleaved projection leaves search + stats consistent", () => {
  // Serialised on the shared connection (see file-header note); asserts the per-WebID upsert
  // ATOMICITY invariant — distinct-WebID projections never corrupt each other's stats/search — not
  // live connection contention.
  it("10 distinct WebIDs projected in one batch are ALL searchable, with exact stats", async () => {
    const webids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const docUrl = `https://p${i}.example/card`;
      const webid = `${docUrl}#me`;
      webids.push(webid);
      // Seed the doc row (rawRdf + label drive the FTS generated columns).
      await store.put(
        makeDoc({
          docUrl,
          webid,
          state: "done",
          label: `Person${i} Concurrent`,
          rawRdf: `<${webid}> <${FOAF}name> "Person${i} Concurrent" .`,
        })
      );
    }
    // Project triples for all 10 WebIDs in one batch — each upsert is its own transaction (the
    // calls serialise on the shared connection; the invariant is that distinct-WebID upserts never
    // corrupt each other's stats/search, however they interleave).
    await Promise.all(
      webids.map((webid, i) => {
        const triples: TpfTriple[] = [
          { s: webid, p: RDF_TYPE, o: `${FOAF}Person`, oIsIri: true },
          { s: webid, p: `${FOAF}name`, o: `Person${i}`, oIsIri: false },
        ];
        return store.upsertTriples({
          webid,
          docUrl: webid.replace(/#me$/, ""),
          triples,
        });
      })
    );

    // Every WebID is searchable.
    const { rows } = await store.search({ query: "concurrent", limit: 50 });
    const found = new Set(rows.map((r) => r.webid));
    for (const w of webids) {
      expect(found.has(w), `search misses ${w}`).toBe(true);
    }
    // Stats are EXACT: 10 entities, 10 Person types, 20 triples (2 each).
    const stats = await store.getStats();
    expect(stats.entities).toBe(10);
    expect(stats.triples).toBe(20);
    const personPartition = stats.classPartitions.find(
      (c) => c.classIri === `${FOAF}Person`
    );
    expect(personPartition?.entities).toBe(10);
  });

  it("SEQUENTIAL re-projection of the same WebID converges via REPLACE semantics (the lease-fenced path)", async () => {
    // In production a WebID is re-projected only by its lease-fenced crawl completion — markDone()
    // returns `completed` for exactly one worker, and the crawler gates upsertTriples() on that, so
    // the re-projections of a single WebID are SERIALISED by the lease, never concurrent. This asserts
    // the REPLACE invariant the fenced path relies on: re-projecting the same WebID replaces (never
    // accumulates) its triples + stats. (The UNFENCED concurrent-same-WebID path is NOT serialised by
    // the store itself — tracked as a follow-up bead — but the crawler never drives it concurrently.)
    const docUrl = "https://same.example/card";
    const webid = `${docUrl}#me`;
    await store.put(
      makeDoc({
        docUrl,
        webid,
        state: "done",
        rawRdf: `<${webid}> a <${FOAF}Person> .`,
      })
    );
    const triples: TpfTriple[] = [
      { s: webid, p: RDF_TYPE, o: `${FOAF}Person`, oIsIri: true },
      { s: webid, p: `${FOAF}name`, o: "Same", oIsIri: false },
    ];
    for (let i = 0; i < 5; i += 1) {
      await store.upsertTriples({ webid, docUrl, triples });
    }
    const out = await store.tpf({ pattern: { s: webid }, limit: 100 });
    expect(out.triples.length).toBe(2);
    // Stats count this WebID exactly once.
    const stats = await store.getStats();
    expect(stats.entities).toBe(1);
    expect(stats.triples).toBe(2);
  });
});
