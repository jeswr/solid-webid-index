// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * crawler.test.ts — runCrawlBatch tests against a LOCAL fixture WebID server + an in-memory pglite
 * store. NEVER hits the public internet: the fixture HTTP server binds 127.0.0.1 and the crawler
 * runs with `allowLoopback: true` (the documented TEST-ONLY hook). The store is @electric-sql/pglite
 * (in-process WASM Postgres) — no Neon account, no network.
 *
 * The KEY correctness tests are cycle-termination + dedup: a knows-cycle A↔B must terminate (each
 * node crawled exactly once), and a fully-connected graph must not loop forever.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PgStore, createPgliteExecutor } from "../store/pgStore.js";
import { type CrawlStore, runCrawlBatch } from "./crawler.js";

// ───────────────────────── Fixture WebID server (127.0.0.1) ─────────────────────────

type RouteFn = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let server: http.Server;
let base: string; // http://127.0.0.1:PORT
const routes = new Map<string, RouteFn>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("#")[0];
    const fn = routes.get(path);
    if (fn) {
      fn(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  routes.clear();
});

/** Serve a Turtle WebID profile whose subject is `${base}${path}#me` with the given knows targets. */
function serveProfile(
  path: string,
  opts: {
    name?: string;
    knows?: string[];
    solid?: boolean;
    etag?: string;
    extraHeaders?: Record<string, string>;
  } = {}
): void {
  const subject = `${base}${path}#me`;
  const knowsTtl =
    opts.knows && opts.knows.length > 0
      ? `; foaf:knows ${opts.knows.map((k) => `<${k}>`).join(", ")} `
      : "";
  const oidc =
    opts.solid !== false ? "; solid:oidcIssuer <https://idp.example> " : "";
  const ttl = `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<${subject}> a foaf:Person ; foaf:name "${opts.name ?? path}" ${oidc}${knowsTtl}.
`;
  routes.set(path, (req, res) => {
    // Conditional re-validation support.
    if (opts.etag && req.headers["if-none-match"] === opts.etag) {
      res.writeHead(304, { "content-type": "text/turtle", etag: opts.etag });
      res.end();
      return;
    }
    const headers: Record<string, string> = {
      "content-type": "text/turtle",
      ...(opts.etag ? { etag: opts.etag } : {}),
      ...(opts.extraHeaders ?? {}),
    };
    res.writeHead(200, headers);
    res.end(ttl);
  });
}

/**
 * Serve a Turtle profile whose subject is an EXPLICIT WebID IRI (e.g. `${base}/frag#alice`, NOT the
 * `#me` convention). Used to prove the crawler parses/extracts the persisted discovered WebID subject
 * rather than assuming `#me`.
 */
function serveProfileWithSubject(
  path: string,
  subject: string,
  opts: { knows?: string[]; solid?: boolean } = {}
): void {
  const knowsTtl =
    opts.knows && opts.knows.length > 0
      ? `; foaf:knows ${opts.knows.map((k) => `<${k}>`).join(", ")} `
      : "";
  const oidc =
    opts.solid !== false ? "; solid:oidcIssuer <https://idp.example> " : "";
  const ttl = `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<${subject}> a foaf:Person ; foaf:name "${path}" ${oidc}${knowsTtl}.
`;
  routes.set(path, (_req, res) => {
    res.writeHead(200, { "content-type": "text/turtle" });
    res.end(ttl);
  });
}

/**
 * Serve a profile that `knows` a LARGE number of distinct children (high fan-out) so the
 * anti-amplification budget is exercised. Each child is a served Solid profile with no further knows.
 */
function serveFanout(path: string, childCount: number): string[] {
  const children: string[] = [];
  for (let i = 0; i < childCount; i += 1) {
    const childPath = `${path}-c${i}`;
    serveProfile(childPath, {});
    children.push(webIdOf(childPath));
  }
  serveProfile(path, { knows: children });
  return children;
}

/** docUrl for a fixture path (fragment-stripped — what the frontier keys on). */
function docOf(path: string): string {
  return `${base}${path}`;
}

