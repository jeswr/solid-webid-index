// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/crawl/crawler.ts — the bounded, serverless crawl batch.
 *
 * `runCrawlBatch(store, opts)` processes a BOUNDED slice of the frontier and returns a summary so a
 * scheduling caller (the QStash/cron job route) can decide whether to self-chain. It is designed for
 * a serverless invocation: NO long-running loop beyond `TIME_BUDGET_MS`, all coordination state in
 * the DB (the box is stateless).
 *
 * This module COMPOSES the existing, separately-tested pieces — it does NOT re-implement any of them:
 *   - guardedFetch       (src/lib/security/guardedFetch.ts) — the ONLY fetch path (SSRF-safe).
 *   - parseProfile /
 *     extractWebIdProfile /
 *     isSolidWebId        (src/lib/rdf/profile.ts)           — parse + typed extraction.
 *   - canonicalWebId /
 *     canonicalDocUrl     (src/lib/url/canonical.ts)         — the dedup key.
 *   - CrawlCoordinator    (src/lib/store/ports.ts)           — claim / markDone / enqueue / exists.
 *   - PolitenessStore     (src/lib/store/ports.ts)           — per-host next_allowed_at.
 *
 * ── Termination (rigorous — DESIGN.md §3.2) ────────────────────────────────────────────────────
 * A single batch terminates because it claims at most `BATCH_SIZE` rows and processes each at most
 * once, stopping when the wall-clock `TIME_BUDGET_MS` is hit. The WHOLE crawl (many self-chained
 * batches) terminates because the frontier cannot grow without bound:
 *   1. Canonical PK dedup — every discovered link is canonicalised (`canonicalDocUrl`) and only
 *      enqueued when `store.exists()` is false. A `knows` cycle A↔B therefore enqueues each node at
 *      most once; the second discovery is a no-op. This is the LOAD-BEARING bound (a fully-connected
 *      malicious Solid graph cannot stay at depth 0 forever).
 *   2. FRONTIER_CAP — enqueue is refused once the total frontier (pending+claimed) reaches the cap.
 *   3. MAX_DEPTH — a child is only enqueued when `depth + 1 <= MAX_DEPTH`.
 *   4. MAX_OUTLINKS_PER_DOC — `extractWebIdProfile` already caps `knows` per document.
 *   5. Redirect cap — guardedFetch follows at most `MAX_REDIRECTS` hops.
 *
 * @see docs/DESIGN.md §3.3 "The batch handler (runCrawlBatch)"
 */
import { createHash } from "node:crypto";

import type { Quad } from "@rdfjs/types";
import { DataFactory, Writer } from "n3";

import {
  BATCH_SIZE,
  FAILED_COOLDOWN_MS,
  FRONTIER_CAP,
  HOST_CRAWL_DELAY_MS,
  MAX_ATTEMPTS,
  MAX_DEPTH,
  RECRAWL_INTERVAL_OTHER_MS,
  RECRAWL_INTERVAL_SOLID_MS,
  TIME_BUDGET_MS,
  TRANSIENT_BACKOFF_BASE_MS,
  TRANSIENT_BACKOFF_MAX_MS,
} from "../config.js";
import {
  ParseLimitError,
  RdfFetchError,
  extractWebIdProfile,
  isSolidWebId,
  parseProfile,
} from "../rdf/profile.js";
import { type FragmentTriple, datasetToTriples } from "../rdf/tpf.js";
import {
  BodyTooLargeError,
  GuardedFetchError,
  SsrfError,
  guardedFetch,
} from "../security/guardedFetch.js";
import type {
  CrawlCoordinator,
  DocRecord,
  PolitenessStore,
  ReadStore,
} from "../store/ports.js";
import {
  CanonicalError,
  canonicalDocUrl,
  canonicalWebId,
} from "../url/canonical.js";

// ─── Public surface ─────────────────────────────────────────────────────────

