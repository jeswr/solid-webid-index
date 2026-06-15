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
  /**
   * Extracted display label for the WebID agent (foaf:name / vcard:fn / schema:name),
   * populated by the crawler projection step.  Null until first crawl or when no
   * name is present in the profile.  Used as the 'A'-weight FTS input so name
   * matches rank above raw-RDF URI/predicate hits.
   */
  label: string | null;
  /**
   * Opaque, deterministic slug for the served entry document /p/{slug}
   * (= base32(sha256(webid))[0..24]; DESIGN.md §2.1.c).  Maintained alongside
   * `webid` so the reverse lookup slug → doc is a single indexed read.  Null until
   * the doc has a webid.
   */
  slug: string | null;
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
  /**
   * Extracted display label (foaf:name / vcard:fn / schema:name), or null when
   * the profile carries no name or has not yet been crawled.
   */
  label: string | null;
}

// ─── Triple Pattern Fragments supporting types ────────────────────────────────

/**
 * A triple pattern for `GET /tpf?s=&p=&o=` (DESIGN.md §4.5).  Any of the three
 * terms may be omitted (a variable).  When `o` is present, `oIsIri` disambiguates
 * an IRI object from a literal object — the route derives it from how the client
 * supplied the value (an absolute IRI is matched as an IRI; otherwise a literal).
 */
export interface TpfPattern {
  /** Subject IRI to match, or undefined for a variable subject. */
  s?: string;
  /** Predicate IRI to match, or undefined for a variable predicate. */
  p?: string;
  /** Object value (IRI or literal lexical form) to match, or undefined. */
  o?: string;
  /**
   * When `o` is set, whether to match it as an IRI (true) or a literal (false).
   * Ignored when `o` is undefined.  Default (route-level) is to treat an
   * absolute-IRI-shaped `o` as an IRI and anything else as a literal.
   */
  oIsIri?: boolean;
}

/**
 * One matched triple returned by {@link ReadStore.tpf}.  `oIsIri` lets the route
 * faithfully rebuild the object term (NamedNode vs Literal) for serialisation.
 */
export interface TpfTriple {
  s: string;
  p: string;
  o: string;
  oIsIri: boolean;
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
   * Fetch the indexed entry by its opaque slug (the /p/{slug} reverse lookup).
   *
   * Returns:
   *  - the DocRecord when a non-tombstoned row with that slug exists (served as 200);
   *  - `"tombstoned"` when the slug maps to a tombstoned row (served as 410 + no-store);
   *  - null when the slug is unknown (served as 404).
   *
   * The three-way result lets the entry route distinguish 404 (never indexed / erased
   * without a tombstone) from 410 (explicitly tombstoned — DESIGN.md §4.1 H1).
   */
  getEntryBySlug(slug: string): Promise<DocRecord | "tombstoned" | null>;

  /**
   * Fetch the indexed entry by canonical WebID (the /lookup?webid= forward lookup).
   * Returns the DocRecord (non-tombstoned), or null when the WebID is not indexed.
   */
  getEntryByWebid(webid: string): Promise<DocRecord | null>;

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

  /**
   * Triple Pattern Fragments DATA read (DESIGN.md §4.5).
   *
   * Returns the matching triples from the materialised `triple` table for the given
   * pattern, page-capped with an opaque keyset cursor.  Triples ABOUT a tombstoned
   * WebID are NEVER returned (DESIGN.md §4.8 H1) — the filter is applied in SQL.
   *
   * Ordering is deterministic (s, p, o, o_is_iri) so keyset pagination is stable.
   */
  tpf(opts: {
    pattern: TpfPattern;
    limit: number;
    cursor?: string;
  }): Promise<{ triples: TpfTriple[]; nextCursor: string | null }>;

  /**
   * TPF METADATA read — the PATTERN cardinality ESTIMATE for `void:triples`
   * (DESIGN.md §4.5).
   *
   * This is intentionally an ESTIMATE, not a live COUNT on the hot path (arch M1):
   *  - the empty pattern (no s/p/o) reads the `stats` total-triples counter;
   *  - a predicate-only pattern reads the per-predicate `stats` counter when present;
   *  - any other pattern falls back to a BOUNDED COUNT (capped) so a hot pattern
   *    never triggers an unbounded scan.
   *
   * STATS-SIBLING RECONCILIATION (pss-b0a): a concurrent sibling bead builds richer
   * incremental stats (per-class/predicate maintenance in the projection tx).  This
   * method is the SMALL, clearly-named stats-read seam the route depends on; the
   * sibling's richer estimator can supersede the body of this method at merge
   * WITHOUT changing this signature.
   */
  estimatePatternCardinality(pattern: TpfPattern): Promise<number>;

