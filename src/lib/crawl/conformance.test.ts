// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * conformance.test.ts — CRAWLER conformance + security suite (pss-q2h), driven entirely by the shared
 * offline fixture server (src/lib/testing/fixtureServer.ts) + a pglite store. NEVER hits the public
 * internet: the fixture binds 127.0.0.1 and the crawler runs with `allowLoopback: true`.
 *
 * This complements crawler.test.ts (which owns the discovery/cycle/budget unit cases) by exercising
 * the SECURITY + ROBUSTNESS surface end-to-end through `runCrawlBatch`:
 *   - termination + idempotency on cycles/self-links (no infinite loop; re-crawl is a no-op);
 *   - the 304 cheap-path (a re-crawl with a matching validator does 0 profile writes);
 *   - parser bombs (deeply-nested JSON-LD / huge Turtle) are SKIPPED deterministically, never OOM;
 *   - RDFa-in-HTML is REJECTED on the content-type allowlist (the crawler never parses RDFa);
 *   - oversized bodies (over the byte cap) are SKIPPED deterministically;
 *   - a redirect-to-private chain is BLOCKED (SSRF) and the row is skipped, not retried;
 *   - a hostile foaf:knows fan-out is bounded by the shared suggestion budget.
 *
 * Security-critical paths (SSRF refusal, parser-bomb caps, content-type rejection) are tested
 * exhaustively here against canned-but-realistic hostile responses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { freshTestStore } from "@/lib/store/testStore";
import {
  type FixtureServer,
  startFixtureServer,
} from "@/lib/testing/fixtureServer";
import { type CrawlStore, runCrawlBatch } from "./crawler";

let fx: FixtureServer;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  fx.reset();
});

async function makeStore(): Promise<
  CrawlStore & Awaited<ReturnType<typeof freshTestStore>>["store"]
> {
  const { store } = await freshTestStore();
  return store;
}

/** Drive runCrawlBatch until the frontier drains (or a safety cap that proves TERMINATION). */
async function drain(
  store: CrawlStore,
  maxBatches = 60
): Promise<{
  batches: number;
  added: number;
  fetched: number;
  errors: number;
}> {
  let batches = 0;
  let added = 0;
  let fetched = 0;
  let errors = 0;
  for (; batches < maxBatches; batches += 1) {
    const s = await runCrawlBatch(store, {
      allowLoopback: true,
      batchSize: 8,
      hostCrawlDelayMs: 0,
    });
    added += s.added;
    fetched += s.fetched;
    errors += s.errors;
    if (s.claimed === 0) break;
  }
  return { batches, added, fetched, errors };
}

// ════════════════════════════════ Termination + idempotency ════════════════════════════════

describe("crawler conformance — termination + idempotency", () => {
  it("a SELF-LINK (a profile that knows itself) terminates after one crawl", async () => {
    const store = await makeStore();
    // Alice knows herself — a degenerate 1-node cycle. Must not loop.
    const me = fx.webid("/self");
    fx.serveProfile("/self", { knows: [me] });
    await store.enqueue(fx.doc("/self"), { source: "seed", depth: 0 });

    const totals = await drain(store, 10);
    expect((await store.get(fx.doc("/self")))?.state).toBe("done");
    expect((await store.get(fx.doc("/self")))?.attempts).toBe(1); // crawled exactly once
    expect(totals.added).toBe(0); // self-edge is a dedup no-op
    expect(totals.batches).toBeLessThan(5);
    expect(fx.hitCount("/self")).toBe(1); // fetched exactly once
  });

  it("RE-CRAWL is idempotent: a second drain after making rows eligible touches each doc once more, no growth", async () => {
    const store = await makeStore();
    fx.serveProfile("/a", { knows: [fx.webid("/b")] });
    fx.serveProfile("/b", {});
    await store.enqueue(fx.doc("/a"), { source: "seed", depth: 0 });
    const first = await drain(store);
    expect(first.added).toBe(1);

    // Make every done row eligible again (simulate the recrawl interval elapsing).
    for (const path of ["/a", "/b"]) {
      const rec = await store.get(fx.doc(path));
      if (rec) {
        rec.nextEligibleAt = 0;
        await store.put(rec);
      }
    }
    const second = await drain(store);
    // Re-crawl enqueues NOTHING new (both docs already exist) — the frontier does not grow.
    expect(second.added).toBe(0);
    expect((await store.get(fx.doc("/a")))?.state).toBe("done");
    // The whole doc set is still exactly two rows.
    const { rows } = await store.list({ limit: 1000 });
    expect(rows.length).toBe(2);
  });

  it("a long CYCLE A→B→C→A terminates with each node crawled exactly once", async () => {
    const store = await makeStore();
    fx.serveProfile("/x", { knows: [fx.webid("/y")] });
    fx.serveProfile("/y", { knows: [fx.webid("/z")] });
    fx.serveProfile("/z", { knows: [fx.webid("/x")] });
    await store.enqueue(fx.doc("/x"), { source: "seed", depth: 0 });
    const totals = await drain(store, 20);
    for (const p of ["/x", "/y", "/z"]) {
      expect((await store.get(fx.doc(p)))?.attempts, p).toBe(1);
      expect(fx.hitCount(p), p).toBe(1);
    }
    expect(totals.batches).toBeLessThan(8);
  });
});

