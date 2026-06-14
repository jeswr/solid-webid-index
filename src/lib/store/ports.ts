// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/store/ports.ts — DB-agnostic TypeScript port interfaces for the storage seam.
 *
 * Three honest ports (DESIGN.md §2.4):
 *  - ReadStore:         get / exists / list / put / tombstone
 *  - SearchIndex:       full-text search with ts_rank + keyset pagination
 *  - CrawlCoordinator:  frontier management (enqueue / claim / markDone / needsRecrawl)
 *
 * No driver types leak through. Adapters implement these interfaces.
 */

// ─── Supporting types ─────────────────────────────────────────────────────────

/**
 * Per-document state machine.
 * Matches the CHECK constraint in schema.sql — keep in sync.
 */
export type DocState =
  | "pending"
  | "claimed"
  | "done"
  | "failed"
  | "tombstone"
  | "skipped"
  | "blocked";

/**
 * Source of a discovered document URL.
 */
export type DocSource =
  | "seed"
  | "catalog"
  | "inbox"
  | "knows"
  | "seeAlso"
  | "sameAs"
  | "recheck";

/**
 * Failure classification drives retry policy (DESIGN.md §3.4 H7).
 *  - deterministic: 4xx, parse error, SSRF refusal, content-type reject → skipped, no retry
 *  - transient:     5xx, network timeout → error, re-eligible after cooldown
 */
export type FailClass = "deterministic" | "transient";

/**
 * One row in the `doc` table — the single-row-per-document crawl record.
 * All time columns are epoch milliseconds (DESIGN.md §2.1 L1).
 */
export interface DocRecord {
  /** Canonical, post-redirect, fragment-stripped document URL (PRIMARY KEY). */
  docUrl: string;
  /** Registrable host — used for per-host politeness. */
  host: string;
  /** Canonical WebID (with #fragment) once known; null until first crawl. */
  webid: string | null;
  /** Current crawl state. */
  state: DocState;
  /** BFS depth from the seed. */
  depth: number;
  /** Trusted-seed doc this excursion descends from (C2). */
  rootSeed: string | null;
  /** Remaining node budget for a suggestion-rooted subtree (C2). */
  suggestBudget: number | null;
  /** Discovery source. */
  source: DocSource;
  /** The URL that linked to this doc (for provenance). */
  discoveredFrom: string | null;

  // Lease / fencing
  claimToken: string | null;
  /** epoch ms */
  claimedAt: number | null;
  attempts: number;

  // Conditional re-crawl validators
  etag: string | null;
  /** Verbatim HTTP Last-Modified header value. */
  lastModified: string | null;
  /** sha-256 of reserialised canonical body (change-detect, M5). */
  contentHash: string | null;

  // Timing
  /** epoch ms */
  lastCrawled: number | null;
  /** epoch ms — claim predicate accepts when <= now */
  nextEligibleAt: number;
  /** epoch ms */
  enqueuedAt: number;

  // Per-doc result metadata
  httpStatus: number | null;
  /** 1/true once a solid:oidcIssuer on the subject was seen. */
  isSolid: boolean;
  failClass: FailClass | null;
  /** Truncated last failure reason (never empty-catch). */
  error: string | null;
  /** True → never index; honour X-Robots-Tag / idx:noIndex (DESIGN.md §4.8 H2). */
  noindex: boolean;
  /** Reserialised canonical Turtle — NOT verbatim bytes (M5). */
  rawRdf: string | null;
}

/**
 * Lightweight shape returned by ReadStore.list() — full DocRecord so callers
 * can inspect any field without a second fetch.
 */
export type DocRow = DocRecord;

// ─── SearchIndex supporting types ─────────────────────────────────────────────

/** One search hit, ranked by ts_rank. */
export interface SearchResult {
  docUrl: string;
  webid: string | null;
  rawRdf: string | null;
  isSolid: boolean;
  state: DocState;
  lastCrawled: number | null;
  /** ts_rank score — higher is better. */
  rank: number;
}

// ─── CrawlCoordinator supporting types ────────────────────────────────────────

/** Result of a completed crawl attempt, passed to markDone(). */
export interface CrawlResult {
  state: DocState;
  httpStatus?: number | null;
  etag?: string | null;
  lastModified?: string | null;
  contentHash?: string | null;
  rawRdf?: string | null;
  isSolid?: boolean;
  webid?: string | null;
  failClass?: FailClass | null;
  error?: string | null;
  /** epoch ms; if omitted defaults to Date.now() + RECRAWL_INTERVAL */
  nextEligibleAt?: number;
}

// ─── Port interfaces ──────────────────────────────────────────────────────────