  /**
   * Project a WebID's triples into the materialised `triple` table for TPF
   * (DESIGN.md §2.1.e), REPLACING any existing triples for that WebID first so a
   * re-projection never leaves stale rows.  Maintains the minimal `stats` counters
   * (total triples + per-predicate) additively.  Called from the projection/erasure
   * path; safe to call with an empty triple list (acts as a delete-by-webid).
   */
  upsertTriples(opts: {
    webid: string;
    docUrl: string;
    triples: TpfTriple[];
  }): Promise<void>;
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
   *
   * `webid` is the discovered canonical WebID (WITH its #fragment) for this document — e.g. a
   * `knows` target `https://x.example/profile#alice` strips to doc `…/profile` (the frontier key)
   * but carries the subject `…/profile#alice`. Persisting it means the crawler parses/extracts the
   * REAL subject on first crawl instead of assuming `#me` (DESIGN.md §3.3).
   *
   * When `suggestBudget` and `rootSeed` are both set, a shared `suggest_budget` row for that root is
   * created (INSERT … ON CONFLICT DO NOTHING) so the suggestion-rooted subtree has a single CONSUMED
   * budget (anti-amplification C2) — see {@link tryConsumeSuggestBudget}.
   */
  enqueue(
    docUrl: string,
    opts?: {
      depth?: number;
      rootSeed?: string | null;
      suggestBudget?: number | null;
      webid?: string | null;
      source?: DocSource;
      discoveredFrom?: string | null;
      nextEligibleAt?: number;
    }
  ): Promise<void>;

  /**
   * Atomically consume one node from a suggestion root's SHARED budget (anti-amplification C2).
   *
   * Runs `UPDATE suggest_budget SET remaining = remaining - 1 WHERE root_seed = $1 AND remaining > 0
   * RETURNING remaining` — a single atomic statement, so concurrent/serverless invocations can never
   * over-spend a budget. Returns true when a slot was granted (budget decremented), false when the
   * budget is exhausted (or the root has no budget row). The budget is CONSUMED across the whole
   * subtree, not reset per node, so a suggestion with budget N enqueues AT MOST N total descendants.
   */
  tryConsumeSuggestBudget(rootSeed: string): Promise<boolean>;

  /**
   * Count the LIVE frontier — rows in state 'pending' OR 'claimed'. Used to enforce FRONTIER_CAP
   * against the true in-flight frontier (under active crawling, claimed rows are part of the
   * frontier; counting only 'pending' under-counts and lets the cap be exceeded).
   */
  countFrontier(): Promise<number>;

  /**
   * Atomically claim a batch of pending docs for this worker.
   *
   * Implementation: SELECT … FOR UPDATE SKIP LOCKED (Postgres / pss-5i8).
   *
   * A FRESH UNIQUE opaque token (crypto.randomUUID()) is generated per claim()
   * invocation and stored in claim_token for all claimed rows.  The token is
   * returned on each claimed DocRecord (claimToken field) so the caller can pass
   * it to markDone().  workerId is the caller's logical identity and is NOT
   * stored in the database — keeping the two concerns separate ensures that a
   * restarted worker or a re-claim with the same workerId cannot collide with a
   * previous claim's token, making the lease fence genuinely effective.
   *
   * @param workerId   Caller's logical identity label (not stored as claim_token).
   * @param batchSize  Max rows to claim in one call.
   * @returns          The claimed rows (may be fewer than batchSize when the frontier is thin).
   *                   Each row's claimToken field carries the unique token for this batch.
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

// ─── PolitenessStore ──────────────────────────────────────────────────────────

/**
 * Per-host politeness state (the `host_politeness` table — DESIGN.md §2.1.b / §5).
 *
 * State lives in the DB because invocations are stateless (serverless): the
 * per-host crawl rate (`next_allowed_at`) must survive across separate function
 * invocations. The crawler reads `getHostState()` before each fetch and stamps
 * `next_allowed_at` after each fetch so a same-host second fetch is delayed.
 * All time columns are epoch milliseconds.
 */
export interface HostState {
  host: string;
  /** epoch ms — the host must not be fetched again before this instant. */
  nextAllowedAt: number;
  /** Count of consecutive transient failures (drives exponential host backoff). */
  consecutiveErrors: number;
}

/**
 * PolitenessStore — per-host rate limiting for the crawler.
 *
 * Separate from CrawlCoordinator so the frontier-claim port stays focused. The
 * Postgres adapter (PgStore) implements all four ports.
 */
export interface PolitenessStore {
  /**
   * Read the current host politeness row. Returns a zeroed default
   * (`nextAllowedAt: 0`, `consecutiveErrors: 0`) when the host is unknown — i.e.
   * an un-throttled host is immediately fetchable.
   */
  getHostState(host: string): Promise<HostState>;

  /**
   * Stamp the next-allowed instant for a host after the round-trip — the
   * politeness delay — and set/reset the consecutive-error counter. Upserts the row.
   *
   * @param host                The registrable host.
   * @param nextAllowedAt       epoch ms — the host is fetchable again at/after this.
   * @param consecutiveErrors   New consecutive-error count (0 resets on success).
   */
  stampHost(
    host: string,
    nextAllowedAt: number,
    consecutiveErrors: number
  ): Promise<void>;
}

// ─── StatsStore — incremental dataset statistics (DESIGN.md §2.1.j / §4.2) ─────

/**
 * One `void:classPartition` — a class IRI and how many entities (distinct
 * subjects) carry that `rdf:type` across the served dataset.
 */
export interface ClassPartition {
  /** The class IRI (the `rdf:type` object), e.g. `http://xmlns.com/foaf/0.1/Person`. */
  classIri: string;
  /** Number of entities (distinct subjects) of this class in the served dataset. */
  entities: number;
}

/**
 * One `void:propertyPartition` — a predicate IRI and how many triples in the
 * served dataset use it.
 */
export interface PropertyPartition {
  /** The predicate IRI, e.g. `http://xmlns.com/foaf/0.1/knows`. */
  propertyIri: string;
  /** Number of triples in the served dataset with this predicate. */
  triples: number;
}

/**
 * Dataset statistics for the VoID / DCAT description (DESIGN.md §4.2).
 *
 * Every field is read O(1) from the incrementally-maintained `stats` table — the
 * read NEVER scans `doc` or counts triples live (arch M1 / pss-0zp acceptance).
 *
 * `triples` is the total triple count of the SERVED dataset (the union of every
 * `/p/{slug}` entry graph), `entities` the number of indexed WebIDs, `classes` /
 * `properties` the number of DISTINCT classes / predicates, and the two partition
 * arrays the per-class / per-property breakdowns (`void:classPartition` /
 * `void:propertyPartition`).
 */
export interface DatasetStats {
  /** void:triples — total triples across all served entry graphs. */
  triples: number;
  /** void:entities — number of indexed WebIDs (served entries). */
  entities: number;
  /** void:classes — number of DISTINCT classes appearing in the dataset. */
  classes: number;
  /** void:properties — number of DISTINCT predicates appearing in the dataset. */
  properties: number;
  /** void:classPartition breakdown (sorted descending by entities, then IRI). */
  classPartitions: ClassPartition[];
  /** void:propertyPartition breakdown (sorted descending by triples, then IRI). */
  propertyPartitions: PropertyPartition[];
}

/**
 * StatsStore — the O(1) read seam for dataset statistics + the incremental
 * maintenance hook (DESIGN.md §2.1.j / §4.2).
 *
 * The maintenance contract (pss-0zp): the served-entry write path
 * ({@link CrawlCoordinator.markDone} on a `done` entry, and erasure /
 * {@link ReadStore.tombstone}) applies a DELTA to the `stats` counters — it does
 * NOT recount the dataset. `getStats()` therefore reads pre-aggregated counters and
 * is O(number of distinct classes/properties), independent of the dataset size.
 *
 * The TPF sibling's `estimatePatternCardinality` reads the SAME `stats` table
 * (predicate-partition counts) for its `void:triples` pattern estimate — this
 * interface is the clearly-named accessor that read path depends on.
 */
export interface StatsStore {
  /**
   * Read the current dataset statistics from the incrementally-maintained `stats`
   * table. O(distinct classes + distinct properties); never scans `doc` or `triple`.
   */
  getStats(): Promise<DatasetStats>;

  /**
   * Return the cardinality (triple count) of a single predicate across the served
   * dataset, read O(1) from the per-predicate `stats` counter, or 0 when the
   * predicate is absent. This is the cheap, clearly-named accessor the TPF sibling
   * (`estimatePatternCardinality`) reads for a predicate-only pattern estimate so
   * it never issues a live `COUNT` for `?p=` fragments.
   */
  getPredicateCardinality(propertyIri: string): Promise<number>;
}