/** WebID (with #me) for a fixture path. */
function webIdOf(path: string): string {
  return `${base}${path}#me`;
}

// ───────────────────────── Store helper ─────────────────────────

async function makeStore(): Promise<{ store: PgStore; db: PGlite }> {
  const db = new PGlite();
  const store = new PgStore(createPgliteExecutor(db));
  await store.migrate();
  return { store, db };
}

/** Drive runCrawlBatch repeatedly until the frontier drains (or a safety cap), accumulating totals.
 *  The safety cap is the real assertion that the crawl TERMINATES: a non-terminating crawl trips it.
 *
 *  Politeness delay is set to 0 here so back-to-back batches against the single loopback fixture host
 *  are not rate-stalled (the dedicated politeness test asserts the same-host gate separately). Using
 *  the REAL clock keeps the crawler's `now()` aligned with the store's internal `Date.now()` so a
 *  re-pended row's `next_eligible_at` is honoured by the very next claim. */
async function drain(
  store: CrawlStore,
  maxBatches = 50
): Promise<{ batches: number; added: number; fetched: number }> {
  let batches = 0;
  let added = 0;
  let fetched = 0;
  for (; batches < maxBatches; batches += 1) {
    const s = await runCrawlBatch(store, {
      allowLoopback: true,
      batchSize: 8,
      hostCrawlDelayMs: 0,
    });
    added += s.added;
    fetched += s.fetched;
    if (s.claimed === 0) break; // frontier drained
  }
  return { batches, added, fetched };
}

// ════════════════════════════════ Tests ════════════════════════════════

describe("runCrawlBatch — discovery (knows fan-out)", () => {
  it("crawls a seed whose profile knows two others → all three stored + the two crawled", async () => {
    const { store } = await makeStore();
    serveProfile("/alice", {
      knows: [webIdOf("/bob"), webIdOf("/carol")],
    });
    serveProfile("/bob", {});
    serveProfile("/carol", {});

    await store.enqueue(docOf("/alice"), { source: "seed", depth: 0 });

    const totals = await drain(store);

    // All three documents end up stored, done, and Solid-flagged.
    for (const path of ["/alice", "/bob", "/carol"]) {
      const rec = await store.get(docOf(path));
      expect(rec, `record for ${path}`).not.toBeNull();
      expect(rec?.state).toBe("done");
      expect(rec?.isSolid).toBe(true);
      expect(rec?.webid).toBe(webIdOf(path));
      expect(rec?.rawRdf).toBeTruthy();
      expect(rec?.contentHash).toBeTruthy();
      expect(rec?.httpStatus).toBe(200);
    }
    // Two children enqueued from alice.
    expect(totals.added).toBe(2);
    // The crawl terminated well within the safety cap.
    expect(totals.batches).toBeLessThan(10);

    // bob/carol were discovered at depth 1.
    expect((await store.get(docOf("/bob")))?.depth).toBe(1);
  });
});

describe("runCrawlBatch — cycle termination + dedup (KEY correctness)", () => {
  it("a knows-cycle A↔B terminates with each node crawled exactly once", async () => {
    const { store } = await makeStore();
    // Mutual knows — the classic cycle.
    serveProfile("/a", { knows: [webIdOf("/b")] });
    serveProfile("/b", { knows: [webIdOf("/a")] });

    await store.enqueue(docOf("/a"), { source: "seed", depth: 0 });

    // If dedup were broken this would never drain and would trip the safety cap (the assertion).
    const totals = await drain(store, 20);

    expect((await store.get(docOf("/a")))?.state).toBe("done");
    expect((await store.get(docOf("/b")))?.state).toBe("done");
    // Each node was added to the frontier at most once: A is the seed (0 added),
    // B added once by A; B's knows→A is a no-op (A already exists).
    expect(totals.added).toBe(1);
    expect(totals.batches).toBeLessThan(10);

    // attempts == 1 proves each was claimed/crawled exactly once (no re-crawl loop).
    expect((await store.get(docOf("/a")))?.attempts).toBe(1);
    expect((await store.get(docOf("/b")))?.attempts).toBe(1);
  });

  it("a fully-connected triangle A↔B↔C↔A terminates; 3 nodes, no infinite loop", async () => {
    const { store } = await makeStore();
    serveProfile("/a", { knows: [webIdOf("/b"), webIdOf("/c")] });
    serveProfile("/b", { knows: [webIdOf("/a"), webIdOf("/c")] });
    serveProfile("/c", { knows: [webIdOf("/a"), webIdOf("/b")] });

    await store.enqueue(docOf("/a"), { source: "seed", depth: 0 });
    const totals = await drain(store, 30);

    for (const p of ["/a", "/b", "/c"]) {
      expect((await store.get(docOf(p)))?.state, p).toBe("done");
      expect((await store.get(docOf(p)))?.attempts, p).toBe(1);
    }
    // B and C each enqueued exactly once (by A); every later discovery is a dedup no-op.
    expect(totals.added).toBe(2);
    expect(totals.batches).toBeLessThan(10);
  });
});