// ════════════════════════════════ 304 cheap path ════════════════════════════════

describe("crawler conformance — 304 cheap path", () => {
  it("a re-crawl with a matching validator returns 304 and does 0 profile rewrites", async () => {
    const store = await makeStore();
    fx.serveProfile("/etag", { etag: '"v1"' });
    await store.enqueue(fx.doc("/etag"), { source: "seed", depth: 0 });

    await runCrawlBatch(store, { allowLoopback: true, hostCrawlDelayMs: 0 });
    const first = await store.get(fx.doc("/etag"));
    expect(first?.etag).toBe('"v1"');
    const hash1 = first?.contentHash;
    const rdf1 = first?.rawRdf;

    const rec = await store.get(fx.doc("/etag"));
    if (rec) {
      rec.nextEligibleAt = 0;
      await store.put(rec);
    }
    const summary = await runCrawlBatch(store, {
      allowLoopback: true,
      hostCrawlDelayMs: 0,
    });
    expect(summary.fetched).toBe(1);

    const after = await store.get(fx.doc("/etag"));
    expect(after?.httpStatus).toBe(304);
    expect(after?.contentHash).toBe(hash1); // preserved (no rewrite)
    expect(after?.rawRdf).toBe(rdf1);
    // The server saw the conditional request twice (first 200, then 304).
    expect(fx.hitCount("/etag")).toBe(2);
  });
});

// ════════════════════════════════ Parser bombs ════════════════════════════════

describe("crawler conformance — parser bombs are rejected deterministically (never OOM/overflow)", () => {
  it("a deeply-nested JSON-LD bomb is SKIPPED (deterministic), not retried, no crash", async () => {
    const store = await makeStore();
    fx.serveJsonLdBomb("/jsonbomb-depth", "depth");
    await store.enqueue(fx.doc("/jsonbomb-depth"), {
      source: "seed",
      depth: 0,
    });
    const summary = await runCrawlBatch(store, { allowLoopback: true });
    expect(summary.errors).toBe(1);

    // The row exists (not tombstoned) and is permanently skipped with no retry.
    const { rows } = await store.list({ state: "skipped", limit: 100 });
    const rec = rows.find((r) => r.docUrl === fx.doc("/jsonbomb-depth"));
    expect(rec?.state).toBe("skipped");
    expect(rec?.failClass).toBe("deterministic");
    expect(rec?.nextEligibleAt).toBeGreaterThan(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    );
  });

  it("a WIDE JSON-LD bomb (huge node count) is SKIPPED deterministically", async () => {
    const store = await makeStore();
    fx.serveJsonLdBomb("/jsonbomb-wide", "nodes");
    await store.enqueue(fx.doc("/jsonbomb-wide"), { source: "seed", depth: 0 });
    const summary = await runCrawlBatch(store, { allowLoopback: true });
    expect(summary.errors).toBe(1);
    const { rows } = await store.list({ state: "skipped", limit: 100 });
    const rec = rows.find((r) => r.docUrl === fx.doc("/jsonbomb-wide"));
    expect(rec?.failClass).toBe("deterministic");
  });

  it("a huge Turtle body (over MAX_QUADS) is SKIPPED deterministically", async () => {
    const store = await makeStore();
    // 200k triples >> MAX_QUADS (50k default). Either the quad cap (ParseLimitError) or the byte cap
    // fires; both are deterministic → skipped, never retried.
    fx.serveTurtleBomb("/ttlbomb", 200_000);
    await store.enqueue(fx.doc("/ttlbomb"), { source: "seed", depth: 0 });
    const summary = await runCrawlBatch(store, { allowLoopback: true });
    expect(summary.errors).toBe(1);
    const { rows } = await store.list({ state: "skipped", limit: 100 });
    const rec = rows.find((r) => r.docUrl === fx.doc("/ttlbomb"));
    expect(rec?.failClass).toBe("deterministic");
  });

  it("a bomb's neighbours are never enqueued (the body is never extracted)", async () => {
    const store = await makeStore();
    fx.serveJsonLdBomb("/bomb-fanout", "depth");
    fx.serveProfile("/should-not-appear", {});
    await store.enqueue(fx.doc("/bomb-fanout"), { source: "seed", depth: 0 });
    await drain(store);
    expect(await store.exists(fx.doc("/should-not-appear"))).toBe(false);
  });
});

// ════════════════════════════════ RDFa rejection ════════════════════════════════

describe("crawler conformance — RDFa-in-HTML is REJECTED (never parsed)", () => {
  it("a text/html RDFa doc is SKIPPED on the content-type allowlist", async () => {
    const store = await makeStore();
    fx.serveRdfaHtml("/rdfa");
    await store.enqueue(fx.doc("/rdfa"), { source: "seed", depth: 0 });
    const summary = await runCrawlBatch(store, { allowLoopback: true });
    expect(summary.errors).toBe(1);

    const { rows } = await store.list({ state: "skipped", limit: 100 });
    const rec = rows.find((r) => r.docUrl === fx.doc("/rdfa"));
    expect(rec?.state).toBe("skipped");
    expect(rec?.failClass).toBe("deterministic");
    // It was NEVER indexed as a person — no isSolid, no rawRdf.
    expect(rec?.isSolid).toBe(false);
    expect(rec?.rawRdf).toBeNull();
  });
});

