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

  -- Opaque, deterministic slug for the served entry document /p/{slug}
  -- (= base32(sha256(webid))[0..24]; DESIGN.md §2.1.c).  Maintained alongside
  -- `webid`: set whenever a webid is known, so the reverse lookup slug → doc is a
  -- single indexed read.  Null until the doc has a webid.
  slug              TEXT,

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

-- `webid` and `slug` ALTERs: `webid` is an original column (no-op on any real DB),
-- but adding it idempotently here means the slug/webid partial indexes below never
-- fail on a minimal pre-existing `doc` table that predates these columns.  `slug`
-- shipped with the SW-CONFORMANCE entry routes (DESIGN.md §2.1.c).
ALTER TABLE doc ADD COLUMN IF NOT EXISTS webid TEXT;

ALTER TABLE doc ADD COLUMN IF NOT EXISTS slug TEXT;

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

-- Slug lookup index — the /p/{slug} entry route resolves slug → doc with a single
-- indexed read.  Partial (slug IS NOT NULL) keeps it tight; slug is unique per webid
-- (a sha256-derived value) so at most one live row matches.
CREATE INDEX IF NOT EXISTS idx_doc_slug ON doc (slug) WHERE slug IS NOT NULL;

-- WebID lookup index — /lookup?webid= and getEntryByWebid resolve webid → doc.
CREATE INDEX IF NOT EXISTS idx_doc_webid ON doc (webid) WHERE webid IS NOT NULL;

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

-- ─── triple — materialised triples for Triple Pattern Fragments (DESIGN.md §2.1.e / §4.5) ────
--
-- Indexed lookups (NOT derived scans over raw_rdf — arch M1) so GET /tpf?s=&p=&o= can answer a
-- triple pattern from an index.  Each row records which indexed WebID + source document it was
-- projected from so the TPF read can FILTER OUT triples about tombstoned WebIDs (DESIGN.md §4.8 H1:
-- a tombstoned person's triples must never be served).  `o_is_iri` distinguishes an IRI object
-- (matched/serialised as a NamedNode) from a literal object (Literal) so the round-trip is faithful.
--
-- The triple set for a WebID is REPLACED wholesale on each (re)projection (delete-by-webid then
-- insert) — see PgStore.upsertTriples — so it never accumulates stale triples across re-crawls.

CREATE TABLE IF NOT EXISTS triple (
  s         TEXT     NOT NULL,                 -- subject IRI
  p         TEXT     NOT NULL,                 -- predicate IRI
  o         TEXT     NOT NULL,                 -- object: IRI or literal LEXICAL value
  o_is_iri  BOOLEAN  NOT NULL,                 -- TRUE → object is an IRI (NamedNode); FALSE → literal
  webid     TEXT,                              -- the indexed WebID this triple describes (tombstone gate)
  doc_url   TEXT                               -- the source doc the triple was projected from
);

-- Triple-pattern access paths (DESIGN.md §2.1.e): (p,o) for ?p=&o=, (p,s) for ?s=&p=, s for ?s=.
CREATE INDEX IF NOT EXISTS idx_triple_po    ON triple (p, o);
CREATE INDEX IF NOT EXISTS idx_triple_ps    ON triple (p, s);
CREATE INDEX IF NOT EXISTS idx_triple_s     ON triple (s);
-- Tombstone-filter + delete-by-webid (re-projection / erasure) access path.
CREATE INDEX IF NOT EXISTS idx_triple_webid ON triple (webid) WHERE webid IS NOT NULL;

-- ─── stats — incremental dataset stats (DESIGN.md §2.1.j / §4.5) ─────────────────────────────
--
-- VoID/DCAT/health and the TPF `void:triples` PATTERN cardinality ESTIMATE read these counters
-- (never a live COUNT on the hot path — arch M1).  Keyed counters: 'triples' (total), 'entities',
-- and per-predicate keys ('p:<predicate-iri>') so a ?p= pattern can be estimated cheaply.
--
-- NOTE (pss-b0a / stats-sibling reconciliation): this is the MINIMAL stats surface needed by TPF.
-- A concurrent sibling bead builds the richer incremental stats maintenance (per-class partitions,
-- entity counts kept in the projection tx).  Both write to THIS table additively (idempotent
-- CREATE TABLE IF NOT EXISTS) — the sibling's richer maintenance supersedes the simple counters
-- written here at merge.  The TPF read goes through PgStore.estimatePatternCardinality (see below).

-- The `stats` counters describe the SERVED query dataset (the materialised `triple` table that TPF
-- serves), so a single `void:triples` is consistent across VoID (GET /.well-known/void) and the TPF
-- empty-pattern estimate.  Maintenance is split additively inside `upsertTriples` (pgStore.ts):
--   'triples'       — total triples              (TPF bead pss-b0a)
--   'p:<predicate>' — per-predicate triple count (TPF bead; void:propertyPartition)
--   'entities'      — number of indexed WebIDs    (stats bead pss-0zp; void:entities)
--   'c:<classIri>'  — per-class entity count      (stats bead; void:classPartition)
-- Counts are kept current by DELTAS computed from the OLD vs NEW triple set on every (re)projection
-- and erasure — never a live COUNT(*) over the dataset — so reads stay O(1) (pss-0zp acceptance).
-- The distinct-class / distinct-property counts (void:classes / void:properties) are DERIVED at read
-- time from the number of c:/p: keys with v > 0.

CREATE TABLE IF NOT EXISTS stats (
  k   TEXT     PRIMARY KEY,                    -- counter key: 'triples', 'entities', 'p:<iri>', 'c:<iri>'
  v   BIGINT   NOT NULL DEFAULT 0              -- counter value (>= 0)
);