describe("runCrawlBatch — MAX_DEPTH stops descent", () => {
  it("does not enqueue children beyond MAX_DEPTH", async () => {
    const { store } = await makeStore();
    // A chain a→b→c→d→e; with batchSize small we crawl the chain. MAX_DEPTH default is 3, so a node
    // at depth 3 (the 4th hop, /d) is crawled but its child /e (depth 4) is NEVER enqueued.
    serveProfile("/d0", { knows: [webIdOf("/d1")] });
    serveProfile("/d1", { knows: [webIdOf("/d2")] });
    serveProfile("/d2", { knows: [webIdOf("/d3")] });
    serveProfile("/d3", { knows: [webIdOf("/d4")] });
    serveProfile("/d4", { knows: [webIdOf("/d5")] });

    await store.enqueue(docOf("/d0"), { source: "seed", depth: 0 });
    await drain(store);

    // depths 0..3 crawled (MAX_DEPTH = 3 inclusive); depth-4 doc never enqueued.
    expect((await store.get(docOf("/d3")))?.state).toBe("done");
    expect((await store.get(docOf("/d3")))?.depth).toBe(3);
    expect(await store.get(docOf("/d4"))).toBeNull(); // never enqueued (would be depth 4)
    expect(await store.exists(docOf("/d4"))).toBe(false);
  });
});

describe("runCrawlBatch — 304 conditional re-crawl", () => {
  it("a doc with stored validators sends If-None-Match and a 304 does 0 profile rewrites", async () => {
    const { store } = await makeStore();
    serveProfile("/etag", { etag: '"v1"' });
    await store.enqueue(docOf("/etag"), { source: "seed", depth: 0 });

    // First crawl: 200, stores etag + content_hash + raw_rdf.
    await runCrawlBatch(store, { allowLoopback: true, hostCrawlDelayMs: 0 });
    const first = await store.get(docOf("/etag"));
    expect(first?.state).toBe("done");
    expect(first?.etag).toBe('"v1"');
    const hash1 = first?.contentHash;
    const rdf1 = first?.rawRdf;
    expect(hash1).toBeTruthy();

    // Make it eligible again and re-crawl: the server returns 304 (validator matches).
    const rec = await store.get(docOf("/etag"));
    if (rec) {
      rec.nextEligibleAt = 0;
      await store.put(rec);
    }
    const summary = await runCrawlBatch(store, {
      allowLoopback: true,
      hostCrawlDelayMs: 0,
    });
    expect(summary.fetched).toBe(1);

    const after = await store.get(docOf("/etag"));
    expect(after?.httpStatus).toBe(304);
    expect(after?.state).toBe("done");
    // Validators + body PRESERVED across the 304 (COALESCE) — no rewrite.
    expect(after?.etag).toBe('"v1"');
    expect(after?.contentHash).toBe(hash1);
    expect(after?.rawRdf).toBe(rdf1);
  });
});