/** The minimal store surface `runCrawlBatch` needs (a subset of PgStore). */
export type CrawlStore = CrawlCoordinator &
  PolitenessStore &
  Pick<ReadStore, "exists" | "upsertTriples">;

export interface RunCrawlBatchOptions {
  /** Logical worker identity passed to `claim()` (not stored as the fence token). */
  readonly workerId?: string;
  /** Rows to claim. Default {@link BATCH_SIZE}. */
  readonly batchSize?: number;
  /** Wall-clock budget (ms) for the whole batch. Default {@link TIME_BUDGET_MS}. */
  readonly timeBudgetMs?: number;
  /**
   * TEST/DEV ONLY: allow loopback (127.0.0.1) + `http:` targets so the fixture WebID server is
   * reachable. Forwarded to guardedFetch AND the canonicalisers. NEVER set in production.
   */
  readonly allowLoopback?: boolean;
  /**
   * Injected clock (ms). Defaults to `Date.now`. NOTE: the store's `claim()`/`markDone()` use the
   * REAL wall-clock internally; an injected `now` that diverges far from real time will write
   * `next_eligible_at` values the real-clock claim won't honour. Use it for time-budget tests
   * (a past deadline), not to fast-forward the whole crawl.
   */
  readonly now?: () => number;
  /**
   * Minimum delay (ms) between two fetches to the same host. Default {@link HOST_CRAWL_DELAY_MS}.
   * Exposed so tests can shrink it (so back-to-back batches against the loopback fixture are not
   * politeness-stalled) or enlarge it (to assert the same-host gate).
   */
  readonly hostCrawlDelayMs?: number;
  /** Injected DNS lookup forwarded to guardedFetch (tests — the rebinding stub). */
  readonly dnsLookup?: (
    host: string
  ) => Promise<{ address: string; family: number }[]>;
}

/** What a single batch did — the scheduler reads this to decide whether to self-chain. */
export interface CrawlBatchSummary {
  /** Rows claimed from the frontier this batch. */
  claimed: number;
  /** Rows that completed a network round-trip — 2xx or 304, not host-skipped. */
  fetched: number;
  /** Newly-enqueued child documents (knows targets that passed all gates). */
  added: number;
  /** Rows that ended in a failure/skip/blocked state this batch. */
  errors: number;
  /** True when the batch stopped because the time budget was hit (not because the frontier drained). */
  budgetHit: boolean;
  /**
   * Lower-bound signal that more eligible work likely remains: true when the batch was FULL
   * (claimed === batchSize) or the budget was hit. The caller pairs this with its own daily budget
   * to decide whether to publish a self-chain message.
   */
  remaining: boolean;
}

// ─── runCrawlBatch ──────────────────────────────────────────────────────────

/**
 * Process one bounded batch of the frontier.
 *
 * For each claimed doc, within the time budget:
 *  - host politeness gate (skip + re-pend if the host's `next_allowed_at` is in the future);
 *  - guardedFetch with the stored conditional validators (the ONLY fetch path);
 *  - 304 → record a cheap re-validation, schedule the next re-crawl, markDone;
 *  - 2xx → parse + extract + store (raw_rdf/etag/last-modified/content_hash/is_solid), markDone,
 *    then enqueue newly-discovered canonical WebIDs from `knows` (capped, dedup'd, depth+frontier-gated);
 *  - failure → classify transient vs deterministic, set `next_eligible_at` with backoff, markDone.
 *
 * Always stamps the host's `next_allowed_at` after the round-trip — politeness state in the DB.
 */
