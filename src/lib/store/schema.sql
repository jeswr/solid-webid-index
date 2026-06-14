-- AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
-- schema.sql — Postgres DDL for solid-webid-index
--
-- Idempotent: every statement uses IF NOT EXISTS so migrate() is safe to call
-- on a live database.  Matches DocRecord in ports.ts — keep in sync.
--
-- All time columns are epoch milliseconds (INTEGER / BIGINT) per DESIGN.md §2.1 L1.
-- FTS: generated tsvector column over raw_rdf + GIN index (Postgres native, DESIGN.md addendum).

-- ─── doc — frontier + per-doc crawl metadata + raw bytes ─────────────────────
--
-- One row per document, keyed on the canonical post-redirect fragment-stripped URL.
-- State mutates in-place; re-crawl = next_eligible_at reset (DESIGN.md §2.1.a).

CREATE TABLE IF NOT EXISTS doc (
  doc_url           TEXT        PRIMARY KEY,
  host              TEXT        NOT NULL,
  webid             TEXT,
  state             TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (state IN (
                                  'pending', 'claimed', 'done', 'failed',
                                  'tombstone', 'skipped', 'blocked'
                                )),
  depth             INTEGER     NOT NULL DEFAULT 0,
  root_seed         TEXT,
  suggest_budget    INTEGER,
  source            TEXT        NOT NULL DEFAULT 'seed',
  discovered_from   TEXT,

  -- lease / fencing (atomic claim, crash-safe)
  claim_token       TEXT,
  claimed_at        BIGINT,                   -- epoch ms
  attempts          INTEGER     NOT NULL DEFAULT 0,

  -- conditional re-crawl validators
  etag              TEXT,
  last_modified     TEXT,                     -- verbatim HTTP Last-Modified
  content_hash      TEXT,                     -- sha-256 of reserialised canonical body (M5)

  -- timing (epoch ms throughout — L1)
  last_crawled      BIGINT,
  next_eligible_at  BIGINT      NOT NULL DEFAULT 0,
  enqueued_at       BIGINT      NOT NULL,

  -- per-doc result metadata
  http_status       INTEGER,
  is_solid          BOOLEAN     NOT NULL DEFAULT FALSE,
  fail_class        TEXT        CHECK (fail_class IN ('deterministic', 'transient')),
  error             TEXT,
  noindex           BOOLEAN     NOT NULL DEFAULT FALSE,
  raw_rdf           TEXT,

  -- FTS: generated tsvector over raw_rdf; updated automatically by Postgres.
  -- websearch_to_tsquery / plainto_tsquery both work against this column.
  fts_vector        TSVECTOR    GENERATED ALWAYS AS (
                      to_tsvector('english', coalesce(raw_rdf, ''))
                    ) STORED
);

-- Frontier / claim query index
CREATE INDEX IF NOT EXISTS idx_doc_ready    ON doc (state, next_eligible_at);
CREATE INDEX IF NOT EXISTS idx_doc_host     ON doc (host, state, next_eligible_at);
CREATE INDEX IF NOT EXISTS idx_doc_recrawl  ON doc (state, last_crawled);

-- FTS GIN index — required for @@ operator to be fast
CREATE INDEX IF NOT EXISTS idx_doc_fts      ON doc USING GIN (fts_vector);

-- ─── host_politeness — per-host crawl rate and robots state ──────────────────

CREATE TABLE IF NOT EXISTS host_politeness (
  host              TEXT    PRIMARY KEY,
  next_allowed_at   BIGINT  NOT NULL DEFAULT 0,   -- epoch ms; advance on 429/503/Retry-After
  robots_fetched_at BIGINT,
  robots_allow      BOOLEAN NOT NULL DEFAULT TRUE,
  crawl_delay_ms    INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0
);

-- ─── inbox — LDN inbox notifications (append-only) ───────────────────────────

CREATE TABLE IF NOT EXISTS inbox (
  id              TEXT    PRIMARY KEY,            -- ULID
  received_at     BIGINT  NOT NULL,               -- epoch ms
  actor           TEXT,
  activity        TEXT    NOT NULL,               -- as:Announce / as:Offer / as:Add
  body            TEXT    NOT NULL,               -- canonical JSON-LD (redacted on erasure)
  redacted        BOOLEAN NOT NULL DEFAULT FALSE,
  processed       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_inbox_recent ON inbox (received_at DESC);

CREATE TABLE IF NOT EXISTS inbox_object (
  notif_id    TEXT    NOT NULL REFERENCES inbox (id) ON DELETE CASCADE,
  object_iri  TEXT    NOT NULL,
  PRIMARY KEY (notif_id, object_iri)
);