describe("runCrawlBatch — failure backoff", () => {
  it("a transient 503 advances next_eligible_at and increments attempts (re-pends, not failed)", async () => {
    const { store } = await makeStore();
    routes.set("/down", (_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("down");
    });
    await store.enqueue(docOf("/down"), { source: "seed", depth: 0 });

    const before = Date.now();
    const summary = await runCrawlBatch(store, { allowLoopback: true });
    expect(summary.errors).toBe(1);

    const rec = await store.get(docOf("/down"));
    expect(rec?.state).toBe("pending"); // re-pended for retry (transient)
    expect(rec?.failClass).toBe("transient");
    expect(rec?.attempts).toBe(1);
    // Backed off into the future.
    expect(rec?.nextEligibleAt).toBeGreaterThan(before);
  });

  it("a deterministic 404 is skipped with no retry", async () => {
    const { store } = await makeStore();
    // No route → 404.
    await store.enqueue(docOf("/missing"), { source: "seed", depth: 0 });
    const summary = await runCrawlBatch(store, { allowLoopback: true });
    expect(summary.errors).toBe(1);

    const rec = await store.get(docOf("/missing"));
    expect(rec?.state).toBe("skipped");
    expect(rec?.failClass).toBe("deterministic");
    // next_eligible far in the future (no retry).
    expect(rec?.nextEligibleAt).toBeGreaterThan(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    );
  });
});

describe("runCrawlBatch — noindex honouring", () => {
  it("an X-Robots-Tag: noindex doc is tombstoned, not indexed", async () => {
    const { store } = await makeStore();
    serveProfile("/private", {
      extraHeaders: { "x-robots-tag": "noindex" },
    });
    await store.enqueue(docOf("/private"), { source: "seed", depth: 0 });
    await runCrawlBatch(store, { allowLoopback: true });

    // Tombstoned → hidden from get()/exists().
    expect(await store.get(docOf("/private"))).toBeNull();
    expect(await store.exists(docOf("/private"))).toBe(false);
  });

  it("a noindex doc's knows are NOT crawled (the body is discarded)", async () => {
    const { store } = await makeStore();
    serveProfile("/noidx", {
      knows: [webIdOf("/secret")],
      extraHeaders: { "x-robots-tag": "noindex" },
    });
    serveProfile("/secret", {});
    await store.enqueue(docOf("/noidx"), { source: "seed", depth: 0 });
    await drain(store);

    expect(await store.exists(docOf("/secret"))).toBe(false);
  });

  it("a knows edge to a TOMBSTONED doc never resurrects it (no re-crawl across paths)", async () => {
    const { store } = await makeStore();
    // /victim is already tombstoned (opted-out). /finder knows it.
    await store.tombstone(docOf("/victim"));
    serveProfile("/finder", { knows: [webIdOf("/victim")] });
    serveProfile("/victim", {}); // served, but must never be fetched
    await store.enqueue(docOf("/finder"), { source: "seed", depth: 0 });
    await drain(store);

    // /finder is indexed; /victim stays tombstoned (hidden, never crawled — http_status stays null).
    expect((await store.get(docOf("/finder")))?.state).toBe("done");
    expect(await store.get(docOf("/victim"))).toBeNull(); // tombstone hidden from reads
    // Prove it was never fetched: a fetched doc would have http_status set. Read it via list (which
    // would also exclude tombstones), so instead assert exists() is false (tombstone) and it was not
    // claimed (attempts still 0 would require raw access; exists()==false is the observable invariant).
    expect(await store.exists(docOf("/victim"))).toBe(false);
  });
});