export async function runCrawlBatch(
  store: CrawlStore,
  opts: RunCrawlBatchOptions = {}
): Promise<CrawlBatchSummary> {
  const now = opts.now ?? Date.now;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const timeBudgetMs = opts.timeBudgetMs ?? TIME_BUDGET_MS;
  const allowLoopback = opts.allowLoopback ?? false;
  const workerId = opts.workerId ?? "crawler";
  const hostDelay = opts.hostCrawlDelayMs ?? HOST_CRAWL_DELAY_MS;
  const deadline = now() + timeBudgetMs;

  const summary: CrawlBatchSummary = {
    claimed: 0,
    fetched: 0,
    added: 0,
    errors: 0,
    budgetHit: false,
    remaining: false,
  };

  // A single claim of up to batchSize rows. The serverless invocation processes ONE claim per
  // call; self-chaining (the scheduling bead) drives subsequent batches. This keeps the unit of
  // work bounded and the function short. claim() already excludes noindex rows and respects
  // depth/eligibility (DESIGN.md §3.1).
  const claimed = await store.claim(workerId, batchSize);
  summary.claimed = claimed.length;
  if (claimed.length === batchSize) summary.remaining = true;

  for (const row of claimed) {
    if (now() >= deadline) {
      // Out of time: re-pend the remainder so the next invocation reclaims it. markDone with state
      // 'pending' and an immediate next_eligible_at; the fence token releases the lease.
      summary.budgetHit = true;
      summary.remaining = true;
      await repend(store, row, now());
      continue;
    }
    const result = await processDoc(store, row, {
      now,
      allowLoopback,
      hostDelay,
      opts,
    });
    summary.fetched += result.fetched ? 1 : 0;
    summary.added += result.added;
    summary.errors += result.errored ? 1 : 0;
  }

  return summary;
}

// ─── Per-document processing ──────────────────────────────────────────────────

interface DocOutcome {
  fetched: boolean;
  added: number;
  errored: boolean;
}

interface ProcessCtx {
  now: () => number;
  allowLoopback: boolean;
  hostDelay: number;
  opts: RunCrawlBatchOptions;
}