// ════════════════════════════════ Oversized body ════════════════════════════════

describe("crawler conformance — oversized body over the byte cap", () => {
  it("a body larger than MAX_BYTES_PROFILE is SKIPPED deterministically (BodyTooLarge)", async () => {
    const store = await makeStore();
    fx.serveOversized("/oversized"); // > 256 KiB
    await store.enqueue(fx.doc("/oversized"), { source: "seed", depth: 0 });
    const summary = await runCrawlBatch(store, { allowLoopback: true });
    expect(summary.errors).toBe(1);
    const { rows } = await store.list({ state: "skipped", limit: 100 });
    const rec = rows.find((r) => r.docUrl === fx.doc("/oversized"));
    expect(rec?.failClass).toBe("deterministic");
  });
});

// ════════════════════════════════ Redirect-to-private (SSRF) ════════════════════════════════

describe("crawler conformance — redirect-to-private chain is BLOCKED (SSRF), skipped not retried", () => {
  it("a redirect to a cloud-metadata IP is refused and the row is permanently skipped", async () => {
    const store = await makeStore();
    fx.serveRedirect("/redir-meta", "http://169.254.169.254/latest/meta-data/");
    await store.enqueue(fx.doc("/redir-meta"), { source: "seed", depth: 0 });
    const summary = await runCrawlBatch(store, { allowLoopback: true });
    expect(summary.errors).toBe(1);

    const { rows } = await store.list({ state: "skipped", limit: 100 });
    const rec = rows.find((r) => r.docUrl === fx.doc("/redir-meta"));
    expect(rec?.state).toBe("skipped"); // SSRF refusal is deterministic
    expect(rec?.failClass).toBe("deterministic");
    expect(rec?.nextEligibleAt).toBeGreaterThan(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    );
  });

  it("a CHAIN that eventually points at a private host is blocked at the offending hop", async () => {
    const store = await makeStore();
    // /step1 → /step2 (served redirect) → 10.0.0.1 (private) — blocked on the last hop.
    fx.serveRedirect("/step1", fx.doc("/step2"));
    fx.serveRedirect("/step2", "http://10.0.0.1/internal");
    await store.enqueue(fx.doc("/step1"), { source: "seed", depth: 0 });
    const summary = await runCrawlBatch(store, { allowLoopback: true });
    expect(summary.errors).toBe(1);
    const { rows } = await store.list({ state: "skipped", limit: 100 });
    const rec = rows.find((r) => r.docUrl === fx.doc("/step1"));
    expect(rec?.failClass).toBe("deterministic");
  });
});

// ════════════════════════════════ Hostile fan-out ════════════════════════════════

describe("crawler conformance — hostile foaf:knows fan-out is bounded by the shared budget", () => {
  it("a suggestion that knows 200 children enqueues AT MOST the budget, never explodes", async () => {
    const store = await makeStore();
    const BUDGET = 5;
    const { parent: _parent } = fx.serveFanout("/hostile", 200);
    await store.enqueue(fx.doc("/hostile"), {
      source: "inbox",
      depth: 0,
      rootSeed: fx.doc("/hostile"),
      suggestBudget: BUDGET,
    });
    const totals = await drain(store);
    expect(totals.added).toBeLessThanOrEqual(BUDGET);
    expect(totals.added).toBe(BUDGET); // budget fully consumed (fan-out >> budget)

    const { rows } = await store.list({ limit: 1000 });
    const descendants = rows.filter((r) => r.docUrl !== fx.doc("/hostile"));
    expect(descendants.length).toBeLessThanOrEqual(BUDGET);
    // Only the budgeted children were ever FETCHED — the other ~195 were never dereferenced.
    let fetchedChildren = 0;
    for (let i = 0; i < 200; i += 1) {
      if (fx.hitCount(`/hostile-c${i}`) > 0) fetchedChildren += 1;
    }
    expect(fetchedChildren).toBeLessThanOrEqual(BUDGET);
  });

  it("a JSON-LD profile with a knows fan-out is parsed + bounded identically to Turtle", async () => {
    const store = await makeStore();
    const BUDGET = 3;
    const children: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      fx.serveJsonLdProfile(`/jc-${i}`, {});
      children.push(fx.webid(`/jc-${i}`));
    }
    fx.serveJsonLdProfile("/jroot", { knows: children });
    await store.enqueue(fx.doc("/jroot"), {
      source: "inbox",
      depth: 0,
      rootSeed: fx.doc("/jroot"),
      suggestBudget: BUDGET,
    });
    const totals = await drain(store);
    expect(totals.added).toBeLessThanOrEqual(BUDGET);
    expect((await store.get(fx.doc("/jroot")))?.state).toBe("done");
    expect((await store.get(fx.doc("/jroot")))?.isSolid).toBe(true);
  });
});
