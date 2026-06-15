// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/store/pgStore.ts — Postgres adapter implementing ReadStore + SearchIndex + CrawlCoordinator.
 *
 * Driver-agnostic core: all SQL runs through SqlExecutor, which is implemented by:
 *   - createNeonExecutor()  — @neondatabase/serverless (production, Vercel+Neon)
 *   - createPgliteExecutor()— @electric-sql/pglite    (tests, in-process WASM Postgres)
 *
 * The adapter itself imports neither driver — callers inject the executor via makeStore()
 * or the PgStore constructor.  This keeps the hot path tree-shakeable and tests driver-free.
 *
 * FTS: uses websearch_to_tsquery('english', ...) with a fallback to plainto_tsquery when
 * the former is unavailable (pglite 0.5.x ships it, so no fallback is needed in practice).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Pool, neon } from "@neondatabase/serverless";

import { TPF_ESTIMATE_COUNT_CAP } from "../config";
import { slugForWebId } from "../url/slug";
import type {
  ClassPartition,
  CrawlCoordinator,
  CrawlResult,
  DatasetStats,
  DocRecord,
  DocSource,
  DocState,
  EraseInput,
  FailClass,
  HostState,
  InboxNotificationRecord,
  OptoutNonce,
  OptoutStore,
  PolitenessStore,
  PropertyPartition,
  ReadStore,
  RecordNotificationInput,
  SearchIndex,
  SearchResult,
  StatsStore,
  SuggestInboxStore,
  SuggestionStatus,
  TpfPattern,
  TpfTriple,
} from "./ports.js";
import {
  STATS_KEY_ENTITIES,
  STATS_KEY_SUPPRESSED,
  STATS_KEY_TRIPLES,
  STATS_PREFIX_CLASS,
  STATS_PREFIX_PROPERTY,
  STATS_PREFIX_SUPPRESSED,
  type StatTriple,
  classDelta,
  classEntityContribution,
  suppressedKey,
} from "./stats";

/** The rdf:type predicate IRI — class partitions count its IRI objects. */
const RDF_TYPE_IRI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// ─── SqlExecutor interface ────────────────────────────────────────────────────

/**
 * Minimal query interface — the only surface the adapter ever calls.
 * Both Neon and pglite satisfy this with a thin wrapper.
 */
export interface SqlExecutor {
  /**
   * Execute a parameterised SQL statement and return typed rows.
   * Params are positional ($1, $2, …).
   */
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<T[]>;

  /**
   * Execute a raw SQL script that may contain multiple statements separated by
   * semicolons (e.g. schema migration files).  No parameterisation.
   *
   * Implementations MUST handle the full SQL grammar correctly — they must not
   * misparse a `;` or `--` that appears inside a string literal, dollar-quoted
   * block, or comment.
   *
   * - pglite exposes a native `db.exec()` that accepts multi-statement strings.
   * - Neon uses statement-level splitting via splitSqlStatements() which is safe
   *   for DDL-only scripts that contain no dollar-quoted function bodies.
   */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a SINGLE database transaction (BEGIN … COMMIT / ROLLBACK).
   *
   * `fn` receives a tx-scoped {@link SqlExecutor} whose `query()` runs on the SAME connection inside
   * the open transaction.  When `fn` resolves the transaction COMMITs; when it throws the transaction
   * ROLLs BACK and the error propagates — so a mid-transaction failure leaves the DB consistent (the
   * atomicity guarantee the erasure path needs — DESIGN.md §4.8 H1).
   *
   * Both supported drivers provide a real transaction:
   *  - pglite — `db.transaction(tx => …)` gives a tx handle with `query()`;
   *  - @neondatabase/serverless — the HTTP driver lacks interactive transactions, so the Neon
   *    executor implements this by issuing BEGIN/COMMIT/ROLLBACK over a pooled connection (the
   *    serverless transaction API), running every `fn` statement on that one connection.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

// ─── Neon executor ────────────────────────────────────────────────────────────

/**
 * Wraps the Neon serverless HTTP driver.
 * Uses a top-level ESM import (no require()) — safe in production and
 * never invoked in tests because tests inject a pglite executor instead.
 */
export function createNeonExecutor(connectionString: string): SqlExecutor {
  // Initialise lazily so that the connection string is bound at call time,
  // but the neon() factory is only invoked on first query.
  let sql: ReturnType<typeof neon> | null = null;

  function getSql(): ReturnType<typeof neon> {
    if (!sql) {
      sql = neon(connectionString);
    }
    return sql;
  }

  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params?: unknown[]
    ): Promise<T[]> {
      // Neon's query<T> has ArrayMode/FullResults type params that don't accept
      // our generic T directly — cast through unknown to the concrete row type.
      const rows = await getSql().query(text, params ?? []);
      return rows as unknown as T[];
    },

    async exec(sql: string): Promise<void> {
      // Neon's HTTP driver does not support multi-statement strings in a single
      // call, so split into individual statements.  splitSqlStatements() is safe
      // for DDL-only scripts that contain no dollar-quoted function bodies.
      for (const stmt of splitSqlStatements(sql)) {
        await getSql().query(stmt, []);
      }
    },

    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      // The HTTP `neon()` tag is stateless (each call is its own implicit transaction), so an
      // INTERACTIVE multi-statement transaction needs a real pooled connection. @neondatabase/
      // serverless ships a node-postgres-compatible Pool/Client for exactly this — one connection,
      // explicit BEGIN/COMMIT/ROLLBACK, every statement on that connection (DESIGN.md §4.8 H1).
      const pool = new Pool({ connectionString });
      const client = await pool.connect();
      // A tx-scoped executor whose query() runs on THIS connection inside the open transaction.
      // exec()/transaction() are unsupported within an already-open transaction (the erasure path
      // never needs them) — guard so a misuse fails loudly rather than silently escaping the tx.
      const txExecutor: SqlExecutor = {
        async query<R = Record<string, unknown>>(
          text: string,
          params?: unknown[]
        ): Promise<R[]> {
          const result = await client.query(text, params ?? []);
          return result.rows as unknown as R[];
        },
        async exec(): Promise<void> {
          throw new Error("exec() is not supported inside a transaction");
        },
        async transaction(): Promise<never> {
          throw new Error("nested transaction() is not supported");
        },
      };
      try {
        await client.query("BEGIN");
        const out = await fn(txExecutor);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        // Roll back on ANY failure so a partial erasure can never commit. A rollback that itself
        // throws (e.g. the connection died) must not mask the original error.
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore — surface the original error below
        }
        throw err;
      } finally {
        client.release();
        await pool.end().catch(() => {});
      }
    },
  };
}

// ─── pglite executor ─────────────────────────────────────────────────────────

/**
 * Wraps @electric-sql/pglite for in-process testing.
 * PGlite is imported as a type to keep it dev-only; callers pass an instance.
 */
export function createPgliteExecutor(
  // Accept any object with .query(), .exec(), and .transaction() methods matching the pglite shape.
  // exec() returns an array of result objects; we ignore the return value here.
  db: {
    query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
    exec(sql: string): Promise<unknown>;
    transaction<T>(
      fn: (tx: {
        query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
      }) => Promise<T>
    ): Promise<T>;
  }
): SqlExecutor {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params?: unknown[]
    ): Promise<T[]> {
      const result = await db.query<T>(text, params ?? []);
      return result.rows;
    },

    async exec(sql: string): Promise<void> {
      // pglite's exec() natively handles multi-statement strings — it parses the
      // full SQL, respecting string literals and block comments, so a `;` or `--`
      // inside a quoted value or comment body never splits the statement wrongly.
      await db.exec(sql);
    },

    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      // pglite runs real Postgres (WASM) and provides db.transaction(cb) with a tx handle that
      // commits when cb resolves and rolls back when it throws — a genuine atomic transaction.
      return db.transaction(async (txDb) => {
        const txExecutor: SqlExecutor = {
          async query<R = Record<string, unknown>>(
            text: string,
            params?: unknown[]
          ): Promise<R[]> {
            const result = await txDb.query<R>(text, params ?? []);
            return result.rows;
          },
          async exec(): Promise<void> {
            throw new Error("exec() is not supported inside a transaction");
          },
          async transaction(): Promise<never> {
            throw new Error("nested transaction() is not supported");
          },
        };
        return fn(txExecutor);
      });
    },
  };
}

// ─── Row ↔ DocRecord mapping ──────────────────────────────────────────────────

interface DocRow {
  doc_url: string;
  host: string;
  webid: string | null;
  state: string;
  depth: number;
  root_seed: string | null;
  suggest_budget: number | null;
  source: string;
  discovered_from: string | null;
  claim_token: string | null;
  claimed_at: string | null; // BIGINT comes back as string from some drivers
  attempts: number;
  etag: string | null;
  last_modified: string | null;
  content_hash: string | null;
  last_crawled: string | null;
  next_eligible_at: string;
  enqueued_at: string;
  http_status: number | null;
  is_solid: boolean;
  fail_class: string | null;
  error: string | null;
  noindex: boolean;
  raw_rdf: string | null;
  label: string | null;
  slug: string | null;
}

function rowToRecord(r: DocRow): DocRecord {
  return {
    docUrl: r.doc_url,
    host: r.host,
    webid: r.webid,
    state: r.state as DocState,
    depth: Number(r.depth),
    rootSeed: r.root_seed,
    suggestBudget: r.suggest_budget != null ? Number(r.suggest_budget) : null,
    source: r.source as DocSource,
    discoveredFrom: r.discovered_from,
    claimToken: r.claim_token,
    claimedAt: r.claimed_at != null ? Number(r.claimed_at) : null,
    attempts: Number(r.attempts),
    etag: r.etag,
    lastModified: r.last_modified,
    contentHash: r.content_hash,
    lastCrawled: r.last_crawled != null ? Number(r.last_crawled) : null,
    nextEligibleAt: Number(r.next_eligible_at),
    enqueuedAt: Number(r.enqueued_at),
    httpStatus: r.http_status != null ? Number(r.http_status) : null,
    isSolid: Boolean(r.is_solid),
    failClass: r.fail_class as FailClass | null,
    error: r.error,
    noindex: Boolean(r.noindex),
    rawRdf: r.raw_rdf,
    label: r.label ?? null,
    slug: r.slug ?? null,
  };
}

// ─── PgStore ──────────────────────────────────────────────────────────────────

/**
 * Implements ReadStore + SearchIndex + CrawlCoordinator against a SqlExecutor.
 *
 * Instantiate via makeStore() in production or directly with a pglite executor in tests.
 */