async function processDoc(
  store: CrawlStore,
  row: DocRecord,
  ctx: ProcessCtx
): Promise<DocOutcome> {
  const { now, allowLoopback, hostDelay } = ctx;

  // ── Host politeness gate ─────────────────────────────────────────────────
  // State lives in the DB (serverless = stateless). If the host is rate-limited (a same-host fetch
  // happened too recently), re-pend this row at the host's next_allowed_at and skip it this batch —
  // we do NOT block/sleep inside the invocation.
  const hostState = await store.getHostState(row.host);
  if (hostState.nextAllowedAt > now()) {
    await repend(store, row, hostState.nextAllowedAt);
    return { fetched: false, added: 0, errored: false };
  }

  // Stamp the host BEFORE the fetch so a concurrent/subsequent same-host claim in this or a parallel
  // invocation is delayed (politeness is best-effort; the stamp-before makes the window tight).
  await store.stampHost(
    row.host,
    now() + hostDelay,
    hostState.consecutiveErrors
  );

  // ── The single guarded fetch ─────────────────────────────────────────────
  let res: Awaited<ReturnType<typeof guardedFetch>>;
  try {
    res = await guardedFetch(row.docUrl, {
      allowLoopback,
      dnsLookup: ctx.opts.dnsLookup,
      // Honour X-Robots-Tag: noindex INSIDE the fetch — before the content-type allowlist and before
      // the body is read — so an opted-out doc is tombstoned without parsing even when its body is
      // malformed / oversized / a non-RDF content-type (DESIGN.md §4.8 H2).
      honourNoindexHeader: true,
      conditional: {
        etag: row.etag ?? undefined,
        lastModified: row.lastModified ?? undefined,
      },
    });
  } catch (err: unknown) {
    return finalizeFailure(store, row, err, now, hostDelay);
  }

  // ── noindex honouring (PRE-PARSE) ────────────────────────────────────────
  // guardedFetch flags a final 2xx response carrying X-Robots-Tag: noindex BEFORE reading/parsing the
  // body. Tombstone the row so it is hidden from every read surface (get/exists/list/search) AND
  // blocked from re-crawl across all paths. The body was never read; nothing about the person is
  // indexed — and a malformed/oversized noindex body is still tombstoned (not skipped/errored).
  if (res.noindex) {
    await store.markDone(
      row.docUrl,
      {
        state: "tombstone",
        httpStatus: res.status,
        error: "noindex (X-Robots-Tag) — not indexed",
        nextEligibleAt: farFuture(now()),
      },
      row.claimToken
    );
    // Erase any previously-materialised triples for this WebID and SUBTRACT its
    // dataset-stats contribution (DESIGN.md §2.1.j / §4.8 H1) — an empty triple list
    // is the documented delete-by-webid, so VoID/DCAT counts decrement on tombstone.
    if (row.webid) {
      await store.upsertTriples({
        webid: row.webid,
        docUrl: row.docUrl,
        triples: [],
      });
    }
    await store.stampHost(row.host, now() + hostDelay, 0);
    return { fetched: true, added: 0, errored: false };
  }

  // ── 304 Not Modified — cheap re-validation, zero profile writes ───────────
  if (res.status === 304) {
    const recrawl = row.isSolid
      ? RECRAWL_INTERVAL_SOLID_MS
      : RECRAWL_INTERVAL_OTHER_MS;
    // COALESCE in markDone preserves etag/last_modified/content_hash/raw_rdf when we pass null,
    // so a 304 touches only timing + state.
    await store.markDone(
      row.docUrl,
      {
        state: "done",
        httpStatus: 304,
        nextEligibleAt: now() + recrawl,
        failClass: null,
        error: null,
      },
      row.claimToken
    );
    // Reset host error counter on a healthy response.
    await store.stampHost(row.host, now() + hostDelay, 0);
    return { fetched: true, added: 0, errored: false };
  }

  // ── Non-2xx → classify and back off ──────────────────────────────────────
  if (res.status < 200 || res.status >= 300) {
    return finalizeHttpError(
      store,
      row,
      res.status,
      res.response,
      now,
      hostDelay
    );
  }

  // ── 2xx → parse + extract + store ────────────────────────────────────────
  // Determine the WebID subject. The document key has no fragment; the WebID is the doc URL with
  // `#me` by convention, unioned with any pre-known webid. parseProfile/extractWebIdProfile use the
  // post-redirect finalUrl as the base IRI (the canonical document the bytes came from).
  let canonicalFinalDoc: string;
  try {
    canonicalFinalDoc = canonicalDocUrl(res.finalUrl, { allowLoopback });
  } catch {
    // A malformed final URL is a deterministic failure — never retried.
    await store.markDone(
      row.docUrl,
      {
        state: "skipped",
        httpStatus: res.status,
        failClass: "deterministic",
        error: `non-canonicalisable final URL: ${res.finalUrl}`,
        nextEligibleAt: farFuture(now()),
      },
      row.claimToken
    );
    return { fetched: true, added: 0, errored: true };
  }

  const webIdIri = row.webid ?? `${canonicalFinalDoc}#me`;

  let isSolid: boolean;
  let knows: string[];
  let canonicalRdf: string;
  let contentHash: string;
  let triples: FragmentTriple[];
  try {
    const dataset = await parseProfile({
      text: res.text,
      contentType: res.contentType,
      baseIri: res.finalUrl,
    });
    isSolid = isSolidWebId(dataset, webIdIri);
    knows = extractWebIdProfile(dataset, webIdIri).knows;
    canonicalRdf = serializeCanonical(dataset);
    contentHash = sha256(canonicalRdf);
    // Materialise the parsed graph into the TPF triple index (DESIGN.md §2.1.e /
    // §4.5).  upsertTriples REPLACES the WebID's prior triples, so a re-crawl never
    // leaves stale rows.  Built via the typed projection helper — never hand-built.
    triples = datasetToTriples(dataset);
  } catch (err: unknown) {
    // Parse error / parser-bomb cap / content-type reject → deterministic, no retry (DESIGN.md §3.4).
    if (err instanceof ParseLimitError || err instanceof RdfFetchError) {
      await store.markDone(
        row.docUrl,
        {
          state: "skipped",
          httpStatus: res.status,
          failClass: "deterministic",
          error: truncate(err.message),
          nextEligibleAt: farFuture(now()),
        },
        row.claimToken
      );
      return { fetched: true, added: 0, errored: true };
    }
    // Anything unexpected during parse → treat as transient so a real pod isn't lost permanently.
    return finalizeFailure(store, row, err, now, hostDelay);
  }

  // Content-hash gate: identical canonical body → no rewrite, just re-schedule (M5).
  const recrawl = isSolid
    ? RECRAWL_INTERVAL_SOLID_MS
    : RECRAWL_INTERVAL_OTHER_MS;
  if (row.contentHash && row.contentHash === contentHash) {
    await store.markDone(
      row.docUrl,
      {
        state: "done",
        httpStatus: res.status,
        isSolid,
        webid: webIdIri,
        nextEligibleAt: now() + recrawl,
        failClass: null,
        error: null,
      },
      row.claimToken
    );
    await store.stampHost(row.host, now() + hostDelay, 0);
    return { fetched: true, added: 0, errored: false };
  }

  // Store the projected record + validators + canonical body.  markDone returns whether the FENCED
  // completion actually committed: it is `false` when our lease token no longer matches (the row was
  // reclaimed by a newer crawl after our lease expired) OR when the WebID was tombstoned mid-crawl.
  const completed = await store.markDone(
    row.docUrl,
    {
      state: "done",
      httpStatus: res.status,
      etag: res.response.headers.get("etag"),
      lastModified: res.response.headers.get("last-modified"),
      contentHash,
      rawRdf: canonicalRdf,
      isSolid,
      webid: webIdIri,
      nextEligibleAt: now() + recrawl,
      failClass: null,
      error: null,
    },
    row.claimToken
  );
  // Materialise the parsed triples for the TPF index (DESIGN.md §4.5) — but ONLY when the fenced
  // completion above actually committed (roborev HIGH 1). If our lease was stale, upsertTriples runs
  // OUTSIDE any fence and would clobber a newer crawl's projection / stats; if the WebID was
  // tombstoned, projecting would resurrect erased PII (the projection gate would catch it, but the
  // stats churn is still wrong). Skipping projection on a refused/stale completion keeps every
  // projection + stats mutation INSIDE the lease fence. REPLACE semantics keep the index in lock-step
  // with raw_rdf on every re-crawl.
  if (completed) {
    await store.upsertTriples({
      webid: webIdIri,
      docUrl: row.docUrl,
      triples,
    });
  }
  // Healthy response → reset the host error counter.
  await store.stampHost(row.host, now() + hostDelay, 0);

  // ── Enqueue newly-discovered WebIDs from knows (capped, dedup'd, bounded) ─
  const added = await enqueueKnows(store, row, knows, { now, allowLoopback });

  return { fetched: true, added, errored: false };
}