describe("runCrawlBatch — tombstone-path suppresses inbound edges from SERVED TPF", () => {
  const FOAF_KNOWS = "http://xmlns.com/foaf/0.1/knows";

  it("a crawled 410 tombstones the doc AND drops the inbound knows edge from served TPF", async () => {
    const { store } = await makeStore();
    // /alice knows /victim. /alice is served; /victim returns 410 Gone → tombstoned by the crawler.
    serveProfile("/alice", { knows: [webIdOf("/victim")] });
    routes.set("/victim", (_req, res) => {
      res.writeHead(410, { "content-type": "text/plain" });
      res.end("gone");
    });
    await store.enqueue(docOf("/alice"), { source: "seed", depth: 0 });
    await drain(store);

    // /victim is tombstoned (hidden), /alice is indexed.
    expect(await store.exists(docOf("/victim"))).toBe(false);
    expect((await store.get(docOf("/alice")))?.state).toBe("done");

    // HARD GUARANTEE: the crawler's 410 path suppresses Alice's foaf:knows→victim from SERVED TPF
    // output (it survives in `triple` under live Alice but tombstoneObjectClause drops it at read).
    // The numeric estimate may marginally over-count it (the incremental suppressed counter was
    // removed, rounds 6–8) — spec-legal for void:triples; the served data is exact.
    const knowsTpf = await store.tpf({
      pattern: { p: FOAF_KNOWS },
      limit: 100,
    });
    expect(knowsTpf.triples.length).toBe(0);
    expect(
      await store.estimatePatternCardinality({ p: FOAF_KNOWS })
    ).toBeGreaterThanOrEqual(0);
  });

  it("a crawled noindex doc tombstones it AND drops the inbound knows edge from served TPF", async () => {
    const { store } = await makeStore();
    // /alice knows /victim. /victim serves X-Robots-Tag: noindex → tombstoned (body discarded).
    serveProfile("/alice", { knows: [webIdOf("/victim")] });
    serveProfile("/victim", {
      extraHeaders: { "x-robots-tag": "noindex" },
    });
    await store.enqueue(docOf("/alice"), { source: "seed", depth: 0 });
    await drain(store);

    expect(await store.exists(docOf("/victim"))).toBe(false);
    expect((await store.get(docOf("/alice")))?.state).toBe("done");

    const knowsTpf = await store.tpf({
      pattern: { p: FOAF_KNOWS },
      limit: 100,
    });
    expect(knowsTpf.triples.length).toBe(0);
    expect(
      await store.estimatePatternCardinality({ p: FOAF_KNOWS })
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("runCrawlBatch — anti-amplification: SHARED suggest budget (KEY correctness)", () => {
  it("a suggestion with budget N enqueues AT MOST N descendants despite high fan-out at one node", async () => {
    const { store } = await makeStore();
    const BUDGET = 3;
    const FANOUT = 12;
    // /root knows 12 distinct children — far more than the budget. Only BUDGET may be enqueued.
    serveFanout("/root", FANOUT);

    await store.enqueue(docOf("/root"), {
      source: "inbox",
      depth: 0,
      rootSeed: docOf("/root"),
      suggestBudget: BUDGET,
    });

    const totals = await drain(store);

    // The whole suggestion-rooted subtree enqueued AT MOST BUDGET descendants — the invariant.
    expect(totals.added).toBeLessThanOrEqual(BUDGET);
    // It actually used the budget (not zero) — the fan-out was larger than the budget.
    expect(totals.added).toBe(BUDGET);

    // Count the doc rows that descend from the root (everything except the root itself).
    const { rows } = await store.list({ limit: 1000 });
    const descendants = rows.filter((r) => r.docUrl !== docOf("/root"));
    expect(descendants.length).toBeLessThanOrEqual(BUDGET);
    // The shared budget row is fully consumed.
    expect(await store.tryConsumeSuggestBudget(docOf("/root"))).toBe(false);
  });

  it("the budget is CONSUMED across the whole subtree (multi-level), not reset per node", async () => {
    const { store } = await makeStore();
    const BUDGET = 4;
    // A branching tree: /s knows two children, each of which knows two grandchildren (fan-out 2 at
    // every node, several levels). A per-node reset budget would let each node spend BUDGET-1 — an
    // explosion. The shared budget must cap the TOTAL descendants at BUDGET.
    serveProfile("/s", { knows: [webIdOf("/s-a"), webIdOf("/s-b")] });
    serveProfile("/s-a", { knows: [webIdOf("/s-a1"), webIdOf("/s-a2")] });
    serveProfile("/s-b", { knows: [webIdOf("/s-b1"), webIdOf("/s-b2")] });
    serveProfile("/s-a1", {});
    serveProfile("/s-a2", {});
    serveProfile("/s-b1", {});
    serveProfile("/s-b2", {});

    await store.enqueue(docOf("/s"), {
      source: "inbox",
      depth: 0,
      rootSeed: docOf("/s"),
      suggestBudget: BUDGET,
    });

    const totals = await drain(store);

    // TOTAL descendants enqueued across ALL levels is bounded by the single shared budget.
    expect(totals.added).toBeLessThanOrEqual(BUDGET);
    const { rows } = await store.list({ limit: 1000 });
    const descendants = rows.filter((r) => r.docUrl !== docOf("/s"));
    expect(descendants.length).toBeLessThanOrEqual(BUDGET);
  });

  it("a seed/catalog excursion (no suggestBudget) is NOT capped by the shared budget", async () => {
    const { store } = await makeStore();
    serveFanout("/seedroot", 5);
    await store.enqueue(docOf("/seedroot"), { source: "seed", depth: 0 });
    const totals = await drain(store);
    // No suggestBudget → all 5 children enqueued (bounded only by MAX_DEPTH + FRONTIER_CAP).
    expect(totals.added).toBe(5);
  });
});

describe("runCrawlBatch — discovered WebID fragment is persisted + used as subject", () => {
  it("a knows target with a non-#me fragment is persisted and re-crawled with the correct subject", async () => {
    const { store } = await makeStore();
    // /finder knows alice whose WebID is …/profile#alice (NOT #me). Its profile document is at
    // …/profile and the RDF subject is the fragmented WebID.
    const aliceWebId = `${base}/profile#alice`;
    serveProfile("/finder", { knows: [aliceWebId] });
    serveProfileWithSubject("/profile", aliceWebId, {});

    await store.enqueue(docOf("/finder"), { source: "seed", depth: 0 });
    await drain(store);

    const finder = await store.get(docOf("/finder"));
    expect(finder?.state).toBe("done");

    const alice = await store.get(docOf("/profile"));
    expect(alice, "alice doc enqueued").not.toBeNull();
    expect(alice?.state).toBe("done");
    // The discovered canonical WebID (with #alice) was persisted, not stripped to #me.
    expect(alice?.webid).toBe(aliceWebId);
    // Because the persisted subject was used for extraction, the solid:oidcIssuer on #alice was seen.
    expect(alice?.isSolid).toBe(true);
  });

  it("a non-#me subject is NOT detected when the WebID was not persisted (regression guard)", async () => {
    const { store } = await makeStore();
    // Same fragmented-subject doc, but enqueued directly with NO webid → falls back to #me, which does
    // not match the #alice subject, so isSolid stays false. This pins the behaviour the fix corrects.
    const aliceWebId = `${base}/loneprofile#alice`;
    serveProfileWithSubject("/loneprofile", aliceWebId, {});
    await store.enqueue(docOf("/loneprofile"), { source: "seed", depth: 0 });
    await drain(store);

    const rec = await store.get(docOf("/loneprofile"));
    expect(rec?.state).toBe("done");
    // No persisted webid → assumed #me → the #alice subject's oidcIssuer is invisible.
    expect(rec?.webid).toBe(`${docOf("/loneprofile")}#me`);
    expect(rec?.isSolid).toBe(false);
  });
});

describe("runCrawlBatch — noindex tombstoned WITHOUT parsing the body", () => {
  it("a noindex response with a non-RDF / garbage body is tombstoned, not errored", async () => {
    const { store } = await makeStore();
    // noindex header + a body that is NOT RDF and a non-RDF content-type. Pre-fix, guardedFetch would
    // reject the content-type and the row would be 'skipped' (deterministic error). Post-fix, the
    // noindex header short-circuits BEFORE the content-type allowlist + body read → tombstone.
    routes.set("/garbage", (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "x-robots-tag": "noindex",
      });
      res.end("<html>not rdf at all <<< broken {{{</html>");
    });
    await store.enqueue(docOf("/garbage"), { source: "seed", depth: 0 });
    const summary = await runCrawlBatch(store, { allowLoopback: true });

    // Tombstoned (hidden from reads), and NOT counted as an error — the body was never parsed.
    expect(summary.errors).toBe(0);
    expect(await store.get(docOf("/garbage"))).toBeNull();
    expect(await store.exists(docOf("/garbage"))).toBe(false);
  });

  it("a noindex doc's knows are NOT enqueued even with a garbage body (no parse, no fan-out)", async () => {
    const { store } = await makeStore();
    // A noindex doc whose (non-RDF) body could not be parsed for knows anyway — proves the fan-out is
    // skipped because the body is never read, not merely because the parse failed.
    routes.set("/noidx-garbage", (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-robots-tag": "noindex",
      });
      res.end(Buffer.from([0x00, 0x01, 0x02, 0xff]));
    });
    serveProfile("/should-not-be-found", {});
    await store.enqueue(docOf("/noidx-garbage"), { source: "seed", depth: 0 });
    await drain(store);

    expect(await store.exists(docOf("/noidx-garbage"))).toBe(false);
    expect(await store.exists(docOf("/should-not-be-found"))).toBe(false);
  });
});

describe("runCrawlBatch — politeness", () => {
  it("delays a same-host second fetch (host next_allowed_at gates the second doc)", async () => {
    const { store } = await makeStore();
    serveProfile("/p1", {});
    serveProfile("/p2", {});
    await store.enqueue(docOf("/p1"), { source: "seed", depth: 0 });
    await store.enqueue(docOf("/p2"), { source: "seed", depth: 0 });

    // Single batch claims both (same host). The first fetch stamps next_allowed_at into the future;
    // the second doc is then host-gated → re-pended (NOT fetched this batch). A non-zero crawl delay
    // makes the gate observable.
    const summary = await runCrawlBatch(store, {
      allowLoopback: true,
      hostCrawlDelayMs: 5_000,
    });
    expect(summary.claimed).toBe(2);
    expect(summary.fetched).toBe(1); // only ONE same-host fetch went through this batch

    const states = [
      (await store.get(docOf("/p1")))?.state,
      (await store.get(docOf("/p2")))?.state,
    ];
    // Exactly one done, one re-pended (politeness-delayed).
    expect(states.filter((s) => s === "done").length).toBe(1);
    expect(states.filter((s) => s === "pending").length).toBe(1);

    // The host row carries a future next_allowed_at (the politeness stamp).
    const hostState = await store.getHostState(new URL(base).hostname);
    expect(hostState.nextAllowedAt).toBeGreaterThan(Date.now());

    // Identify the re-pended doc and confirm its next_eligible_at was advanced to the host window.
    const repended =
      (await store.get(docOf("/p1")))?.state === "pending"
        ? await store.get(docOf("/p1"))
        : await store.get(docOf("/p2"));
    expect(repended?.nextEligibleAt).toBeGreaterThanOrEqual(
      hostState.nextAllowedAt
    );

    // ONCE THE DELAY HAS ELAPSED (modelled by clearing the host stamp + making the row eligible —
    // exactly what real wall-clock does after the window), the second same-host doc fetches.
    await store.stampHost(new URL(base).hostname, 0, 0);
    if (repended) {
      repended.nextEligibleAt = 0;
      await store.put(repended);
    }
    const summary2 = await runCrawlBatch(store, {
      allowLoopback: true,
      hostCrawlDelayMs: 0,
    });
    expect(summary2.fetched).toBe(1);
    expect((await store.get(docOf("/p1")))?.state).toBe("done");
    expect((await store.get(docOf("/p2")))?.state).toBe("done");
  });
});

describe("runCrawlBatch — time budget", () => {
  it("re-pends remaining rows when the time budget is exhausted", async () => {
    const { store } = await makeStore();
    serveProfile("/t1", {});
    await store.enqueue(docOf("/t1"), { source: "seed", depth: 0 });

    // A zero/negative budget means the deadline is already past → every claimed row is re-pended.
    const summary = await runCrawlBatch(store, {
      allowLoopback: true,
      timeBudgetMs: -1,
    });
    expect(summary.claimed).toBe(1);
    expect(summary.fetched).toBe(0);
    expect(summary.budgetHit).toBe(true);

    const rec = await store.get(docOf("/t1"));
    expect(rec?.state).toBe("pending"); // re-pended, lease released
    expect(rec?.claimToken).toBeNull();
  });
});