/**
 * ReadStore — portable read / write / list operations on the doc table.
 *
 * A SPARQL/QLever implementation maps each method to SELECT/INSERT DATA/DELETE DATA.
 */
export interface ReadStore {
  /**
   * Fetch a single doc record by URL.
   * Returns null when the URL is unknown OR when state = 'tombstone' (hidden from reads).
   */
  get(docUrl: string): Promise<DocRecord | null>;

  /**
   * Returns true when the URL is present AND state != 'tombstone'.
   */
  exists(docUrl: string): Promise<boolean>;

  /**
   * List documents with optional state filter and keyset pagination.
   * cursor is an opaque token encoding (docUrl) — pass nextCursor from the previous page.
   */
  list(opts: {
    state?: DocState;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: DocRow[]; nextCursor: string | null }>;

  /**
   * Upsert a complete DocRecord. On conflict (same docUrl) the row is updated in full.
   */
  put(record: DocRecord): Promise<void>;

  /**
   * Mark a doc as tombstoned — permanently hidden from get(), exists(), list(), and search().
   * Idempotent; safe to call when the row doesn't exist (no-op).
   */
  tombstone(docUrl: string): Promise<void>;
}

/**
 * SearchIndex — full-text query interface.
 *
 * Postgres: tsvector GIN index + websearch_to_tsquery / plainto_tsquery + ts_rank.
 * The substrate-specific FTS function is encapsulated in the adapter (pgStore.ts).
 *
 * Tombstoned docs are excluded from results.
 */
export interface SearchIndex {
  /**
   * Full-text search over indexed doc content (raw_rdf).
   * Results are ordered by ts_rank DESC, then docUrl ASC for deterministic tiebreak.
   * cursor is an opaque token encoding (rank, docUrl) for keyset pagination.
   */
  search(opts: {
    query: string;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: SearchResult[]; nextCursor: string | null }>;
}

/**
 * CrawlCoordinator — frontier management.
 *
 * Atomic claim semantics are intentionally substrate-specific: the Postgres adapter
 * uses SELECT … FOR UPDATE SKIP LOCKED (DECISION ADDENDUM); a SPARQL adapter would
 * supply its own claim primitive.
 *
 * NOTE: claim() is declared in this interface but the implementation is deferred to
 * pss-5i8 — the stub throws NotImplementedError.
 */
export interface CrawlCoordinator {
  /**
   * Enqueue a URL for crawling.
   *
   * Syntactic-only (no DNS) — SSRF classification happens later in guardedFetch.
   * Idempotent: if the URL already exists, the row is left unchanged (INSERT … ON CONFLICT DO NOTHING).
   * nextEligibleAt defaults to 0 (immediate).
   */
  enqueue(
    docUrl: string,
    opts?: {
      depth?: number;
      rootSeed?: string | null;
      suggestBudget?: number | null;
      source?: DocSource;
      discoveredFrom?: string | null;
      nextEligibleAt?: number;
    }
  ): Promise<void>;

  /**
   * Atomically claim a batch of pending docs for this worker.
   *
   * Implementation: SELECT … FOR UPDATE SKIP LOCKED (Postgres / pss-5i8).
   * STUB: throws NotImplementedError — implemented in pss-5i8.
   *
   * @param workerId   Unique worker / invocation identifier (used as claim_token).
   * @param batchSize  Max rows to claim in one call.
   * @returns          The claimed rows (may be fewer than batchSize when the frontier is thin).
   */
  claim(workerId: string, batchSize: number): Promise<DocRecord[]>;

  /**
   * Finalise a completed crawl attempt: update state, validators, and next_eligible_at.
   *
   * @param claimToken  The token returned by the claim() call that owns this row.
   *   The UPDATE is fenced to `WHERE doc_url = docUrl AND claim_token = claimToken`.
   *   If the token no longer matches (row was reclaimed by another worker after this
   *   worker's lease expired), the update touches 0 rows and is treated as a SAFE
   *   NO-OP — the stale completion is silently discarded.  Pass `null` / `undefined`
   *   only when calling outside the claim→markDone lifecycle (e.g. tests that call
   *   enqueue() then markDone() directly without going through claim()); in that case
   *   the fence is skipped and the traditional "0 rows = unknown docUrl → throw"
   *   behaviour is preserved.
   */
  markDone(
    docUrl: string,
    result: CrawlResult,
    claimToken?: string | null
  ): Promise<void>;

  /**
   * Returns true when the doc is due for re-crawl.
   * A doc needs recrawl when:
   *   - it is unknown (never crawled) → true
   *   - state = 'done' or 'failed' and next_eligible_at <= now
   *   - currentEtag differs from the stored etag (validator mismatch)
   */
  needsRecrawl(docUrl: string, currentEtag?: string): Promise<boolean>;
}