// ─── knows fan-out ────────────────────────────────────────────────────────────

/**
 * Enqueue the canonical document URLs of `knows` targets at `depth + 1`, respecting MAX_DEPTH,
 * FRONTIER_CAP, and PK dedup (via store.exists). `knows` is already capped at MAX_OUTLINKS_PER_DOC
 * by extractWebIdProfile. Returns the count actually enqueued.
 *
 * This is the cycle-termination point: a `knows` edge to an already-known document is a no-op
 * (`exists` is true), so A↔B converges after each node is seen once.
 */
async function enqueueKnows(
  store: CrawlStore,
  parent: DocRecord,
  knows: string[],
  ctx: { now: () => number; allowLoopback: boolean }
): Promise<number> {
  const childDepth = parent.depth + 1;
  if (childDepth > MAX_DEPTH) return 0;

  // Suggestion-rooted subtree budget (anti-amplification C2): when this excursion descends from a
  // suggestion (suggestBudget set AND a rootSeed to key the shared budget on), every child enqueued
  // ANYWHERE in the subtree CONSUMES one slot from a single shared counter (store.tryConsumeSuggestBudget),
  // not a per-node budget that resets to (budget-1) at every node. A budget of N therefore enqueues AT
  // MOST N total descendants regardless of fan-out. A null budget means a seed/catalog excursion (no
  // per-subtree cap; bounded by MAX_DEPTH + FRONTIER_CAP). A budget without a rootSeed cannot be shared
  // (nothing to key it on) — treat as exhausted to fail closed rather than amplify.
  const budgeted = parent.suggestBudget != null;
  const budgetRoot = parent.rootSeed;
  if (budgeted && budgetRoot == null) return 0;

  let added = 0;
  // De-dup within this document first (two knows pointing at the same doc, or #me vs #card).
  const seen = new Set<string>();
  for (const target of knows) {
    let childDoc: string;
    let childWebId: string;
    try {
      // canonicalWebId KEEPS the fragment (the RDF subject, e.g. …/profile#alice); canonicalDocUrl
      // STRIPS it (the frontier key, …/profile). We persist the former so the child is parsed with
      // its REAL subject on first crawl instead of assuming #me (DESIGN.md §3.3).
      childWebId = canonicalWebId(target, {
        allowLoopback: ctx.allowLoopback,
      });
      childDoc = canonicalDocUrl(target, { allowLoopback: ctx.allowLoopback });
    } catch (err: unknown) {
      // CanonicalError (forbidden scheme/userinfo/malformed) → not a crawlable target; skip.
      if (err instanceof CanonicalError) continue;
      throw err;
    }
    if (seen.has(childDoc)) continue;
    seen.add(childDoc);

    // PK dedup against the store: a known LIVE document is never re-enqueued. This is the
    // load-bearing cycle/termination bound — a knows edge to an already-seen doc is a no-op, so a
    // cycle converges after each node is seen once. NOTE: exists() reports false for a TOMBSTONED
    // doc_url (it is hidden from reads), but enqueue() uses INSERT … ON CONFLICT (doc_url) DO
    // NOTHING, so a tombstoned row is NEVER resurrected even if we attempt it here — the tombstone
    // invariant (no re-crawl across any path) holds. claim() also excludes 'tombstone' rows.
    if (await store.exists(childDoc)) continue;

    // FRONTIER_CAP: re-check before each insert so a single document cannot blow the cap.
    if (await frontierFull(store)) break;

    // Shared suggestion-root budget: consume one slot ATOMICALLY before enqueuing. If the budget is
    // exhausted, stop the whole fan-out — no further descendants under this root may be enqueued.
    if (budgeted && budgetRoot != null) {
      const granted = await store.tryConsumeSuggestBudget(budgetRoot);
      if (!granted) break;
    }

    await store.enqueue(childDoc, {
      depth: childDepth,
      source: "knows",
      discoveredFrom: parent.docUrl,
      rootSeed: parent.rootSeed,
      // Propagate the budget value (null for non-suggestion excursions). The SHARED counter is keyed
      // on rootSeed and already seeded at the root's enqueue; this value is informational on the row.
      suggestBudget: parent.suggestBudget,
      // Persist the discovered canonical WebID (WITH fragment) so the child is parsed/extracted with
      // its real subject on first crawl, not an assumed `#me`.
      webid: childWebId,
      nextEligibleAt: 0,
    });
    added += 1;
  }
  return added;
}

