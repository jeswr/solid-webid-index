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

  -- Extracted display label (foaf:name / vcard:fn / schema:name) for the WebID
  -- agent described by this doc.  Populated by the crawler's projection step.
  -- Null until the doc has been crawled and a name extracted.
  label             TEXT,

  -- FTS: generated tsvector over raw_rdf (backward-compat; used when label_fts
  -- is unavailable on older rows or when label_fts index is not yet built).
  fts_vector        TSVECTOR    GENERATED ALWAYS AS (
                      to_tsvector('english', coalesce(raw_rdf, ''))
                    ) STORED,

  -- Weighted FTS: label is 'A' (highest weight), raw_rdf is 'D' (lowest weight).
  -- ts_rank against label_fts ranks name-matching results above URI/predicate hits.
  -- Populated automatically; populated even when label is NULL (falls back to
  -- to_tsvector on empty string = empty tsvector).
  label_fts         TSVECTOR    GENERATED ALWAYS AS (
                      setweight(to_tsvector('english', coalesce(label, '')), 'A')
                      || setweight(to_tsvector('english', coalesce(raw_rdf, '')), 'D')
                    ) STORED
);

-- ─── doc column migrations (idempotent) ──────────────────────────────────────
--
-- CREATE TABLE IF NOT EXISTS above is a NO-OP on an already-created `doc` table,
-- so columns added AFTER the table first shipped (label, label_fts) would be
-- ABSENT on a pre-existing database — and the CREATE INDEX … (label_fts) below
-- would then FAIL with "column \"label_fts\" does not exist".
--
-- ALTER TABLE … ADD COLUMN IF NOT EXISTS is the idempotent bridge: it adds the
-- column on an old-shape table and is a no-op once present (fresh schemas already
-- have it from the CREATE TABLE above, so the ALTERs are no-ops there too).  These
-- MUST run BEFORE the GIN index on label_fts.  The generated expression here is
-- byte-identical to the CREATE TABLE definition above — keep the two in sync.
--
-- PG / pglite support: PostgreSQL ≥ 12 (pglite 0.5.x ships PG 18) supports adding
-- a STORED generated column via ALTER TABLE, including the ADD COLUMN IF NOT EXISTS
-- form — verified against pglite 0.5.2 in pgStore.test.ts.
ALTER TABLE doc ADD COLUMN IF NOT EXISTS label TEXT;

ALTER TABLE doc ADD COLUMN IF NOT EXISTS label_fts TSVECTOR GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(label, '')), 'A')
  || setweight(to_tsvector('english', coalesce(raw_rdf, '')), 'D')
) STORED;

-- Frontier / claim query index
CREATE INDEX IF NOT EXISTS idx_doc_ready    ON doc (state, next_eligible_at);
CREATE INDEX IF NOT EXISTS idx_doc_host     ON doc (host, state, next_eligible_at);
CREATE INDEX IF NOT EXISTS idx_doc_recrawl  ON doc (state, last_crawled);

-- FTS GIN index — required for @@ operator to be fast
CREATE INDEX IF NOT EXISTS idx_doc_fts      ON doc USING GIN (fts_vector);

-- Weighted FTS GIN index (label_fts combines label A + raw_rdf D weights)
CREATE INDEX IF NOT EXISTS idx_doc_label_fts ON doc USING GIN (label_fts);

-- ─── suggest_budget — shared anti-amplification budget per suggestion root ────
--
-- One row per suggestion-rooted subtree (keyed by root_seed), holding the REMAINING
-- node budget that is CONSUMED — not reset per node — as descendants are enqueued
-- (anti-amplification C2, DESIGN.md §5). The crawler decrements `remaining` atomically
-- on every enqueue under that root and stops once it reaches 0, so a suggestion with
-- budget N can enqueue AT MOST N total descendants regardless of fan-out. The atomic
-- `UPDATE … SET remaining = remaining - 1 WHERE root_seed = $1 AND remaining > 0
-- RETURNING remaining` makes this correct under concurrent/serverless invocations.

CREATE TABLE IF NOT EXISTS suggest_budget (
  root_seed   TEXT     PRIMARY KEY,            -- the suggestion root this budget governs
  remaining   INTEGER  NOT NULL                -- nodes still enqueuable under this root (>= 0)
                       CHECK (remaining >= 0)
);

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