export class PgStore
  implements
    ReadStore,
    SearchIndex,
    CrawlCoordinator,
    PolitenessStore,
    StatsStore,
    SuggestInboxStore,
    OptoutStore
{
  constructor(private readonly db: SqlExecutor) {}

  // ─── migrate ───────────────────────────────────────────────────────────────

  /**
   * Apply schema.sql idempotently.  Uses IF NOT EXISTS throughout so it is safe
   * to call on an existing database.
   *
   * The entire schema.sql is executed as a single multi-statement script.  Both
   * pglite and @neondatabase/serverless support multi-statement DDL, so no manual
   * splitting is necessary — and avoiding the split is safer because a `;` or `--`
   * inside a string literal, dollar-quoted function body, or future expression
   * cannot corrupt the parse.
   */
  async migrate(): Promise<void> {
    // Read schema relative to this file's location; works in both src/ and compiled dist/.
    // In tests (vitest), import.meta.url resolves to the actual source directory.
    let schemaSql: string;
    try {
      // Primary: resolve from the directory containing this module file.
      // Use new URL("schema.sql", import.meta.url) — the two-argument form is
      // recognised by webpack 5 as a static asset URL and does NOT trigger the
      // "can't resolve '.'" error that the new URL(".", import.meta.url) form
      // causes (webpack interprets "." as a module specifier).
      const schemaPath = new URL("schema.sql", import.meta.url).pathname;
      schemaSql = readFileSync(schemaPath, "utf-8");
    } catch {
      // Fallback: resolve from process.cwd() (e.g. project root in some vitest configs).
      const schemaPath = join(process.cwd(), "src/lib/store/schema.sql");
      schemaSql = readFileSync(schemaPath, "utf-8");
    }

    // Execute the whole schema as a multi-statement script via exec().
    // pglite uses its native exec() which parses the full SQL correctly.
    // Neon uses statement-level splitting via splitSqlStatements() (safe for
    // DDL-only files with no dollar-quoted function bodies).
    await this.db.exec(schemaSql);

    // ── slug backfill (idempotent) ──────────────────────────────────────────
    //
    // The `slug` column shipped AFTER `webid`, so rows crawled before the slug
    // route landed have `webid IS NOT NULL AND slug IS NULL`.  Without a backfill,
    // /lookup?webid= 303-redirects to /p/{slug} (it computes the slug forward)
    // but /p/{slug} then 404s (getEntryBySlug reads the empty slug column) — a
    // misleading 303→404 chain.  The slug is derived in app code (sha256+base32,
    // see slugForWebId), not in SQL, so it cannot be a generated column — we
    // compute it here for each affected row.
    //
    // Idempotent: the predicate `slug IS NULL` means a re-run after a successful
    // backfill selects nothing, and slugForWebId is deterministic so a partial
    // run is safe to resume.  Batched to keep memory bounded on large tables.
    await this.backfillSlugs();

    // ── triple + stats backfill (idempotent) ─────────────────────────────────
    //
    // The `triple` table + `stats` counters shipped AFTER the crawler first ran, so
    // a database with already-crawled `done` rows would expose EMPTY /tpf + VoID
    // stats until every profile is re-crawled (roborev).  Re-project each served row
    // (state='done', has webid + raw_rdf) that has NO triple rows yet, parsing its
    // stored canonical raw_rdf through the sanctioned path.  Idempotent: a row that
    // already has triples is skipped; upsertTriples is REPLACE-by-webid so a partial
    // run is safe to resume and re-running after completion is a no-op.
    await this.backfillTriples();
  }

  /**
   * Re-project served rows (state='done', webid + raw_rdf set) that have NO triples
   * materialised yet, populating the `triple` table + `stats` counters.  Bounded by
   * paging; safe to call repeatedly (idempotent — only rows lacking triples).
   *
   * The parse + projection helpers are dynamic-imported so the store's hot path stays
   * free of the parser bundle (mirrors claim()'s config dynamic-import).
   */
  private async backfillTriples(): Promise<void> {
    const PAGE = 200;
    const { parseProfile } = await import("@/lib/rdf/profile");
    const { datasetToTriples } = await import("@/lib/rdf/tpf");

    // KEYSET page by doc_url so each candidate row is visited AT MOST ONCE per call:
    // a row that re-projects to ZERO triples still has NO `triple` rows, so a
    // NOT-EXISTS-only predicate would re-select it forever (infinite loop).  Walking
    // forward by doc_url > cursor guarantees termination regardless of triple yield.
    let cursor = "";
    for (;;) {
      const rows = await this.db.query<{
        doc_url: string;
        webid: string;
        raw_rdf: string;
      }>(
        `SELECT d.doc_url, d.webid, d.raw_rdf
           FROM doc d
          WHERE d.state = 'done'
            AND d.webid IS NOT NULL
            AND d.raw_rdf IS NOT NULL
            AND d.doc_url > $1
            AND NOT EXISTS (SELECT 1 FROM triple t WHERE t.webid = d.webid)
          ORDER BY d.doc_url ASC
          LIMIT $2`,
        [cursor, PAGE]
      );
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].doc_url;

      for (const row of rows) {
        try {
          const dataset = await parseProfile({
            text: row.raw_rdf,
            contentType: "text/turtle",
            baseIri: row.doc_url,
          });
          const triples = datasetToTriples(dataset);
          await this.upsertTriples({
            webid: row.webid,
            docUrl: row.doc_url,
            triples,
          });
        } catch {
          // A row whose stored raw_rdf no longer parses is left un-projected — it will
          // be re-projected on its next crawl.  Never let one bad row abort the backfill;
          // the keyset cursor has already moved past it so it is not re-selected this call.
        }
      }

      if (rows.length < PAGE) break;
    }
  }

  /**
   * Compute and persist `slug` for every row that has a `webid` but no `slug`
   * (pre-slug rows).  Called from migrate(); safe to call repeatedly.
   *
   * The slug is sha256(webid)→base32 (slugForWebId) — not expressible in SQL —
   * so we read the backlog in pages and UPDATE each row by its webid.  The
   * `WHERE slug IS NULL` guard on both the SELECT and the UPDATE makes this
   * idempotent and re-entrant under concurrent migrators.
   */
  private async backfillSlugs(): Promise<void> {
    const PAGE = 500;
    // Loop until no more pre-slug rows remain.  Each page reads distinct webids
    // that still lack a slug and writes the computed slug back.
    for (;;) {
      const rows = await this.db.query<{ webid: string }>(
        `SELECT DISTINCT webid FROM doc
           WHERE webid IS NOT NULL AND slug IS NULL
           LIMIT $1`,
        [PAGE]
      );
      if (rows.length === 0) break;

      for (const { webid } of rows) {
        await this.db.query(
          "UPDATE doc SET slug = $1 WHERE webid = $2 AND slug IS NULL",
          [slugForWebId(webid), webid]
        );
      }

      // Final partial page → done (avoids an extra empty SELECT round-trip).
      if (rows.length < PAGE) break;
    }
  }

  // ─── ReadStore ─────────────────────────────────────────────────────────────

  async get(docUrl: string): Promise<DocRecord | null> {
    const rows = await this.db.query<DocRow>(
      `SELECT * FROM doc WHERE doc_url = $1 AND state != 'tombstone'`,
      [docUrl]
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async getEntryBySlug(slug: string): Promise<DocRecord | "tombstoned" | null> {
    // Include tombstoned rows so we can distinguish 410 (tombstoned) from 404
    // (unknown slug) — the entry route serves a different status for each.
    const rows = await this.db.query<DocRow>(
      "SELECT * FROM doc WHERE slug = $1 LIMIT 1",
      [slug]
    );
    const row = rows[0];
    if (!row) return null;
    if (row.state === "tombstone") return "tombstoned";
    return rowToRecord(row);
  }

  async getEntryByWebid(webid: string): Promise<DocRecord | null> {
    const rows = await this.db.query<DocRow>(
      `SELECT * FROM doc WHERE webid = $1 AND state != 'tombstone' LIMIT 1`,
      [webid]
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async exists(docUrl: string): Promise<boolean> {
    const rows = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM doc WHERE doc_url = $1 AND state != 'tombstone'
       ) AS exists`,
      [docUrl]
    );
    return Boolean(rows[0]?.exists);
  }

  async list(opts: {
    state?: DocState;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: DocRecord[]; nextCursor: string | null }> {
    const { state, limit, cursor } = opts;

    // Keyset cursor is just the doc_url (lexicographic ordering is stable and cheap).
    const cursorDocUrl = cursor ? decodeCursor(cursor) : null;

    const params: unknown[] = [limit + 1];
    let whereClause = "WHERE 1=1";

    if (state) {
      params.push(state);
      whereClause += ` AND state = $${params.length}`;
    } else {
      // Default: exclude tombstones from listings
      whereClause += ` AND state != 'tombstone'`;
    }

    if (cursorDocUrl) {
      params.push(cursorDocUrl);
      whereClause += ` AND doc_url > $${params.length}`;
    }

    const rows = await this.db.query<DocRow>(
      `SELECT * FROM doc ${whereClause} ORDER BY doc_url ASC LIMIT $1`,
      params
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && pageRows.length > 0
        ? encodeCursor(pageRows[pageRows.length - 1].doc_url)
        : null;

    return {
      rows: pageRows.map(rowToRecord),
      nextCursor,
    };
  }

  async put(record: DocRecord): Promise<void> {
    // Slug is derived from the canonical webid (single source of truth). An
    // explicit record.slug is honoured only as a fallback when no webid is set.
    const slug = record.webid
      ? slugForWebId(record.webid)
      : (record.slug ?? null);
    await this.db.query(
      `INSERT INTO doc (
         doc_url, host, webid, state, depth, root_seed, suggest_budget,
         source, discovered_from, claim_token, claimed_at, attempts,
         etag, last_modified, content_hash, last_crawled, next_eligible_at,
         enqueued_at, http_status, is_solid, fail_class, error, noindex, raw_rdf, label, slug
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17,
         $18, $19, $20, $21, $22, $23, $24, $25, $26
       )
       ON CONFLICT (doc_url) DO UPDATE SET
         host             = EXCLUDED.host,
         webid            = EXCLUDED.webid,
         state            = EXCLUDED.state,
         depth            = EXCLUDED.depth,
         root_seed        = EXCLUDED.root_seed,
         suggest_budget   = EXCLUDED.suggest_budget,
         source           = EXCLUDED.source,
         discovered_from  = EXCLUDED.discovered_from,
         claim_token      = EXCLUDED.claim_token,
         claimed_at       = EXCLUDED.claimed_at,
         attempts         = EXCLUDED.attempts,
         etag             = EXCLUDED.etag,
         last_modified    = EXCLUDED.last_modified,
         content_hash     = EXCLUDED.content_hash,
         last_crawled     = EXCLUDED.last_crawled,
         next_eligible_at = EXCLUDED.next_eligible_at,
         enqueued_at      = EXCLUDED.enqueued_at,
         http_status      = EXCLUDED.http_status,
         is_solid         = EXCLUDED.is_solid,
         fail_class       = EXCLUDED.fail_class,
         error            = EXCLUDED.error,
         noindex          = EXCLUDED.noindex,
         raw_rdf          = EXCLUDED.raw_rdf,
         label            = EXCLUDED.label,
         slug             = EXCLUDED.slug`,
      [
        record.docUrl,
        record.host,
        record.webid,
        record.state,
        record.depth,
        record.rootSeed,
        record.suggestBudget,
        record.source,
        record.discoveredFrom,
        record.claimToken,
        record.claimedAt,
        record.attempts,
        record.etag,
        record.lastModified,
        record.contentHash,
        record.lastCrawled,
        record.nextEligibleAt,
        record.enqueuedAt,
        record.httpStatus,
        record.isSolid,
        record.failClass,
        record.error,
        record.noindex,
        record.rawRdf,
        record.label ?? null,
        slug,
      ]
    );
  }

  async tombstone(docUrl: string): Promise<void> {
    const now = Date.now();
    // Clear this document's materialised triples + SUBTRACT its stats contribution
    // BEFORE tombstoning the doc row (roborev): a direct tombstone() (the opt-out /
    // erasure path, DESIGN.md §4.8) must decrement the stats counters too, otherwise
    // a predicate-only TPF estimate (which reads the 'p:<iri>' counter directly) would
    // keep advertising void:triples / hydra:totalItems for an erased WebID even though
    // the data rows are tombstone-filtered out of the response.  Erase by EVERY webid
    // currently projected from this document so no counter is left over-counting.
    const projectedWebids = await this.db.query<{ webid: string }>(
      "SELECT DISTINCT webid FROM triple WHERE doc_url = $1 AND webid IS NOT NULL",
      [docUrl]
    );
    for (const { webid } of projectedWebids) {
      await this.clearWebidProjection(webid);
    }

    await this.db.query(
      `INSERT INTO doc (
         doc_url, host, state, source, enqueued_at, terminal_at
       ) VALUES ($1, '', 'tombstone', 'seed', $2, $2)
       ON CONFLICT (doc_url) DO UPDATE SET
         state = 'tombstone',
         claim_token = NULL,
         raw_rdf = NULL,
         terminal_at = $2`,
      [docUrl, now]
    );
  }

  // ─── Triple Pattern Fragments (ReadStore — DESIGN.md §4.5) ───────────────────

  /**
   * TPF data read.  Builds a parameterised WHERE from whichever of s/p/o are bound,
   * then filters out triples ABOUT a tombstoned WebID via a correlated NOT EXISTS
   * against the `doc` table (DESIGN.md §4.8 H1).  Keyset paginated on (s,p,o,o_is_iri)
   * with an opaque cursor; ORDER BY matches the keyset so paging is stable.
   */
  async tpf(opts: {
    pattern: TpfPattern;
    limit: number;
    cursor?: string;
  }): Promise<{ triples: TpfTriple[]; nextCursor: string | null }> {
    const { pattern, limit, cursor } = opts;

    // LIMIT placeholder is $1; subsequent bound terms append after it.
    const params: unknown[] = [limit + 1];
    const where: string[] = [];

    if (pattern.s !== undefined) {
      params.push(pattern.s);
      where.push(`t.s = $${params.length}`);
    }
    if (pattern.p !== undefined) {
      params.push(pattern.p);
      where.push(`t.p = $${params.length}`);
    }
    if (pattern.o !== undefined) {
      params.push(pattern.o);
      where.push(`t.o = $${params.length}`);
      // Only constrain o_is_iri when the route disambiguated the object term.
      if (pattern.oIsIri !== undefined) {
        params.push(pattern.oIsIri);
        where.push(`t.o_is_iri = $${params.length}`);
      }
    }

    // Tombstone gate: never serve a triple ABOUT a tombstoned WebID, NOR an inbound edge whose IRI
    // OBJECT is a tombstoned WebID (DESIGN.md §4.8 H1 — drop `foaf:knows` edges TO a tombstoned
    // person from served output). A triple with a NULL webid (provenance/structural) is servable
    // unless its object is itself a tombstoned WebID. The gate matches on EITHER the WebID key OR the
    // doc URL key (variant-key gate, DESIGN.md §2.2 L5), and covers BOTH the permanent `tombstone`
    // table AND a `doc` row already in state 'tombstone' (the crawler auto-tombstone path).
    where.push(tombstoneSubjectClause("t"));
    where.push(tombstoneObjectClause("t"));

    // Keyset cursor encodes the last (s,p,o,o_is_iri) tuple emitted; the row-value
    // comparison (a,b,c,d) > ($..,$..,$..,$..) walks forward deterministically.
    const cursorTuple = cursor ? decodeTpfCursor(cursor) : null;
    if (cursorTuple) {
      params.push(
        cursorTuple.s,
        cursorTuple.p,
        cursorTuple.o,
        cursorTuple.oIsIri
      );
      const b = params.length;
      where.push(
        `(t.s, t.p, t.o, t.o_is_iri) > ($${b - 3}, $${b - 2}, $${b - 1}, $${b})`
      );
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await this.db.query<{
      s: string;
      p: string;
      o: string;
      o_is_iri: boolean;
    }>(
      `SELECT t.s, t.p, t.o, t.o_is_iri
         FROM triple t
         ${whereClause}
        ORDER BY t.s ASC, t.p ASC, t.o ASC, t.o_is_iri ASC
        LIMIT $1`,
      params
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const triples: TpfTriple[] = pageRows.map((r) => ({
      s: r.s,
      p: r.p,
      o: r.o,
      oIsIri: Boolean(r.o_is_iri),
    }));

    const last = triples[triples.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeTpfCursor({
            s: last.s,
            p: last.p,
            o: last.o,
            oIsIri: last.oIsIri,
          })
        : null;

    return { triples, nextCursor };
  }

  /**
   * TPF metadata read — the `void:triples` PATTERN cardinality ESTIMATE.
   *
   * Estimate sources (NEVER a live COUNT on the unbounded hot path — arch M1):
   *  - empty pattern → the `stats` 'triples' total counter (0 when unset);
   *  - predicate-only (p set, s+o unset) → the per-predicate `stats` 'p:<iri>' counter
   *    when present, else a bounded COUNT fallback;
   *  - any other pattern → a BOUNDED COUNT (capped at TPF_ESTIMATE_COUNT_CAP) so a
   *    pathological pattern can never trigger an unbounded scan.
   *
   * Tombstoned-WebID triples are excluded from every estimate path: subject-tombstoned rows are
   * already deleted from `triple` on erasure (so the O(1) counters never count them), and the bounded
   * COUNT applies the same NOT EXISTS gate as tpf().  INBOUND IRI-object edges TO a tombstoned WebID
   * (e.g. Alice's `foaf:knows Bob` after Bob is erased) remain in the table keyed under the still-live
   * subject, so they are SUPPRESSED at read but the raw O(1) counters still include them — the O(1)
   * paths SUBTRACT that suppressed count so the estimate matches the triples TPF actually serves
   * (roborev MEDIUM).
   */
  async estimatePatternCardinality(pattern: TpfPattern): Promise<number> {
    const noTerms =
      pattern.s === undefined &&
      pattern.p === undefined &&
      pattern.o === undefined;

    if (noTerms) {
      // Empty pattern → the SHARED total-triples counter (STATS_KEY_TRIPLES is
      // maintained in upsertTriples; the stats sibling reads the same key for
      // void:triples).  Absent row (pre-projection) → bounded COUNT fallback.
      const rows = await this.db.query<{ v: number | string }>(
        "SELECT v FROM stats WHERE k = $1",
        [STATS_KEY_TRIPLES]
      );
      if (rows[0]) {
        const counter = Number(rows[0].v);
        // Subtract inbound IRI-object edges to tombstoned WebIDs that the counter still includes but
        // the served TPF suppresses (clamp at 0). The suppressed count is read from the INCREMENTAL
        // `sup` counter — O(1), NO cap — so a dataset with more suppressed edges than
        // TPF_ESTIMATE_COUNT_CAP no longer over-reports (roborev MEDIUM).
        const suppressed = await this.getSuppressedCount(STATS_KEY_SUPPRESSED);
        return Math.max(0, counter - suppressed);
      }
    } else if (
      pattern.p !== undefined &&
      pattern.s === undefined &&
      pattern.o === undefined
    ) {
      // Predicate-only → the per-predicate counter via the stats sibling's
      // clearly-named O(1) accessor (its 'p:<iri>' key, maintained by this bead).
      // It returns 0 for an absent predicate; a 0 means the predicate is not in the
      // dataset, so a bounded COUNT would also return 0 — fall through only when the
      // accessor yields a positive estimate to avoid masking a transient empty state.
      const card = await this.getPredicateCardinality(pattern.p);
      if (card > 0) {
        // Same correction as the empty pattern, but scoped to this predicate: subtract the suppressed
        // inbound-object edges under THIS predicate from the INCREMENTAL `sp:<pred>` counter (O(1), no
        // cap — e.g. the `foaf:knows`→tombstoned-Bob edges).
        const suppressed = await this.getSuppressedCount(
          suppressedKey(pattern.p)
        );
        return Math.max(0, card - suppressed);
      }
    }

    // Bounded COUNT fallback — never an unbounded scan.  We count over a capped
    // subquery so the planner stops after at most the cap rows.
    return this.boundedPatternCount(pattern);
  }

  /**
   * Read a SUPPRESSED-edge counter (`sup` total OR `sp:<pred>` per-predicate) — the INCREMENTAL count
   * of inbound IRI-object edges whose object is a tombstoned WebID. These are maintained additively by
   * the store on EVERY projection mutation + erasure (see {@link adjustSuppressedCounters}), so the
   * empty-pattern + predicate-only estimates subtract the FULL hidden count in O(1) with NO cap — a
   * dataset with more suppressed edges than TPF_ESTIMATE_COUNT_CAP no longer over-reports (roborev
   * MEDIUM). Returns 0 for an absent counter (no suppression).
   */
  private async getSuppressedCount(key: string): Promise<number> {
    const rows = await this.db.query<{ v: number | string }>(
      "SELECT v FROM stats WHERE k = $1",
      [key]
    );
    return rows[0] ? Number(rows[0].v) : 0;
  }

  /**
   * BOUNDED COUNT over the triple table for a pattern, applying the tombstone gate.
   * Counts at most {@link TPF_ESTIMATE_COUNT_CAP} matching rows — a hard ceiling so
   * a hot/degenerate pattern can never trigger an unbounded scan on the hot path.
   */
  private async boundedPatternCount(pattern: TpfPattern): Promise<number> {
    const params: unknown[] = [];
    const where: string[] = [];

    if (pattern.s !== undefined) {
      params.push(pattern.s);
      where.push(`t.s = $${params.length}`);
    }
    if (pattern.p !== undefined) {
      params.push(pattern.p);
      where.push(`t.p = $${params.length}`);
    }
    if (pattern.o !== undefined) {
      params.push(pattern.o);
      where.push(`t.o = $${params.length}`);
      if (pattern.oIsIri !== undefined) {
        params.push(pattern.oIsIri);
        where.push(`t.o_is_iri = $${params.length}`);
      }
    }
    where.push(tombstoneSubjectClause("t"));
    where.push(tombstoneObjectClause("t"));

    params.push(TPF_ESTIMATE_COUNT_CAP);
    const capParam = `$${params.length}`;
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await this.db.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM triple t ${whereClause} LIMIT ${capParam}
       ) capped`,
      params
    );
    return rows[0] ? Number(rows[0].n) : 0;
  }

  /**
   * Project a WebID's triples into the materialised `triple` table (REPLACE), and
   * maintain the minimal `stats` counters additively.  Delete-by-webid first so a
   * re-projection never leaves stale rows; then bulk-insert the new triple set.
   */
  async upsertTriples(opts: {
    webid: string;
    docUrl: string;
    triples: TpfTriple[];
  }): Promise<void> {
    const { webid, docUrl, triples } = opts;

    // ── Projection tombstone gate (gate 3 of 3 — DESIGN.md §4.8 H1) ────────────
    // A tombstoned WebID must NEVER be (re)projected into the served `triple` table — even if a
    // crawler somehow reaches its raw_rdf, the projection write is the enforcement point that keeps
    // an erased person out of TPF / search / dump. Treat a non-empty projection of a tombstoned WebID
    // as an EMPTY projection (delete-by-webid), so any residue is cleared rather than re-served. (An
    // empty triple list — the documented delete-by-webid used on 410/noindex — is allowed through to
    // the clear path below regardless.)
    if (triples.length > 0) {
      const tombstoned = await this.isTombstoned({ webid, docUrl });
      if (tombstoned) {
        // Clear the projection AND redact the doc row to a DURABLE tombstone (raw_rdf + generated FTS
        // blanked, WebID redacted, slug retained) in ONE transaction so a tombstoned WebID leaves NO
        // servable residue — neither in TPF (triples) NOR on /p/{slug} / search (the doc row). Before
        // this, the projection was skipped but a `done` doc row with raw_rdf/webid could still serve
        // erased PII (DESIGN.md §4.8 H1). The doc row is REDACTED, not deleted, so the durable PK gate
        // against enqueue resurrection (roborev HIGH 2) stays in place. Both keys are handled
        // (variant-key cleanup, DESIGN.md §2.2 L5).
        await this.db.transaction(async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            docUrl,
          ]);
          await this.clearWebidProjection(webid, tx);
          await this.redactDocToTombstone({ webid, docUrl }, tx);
        });
        return;
      }
    }

    // ── Clear any STALE prior projection of this DOCUMENT under a DIFFERENT webid
    // (roborev): a doc_url that first resolved to W1 and later to W2 would otherwise
    // leave W1's triples (keyed by doc_url) served + counted forever.  For each such
    // stale webid, run the empty-projection clear (delete-by-webid + subtract its
    // stats) so both the triple table AND the stats counters stay exact.  Skipped in
    // the common case (no doc_url/webid change) by the WHERE webid != $2 filter.
    const staleWebids = await this.db.query<{ webid: string }>(
      "SELECT DISTINCT webid FROM triple WHERE doc_url = $1 AND webid IS NOT NULL AND webid != $2",
      [docUrl, webid]
    );
    for (const { webid: stale } of staleWebids) {
      await this.clearWebidProjection(stale);
    }

    // Decrement the stats counters by the OLD triple count for this webid before
    // replacing, then re-add the new count — keeps 'triples'/'p:<iri>' consistent
    // across re-projections.  (TPF bead owns these counters; the stats bead pss-0zp
    // owns 'entities'/'c:<iri>', maintained below from the same old→new diff.)
    const oldByPred = await this.db.query<{ p: string; n: number | string }>(
      "SELECT p, COUNT(*) AS n FROM triple WHERE webid = $1 GROUP BY p",
      [webid]
    );

    // OLD entity + class-partition contribution for this webid — read its existing
    // rdf:type IRI triples BEFORE the DELETE so the stats-bead delta (entities +
    // c:<iri>) is computed against the previous served state (DESIGN.md §2.1.j).
    const oldTypeRows = await this.db.query<{ s: string; o: string }>(
      "SELECT s, o FROM triple WHERE webid = $1 AND p = $2 AND o_is_iri = TRUE",
      [webid, RDF_TYPE_IRI]
    );
    // isEntity reflects whether the webid had ANY served triples (not just typed
    // ones), so a typeless-but-present webid still counts as an entity. Derive it
    // from oldByPred (the previous total triple count); take the class breakdown
    // from the typed rows.
    const oldContribution = {
      isEntity: oldByPred.length > 0 ? 1 : 0,
      classes: classEntityContribution(
        oldTypeRows.map((r) => ({
          s: r.s,
          p: RDF_TYPE_IRI,
          o: r.o,
          oIsIri: true,
        }))
      ).classes,
    };

    // OLD SUPPRESSED contribution for this webid — its existing rows whose IRI object is a tombstoned
    // WebID (inbound edges to an erased person). Read BEFORE the DELETE so the incremental
    // suppressed-edge counters drop by exactly what is being removed (roborev MEDIUM, no cap).
    const oldSuppressed = await this.suppressedContributionForWebid(webid);

    await this.db.query("DELETE FROM triple WHERE webid = $1", [webid]);

    // Subtract the OLD per-predicate counts (TPF bead's 'triples' + 'p:<iri>'
    // counters) in ONE batched upsert — fewer round-trips than a query per predicate.
    const oldDelta: Array<[string, number]> = [];
    let oldTotal = 0;
    for (const old of oldByPred) {
      const n = Number(old.n);
      oldTotal += n;
      oldDelta.push([`p:${old.p}`, -n]);
    }
    if (oldTotal > 0) oldDelta.push(["triples", -oldTotal]);
    await this.adjustStatsBatch(oldDelta);

    // NEW entity + class-partition contribution (this bead's owned counters).
    const newContribution = classEntityContribution(triples as StatTriple[]);
    await this.applyClassEntityDelta(oldContribution, newContribution);

    // Maintain the incremental SUPPRESSED-edge counters across this re-projection: subtract the OLD
    // suppressed contribution, then add the NEW one (the new triples whose IRI object is currently a
    // tombstoned WebID). Net delta keeps `sup` / `sp:<pred>` exact so the O(1) VoID/TPF correction
    // never relies on a capped scan (roborev MEDIUM).
    await this.adjustSuppressedCounters(oldSuppressed, "subtract");
    const newSuppressed = await this.suppressedContributionInTriples(triples);
    await this.adjustSuppressedCounters(newSuppressed, "add");

    if (triples.length > 0) {
      // Build a single multi-row INSERT (bounded by MAX_QUADS upstream).
      const values: string[] = [];
      const params: unknown[] = [webid, docUrl];
      for (const t of triples) {
        const base = params.length;
        params.push(t.s, t.p, t.o, t.oIsIri);
        // s=$(base+1), p=$(base+2), o=$(base+3), o_is_iri=$(base+4); webid=$1, doc_url=$2.
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $1, $2)`
        );
      }
      await this.db.query(
        `INSERT INTO triple (s, p, o, o_is_iri, webid, doc_url) VALUES ${values.join(", ")}`,
        params
      );

      // Re-add the new per-predicate counts + the total in ONE batched upsert.
      const newByPred = new Map<string, number>();
      for (const t of triples) {
        newByPred.set(t.p, (newByPred.get(t.p) ?? 0) + 1);
      }
      const newDelta: Array<[string, number]> = [["triples", triples.length]];
      for (const [pred, n] of newByPred) {
        newDelta.push([`p:${pred}`, n]);
      }
      await this.adjustStatsBatch(newDelta);
    }
  }

  /**
   * Fully clear a WebID's materialised projection: delete its triples and subtract
   * its WHOLE stats contribution (TPF bead's 'triples'/'p:<iri>' + this bead's
   * 'entities'/'c:<iri>').  Used to evict a STALE projection when a document changes
   * the WebID it resolves to (roborev) — the old WebID's rows must not linger.
   * Idempotent: a WebID with no rows is a no-op.
   */
  private async clearWebidProjection(
    webid: string,
    db: SqlExecutor = this.db
  ): Promise<void> {
    const oldByPred = await db.query<{ p: string; n: number | string }>(
      "SELECT p, COUNT(*) AS n FROM triple WHERE webid = $1 GROUP BY p",
      [webid]
    );
    if (oldByPred.length === 0) return; // nothing projected for this webid

    const oldTypeRows = await db.query<{ s: string; o: string }>(
      "SELECT s, o FROM triple WHERE webid = $1 AND p = $2 AND o_is_iri = TRUE",
      [webid, RDF_TYPE_IRI]
    );
    const oldContribution = {
      isEntity: 1,
      classes: classEntityContribution(
        oldTypeRows.map((r) => ({
          s: r.s,
          p: RDF_TYPE_IRI,
          o: r.o,
          oIsIri: true,
        }))
      ).classes,
    };

    // This WebID's OLD SUPPRESSED contribution: its rows whose IRI object is a tombstoned WebID
    // (inbound edges, e.g. knows→erased-person). They are about to be deleted, so the incremental
    // suppressed counters must drop by them (roborev MEDIUM — keeps the O(1) correction exact, no cap).
    const oldSuppressed = await this.suppressedContributionForWebid(webid, db);

    await db.query("DELETE FROM triple WHERE webid = $1", [webid]);

    // Subtract TPF counters ('triples' + 'p:<iri>').
    const delta: Array<[string, number]> = [];
    let total = 0;
    for (const old of oldByPred) {
      const n = Number(old.n);
      total += n;
      delta.push([`p:${old.p}`, -n]);
    }
    if (total > 0) delta.push(["triples", -total]);
    await this.adjustStatsBatch(delta, db);

    // Subtract this bead's counters ('entities' + 'c:<iri>') — to EMPTY.
    await this.applyClassEntityDelta(
      oldContribution,
      {
        isEntity: 0,
        classes: {},
      },
      db
    );

    // Subtract the suppressed inbound-edge counters this WebID contributed.
    await this.adjustSuppressedCounters(oldSuppressed, "subtract", db);
  }

  /**
   * Count this WebID's rows whose IRI object is a tombstoned WebID, GROUPED BY predicate — i.e. the
   * inbound edges projected UNDER this WebID that TPF/VoID SUPPRESS (object = an erased person). Used
   * to keep the INCREMENTAL suppressed-edge counters (`sup` / `sp:<pred>`) exact when this WebID's
   * projection changes or is cleared (roborev MEDIUM). Returns an EMPTY map when no tombstone exists
   * (a single cheap EXISTS short-circuit), so the common no-erasure path adds no work.
   */
  private async suppressedContributionForWebid(
    webid: string,
    db: SqlExecutor = this.db
  ): Promise<Map<string, number>> {
    const anyTomb = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM tombstone
         UNION ALL
         SELECT 1 FROM doc WHERE state = 'tombstone'
       ) AS exists`
    );
    if (!anyTomb[0]?.exists) return new Map();

    const rows = await db.query<{ p: string; n: number | string }>(
      `SELECT t.p AS p, COUNT(*) AS n
         FROM triple t
        WHERE t.webid = $1
          AND t.o_is_iri = TRUE
          AND EXISTS (
            SELECT 1 FROM tombstone ts WHERE ts.webid = t.o
            UNION ALL
            SELECT 1 FROM doc d WHERE d.state = 'tombstone' AND d.webid = t.o
          )
        GROUP BY t.p`,
      [webid]
    );
    return new Map(rows.map((r) => [r.p, Number(r.n)]));
  }

  /**
   * Given the NEW triple set being projected for a WebID, return the per-predicate count of those
   * triples whose IRI object is CURRENTLY a tombstoned WebID — i.e. the inbound edges that will be
   * SUPPRESSED at read the moment they are inserted (e.g. re-crawling Alice's `knows`→already-erased
   * Bob). Used to keep the incremental suppressed-edge counters exact on re-projection (roborev
   * MEDIUM). Returns an EMPTY map when no triple has an IRI object OR no tombstone exists (one cheap
   * batched lookup of only the distinct IRI objects, never an unbounded scan).
   */
  private async suppressedContributionInTriples(
    triples: TpfTriple[]
  ): Promise<Map<string, number>> {
    // Distinct IRI objects appearing in the new triple set — the only candidates for object-suppression.
    const iriObjects = new Set<string>();
    for (const t of triples) {
      if (t.oIsIri) iriObjects.add(t.o);
    }
    if (iriObjects.size === 0) return new Map();

    // Which of those distinct IRI objects are tombstoned WebIDs (one batched query bounded by the
    // distinct-object count, not the dataset). tombstonedWebids() covers both the permanent table and
    // a `doc` row in state 'tombstone'.
    const tombstonedObjects = await this.tombstonedWebids([...iriObjects]);
    if (tombstonedObjects.size === 0) return new Map();

    const byPredicate = new Map<string, number>();
    for (const t of triples) {
      if (t.oIsIri && tombstonedObjects.has(t.o)) {
        byPredicate.set(t.p, (byPredicate.get(t.p) ?? 0) + 1);
      }
    }
    return byPredicate;
  }

  /**
   * Apply a per-predicate suppressed-edge delta to the incremental counters (`sup` total +
   * `sp:<pred>` per-predicate), either adding (newly suppressed edges) or subtracting (edges removed /
   * re-projected away). One batched, GREATEST(0,…)-clamped upsert — the same O(1) path the other
   * counters use. A zero/empty map is a no-op (no query). Maintained on EVERY projection mutation +
   * erasure so `getStats` / `estimatePatternCardinality` subtract the FULL hidden count with NO cap
   * (roborev MEDIUM).
   */
  private async adjustSuppressedCounters(
    byPredicate: Map<string, number>,
    op: "add" | "subtract",
    db: SqlExecutor = this.db
  ): Promise<void> {
    if (byPredicate.size === 0) return;
    const sign = op === "add" ? 1 : -1;
    const adjustments: Array<[string, number]> = [];
    let total = 0;
    for (const [pred, n] of byPredicate) {
      if (n === 0) continue;
      total += n;
      adjustments.push([suppressedKey(pred), sign * n]);
    }
    if (total !== 0) adjustments.push([STATS_KEY_SUPPRESSED, sign * total]);
    await this.adjustStatsBatch(adjustments, db);
  }

  // ─── StatsStore (pss-0zp) — entities + class partitions + O(1) reads ──────────

  /**
   * Apply the signed entity + class-partition delta computed by classDelta() to the
   * `stats` counters (this bead's owned keys: 'entities' + 'c:<classIri>').  Called
   * from upsertTriples on every (re)projection AND erasure (empty triple list), so
   * the counters are maintained INCREMENTALLY on upsert AND erase (pss-0zp).
   */
  private async applyClassEntityDelta(
    old: { isEntity: number; classes: Record<string, number> },
    next: { isEntity: number; classes: Record<string, number> },
    db: SqlExecutor = this.db
  ): Promise<void> {
    const delta = classDelta(old, next);

    // Collect every non-zero counter adjustment ('entities' + each 'c:<iri>') and
    // apply them in ONE multi-row upsert — fewer round-trips than a query per class
    // (keeps the projection write cheap under load).
    const adjustments: Array<[string, number]> = [];
    if (delta.entities !== 0) {
      adjustments.push([STATS_KEY_ENTITIES, delta.entities]);
    }
    for (const [classIri, n] of Object.entries(delta.classes)) {
      adjustments.push([`${STATS_PREFIX_CLASS}${classIri}`, n]);
    }
    await this.adjustStatsBatch(adjustments, db);
  }

  /**
   * Apply a batch of (key, delta) counter adjustments in a SINGLE multi-row upsert,
   * clamping each at 0 (GREATEST(0, …) — a counter never goes negative).  Zero
   * deltas are skipped.  One round-trip regardless of how many counters change.
   */
  private async adjustStatsBatch(
    adjustments: Array<[string, number]>,
    db: SqlExecutor = this.db
  ): Promise<void> {
    const nonZero = adjustments.filter(([, d]) => d !== 0);
    if (nonZero.length === 0) return;

    // The inserted value carries the RAW delta so the conflict branch can add it
    // (EXCLUDED.v = the raw delta).  GREATEST(0, …) clamps the RESULT in the conflict
    // branch.  A brand-new key is only ever created by a POSITIVE delta (a class /
    // entity that did not exist before its first projection), so the unclamped INSERT
    // value is always ≥ 0 — a negative delta always targets an existing row (the
    // conflict branch), where the result is clamped.  One round-trip regardless of
    // how many counters change.
    const values: string[] = [];
    const params: unknown[] = [];
    for (const [key, delta] of nonZero) {
      const base = params.length;
      params.push(key, delta);
      values.push(`($${base + 1}, $${base + 2}::bigint)`);
    }
    await db.query(
      `INSERT INTO stats (k, v) VALUES ${values.join(", ")}
       ON CONFLICT (k) DO UPDATE SET v = GREATEST(0, stats.v + EXCLUDED.v)`,
      params
    );
  }

  async getStats(): Promise<DatasetStats> {
    // Single O(distinct classes + distinct properties) read of the pre-aggregated
    // counters — NEVER a live COUNT over doc/triple (arch M1 / pss-0zp acceptance).
    // Only rows with v > 0 count: a partition that dropped to 0 (erased) leaves a
    // v=0 row (the counter clamps at 0, it does not DELETE the row) which must not
    // inflate the distinct class/property counts.
    const rows = await this.db.query<{ k: string; v: number | string }>(
      "SELECT k, v FROM stats WHERE v > 0"
    );

    let triples = 0;
    let entities = 0;
    let suppressedTotal = 0;
    const classPartitions: ClassPartition[] = [];
    const propertyPartitions: PropertyPartition[] = [];
    // Per-predicate SUPPRESSED inbound-edge counts, read from the INCREMENTAL `sp:<pred>` counters in
    // the SAME single stats read (no extra scan) — roborev MEDIUM.
    const suppressedByPred = new Map<string, number>();

    for (const r of rows) {
      const v = Number(r.v);
      if (r.k === STATS_KEY_TRIPLES) {
        triples = v;
      } else if (r.k === STATS_KEY_ENTITIES) {
        entities = v;
      } else if (r.k === STATS_KEY_SUPPRESSED) {
        suppressedTotal = v;
      } else if (r.k.startsWith(STATS_PREFIX_SUPPRESSED)) {
        suppressedByPred.set(r.k.slice(STATS_PREFIX_SUPPRESSED.length), v);
      } else if (r.k.startsWith(STATS_PREFIX_CLASS)) {
        classPartitions.push({
          classIri: r.k.slice(STATS_PREFIX_CLASS.length),
          entities: v,
        });
      } else if (r.k.startsWith(STATS_PREFIX_PROPERTY)) {
        propertyPartitions.push({
          propertyIri: r.k.slice(STATS_PREFIX_PROPERTY.length),
          triples: v,
        });
      }
    }

    // Correct for SUPPRESSED inbound IRI-object edges to tombstoned WebIDs (roborev MEDIUM): an edge
    // like Alice's `foaf:knows Bob` survives in `triple` (keyed under live Alice) after Bob is erased,
    // so the raw `triples`/`p:` counters still include it, but TPF/served output suppresses it. The
    // suppressed counts are maintained INCREMENTALLY (`sup` / `sp:<pred>`, on every projection +
    // erasure), so the correction subtracts the FULL hidden count with NO cap — a dataset with more
    // suppressed inbound edges than TPF_ESTIMATE_COUNT_CAP no longer over-reports. Subtract from the
    // total `triples` AND from each affected property partition so VoID matches served data.
    if (suppressedTotal > 0 || suppressedByPred.size > 0) {
      triples = Math.max(0, triples - suppressedTotal);
      for (const part of propertyPartitions) {
        const sub = suppressedByPred.get(part.propertyIri);
        if (sub) part.triples = Math.max(0, part.triples - sub);
      }
    }
    // Drop any property partition whose served count is now 0 so void:properties + the partition list
    // reflect only predicates with at least one SERVED triple.
    const servedPropertyPartitions = propertyPartitions.filter(
      (p) => p.triples > 0
    );

    // Sort partitions deterministically: descending count, then IRI for stable
    // ordering (so the VoID graph + its ETag are stable across reads).
    classPartitions.sort(
      (a, b) => b.entities - a.entities || a.classIri.localeCompare(b.classIri)
    );
    servedPropertyPartitions.sort(
      (a, b) =>
        b.triples - a.triples || a.propertyIri.localeCompare(b.propertyIri)
    );

    return {
      triples,
      entities,
      // void:classes / void:properties = number of DISTINCT classes / predicates
      // (derived from the partition counts, all already v > 0 / served > 0).
      classes: classPartitions.length,
      properties: servedPropertyPartitions.length,
      classPartitions,
      propertyPartitions: servedPropertyPartitions,
    };
  }

  async getPredicateCardinality(propertyIri: string): Promise<number> {
    const rows = await this.db.query<{ v: number | string }>(
      "SELECT v FROM stats WHERE k = $1",
      [`${STATS_PREFIX_PROPERTY}${propertyIri}`]
    );
    return rows[0] ? Number(rows[0].v) : 0;
  }

  // ─── SearchIndex ───────────────────────────────────────────────────────────

  async search(opts: {
    query: string;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: SearchResult[]; nextCursor: string | null }> {
    const { query, limit, cursor } = opts;

    // Decode keyset cursor — encodes (rank, docUrl) as a JSON string.
    const cursorParts = cursor ? decodeSearchCursor(cursor) : null;

    const params: unknown[] = [query, limit + 1];

    // Keyset: filter out rows that would appear before the cursor.
    // Ordering: rank DESC, doc_url ASC (deterministic tiebreak).
    // Keyset condition: (rank < cursorRank) OR (rank = cursorRank AND doc_url > cursorDocUrl)
    //
    // ts_rank() returns REAL (float4). Passing a float8 cursor rank back as a
    // Postgres parameter risks the equality branch failing due to float64→float4
    // precision loss. Cast the parameter to ::real so Postgres compares float4
    // to float4 (the same type as the computed rank expression).
    let cursorClause = "";
    if (cursorParts) {
      params.push(cursorParts.rank, cursorParts.docUrl);
      const rankParam = `$${params.length - 1}::real`;
      cursorClause = `AND (
        ts_rank(label_fts, websearch_to_tsquery('english', $1)) < ${rankParam}
        OR (
          ts_rank(label_fts, websearch_to_tsquery('english', $1)) = ${rankParam}
          AND doc_url > $${params.length}
        )
      )`;
    }

    interface SearchRow {
      doc_url: string;
      webid: string | null;
      raw_rdf: string | null;
      is_solid: boolean;
      state: string;
      last_crawled: string | null;
      rank: number | string;
      label: string | null;
    }

    // Use label_fts (weighted: label='A', raw_rdf='D') for ranking so name-matching
    // results outrank incidental URI/predicate hits.  Fall back to fts_vector (raw_rdf
    // only) when websearch_to_tsquery is unavailable (older pglite builds) or if
    // label_fts column has not yet been migrated in (guard against schema-lag).
    let rows: SearchRow[];
    try {
      rows = await this.db.query<SearchRow>(
        `SELECT doc_url, webid, raw_rdf, is_solid, state, last_crawled, label,
                ts_rank(label_fts, websearch_to_tsquery('english', $1)) AS rank
         FROM doc
         WHERE label_fts @@ websearch_to_tsquery('english', $1)
           AND state != 'tombstone'
           ${cursorClause}
         ORDER BY rank DESC, doc_url ASC
         LIMIT $2::int`,
        params
      );
    } catch (err) {
      // Fallback 1: websearch_to_tsquery absent (pglite ≤0.4.x) — try plainto_tsquery
      // with label_fts.  Fallback 2: label_fts column absent (pre-migration schema) —
      // fall back to fts_vector.  Both are caught by the same "undefined function /
      // column not found" error class; we try once more with fts_vector + plainto_tsquery.
      if (!isUndefinedFunctionError(err) && !isUndefinedColumnError(err)) {
        throw err;
      }

      // Older pglite builds may not ship websearch_to_tsquery; label_fts may be absent
      // on pre-migration schemas.  plainto_tsquery + fts_vector is always available.
      const fallbackParams = [...params];
      const fallbackCursorClause = cursorParts
        ? `AND (
          ts_rank(fts_vector, plainto_tsquery('english', $1)) < $${fallbackParams.length - 1}::real
          OR (
            ts_rank(fts_vector, plainto_tsquery('english', $1)) = $${fallbackParams.length - 1}::real
            AND doc_url > $${fallbackParams.length}
          )
        )`
        : "";

      rows = await this.db.query<SearchRow>(
        `SELECT doc_url, webid, raw_rdf, is_solid, state, last_crawled,
                NULL::TEXT AS label,
                ts_rank(fts_vector, plainto_tsquery('english', $1)) AS rank
         FROM doc
         WHERE fts_vector @@ plainto_tsquery('english', $1)
           AND state != 'tombstone'
           ${fallbackCursorClause}
         ORDER BY rank DESC, doc_url ASC
         LIMIT $2::int`,
        fallbackParams
      );
    }

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const results: SearchResult[] = pageRows.map((r) => ({
      docUrl: r.doc_url,
      webid: r.webid,
      rawRdf: r.raw_rdf,
      isSolid: Boolean(r.is_solid),
      state: r.state as DocState,
      lastCrawled: r.last_crawled != null ? Number(r.last_crawled) : null,
      rank: Number(r.rank),
      label: r.label ?? null,
    }));

    const nextCursor =
      hasMore && results.length > 0
        ? encodeSearchCursor(
            results[results.length - 1].rank,
            results[results.length - 1].docUrl
          )
        : null;

    return { rows: results, nextCursor };
  }

  // ─── CrawlCoordinator ──────────────────────────────────────────────────────

  async enqueue(
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
  ): Promise<void> {
    const host = extractHost(docUrl);
    const rootSeed = opts?.rootSeed ?? null;
    const suggestBudget = opts?.suggestBudget ?? null;
    const webidForGate = opts?.webid ?? null;
    const webid = opts?.webid ?? null;
    const slug = webid ? slugForWebId(webid) : null;

    // ── Enqueue tombstone gate (gate 1 of 3 — DESIGN.md §4.8 H1) ────────────────
    // A permanently-tombstoned WebID / doc URL must NEVER be re-enqueued, across ANY discovery path
    // (seed / catalog / inbox / knows). Erasure DELETES the doc row (so the ON CONFLICT DO NOTHING
    // below would otherwise happily re-insert it); the permanent `tombstone` table is the durable
    // gate. Check by EITHER key so a fragment-variant cannot resurrect an opted-out person.
    //
    // The check + the INSERT run in ONE transaction so the gate is ATOMIC against a concurrent
    // eraseWebId(). The DURABLE guarantee is the surviving tombstone DOC ROW that erase leaves behind:
    // the doc-table PK means the `INSERT … ON CONFLICT (doc_url) DO NOTHING` below CANNOT create a
    // competing `pending` row once the canonical doc URL has a tombstone row — so even under READ
    // COMMITTED (where the `tombstone`-table SELECT might miss a not-yet-committed erase), a committed
    // erase can never be resurrected (roborev HIGH 2). The advisory lock — shared with eraseWebId() /
    // markDone() on hashtext(docUrl) — serialises the CHECK ↔ INSERT ordering as belt-and-braces.
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [docUrl]);

      if (
        await this.isTombstonedOn(
          { webid: webidForGate ?? undefined, docUrl },
          tx
        )
      ) {
        return; // silently refuse — the tombstone is permanent
      }

      // Seed the SHARED suggestion-root budget BEFORE inserting the doc. When a suggestion-rooted
      // document is enqueued with a budget, the budget belongs to the whole subtree (keyed on
      // root_seed), so all descendants CONSUME from this one counter (anti-amplification C2). ON
      // CONFLICT DO NOTHING means a re-enqueue of the same root never resets a partially-spent budget.
      if (suggestBudget != null && rootSeed != null) {
        await tx.query(
          `INSERT INTO suggest_budget (root_seed, remaining)
           VALUES ($1, $2)
           ON CONFLICT (root_seed) DO NOTHING`,
          [rootSeed, Math.max(0, suggestBudget)]
        );
      }

      await tx.query(
        `INSERT INTO doc (
           doc_url, host, webid, state, depth, root_seed, suggest_budget,
           source, discovered_from, next_eligible_at, enqueued_at, slug
         ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (doc_url) DO NOTHING`,
        [
          docUrl,
          host,
          webid,
          opts?.depth ?? 0,
          rootSeed,
          suggestBudget,
          opts?.source ?? "seed",
          opts?.discoveredFrom ?? null,
          opts?.nextEligibleAt ?? 0,
          Date.now(),
          slug,
        ]
      );
    });
  }

  async tryConsumeSuggestBudget(rootSeed: string): Promise<boolean> {
    // Atomic decrement: at most one invocation can take the LAST slot, so a budget of N grants at
    // most N successful consumptions across all concurrent/serverless callers. 0 rows returned =
    // budget exhausted (remaining was already 0) or no budget row for this root.
    const rows = await this.db.query<{ remaining: number }>(
      `UPDATE suggest_budget
          SET remaining = remaining - 1
        WHERE root_seed = $1
          AND remaining > 0
        RETURNING remaining`,
      [rootSeed]
    );
    return rows.length > 0;
  }

  async countFrontier(): Promise<number> {
    // Live frontier = pending + claimed rows. Both are part of the in-flight frontier; counting only
    // 'pending' under-counts under active crawling and lets FRONTIER_CAP be exceeded.
    const rows = await this.db.query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM doc WHERE state IN ('pending', 'claimed')`
    );
    return rows[0] ? Number(rows[0].n) : 0;
  }

  /**
   * Atomically claim a batch of pending (or expired-lease, or due-terminal) frontier rows.
   *
   * SQL pattern — single statement, one round-trip:
   *
   *   WITH eligible AS (
   *     SELECT doc_url FROM doc
   *     WHERE (
   *       (state IN ('pending','done','failed') AND next_eligible_at <= now)
   *       OR
   *       (state = 'claimed' AND claimed_at <= expiredBefore)
   *     )
   *     AND noindex = FALSE
   *     ORDER BY depth ASC, next_eligible_at ASC
   *     LIMIT batchSize
   *     FOR UPDATE SKIP LOCKED          -- skip rows locked by concurrent workers
   *   )
   *   UPDATE doc SET
   *     state = 'claimed', claim_token = $token,
   *     claimed_at = $now, attempts = attempts + 1
   *   FROM eligible
   *   WHERE doc.doc_url = eligible.doc_url
   *   RETURNING *
   *
   * SKIP LOCKED means a concurrent worker claiming at the same instant skips any
   * row this transaction has already locked — concurrent workers therefore receive
   * disjoint row sets with no blocking and no double-claims.
   *
   * Eligibility:
   *   - pending rows whose next_eligible_at <= now (immediate crawl)
   *   - done/failed rows whose next_eligible_at <= now (due recrawl — DESIGN.md §3.4)
   *   - claimed rows whose claimed_at <= (now - LEASE_MS) (crash recovery)
   *
   * markDone() clears the lease on normal completion with a token-fenced UPDATE.
   *
   * pglite note: pglite runs real Postgres internally (WASM), so FOR UPDATE SKIP
   * LOCKED is fully supported — verified by the concurrency test in pgStore.test.ts.
   */
  async claim(_workerId: string, batchSize: number): Promise<DocRecord[]> {
    const now = Date.now();
    // A row is reclaimable if it has been claimed for longer than LEASE_MS.
    // Import LEASE_MS from config so the threshold is the single-source constant.
    // We inline the import here to keep the adapter config-aware without coupling
    // the constructor to config (tests inject their own batchSize).
    const { LEASE_MS } = await import("@/lib/config");
    const expiredBefore = now - LEASE_MS;

    // Generate a FRESH UNIQUE opaque token for this claim() call.  All rows in
    // the batch share the same token (one token per claim() invocation is
    // sufficient — the batch is atomic).  Using a UUID means a restarted worker
    // or a re-claim of the same workerId CANNOT produce the same token, so a
    // stale markDone() from a previous claim never matches the new owner's token.
    // workerId is retained as the caller's logical identity but is NOT stored in
    // claim_token — keeping the two concerns separate.
    const claimToken = crypto.randomUUID();

    const rows = await this.db.query<DocRow>(
      `WITH eligible AS (
         SELECT doc_url FROM doc
         WHERE (
           (state IN ('pending', 'done', 'failed') AND next_eligible_at <= $1)
           OR
           (state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= $2)
         )
         AND noindex = FALSE
         ORDER BY depth ASC, next_eligible_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE doc
          SET state       = 'claimed',
              claim_token = $4,
              claimed_at  = $1,
              attempts    = attempts + 1
         FROM eligible
        WHERE doc.doc_url = eligible.doc_url
        RETURNING doc.*`,
      [now, expiredBefore, batchSize, claimToken]
    );

    return rows.map(rowToRecord);
  }

  async markDone(
    docUrl: string,
    result: CrawlResult,
    claimToken?: string | null
  ): Promise<boolean> {
    // When a claimToken is provided, fence the UPDATE so only the owning worker
    // can write back results.  If the lease expired and another worker reclaimed
    // the row, our token no longer matches — 0 rows updated is a STALE completion
    // (safe no-op: the new owner's in-progress state must not be clobbered).
    //
    // When no claimToken is provided (e.g. tests that call enqueue→markDone directly
    // without going through claim()), fall back to the traditional doc_url-only
    // predicate, and treat 0 rows as a caller error (unknown URL → throw).
    // Derive the slug from the webid being written (if any). COALESCE keeps the
    // existing slug when no webid is supplied — the slug is set the first time the
    // webid is known and never silently cleared on a validator-only re-crawl.
    const slug = result.webid ? slugForWebId(result.webid) : null;
    // Stamp terminal_at when the row enters a terminal/tombstoned state — this drives the suggest-
    // inbox 7-day re-suggest cooldown (DESIGN.md §4.3/§5). Non-terminal states (e.g. a re-pend back
    // to 'pending') leave the prior terminal_at intact via COALESCE. The crawler does not need to
    // know about this column — markDone derives it from the target state.
    const TERMINAL_STATES = [
      "done",
      "failed",
      "skipped",
      "blocked",
      "tombstone",
    ];
    const terminalAt = TERMINAL_STATES.includes(result.state)
      ? Date.now()
      : null;

    // ── markDone tombstone gate — close the erasure resurrection RACE (DESIGN.md §4.8 H1) ─────────
    // The completion write below sets state='done' + raw_rdf + webid + slug on the doc row, so a
    // crawl that finishes AFTER an opt-out/erasure tombstoned this WebID would RESURRECT servable PII
    // on /p/{slug} + search even though the triple projection is skipped. To make the gate airtight
    // against a concurrent eraseWebId() we run the tombstone CHECK and the write in ONE transaction:
    //  - erase commits FIRST → this tx's tombstone SELECT sees it (READ COMMITTED) → we refuse + purge
    //    any residual doc row instead of writing 'done'.
    //  - this markDone commits FIRST → eraseWebId redacts the just-written row to a tombstone doc
    //    row (raw_rdf=NULL, webid redacted), so it is still erased.
    // Either interleaving leaves the WebID erased — no servable raw_rdf/webid row survives.
    //
    // RETURN VALUE: this method resolves to `true` only when a fenced completion was actually written
    // (the UPDATE matched a row). A stale-token no-op OR a tombstone refusal returns `false`, so the
    // crawler gates its out-of-fence projection (upsertTriples) on this result — a stale lease can
    // neither complete nor project (DESIGN.md §3.4 / §4.8 H1 — roborev HIGH).
    return this.db.transaction(async (tx) => {
      // Serialise this completion against a concurrent eraseWebId() on the SAME canonical doc key, so
      // the tombstone CHECK below + the write commit atomically relative to the erase (belt-and-braces
      // alongside the durable tombstone doc row + PK that erase leaves behind).
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [docUrl]);

      const tombstoned = await this.isTombstonedOn(
        { webid: result.webid ?? undefined, docUrl },
        tx
      );
      if (tombstoned) {
        // Redact any doc row a concurrent enqueue/crawl may have (re)created for this URL/WebID to a
        // durable tombstone row (raw_rdf=NULL, webid redacted) so the tombstoned entry can never be
        // served, then refuse the completion write entirely. Both keys are matched (variant-key
        // cleanup, DESIGN.md §2.2 L5).
        await this.redactDocToTombstone(
          { webid: result.webid ?? null, docUrl },
          tx
        );
        return false; // refused: tombstoned — no fenced completion written
      }

      if (claimToken != null) {
        const fenced = await tx.query<{ doc_url: string }>(
          `UPDATE doc SET
             state            = $2,
             http_status      = $3,
             etag             = COALESCE($4, etag),
             last_modified    = COALESCE($5, last_modified),
             content_hash     = COALESCE($6, content_hash),
             raw_rdf          = COALESCE($7, raw_rdf),
             is_solid         = COALESCE($8, is_solid),
             webid            = COALESCE($9, webid),
             slug             = COALESCE($15, slug),
             fail_class       = $10,
             error            = $11,
             next_eligible_at = $12,
             last_crawled     = $13,
             terminal_at      = COALESCE($16, terminal_at),
             claim_token      = NULL,
             claimed_at       = NULL
           WHERE doc_url = $1
             AND claim_token = $14
           RETURNING doc_url`,
          [
            docUrl,
            result.state,
            result.httpStatus ?? null,
            result.etag ?? null,
            result.lastModified ?? null,
            result.contentHash ?? null,
            result.rawRdf ?? null,
            result.isSolid ?? null,
            result.webid ?? null,
            result.failClass ?? null,
            result.error ?? null,
            result.nextEligibleAt ?? Date.now() + 14 * 24 * 60 * 60 * 1000,
            Date.now(),
            claimToken,
            slug,
            terminalAt,
          ]
        );
        // 0 rows updated = stale completion (token mismatch — row reclaimed by another
        // worker).  Safe no-op: do NOT throw, do NOT clobber the new owner's state.  Return
        // `false` so the caller skips the out-of-fence projection (roborev HIGH 1).
        return fenced.length > 0;
      }

      // No claimToken: traditional path (enqueue→markDone without claim).
      // RETURNING doc_url lets us detect a no-op UPDATE (0 rows matched).
      const updated = await tx.query<{ doc_url: string }>(
        `UPDATE doc SET
           state            = $2,
           http_status      = $3,
           etag             = COALESCE($4, etag),
           last_modified    = COALESCE($5, last_modified),
           content_hash     = COALESCE($6, content_hash),
           raw_rdf          = COALESCE($7, raw_rdf),
           is_solid         = COALESCE($8, is_solid),
           webid            = COALESCE($9, webid),
           slug             = COALESCE($14, slug),
           fail_class       = $10,
           error            = $11,
           next_eligible_at = $12,
           last_crawled     = $13,
           terminal_at      = COALESCE($15, terminal_at),
           claim_token      = NULL,
           claimed_at       = NULL
         WHERE doc_url = $1
         RETURNING doc_url`,
        [
          docUrl,
          result.state,
          result.httpStatus ?? null,
          result.etag ?? null,
          result.lastModified ?? null,
          result.contentHash ?? null,
          result.rawRdf ?? null,
          result.isSolid ?? null,
          result.webid ?? null,
          result.failClass ?? null,
          result.error ?? null,
          result.nextEligibleAt ?? Date.now() + 14 * 24 * 60 * 60 * 1000,
          Date.now(),
          slug,
          terminalAt,
        ]
      );

      if (updated.length === 0) {
        throw new Error(
          `markDone: no row found for docUrl="${docUrl}" — must call enqueue() before markDone()`
        );
      }
      return true; // token-less completion written
    });
  }

  /**
   * Replace any `doc` row for this WebID / doc URL with a DURABLE redacted tombstone row instead of
   * deleting it (DESIGN.md §4.8 H1 — roborev HIGH 2). Keeping a permanent `state='tombstone'` row
   * (raw_rdf=NULL, webid redacted to NULL, but the slug retained for the /p/{slug} 410 distinction)
   * means a concurrent enqueue's `INSERT … ON CONFLICT (doc_url) DO NOTHING` CANNOT create a competing
   * `pending` row for the canonical doc key — the PK + the surviving tombstone row are the durable
   * serialization guarantee against the enqueue/erase resurrection race, independent of transaction
   * isolation level. Both the WebID key and the doc URL key are redacted (variant-key cleanup,
   * DESIGN.md §2.2 L5).
   *
   * The slug is recomputed from the (now-deleted) WebID where known so /p/{slug} still resolves to a
   * 410 tombstone; when the doc row is keyed only by doc_url with no WebID, the existing slug column is
   * preserved via COALESCE.
   */
  private async redactDocToTombstone(
    opts: { webid: string | null; docUrl: string },
    db: SqlExecutor = this.db
  ): Promise<void> {
    const { webid, docUrl } = opts;
    const now = Date.now();
    const slug = webid ? slugForWebId(webid) : null;
    // Redact every matching live row (by doc URL OR by WebID — variant-key cleanup) to a tombstone:
    // strip raw_rdf + webid (so search/getEntryByWebid never serve PII), keep the slug for the 410
    // distinction, and clear the lease. The fts/label_fts generated columns recompute to empty once
    // raw_rdf/label are NULL, so search drops the row too.
    await db.query(
      `UPDATE doc SET
         state         = 'tombstone',
         webid         = NULL,
         raw_rdf       = NULL,
         label         = NULL,
         content_hash  = NULL,
         etag          = NULL,
         last_modified = NULL,
         is_solid      = FALSE,
         claim_token   = NULL,
         claimed_at    = NULL,
         slug          = COALESCE($3, slug),
         terminal_at   = $2
       WHERE doc_url = $1 OR ($4::text IS NOT NULL AND webid = $4)`,
      [docUrl, now, slug, webid]
    );
    // Ensure a tombstone row EXISTS for the canonical doc URL even if no live row was present (so the
    // durable PK gate is in place for enqueue). ON CONFLICT keeps the row already redacted above.
    await db.query(
      `INSERT INTO doc (doc_url, host, state, source, enqueued_at, terminal_at, slug)
         VALUES ($1, '', 'tombstone', 'seed', $2, $2, $3)
       ON CONFLICT (doc_url) DO NOTHING`,
      [docUrl, now, slug]
    );
  }

  async needsRecrawl(docUrl: string, currentEtag?: string): Promise<boolean> {
    const rows = await this.db.query<{
      state: string;
      next_eligible_at: string;
      etag: string | null;
    }>("SELECT state, next_eligible_at, etag FROM doc WHERE doc_url = $1", [
      docUrl,
    ]);

    if (rows.length === 0) return true; // unknown → needs crawl

    const row = rows[0];
    const now = Date.now();

    if (
      row.state === "tombstone" ||
      row.state === "skipped" ||
      row.state === "blocked"
    ) {
      return false;
    }

    if (
      (row.state === "done" || row.state === "failed") &&
      Number(row.next_eligible_at) <= now
    ) {
      return true;
    }

    if (currentEtag && row.etag && currentEtag !== row.etag) {
      return true;
    }

    return false;
  }

  // ─── PolitenessStore ─────────────────────────────────────────────────────────

  async getHostState(host: string): Promise<HostState> {
    const rows = await this.db.query<{
      next_allowed_at: string;
      consecutive_errors: number;
    }>(
      "SELECT next_allowed_at, consecutive_errors FROM host_politeness WHERE host = $1",
      [host]
    );
    const row = rows[0];
    if (!row) {
      // Unknown host → immediately fetchable, no error history.
      return { host, nextAllowedAt: 0, consecutiveErrors: 0 };
    }
    return {
      host,
      nextAllowedAt: Number(row.next_allowed_at),
      consecutiveErrors: Number(row.consecutive_errors),
    };
  }

  async stampHost(
    host: string,
    nextAllowedAt: number,
    consecutiveErrors: number
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO host_politeness (host, next_allowed_at, consecutive_errors)
       VALUES ($1, $2, $3)
       ON CONFLICT (host) DO UPDATE SET
         next_allowed_at    = EXCLUDED.next_allowed_at,
         consecutive_errors = EXCLUDED.consecutive_errors`,
      [host, nextAllowedAt, consecutiveErrors]
    );
  }

  // ─── SuggestInboxStore ───────────────────────────────────────────────────────

  async suggestionStatus(opts: {
    webid: string;
    docUrl: string;
    nowMs: number;
    cooldownMs: number;
  }): Promise<SuggestionStatus> {
    const { webid, docUrl, nowMs, cooldownMs } = opts;

    // PERMANENT tombstone first (DESIGN.md §4.8 H1): erasure DELETES the doc row, so the durable
    // refusal lives in the `tombstone` table. A re-suggest of an erased WebID must be 409 — check it
    // BEFORE the doc lookup (by EITHER key — variant-key gate, DESIGN.md §2.2 L5).
    if (await this.isTombstoned({ webid, docUrl })) return "tombstoned";

    // Match on EITHER the canonical WebID (with #fragment) OR the canonical doc URL (stripped) so a
    // variant key cannot dodge a tombstone/cooldown (DESIGN.md §2.2 L5). Order the result so the most
    // restrictive matching row wins: tombstone first, then a within-cooldown terminal row.
    const rows = await this.db.query<{
      state: string;
      terminal_at: string | null;
    }>(
      `SELECT state, terminal_at FROM doc
        WHERE doc_url = $1 OR webid = $2`,
      [docUrl, webid]
    );
    if (rows.length === 0) return "unknown";

    let sawLive = false;
    for (const r of rows) {
      if (r.state === "tombstone") return "tombstoned"; // most restrictive — short-circuit
      if (r.state === "done") sawLive = true;
      const terminalStates = ["done", "failed", "skipped", "blocked"];
      if (
        terminalStates.includes(r.state) &&
        r.terminal_at != null &&
        nowMs - Number(r.terminal_at) < cooldownMs
      ) {
        // A freshly-terminal WebID: still within the re-suggest cooldown.
        return "cooldown";
      }
    }
    if (sawLive) return "live";
    // Known but pending/claimed (in-flight) → treat as live for dedup (don't re-enqueue).
    return "live";
  }

  async consumeRateBucket(opts: {
    key: string;
    limit: number;
    windowMs: number;
    nowMs: number;
  }): Promise<boolean> {
    const { key, limit, windowMs, nowMs } = opts;
    // Atomic fixed-window UPSERT:
    //  - insert a fresh bucket (count=1) when the key is new;
    //  - on conflict, RESET (window_start→now, count→1) when the stored window has expired, else
    //    INCREMENT count.  All in one statement so concurrent invocations can't over-admit.
    // The returned (window_start, count) reflects the post-update row; we grant iff count <= limit.
    const rows = await this.db.query<{ count: number | string }>(
      `INSERT INTO rate_bucket (key, window_start, count)
         VALUES ($1, $2, 1)
       ON CONFLICT (key) DO UPDATE SET
         window_start = CASE
                          WHEN rate_bucket.window_start + $3 <= $2 THEN $2
                          ELSE rate_bucket.window_start
                        END,
         count        = CASE
                          WHEN rate_bucket.window_start + $3 <= $2 THEN 1
                          ELSE rate_bucket.count + 1
                        END
       RETURNING count`,
      [key, nowMs, windowMs]
    );
    const count = rows[0] ? Number(rows[0].count) : limit + 1;
    return count <= limit;
  }

  async recordNotification(input: RecordNotificationInput): Promise<void> {
    const { id, receivedAt, actor, activity, body, objectIris } = input;
    // `processed` defaults to TRUE (candidates enqueued at receipt). It is set FALSE when admission
    // was DEFERRED (daily budget exhausted) so the daily drain can pick the notification up later.
    const processed = input.processed ?? true;
    // Insert the notification, then its extracted candidate objects. ON CONFLICT DO NOTHING keeps
    // the write idempotent under at-least-once retries / a duplicated client Slug.
    await this.db.query(
      `INSERT INTO inbox (id, received_at, actor, activity, body, redacted, processed)
         VALUES ($1, $2, $3, $4, $5, FALSE, $6)
       ON CONFLICT (id) DO NOTHING`,
      [id, receivedAt, actor, activity, body, processed]
    );
    for (const objectIri of objectIris) {
      await this.db.query(
        `INSERT INTO inbox_object (notif_id, object_iri)
           VALUES ($1, $2)
         ON CONFLICT (notif_id, object_iri) DO NOTHING`,
        [id, objectIri]
      );
    }
  }

  async getNotification(id: string): Promise<InboxNotificationRecord | null> {
    const rows = await this.db.query<{
      id: string;
      received_at: string;
      actor: string | null;
      activity: string;
      body: string;
      processed: boolean;
    }>(
      `SELECT id, received_at, actor, activity, body, processed
         FROM inbox WHERE id = $1 LIMIT 1`,
      [id]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      receivedAt: Number(r.received_at),
      actor: r.actor,
      activity: r.activity,
      body: r.body,
      processed: Boolean(r.processed),
    };
  }

  async listNotifications(opts: {
    limit: number;
    cursor?: string;
  }): Promise<{
    rows: InboxNotificationRecord[];
    nextCursor: string | null;
    total: number;
  }> {
    const { limit, cursor } = opts;
    const cursorParts = cursor ? decodeInboxCursor(cursor) : null;

    const params: unknown[] = [limit + 1];
    let whereClause = "";
    if (cursorParts) {
      params.push(cursorParts.receivedAt, cursorParts.id);
      // Keyset over (received_at DESC, id DESC): a row is AFTER the cursor when its received_at is
      // smaller, or equal-received_at with a smaller id.
      whereClause =
        "WHERE (received_at < $2) OR (received_at = $2 AND id < $3)";
    }

    const rows = await this.db.query<{
      id: string;
      received_at: string;
      actor: string | null;
      activity: string;
      body: string;
      processed: boolean;
    }>(
      `SELECT id, received_at, actor, activity, body, processed
         FROM inbox ${whereClause}
        ORDER BY received_at DESC, id DESC
        LIMIT $1`,
      params
    );

    const totalRows = await this.db.query<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM inbox"
    );
    const total = totalRows[0] ? Number(totalRows[0].n) : 0;

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const records: InboxNotificationRecord[] = pageRows.map((r) => ({
      id: r.id,
      receivedAt: Number(r.received_at),
      actor: r.actor,
      activity: r.activity,
      body: r.body,
      processed: Boolean(r.processed),
    }));

    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeInboxCursor(Number(last.received_at), last.id)
        : null;

    return { rows: records, nextCursor, total };
  }

  // ─── OptoutStore (pss-1ez — DESIGN.md §4.8) ───────────────────────────────────

  async issueOptoutNonce(opts: {
    webid: string;
    docUrl: string;
    nonce: string;
    nowMs: number;
    ttlMs: number;
  }): Promise<OptoutNonce> {
    const { webid, docUrl, nonce, nowMs, ttlMs } = opts;
    const expiresAt = nowMs + ttlMs;
    // REPLACE any prior nonce for this WebID so only the most recent challenge is live, and reset
    // used_at to NULL (a fresh challenge is unused) — ON CONFLICT DO UPDATE on the WebID PK.
    await this.db.query(
      `INSERT INTO optout_nonce (webid, doc_url, nonce, issued_at, expires_at, used_at)
         VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (webid) DO UPDATE SET
         doc_url    = EXCLUDED.doc_url,
         nonce      = EXCLUDED.nonce,
         issued_at  = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
         used_at    = NULL`,
      [webid, docUrl, nonce, nowMs, expiresAt]
    );
    return {
      webid,
      docUrl,
      nonce,
      issuedAt: nowMs,
      expiresAt,
      usedAt: null,
    };
  }

  async getLiveOptoutNonce(
    webid: string,
    nowMs: number
  ): Promise<OptoutNonce | null> {
    const rows = await this.db.query<{
      webid: string;
      doc_url: string;
      nonce: string;
      issued_at: string;
      expires_at: string;
      used_at: string | null;
    }>(
      `SELECT webid, doc_url, nonce, issued_at, expires_at, used_at
         FROM optout_nonce
        WHERE webid = $1 AND used_at IS NULL AND expires_at > $2
        LIMIT 1`,
      [webid, nowMs]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      webid: r.webid,
      docUrl: r.doc_url,
      nonce: r.nonce,
      issuedAt: Number(r.issued_at),
      expiresAt: Number(r.expires_at),
      usedAt: r.used_at != null ? Number(r.used_at) : null,
    };
  }

  async consumeOptoutNonce(webid: string, nowMs: number): Promise<boolean> {
    // Atomic single-use consume: stamp used_at iff the nonce is present, UNUSED, and UNEXPIRED.
    // RETURNING webid tells us whether THIS call won the race — a concurrent double-confirm grants
    // at most one erasure (the second UPDATE matches 0 rows because used_at is now set).
    const rows = await this.db.query<{ webid: string }>(
      `UPDATE optout_nonce
          SET used_at = $2
        WHERE webid = $1 AND used_at IS NULL AND expires_at > $2
        RETURNING webid`,
      [webid, nowMs]
    );
    return rows.length > 0;
  }

  async isTombstoned(opts: {
    webid?: string;
    docUrl?: string;
  }): Promise<boolean> {
    return this.isTombstonedOn(opts, this.db);
  }

  /**
   * Tombstone check against an INJECTED executor — same predicate as {@link isTombstoned} but runnable
   * on a tx-scoped executor so the check + a subsequent write commit/serialise atomically against a
   * concurrent erase (DESIGN.md §4.8 H1 — the markDone resurrection race). When `db` is a tx executor
   * a tombstone committed by a concurrent {@link eraseWebId} is visible (READ COMMITTED), so a crawl
   * that finishes AFTER the erase commits sees the tombstone and refuses to write.
   */
  private async isTombstonedOn(
    opts: { webid?: string; docUrl?: string },
    db: SqlExecutor
  ): Promise<boolean> {
    const { webid, docUrl } = opts;
    if (webid === undefined && docUrl === undefined) return false;
    // Match on EITHER key (WebID with #fragment OR fragment-stripped doc URL) so a variant cannot
    // dodge the tombstone (DESIGN.md §2.2 L5). Also treat a `doc` row whose state is already
    // 'tombstone' as tombstoned (the crawler's 410/noindex auto-tombstone path) so the gate is
    // consistent whether the tombstone came from /optout or from the crawler.
    const rows = await db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM tombstone t
          WHERE ($1::text IS NOT NULL AND t.webid = $1)
             OR ($2::text IS NOT NULL AND t.doc_url = $2)
         UNION ALL
         SELECT 1 FROM doc d
          WHERE d.state = 'tombstone'
            AND (($1::text IS NOT NULL AND d.webid = $1)
              OR ($2::text IS NOT NULL AND d.doc_url = $2))
       ) AS exists`,
      [webid ?? null, docUrl ?? null]
    );
    return Boolean(rows[0]?.exists);
  }

  async tombstonedWebids(webids: string[]): Promise<Set<string>> {
    if (webids.length === 0) return new Set();
    // De-dup the input so the bound-param list is minimal.
    const unique = [...new Set(webids)];
    // ONE placeholder list, reused by BOTH halves of the UNION — so the bound params are exactly
    // `unique` (NOT doubled): both subqueries reference the same $1..$N placeholders.
    const placeholders = unique.map((_, i) => `$${i + 1}`).join(", ");
    // A WebID is tombstoned if it is in the permanent `tombstone` table OR has a `doc` row already in
    // state 'tombstone' (the crawler auto-tombstone path) — consistent with isTombstoned().
    const rows = await this.db.query<{ webid: string }>(
      `SELECT webid FROM tombstone WHERE webid IN (${placeholders})
       UNION
       SELECT webid FROM doc WHERE state = 'tombstone' AND webid IN (${placeholders})`,
      unique
    );
    return new Set(rows.map((r) => r.webid));
  }

  async eraseWebId(input: EraseInput): Promise<void> {
    const { webid, docUrl, reason, proof } = input;
    const now = Date.now();

    // ONE real DB transaction over EVERY served surface (DESIGN.md §4.8 H1). A mid-transaction
    // failure ROLLs BACK the whole erase — the DB can never be left half-erased / stats-skewed.
    await this.db.transaction(async (tx) => {
      // 0. Serialise against a concurrent enqueue() / markDone() on the SAME canonical doc key. The
      //    durable guarantee is the surviving tombstone doc row + its PK (step 2 below), but the
      //    advisory lock (shared with enqueue + markDone) makes the tombstone CHECK ↔ INSERT ordering
      //    explicit too — belt-and-braces against the enqueue/erase resurrection race (roborev HIGH 2).
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [docUrl]);

      // 1. Clear the WebID's materialised triples + decrement the stats counters by its EXACT
      //    contribution (entities/classes/triples/predicates) — inside the tx so the counters and
      //    the triple deletion commit atomically. Idempotent: a webid with no rows is a no-op.
      await this.clearWebidProjection(webid, tx);

      // 1b. Also clear any triples projected from the DOC URL under a different/legacy webid key, so
      //     no residue about this person survives keyed on the document (variant-key cleanup).
      const docWebids = await tx.query<{ webid: string }>(
        "SELECT DISTINCT webid FROM triple WHERE doc_url = $1 AND webid IS NOT NULL AND webid != $2",
        [docUrl, webid]
      );
      for (const { webid: w } of docWebids) {
        await this.clearWebidProjection(w, tx);
      }

      // 1c. The moment this WebID is tombstoned, ALL surviving INBOUND IRI-object edges TO it (e.g.
      //     Alice's `foaf:knows`→this-person, living under Alice's still-served projection) become
      //     SUPPRESSED at read. Count them per-predicate and INCREMENT the incremental suppressed-edge
      //     counters (`sup` / `sp:<pred>`) by the EXACT amount — inside the tx so the counter and the
      //     tombstone commit atomically. This keeps the O(1) VoID/TPF correction exact with NO cap,
      //     however many inbound edges exist (roborev MEDIUM). These edges were NOT previously counted
      //     (this WebID was not tombstoned until now), so this is a pure increment. Self-loops under
      //     this WebID were already removed by step 1, so they are not double-counted.
      const inboundEdges = await tx.query<{ p: string; n: number | string }>(
        `SELECT p, COUNT(*) AS n
           FROM triple
          WHERE o = $1 AND o_is_iri = TRUE
          GROUP BY p`,
        [webid]
      );
      const newlySuppressed = new Map<string, number>(
        inboundEdges.map((r) => [r.p, Number(r.n)])
      );
      await this.adjustSuppressedCounters(newlySuppressed, "add", tx);

      // 2. REPLACE the doc row(s) — by WebID and by doc URL — with a DURABLE redacted tombstone row
      //    rather than DELETING them (roborev HIGH 2). raw_rdf + the generated FTS vectors are blanked
      //    (so search/getEntryByWebid never serve PII) and the WebID is redacted, but the row SURVIVES
      //    in state='tombstone' with its slug retained. Keeping the row + its PK is the durable
      //    serialization guarantee: a concurrent enqueue's `INSERT … ON CONFLICT (doc_url) DO NOTHING`
      //    can no longer create a competing `pending` row for this canonical doc key after the erase
      //    commits — so the WebID can never be resurrected under READ COMMITTED. Both keys are redacted
      //    so a variant row cannot survive servable (DESIGN.md §2.2 L5). The /p/{slug} route serves the
      //    surviving tombstone row as 410 (getEntryBySlug → 'tombstoned').
      await this.redactDocToTombstone({ webid, docUrl }, tx);

      // 3. REDACT the body of any inbox notification that referenced this WebID / doc URL (its
      //    candidate object rows point at the IRI) so the suggestion that named the person no longer
      //    echoes their PII. The notification row is kept (append-only audit) but its body is blanked
      //    and flagged redacted; the child object rows that named the IRI are removed.
      await tx.query(
        `UPDATE inbox SET body = '', redacted = TRUE
          WHERE id IN (
            SELECT notif_id FROM inbox_object WHERE object_iri = $1 OR object_iri = $2
          )`,
        [webid, docUrl]
      );
      await tx.query(
        "DELETE FROM inbox_object WHERE object_iri = $1 OR object_iri = $2",
        [webid, docUrl]
      );

      // 4. Insert the PERMANENT tombstone (canonical WebID key + doc URL) so the three gates refuse
      //    the WebID forever, across all discovery paths. ON CONFLICT keeps the FIRST reason/proof
      //    but refreshes the doc URL (idempotent re-erase is a safe no-op).
      await tx.query(
        `INSERT INTO tombstone (webid, doc_url, reason, created_at, proof)
           VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (webid) DO UPDATE SET doc_url = EXCLUDED.doc_url`,
        [webid, docUrl, reason, now, proof ?? null]
      );
    });
  }
}

// ─── SQL statement splitter ───────────────────────────────────────────────────

/**
 * Split a SQL script into individual statements, respecting:
 *   - single-quoted string literals  ('…')
 *   - double-quoted identifiers      ("…")
 *   - line comments                  (-- …)
 *   - block comments                 (/* … * /)
 *
 * This is intentionally conservative: it handles standard Postgres DDL correctly
 * but does NOT attempt to parse dollar-quoted function bodies ($$ … $$).  It is
 * only used by the Neon executor for the migrate() DDL script; the pglite executor
 * uses pglite's own native exec() instead, which handles the full grammar.
 *
 * Returns non-empty, trimmed statements (semicolons stripped from the end).
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // Line comment: skip to end of line
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        i++;
      }
      current += "\n";
      continue;
    }

    // Block comment: skip to */
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i++;
      }
      i += 2; // consume */
      current += " ";
      continue;
    }

    // Single-quoted string literal — consume until closing quote, handling ''
    if (ch === "'") {
      current += ch;
      i++;
      while (i < sql.length) {
        const c = sql[i];
        current += c;
        i++;
        if (c === "'" && sql[i] !== "'") break; // end of literal (not escaped '')
        if (c === "'" && sql[i] === "'") {
          current += "'"; // consume escaped quote
          i++;
        }
      }
      continue;
    }

    // Double-quoted identifier — consume until closing quote, handling ""
    if (ch === '"') {
      current += ch;
      i++;
      while (i < sql.length) {
        const c = sql[i];
        current += c;
        i++;
        if (c === '"' && sql[i] !== '"') break;
        if (c === '"' && sql[i] === '"') {
          current += '"';
          i++;
        }
      }
      continue;
    }

    // Statement terminator
    // Dollar-quoted body ($$...$$ or $tag$...$tag$) — Postgres function bodies,
    // DO blocks, etc. Everything up to the matching close tag is opaque and may
    // contain ';', '--', or other '$'. The tag regex requires an empty tag or one
    // starting with a letter/underscore, so parameter placeholders like $1 never match.
    if (ch === "$") {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          // Unterminated dollar-quote: append the remainder verbatim and stop.
          current += sql.slice(i);
          i = sql.length;
        } else {
          current += sql.slice(i, end + tag.length);
          i = end + tag.length;
        }
        continue;
      }
    }

    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // Trailing statement without a terminating semicolon
  const trailing = current.trim();
  if (trailing.length > 0) {
    statements.push(trailing);
  }

  return statements;
}

// ─── FTS error helpers ────────────────────────────────────────────────────────

/**
 * Returns true only when the error signals that a Postgres function is
 * undefined (SQLSTATE 42883).  Used to gate the websearch_to_tsquery →
 * plainto_tsquery fallback: all other errors must propagate unchanged so that
 * connection/schema/permission failures are never masked.
 */
function isUndefinedFunctionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Postgres drivers typically surface SQLSTATE as .code on the error object.
  const code = (err as Error & { code?: string }).code;
  if (code === "42883") return true;
  // pglite may not expose .code; fall back to message substring matching.
  const msg = err.message.toLowerCase();
  return (
    msg.includes("websearch_to_tsquery") &&
    (msg.includes("does not exist") || msg.includes("undefined"))
  );
}

/**
 * Returns true only when the error signals an undefined column reference
 * (SQLSTATE 42703).  Used to guard the label_fts → fts_vector fallback when
 * the schema has not yet been migrated to add the label_fts column.
 */
function isUndefinedColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  if (code === "42703") return true;
  const msg = err.message.toLowerCase();
  return msg.includes("label_fts") && msg.includes("does not exist");
}

// ─── Cursor helpers ───────────────────────────────────────────────────────────

function encodeCursor(docUrl: string): string {
  return Buffer.from(docUrl).toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf-8");
}

function encodeSearchCursor(rank: number, docUrl: string): string {
  return Buffer.from(JSON.stringify({ rank, docUrl })).toString("base64url");
}

function decodeSearchCursor(cursor: string): { rank: number; docUrl: string } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
    rank: number;
    docUrl: string;
  };
}

function encodeInboxCursor(receivedAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ receivedAt, id })).toString("base64url");
}

function decodeInboxCursor(cursor: string): { receivedAt: number; id: string } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
    receivedAt: number;
    id: string;
  };
}

/** Opaque keyset cursor for TPF — encodes the last (s,p,o,oIsIri) emitted. */
interface TpfCursorTuple {
  s: string;
  p: string;
  o: string;
  oIsIri: boolean;
}

function encodeTpfCursor(tuple: TpfCursorTuple): string {
  return Buffer.from(JSON.stringify(tuple)).toString("base64url");
}

function decodeTpfCursor(cursor: string): TpfCursorTuple {
  return JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf-8")
  ) as TpfCursorTuple;
}

// ─── Tombstone-gate SQL fragments (shared by tpf + boundedPatternCount) ─────────

/**
 * A WHERE fragment that PASSES a triple unless its SUBJECT-side WebID (`<alias>.webid`) is
 * tombstoned. A triple with a NULL webid (provenance/structural) always passes this clause (its
 * object is gated separately). Covers BOTH the permanent `tombstone` table and a `doc` row already
 * in state 'tombstone' (the crawler 410/noindex auto-tombstone path). No bound params — the clause
 * is self-contained, correlated against the triple alias.
 */
function tombstoneSubjectClause(alias: string): string {
  return `(${alias}.webid IS NULL OR NOT EXISTS (
     SELECT 1 FROM tombstone ts WHERE ts.webid = ${alias}.webid
     UNION ALL
     SELECT 1 FROM doc d WHERE d.state = 'tombstone' AND d.webid = ${alias}.webid
   ))`;
}

/**
 * A WHERE fragment that PASSES a triple unless its IRI OBJECT (`<alias>.o` when `o_is_iri`) is a
 * tombstoned WebID — i.e. it DROPS an inbound `foaf:knows` (or any) edge pointing AT an erased
 * person from served output (DESIGN.md §4.8 H1). A literal object (`o_is_iri = FALSE`) always passes
 * (a literal is never a WebID). Matches the object against the tombstone WebID key.
 */
function tombstoneObjectClause(alias: string): string {
  return `(${alias}.o_is_iri = FALSE OR NOT EXISTS (
     SELECT 1 FROM tombstone ts WHERE ts.webid = ${alias}.o
     UNION ALL
     SELECT 1 FROM doc d WHERE d.state = 'tombstone' AND d.webid = ${alias}.o
   ))`;
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function extractHost(docUrl: string): string {
  try {
    return new URL(docUrl).hostname;
  } catch {
    return docUrl;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * makeStore() — production factory.
 *
 * Reads DATABASE_URL from the environment (injected by Vercel Marketplace / Neon)
 * and returns a PgStore backed by the Neon serverless driver.
 *
 * The returned object implements all three ports: ReadStore, SearchIndex, CrawlCoordinator.
 */
export function makeStore(config?: { databaseUrl?: string }): PgStore {
  const connectionString =
    config?.databaseUrl ??
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    "";

  if (!connectionString) {
    throw new Error(
      "makeStore: DATABASE_URL (or POSTGRES_URL) must be set in the environment"
    );
  }

  const executor = createNeonExecutor(connectionString);
  return new PgStore(executor);
}