/**
 * FRONTIER_CAP check against the LIVE frontier (pending + claimed). Under active crawling, claimed
 * rows are part of the frontier — counting only `pending` under-counts and lets the cap be exceeded.
 * countFrontier() runs a single indexed COUNT over state IN ('pending','claimed') (DESIGN.md §3.2 H6).
 */
async function frontierFull(store: CrawlStore): Promise<boolean> {
  return (await store.countFrontier()) >= FRONTIER_CAP;
}

// ─── Failure handling ─────────────────────────────────────────────────────────

/**
 * Classify a guardedFetch throw and finalize the row.
 *  - SsrfError / GuardedFetchError (bad scheme/port, disallowed content-type, redirect cap/loop/
 *    downgrade, malformed URL) / BodyTooLargeError → DETERMINISTIC: state 'skipped', no retry.
 *  - Network error / timeout (a GuardedFetchError whose cause is a network failure) is also classed
 *    deterministic by the guard's own taxonomy here EXCEPT genuine timeouts/network which we treat as
 *    transient. We distinguish by message: a timeout / network failure is transient.
 */
async function finalizeFailure(
  store: CrawlStore,
  row: DocRecord,
  err: unknown,
  now: () => number,
  hostDelay: number
): Promise<DocOutcome> {
  const transient = isTransientError(err);
  const message = truncate(err instanceof Error ? err.message : String(err));

  if (!transient) {
    // Deterministic: SSRF refusal, bad scheme/port, disallowed content-type, redirect cap/loop,
    // body-too-large — retrying is pointless and amplifies. Skip permanently.
    await store.markDone(
      row.docUrl,
      {
        state: "skipped",
        failClass: "deterministic",
        error: message,
        nextEligibleAt: farFuture(now()),
      },
      row.claimToken
    );
    // A deterministic failure is the host's content, not its health — don't punish the host.
    await store.stampHost(row.host, now() + hostDelay, 0);
    return { fetched: false, added: 0, errored: true };
  }

  // Transient: network/timeout. Back off and retry up to MAX_ATTEMPTS. attempts was already
  // incremented by claim().
  await backoffTransient(store, row, message, now);
  // Punish the host slightly: bump its consecutive-error count and delay it more.
  const hostState = await store.getHostState(row.host);
  await store.stampHost(
    row.host,
    now() + hostDelay,
    hostState.consecutiveErrors + 1
  );
  return { fetched: false, added: 0, errored: true };
}

