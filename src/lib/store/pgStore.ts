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

import { neon } from "@neondatabase/serverless";

import type {
  CrawlCoordinator,
  CrawlResult,
  DocRecord,
  DocSource,
  DocState,
  FailClass,
  ReadStore,
  SearchIndex,
  SearchResult,
} from "./ports.js";

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
  };
}

// ─── pglite executor ─────────────────────────────────────────────────────────

/**
 * Wraps @electric-sql/pglite for in-process testing.
 * PGlite is imported as a type to keep it dev-only; callers pass an instance.
 */
export function createPgliteExecutor(
  // Accept any object with .query() and .exec() methods matching the pglite shape.
  // exec() returns an array of result objects; we ignore the return value here.
  db: {
    query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
    exec(sql: string): Promise<unknown>;
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
  };
}

// ─── PgStore ──────────────────────────────────────────────────────────────────

/**
 * Implements ReadStore + SearchIndex + CrawlCoordinator against a SqlExecutor.
 *
 * Instantiate via makeStore() in production or directly with a pglite executor in tests.
 */
export class PgStore implements ReadStore, SearchIndex, CrawlCoordinator {
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
      const schemaPath = join(
        new URL(".", import.meta.url).pathname,
        "schema.sql"
      );
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
  }

  // ─── ReadStore ─────────────────────────────────────────────────────────────

  async get(docUrl: string): Promise<DocRecord | null> {
    const rows = await this.db.query<DocRow>(
      `SELECT * FROM doc WHERE doc_url = $1 AND state != 'tombstone'`,
      [docUrl]
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
    await this.db.query(
      `INSERT INTO doc (
         doc_url, host, webid, state, depth, root_seed, suggest_budget,
         source, discovered_from, claim_token, claimed_at, attempts,
         etag, last_modified, content_hash, last_crawled, next_eligible_at,
         enqueued_at, http_status, is_solid, fail_class, error, noindex, raw_rdf
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17,
         $18, $19, $20, $21, $22, $23, $24
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
         raw_rdf          = EXCLUDED.raw_rdf`,
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
      ]
    );
  }

  async tombstone(docUrl: string): Promise<void> {
    await this.db.query(
      `INSERT INTO doc (
         doc_url, host, state, source, enqueued_at
       ) VALUES ($1, '', 'tombstone', 'seed', $2)
       ON CONFLICT (doc_url) DO UPDATE SET
         state = 'tombstone',
         claim_token = NULL,
         raw_rdf = NULL`,
      [docUrl, Date.now()]
    );
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
    let cursorClause = "";
    if (cursorParts) {
      params.push(cursorParts.rank, cursorParts.docUrl);
      cursorClause = `AND (
        ts_rank(fts_vector, websearch_to_tsquery('english', $1)) < $${params.length - 1}
        OR (
          ts_rank(fts_vector, websearch_to_tsquery('english', $1)) = $${params.length - 1}
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
    }

    let rows: SearchRow[];
    try {
      rows = await this.db.query<SearchRow>(
        `SELECT doc_url, webid, raw_rdf, is_solid, state, last_crawled,
                ts_rank(fts_vector, websearch_to_tsquery('english', $1)) AS rank
         FROM doc
         WHERE fts_vector @@ websearch_to_tsquery('english', $1)
           AND state != 'tombstone'
           ${cursorClause}
         ORDER BY rank DESC, doc_url ASC
         LIMIT $2`,
        params
      );
    } catch (err) {
      // Fallback ONLY when websearch_to_tsquery is absent (Postgres error code
      // 42883 = undefined_function; pglite surfaces it in the message).
      // All other errors (connection, schema, permission, param) are rethrown
      // immediately so they are not masked by a spurious fallback attempt.
      if (!isUndefinedFunctionError(err)) {
        throw err;
      }

      // Older pglite builds may not ship websearch_to_tsquery.
      // plainto_tsquery is always available and semantically close enough.
      const fallbackParams = [...params];
      const fallbackCursorClause = cursorParts
        ? `AND (
          ts_rank(fts_vector, plainto_tsquery('english', $1)) < $${fallbackParams.length - 1}
          OR (
            ts_rank(fts_vector, plainto_tsquery('english', $1)) = $${fallbackParams.length - 1}
            AND doc_url > $${fallbackParams.length}
          )
        )`
        : "";

      rows = await this.db.query<SearchRow>(
        `SELECT doc_url, webid, raw_rdf, is_solid, state, last_crawled,
                ts_rank(fts_vector, plainto_tsquery('english', $1)) AS rank
         FROM doc
         WHERE fts_vector @@ plainto_tsquery('english', $1)
           AND state != 'tombstone'
           ${fallbackCursorClause}
         ORDER BY rank DESC, doc_url ASC
         LIMIT $2`,
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
      source?: DocSource;
      discoveredFrom?: string | null;
      nextEligibleAt?: number;
    }
  ): Promise<void> {
    const host = extractHost(docUrl);
    await this.db.query(
      `INSERT INTO doc (
         doc_url, host, state, depth, root_seed, suggest_budget,
         source, discovered_from, next_eligible_at, enqueued_at
       ) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (doc_url) DO NOTHING`,
      [
        docUrl,
        host,
        opts?.depth ?? 0,
        opts?.rootSeed ?? null,
        opts?.suggestBudget ?? null,
        opts?.source ?? "seed",
        opts?.discoveredFrom ?? null,
        opts?.nextEligibleAt ?? 0,
        Date.now(),
      ]
    );
  }

  /**
   * STUB — implemented in pss-5i8.
   *
   * The full implementation uses SELECT … FOR UPDATE SKIP LOCKED (DESIGN.md §3.1 addendum)
   * for atomic batch claiming without double-claims under concurrency.
   */
  async claim(_workerId: string, _batchSize: number): Promise<DocRecord[]> {
    throw new Error(
      "CrawlCoordinator.claim(): not implemented — deferred to pss-5i8 (SELECT FOR UPDATE SKIP LOCKED)"
    );
  }

  async markDone(docUrl: string, result: CrawlResult): Promise<void> {
    // RETURNING doc_url lets us detect a no-op UPDATE (0 rows matched).
    // The crawl flow always calls enqueue() before claim()/markDone(), so a
    // zero-row result is always a caller bug — throw rather than silently drop.
    const updated = await this.db.query<{ doc_url: string }>(
      `UPDATE doc SET
         state            = $2,
         http_status      = $3,
         etag             = COALESCE($4, etag),
         last_modified    = COALESCE($5, last_modified),
         content_hash     = COALESCE($6, content_hash),
         raw_rdf          = COALESCE($7, raw_rdf),
         is_solid         = COALESCE($8, is_solid),
         webid            = COALESCE($9, webid),
         fail_class       = $10,
         error            = $11,
         next_eligible_at = $12,
         last_crawled     = $13,
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
      ]
    );

    if (updated.length === 0) {
      throw new Error(
        `markDone: no row found for docUrl="${docUrl}" — must call enqueue() before markDone()`
      );
    }
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