/** Finalize a non-2xx HTTP status. 5xx + 429 → transient; other 4xx → deterministic. 410 → tombstone. */
async function finalizeHttpError(
  store: CrawlStore,
  row: DocRecord,
  status: number,
  response: Response,
  now: () => number,
  hostDelay: number
): Promise<DocOutcome> {
  // 410 Gone → permanent erasure (DESIGN.md §3.4): tombstone.
  if (status === 410) {
    await store.markDone(
      row.docUrl,
      {
        state: "tombstone",
        httpStatus: 410,
        nextEligibleAt: farFuture(now()),
      },
      row.claimToken
    );
    // Erase materialised triples + SUBTRACT the WebID's dataset-stats contribution
    // (empty triple list = delete-by-webid) so VoID/DCAT counts decrement on erasure
    // (DESIGN.md §2.1.j / §4.8 H1).
    if (row.webid) {
      await store.upsertTriples({
        webid: row.webid,
        docUrl: row.docUrl,
        triples: [],
      });
    }
    await store.stampHost(row.host, now() + hostDelay, 0);
    return { fetched: true, added: 0, errored: true };
  }

  const transient = status >= 500 || status === 429;
  if (transient) {
    await backoffTransient(
      store,
      row,
      `HTTP ${status}`,
      now,
      status,
      retryAfterMs(response)
    );
    const hostState = await store.getHostState(row.host);
    // Honour Retry-After / 429 / 503 by advancing the host's next_allowed_at.
    const retry = retryAfterMs(response);
    const hostNext = retry != null ? now() + retry : now() + hostDelay;
    await store.stampHost(row.host, hostNext, hostState.consecutiveErrors + 1);
    return { fetched: true, added: 0, errored: true };
  }

  // Other 4xx (401/403/404/…) → deterministic, no retry.
  await store.markDone(
    row.docUrl,
    {
      state: "skipped",
      httpStatus: status,
      failClass: "deterministic",
      error: `HTTP ${status}`,
      nextEligibleAt: farFuture(now()),
    },
    row.claimToken
  );
  await store.stampHost(row.host, now() + hostDelay, 0);
  return { fetched: true, added: 0, errored: true };
}

/**
 * Apply exponential transient backoff. After MAX_ATTEMPTS the row goes to 'failed' but is made
 * re-eligible after a long cooldown — a flapping-but-real pod is never permanently dead (H7).
 */
async function backoffTransient(
  store: CrawlStore,
  row: DocRecord,
  message: string,
  now: () => number,
  httpStatus?: number,
  retryAfterOverrideMs?: number | null
): Promise<void> {
  // row.attempts already includes this attempt (claim() incremented it).
  const exhausted = row.attempts >= MAX_ATTEMPTS;
  let delay: number;
  if (retryAfterOverrideMs != null && retryAfterOverrideMs > 0) {
    delay = retryAfterOverrideMs;
  } else {
    const exp = TRANSIENT_BACKOFF_BASE_MS * 2 ** Math.max(0, row.attempts - 1);
    delay = Math.min(exp, TRANSIENT_BACKOFF_MAX_MS);
  }
  await store.markDone(
    row.docUrl,
    {
      state: exhausted ? "failed" : "pending",
      httpStatus: httpStatus ?? null,
      failClass: "transient",
      error: truncate(message),
      nextEligibleAt: now() + (exhausted ? FAILED_COOLDOWN_MS : delay),
    },
    row.claimToken
  );
}

/** Re-pend a row (release the lease) so the next invocation reclaims it. Used on budget/politeness. */
async function repend(
  store: CrawlStore,
  row: DocRecord,
  nextEligibleAt: number
): Promise<void> {
  await store.markDone(
    row.docUrl,
    {
      state: "pending",
      nextEligibleAt,
      // Preserve validators via COALESCE — pass nothing that overwrites them.
      failClass: null,
      error: null,
    },
    row.claimToken
  );
}

// ─── Classifiers & helpers ──────────────────────────────────────────────────

/**
 * A transient error is a genuine network failure or timeout — retry-worthy. A guard refusal (SSRF,
 * bad scheme/port, disallowed content-type, redirect cap/loop/downgrade) or a body-too-large is
 * deterministic — the URL/content is the problem, not a flaky network.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof SsrfError) return false;
  if (err instanceof BodyTooLargeError) return false;
  if (err instanceof GuardedFetchError) {
    const m = err.message.toLowerCase();
    // Timeout / network-failure GuardedFetchErrors are transient; the rest (scheme/port, content-type,
    // redirect cap/loop/downgrade, malformed URL) are deterministic.
    if (m.includes("timed out") || m.includes("fetch failed for")) return true;
    return false;
  }
  // Unknown throw shape: be conservative and treat as transient so a real pod isn't lost.
  return true;
}

/** Parse a Retry-After header (delta-seconds OR HTTP-date) into a delay in ms, or null. */
function retryAfterMs(response: Response): number | null {
  const ra = response.headers.get("retry-after");
  if (!ra) return null;
  const secs = Number(ra.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(ra);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

/**
 * Serialise a dataset to a STABLE canonical string (sorted N-Triples) for content-hashing and
 * raw_rdf storage. Sorting makes the hash insensitive to statement order so a re-serve of identical
 * data produces an identical hash (the M5 change-detect gate). Built via n3.Writer — never
 * hand-concatenated triples (house rule).
 */
function serializeCanonical(dataset: Iterable<Quad>): string {
  const writer = new Writer({ format: "N-Triples", factory: DataFactory });
  const quads = [...dataset];
  writer.addQuads(quads);
  let out = "";
  // n3.Writer.end is callback-based but SYNCHRONOUS for N-Triples (no I/O); capture the string.
  writer.end((error, result) => {
    if (error) throw error;
    out = result;
  });
  // Sort the emitted lines so the canonical form is order-independent.
  const lines = out.split("\n").filter((l) => l.trim().length > 0);
  lines.sort();
  return `${lines.join("\n")}\n`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A far-future next_eligible_at for permanently-skipped/deterministic rows (effectively "never"). */
function farFuture(nowMs: number): number {
  return nowMs + 365 * 24 * 60 * 60 * 1000;
}
