# solid-webid-index — Design & Build Spec

> AUTHORED-BY Claude Opus 4.8. Clean-room. The Community Solid Server and `solid-contrib/webid-search`
> are **references only** — consult for behaviour, copy nothing. This is one concrete, deployable
> Next.js app on Vercel Hobby, not a framework.

## 0. Goal & non-negotiables

A public, Linked-Data-native index of Solid WebIDs with **feature parity** to
`solid-contrib/webid-search` plus a real search index, real freshness, real SSRF/privacy posture.
Three hard constraints govern every decision:

1. **LD/SW-native every surface.** Content negotiation (Turtle + JSON-LD 1.1 + N-Triples; HTML for
   browsers); dereferenceable cool URIs; standard vocabularies (foaf, vcard, schema.org, solid, pim,
   dcterms, skos, VoID, DCAT); the "suggest a WebID" POST is an **LDN inbox** taking an **AS2**
   notification (never bespoke JSON); query is **Hydra hypermedia + Triple Pattern Fragments** (SPARQL
   optional/off by default). Not JSON-REST in an RDF hat.
2. **Vercel Hobby, serverless, deploy-on-commit, zero hosting cost.** No long-running process; no
   local FS/SQLite file. Storage = **Turso/libSQL** (SQLite-compatible → FTS5 survives, HTTP driver).
   Crawl = **bounded work per invocation** driven by a durable DB frontier + **Vercel Cron** (daily
   floor) + **Upstash QStash** (sub-daily heartbeat & fan-out). Suggest triggers an immediate bounded
   crawl, rest drains later. Stay inside every free quota.
3. **UI reuses the Pod Manager design system** (shadcn/ui + the PM oklch teal theme). Humans get HTML;
   machines get RDF by conneg. The PM's `/people` + `/contacts` pages consume the LD search.

### Feature-parity checklist vs the reference (kept, fixed, or added)

| Reference behaviour | Here |
|---|---|
| Crawl seeds: catalog TTL + resume + CLI args | Catalog (config URL, SSRF-guarded) + durable frontier as resume + LDN suggestions. **Kept, de-hardcoded.** |
| `foaf:knows` BFS with depth-reset-on-valid-Solid-WebID | **Kept but re-scoped** — reset only on *trusted-seed-rooted* reachability (security C2). |
| OIDC-issuer presence = "is a Solid WebID" gate | **Kept.** Cheap, effective liveness gate. |
| Store raw upstream Turtle (re-derive later) | **Kept** but re-serialised canonical (never echo bytes) + content-hash-gated writes (M5). |
| Two-phase split (crawl → write; index build) | **Kept** as two decoupled serverless stages. |
| Conneg JSON / JSON-LD / Turtle + permissive CORS + results-in-URL | **Kept & corrected** (real compaction, `Vary`). |
| Daily cron crawler | **Kept** as the floor; QStash adds sub-daily without leaving free tier. |
| O(n) substring scan over a baked JSON blob | **Replaced** by FTS5 + BM25 ranking, paged. |
| No SSRF / no timeout / no rate limit / empty catch | **Replaced** by the one `guardedFetch` chokepoint + per-host politeness + typed backoff. |
| `fromSubject(requestedUrl)` mismatch bug | **Fixed** — key extraction on post-redirect URL ∪ requested WebID ∪ `#me` subject set. |
| No freshness / provenance / dedup / opt-out | **Added** — per-record `dcterms:modified`/`prov`, canonical dedup, tombstone + opt-out. |

---

## 1. Architecture in one line

```
Browser (HTML)  ─┐
Solid app / lib ─┤ Accept-conneg  →  Next.js App Router (Vercel, runtime=nodejs)
  (RDF)          │                     ├─ read routes  (search/TPF/entry/void/dcat/ns) — CDN-cached
                 │                     ├─ LDN inbox    (POST suggest → persist + enqueue + QStash kick)
                 │                     └─ job routes   (/api/_jobs/* — QStash-signed)
                 │                                         │
Vercel Cron (daily) ──→ /api/_jobs/tick ──→ QStash ──→ /api/_jobs/crawl  (bounded, loops batches/invocation)
QStash schedule (15m) ─────────────────────┘                 │  guardedFetch (SSRF-pinned) → parse → project
                                                              ▼
                                              Turso/libSQL (frontier + raw + projected + FTS5 + inbox + tombstone)
```

- **One egress chokepoint:** every fetch of an attacker-influenced URL (inbox candidate, `foaf:knows`)
  goes through `lib/security/guardedFetch.ts`. A lint rule + CI grep forbids any other external `fetch`.
- **Stateless core:** all coordination (frontier, leases, host rate, backoff, rate-limits, counters) is
  Turso SQL. Horizontally safe; matches the suite's `decisions/0012` posture.
- **Owned constants:** one `lib/config.ts` is the single source for every limit (H3). No magic numbers
  scattered across files.

---

## 2. Data model & storage (Turso / libSQL)

**Why Turso:** SQLite-compatible (FTS5 + `bm25()` survive), HTTP/web driver usable from serverless
(no socket, no file). Free Starter: 5 GB, 500M row-reads/mo, 10M row-writes/mo, single region (pin
functions to the DB region — L2). Postgres (Neon/Supabase) is a mechanical fallback (only the FTS
table + ranking change).

### 2.1 Schema (single-row-per-doc model — corrects C2/M2)

The frontier, the per-doc crawl metadata, and the raw bytes are **one row per document** keyed by the
canonical document URL. State mutates **in place**; re-crawl is a `next_eligible_at` reset, never a new
row. (The earlier "separate `crawl_queue` + `UNIQUE(webid,state)`" model is **rejected** — it broke
dedup and threw on lease transitions.)

```sql
-- 2.1.a  Frontier + per-doc crawl metadata + raw bytes (ONE row per document)
CREATE TABLE doc (
  doc_url          TEXT PRIMARY KEY,          -- canonical, post-redirect, fragment-stripped (§2.2)
  host             TEXT NOT NULL,             -- registrable host (per-host politeness)
  webid            TEXT,                      -- canonical WebID (with #fragment) once known
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','claimed','done','error','skipped','blocked','tombstoned')),
  depth            INTEGER NOT NULL DEFAULT 0,
  root_seed        TEXT,                      -- the trusted-seed doc this excursion descends from (C2)
  suggest_budget   INTEGER,                   -- remaining node budget for a suggestion-rooted subtree (C2)
  source           TEXT NOT NULL,             -- seed|catalog|inbox|knows|seeAlso|sameAs|recheck
  discovered_from  TEXT,
  -- lease / fencing (atomic claim, crash-safe)
  claim_token      TEXT,
  claimed_at       INTEGER,                   -- epoch ms
  attempts         INTEGER NOT NULL DEFAULT 0,
  -- conditional re-crawl
  etag             TEXT,
  last_modified    TEXT,                      -- verbatim HTTP Last-Modified
  content_hash     TEXT,                      -- sha-256 of reserialised canonical body (change-detect)
  last_crawled     INTEGER,                   -- epoch ms
  next_eligible_at INTEGER NOT NULL DEFAULT 0,
  http_status      INTEGER,
  is_solid         INTEGER NOT NULL DEFAULT 0,-- 1 once a solid:oidcIssuer on the subject was seen
  fail_class       TEXT,                      -- deterministic|transient (drives retry policy, H7)
  error            TEXT,                      -- truncated last failure reason (never empty-catch)
  noindex          INTEGER NOT NULL DEFAULT 0,
  raw_rdf          TEXT,                      -- reserialised canonical Turtle (NOT verbatim bytes; M5)
  enqueued_at      INTEGER NOT NULL
);
CREATE INDEX idx_doc_ready ON doc(state, next_eligible_at);
CREATE INDEX idx_doc_host  ON doc(host, state, next_eligible_at);
CREATE INDEX idx_doc_recrawl ON doc(state, last_crawled);

-- 2.1.b  Per-host politeness (state must be in the DB — invocations are stateless)
CREATE TABLE host_state (
  host               TEXT PRIMARY KEY,
  next_allowed_at    INTEGER NOT NULL DEFAULT 0,
  in_flight          INTEGER NOT NULL DEFAULT 0,  -- (derived from COUNT at claim; see H2)
  robots_fetched_at  INTEGER,
  robots_allow       INTEGER NOT NULL DEFAULT 1,
  crawl_delay_ms     INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0
);

-- 2.1.c  Projected, served entity (one per indexed WebID)
CREATE TABLE webid (
  id            INTEGER PRIMARY KEY,            -- FTS rowid (NEVER make this table WITHOUT ROWID — L2)
  webid         TEXT NOT NULL UNIQUE,           -- canonical WebID = the agent thing-URI
  doc_url       TEXT NOT NULL REFERENCES doc(doc_url),
  slug          TEXT NOT NULL UNIQUE,           -- base32(sha256(webid))[0..24], our /p/{slug}
  label         TEXT,                           -- best-of foaf:name/vcard:fn/schema:name
  img           TEXT,                           -- validated https avatar IRI
  crawl_state   TEXT NOT NULL DEFAULT 'live',   -- live|unreachable|stale (rendered as skos:Concept; C3)
  first_seen    INTEGER NOT NULL,
  last_modified INTEGER NOT NULL,               -- our dcterms:modified
  -- precomputed serialisations (read path does string fetch, no N3/jsonld on hot path — arch H2)
  ttl_cache     TEXT,
  jsonld_cache  TEXT,
  nt_cache      TEXT
);

-- 2.1.d  Multi-valued projected fields (normalised; re-derivable from doc.raw_rdf)
CREATE TABLE label_row    (webid_id INTEGER REFERENCES webid(id) ON DELETE CASCADE, value TEXT, lang TEXT, prop TEXT,
                            PRIMARY KEY (webid_id, value, lang, prop)) WITHOUT ROWID;
CREATE TABLE oidc_issuer  (webid_id INTEGER REFERENCES webid(id) ON DELETE CASCADE, issuer TEXT,
                            PRIMARY KEY (webid_id, issuer)) WITHOUT ROWID;
CREATE TABLE storage_row  (webid_id INTEGER REFERENCES webid(id) ON DELETE CASCADE, storage TEXT,
                            PRIMARY KEY (webid_id, storage)) WITHOUT ROWID;
CREATE TABLE knows_edge   (src_id INTEGER REFERENCES webid(id) ON DELETE CASCADE, dst_webid TEXT,
                            PRIMARY KEY (src_id, dst_webid)) WITHOUT ROWID;
CREATE INDEX idx_knows_dst ON knows_edge(dst_webid);

-- 2.1.e  Materialised triples table for TPF (indexed lookups, not derived scans — arch M1)
CREATE TABLE triple (s TEXT NOT NULL, p TEXT NOT NULL, o TEXT NOT NULL, o_is_iri INTEGER NOT NULL);
CREATE INDEX idx_triple_po ON triple(p, o);
CREATE INDEX idx_triple_ps ON triple(p, s);
CREATE INDEX idx_triple_s  ON triple(s);

-- 2.1.f  FTS5 over label + WebID string + issuer host (contentless; synced in the upsert tx)
CREATE VIRTUAL TABLE webid_fts USING fts5(
  label, webid, issuer, content='', tokenize = "unicode61 remove_diacritics 2");

-- 2.1.g  LDN inbox notifications (append-only) + extracted objects (child table — sw M1)
CREATE TABLE inbox_notification (
  id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, actor TEXT, activity TEXT NOT NULL,
  body TEXT NOT NULL, redacted INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE inbox_object (notif_id TEXT REFERENCES inbox_notification(id) ON DELETE CASCADE, object_iri TEXT,
  PRIMARY KEY (notif_id, object_iri)) WITHOUT ROWID;
CREATE INDEX idx_inbox_recent ON inbox_notification(received_at DESC);

-- 2.1.h  Tombstones (permanent opt-out/erasure — blocks re-crawl across ALL paths; H1)
CREATE TABLE tombstone (
  webid TEXT PRIMARY KEY, doc_url TEXT, reason TEXT NOT NULL CHECK (reason IN ('opt-out','erasure','abuse','noindex')),
  created_at INTEGER NOT NULL, proof TEXT);

-- 2.1.i  Rate-limit buckets (serverless; per-IP and per-candidate-host) + daily budget counters (M4)
CREATE TABLE rate_bucket (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE daily_counter (day TEXT PRIMARY KEY, qstash_msgs INTEGER NOT NULL DEFAULT 0,
  crawl_fetches INTEGER NOT NULL DEFAULT 0, queue_inserts INTEGER NOT NULL DEFAULT 0);

-- 2.1.j  Dataset stats (incremental; VoID/DCAT/health read these — never live COUNT on hot path)
CREATE TABLE stats (k TEXT PRIMARY KEY, v INTEGER NOT NULL);  -- entities, triples, per-class, per-prop
```

**Time representation (L1):** every time column is **epoch milliseconds (INTEGER)** — no ISO-8601
strings in comparison columns (a `TEXT` ISO compared with `<= :nowMs` silently never/always matches).

### 2.2 WebID / URI canonicalisation — the dedup key (corrects C4/H1)

Canonicalisation is **security-critical** (it is the real termination bound, not depth — see §4). One
function, applied once at enqueue, via `new URL()`:

```
canonicalDocUrl(raw):
  u = new URL(raw)                       // reject unparseable
  require u.protocol ∈ {https:} (prod)   // http: only when allowLoopback (dev)
  reject u.username || u.password        // strip userinfo
  host = NFC-normalise + lowercase + Punycode (URL does Punycode; add explicit NFC — H1)
  strip default ports (:443/:80)
  collapse a single trailing slash on the path UNLESS the two forms return different content-hashes
  fragment stripped (doc key); the WebID keeps its #fragment separately
  return u.toString()                    // normalises case + percent-encoding
```

- **Key the row on the post-redirect `res.url`** (C4): `http→https` and trailing-slash variants are
  overwhelmingly resolved by the upstream server's own redirects. The *discovered* (pre-redirect) link
  is recorded as an alias (`discovered_from`) so we never re-fetch it, but the canonical row is the
  final URL.
- The SSRF classifier is **always** fed `new URL(raw).hostname`, never the raw IRI string (M1).
- `http`↔`https` of the same host+path collapse to the **`https` form for storage** (only valid form).
- The tombstone check (§7) runs on the **post-redirect canonical** key at both enqueue and finalize
  (L5) so an opted-out person cannot reappear under a variant.

### 2.3 Conceptual → RDF (httpRange-14, reuse-before-mint)

**One identity per person — describe, never mint (corrects sw H3).** The agent's *only* URI is the
**upstream WebID** (`https://alice.pod/card#me`). We do **NOT** mint `$ORIGIN/p/{slug}#me a foaf:Person`
(that would create a duplicate competing identity — an anti-pattern and a 5-star violation). Our
`$ORIGIN/p/{slug}` is a **200 LDP-RS description document** whose `foaf:primaryTopic`/`schema:about` is
the upstream WebID; it links out (`schema:sameAs`, `rdfs:seeAlso`, `dcterms:source`,
`prov:wasDerivedFrom`) → ★★★★★. A `GET /lookup?webid=<iri>` → `303 See Other` to `/p/{slug}` gives
reverse lookup (the httpRange-14-textbook redirect; resolves slug-reversibility).

Projected fields (the only extracted set; ShEx-validated): `foaf:name` / `schema:name` / `vcard:fn`,
`foaf:img` / `vcard:hasPhoto`, `solid:oidcIssuer` (≥1, the gate), `pim:storage`, `foaf:knows` (IRIs).
Provenance: `dcterms:modified`, `prov:wasDerivedFrom`, `idx:crawlState` (a `skos:Concept` IRI),
`void:inDataset <$ORIGIN/#dataset>` (sw M1). `foaf:knows` objects are **always upstream WebIDs**, never
rewritten to index URLs (sw M4); for indexed targets an additional `rdfs:seeAlso <$ORIGIN/p/{slug}>`.

### 2.4 The Storage seam (split into three honest ports — corrects arch H4)

The "one swappable `IndexStore`" claim leaked bm25 ranking + lease semantics. Split it:

```ts
// lib/store/ReadStore.ts — PORTABLE (a Sparql/QLever impl maps each to SELECT/INSERT DATA)
export interface ReadStore {
  getProfileBySlug(slug: string): Promise<IndexedProfile | null>;
  getProfileByWebid(webid: string): Promise<IndexedProfile | null>;
  tpf(p: TpfPattern): Promise<{ quads: Quad[]; estimate: number }>;   // estimate = pattern cardinality
  stats(): Promise<DatasetStats>;                                      // from stats table
}

// lib/store/SearchIndex.ts — SQLite-semantics (bm25 ranking is substrate-specific; documented as such)
export interface SearchIndex {
  search(q: SearchQuery): Promise<SearchResult>;     // FTS5 + bm25; opaque keyset cursor (H5)
  upsertProjection(p: IndexedProfile): Promise<void>;// rows + FTS + triples + caches, ONE batch tx (H4)
  erase(webid: string): Promise<void>;               // rows + FTS + triples + caches, ONE batch tx
}

// lib/store/CrawlCoordinator.ts — SQLite atomic-claim semantics (a SPARQL backend supplies its own)
export interface CrawlCoordinator {
  enqueue(item: EnqueueItem): Promise<boolean>;      // syntactic only; no DNS (M4); budget-gated (C2/M4)
  claimBatch(opts: ClaimOpts): Promise<ClaimedRow[]>;// token-fenced; verified atomic on libSQL (C1/C3)
  finalize(r: FinalizeInput): Promise<boolean>;      // false = lease lost (fencing); COALESCE validators (H3)
  sweepExpiredLeases(now: number): Promise<number>;
  dueForRecheck(n: number): Promise<string[]>;
  isTombstoned(webid: string): Promise<boolean>;
  tombstone(webid: string, reason: string, proof?: string): Promise<void>;
}
```

Every returned `Quad[]` is built by `@rdfjs/wrapper` typed accessors and serialised through the house
pipeline; `upsertProjection` takes already-projected fields. Parse uses `@jeswr/fetch-rdf` `parseRdf`
(never inline `new Parser().parse`).

---

## 3. The serverless crawler

### 3.1 Atomic claim — verified, not assumed (corrects C1 & C3)

The claim is the concurrency foundation. **It must be empirically verified** against a live libSQL
instance before anything builds on it (bead, launch-gate). The robust, driver-agnostic form is
**mark-by-unique-token then read-back**, run inside a libSQL transactional `batch([...], "write")`:

```sql
-- (1) mark, with status='pending' on the OUTER UPDATE so the predicate survives to write time
UPDATE doc SET state='claimed', claim_token=:token, claimed_at=:now, attempts=attempts+1
WHERE state='pending' AND next_eligible_at <= :now
  AND doc_url IN (
    SELECT d.doc_url FROM doc d JOIN host_state h ON h.host = d.host
    WHERE d.state='pending' AND d.next_eligible_at <= :now AND d.depth <= :maxDepth AND d.noindex=0
      AND h.next_allowed_at <= :now
      AND (SELECT COUNT(*) FROM doc c WHERE c.host=d.host AND c.state='claimed') < :perHost
    ORDER BY (d.source='recheck') ASC, d.depth ASC, d.enqueued_at ASC   -- discovery before recheck (M3/L6)
    LIMIT :batch );
-- (2) read back ONLY this invocation's rows (unique token → invisible to racers)
SELECT doc_url, webid, depth, host, etag, last_modified, source FROM doc WHERE claim_token=:token;
```

If a concurrency test ever shows double-claims, fall back to per-row CAS
(`UPDATE … WHERE doc_url=:id AND state='pending'`) batched + read-back. `in_flight` is **derived from
`COUNT(... state='claimed')`**, never a hand-maintained scalar that drifts/underflows (H2).

### 3.2 Bounds & termination (corrects C3, H6)

| Bound | Default | Where (from `lib/config.ts`) |
|---|---|---|
| `MAX_DEPTH` | 3 | claim filter + enqueue |
| depth reset | 0 **only** if reachable from a trusted seed within the Solid component (C2) | extract |
| per-suggestion node budget | 50 (suggestion-rooted subtree cap, tracked in `suggest_budget`) (C2) | enqueue |
| `FRONTIER_CAP` | from daily drain rate (~10–20k) (arch C2) | enqueue via indexed `COUNT` (H6) |
| per-host frontier cap | N rows/host (anti-starvation) (C3) | enqueue |
| `BATCH_SIZE` | 8 | claim `LIMIT` |
| batches-per-invocation loop | until `TIME_BUDGET_MS` (C2 — many batches, ONE QStash msg) | runBatch loop |
| `MAX_DURATION` | 300 (Fluid-on Hobby) | `vercel.json` |
| `TIME_BUDGET_MS` | 270_000 | runBatch deadline |
| `LEASE_MS` | 360_000 (> MAX_DURATION — never reclaim a live invocation) (H2) | sweeper |
| per-fetch timeout | 8_000 (total: fetch+redirects+body) | guardedFetch |
| `MAX_REDIRECTS` | 3 (each hop re-classified + re-pinned) (L4) | guardedFetch |
| `MAX_BYTES` | 256 KiB profile / 64 KiB inbox | readBoundedText |
| `MAX_OUTLINKS_PER_DOC` | 500 | extract |
| `MAX_QUADS` / JSON nodes / depth | 50_000 / 10_000 / 32 (parser-bomb caps — C3) | parse helper |
| `MAX_ATTEMPTS` (transient) | 5 → `error` re-eligible after cooldown (never permanent) (H7) | finalize |

**Termination invariant (stated correctly):** termination = `FRONTIER_CAP` + **canonical PK dedup** +
per-host cap. Depth is *not* the bound (a fully-connected malicious Solid graph stays at depth 0).
Therefore canonicalisation correctness (§2.2) is load-bearing.

### 3.3 The batch handler (`runCrawlBatch`)

```
deadline = now + TIME_BUDGET_MS
sweepExpiredLeases(now)                       // re-pend stale claims (crash recovery)
loop while now < deadline AND daily budget not exhausted:
  rows = claimBatch({batch:BATCH_SIZE, ...})  // §3.1; break if empty
  for each row (p-limit per-host ≤2; 1 vCPU so this is I/O-overlap only — H3):
     if now > deadline: re-pend remainder; break
     if isTombstoned(row.webid): finalize state='tombstoned'; continue        // gate 2 of 3 (H1)
     robots = getOrFetchRobots(row.host)       // separate allowedContentTypes={text/plain} (L4)
     if !robots.allow: finalize state='blocked'; continue
     res = guardedFetch(row.doc_url, {accept:RDF_ACCEPT, conditional:{etag,lastModified}, ...})
     304 → finalize(timing-only, COALESCE validators — H3); continue          // cheap path, 0 writes
     non-2xx → classify(deterministic|transient); finalize per H7; continue
     {quads, finalUrl, subjects} = parseRdf(res.body, res.contentType, {caps})  // bomb-capped (C3)
     isSolid = hasOidcIssuer on subject ∈ {requestedWebId, requestedUrl, finalUrl, finalUrl#me} (M3)
     contentHash = sha256(reserialise(quads))
     if contentHash == row.content_hash: finalize(timing-only); continue       // M5 — no rewrite
     project fields (typed accessors) → upsertProjection(...) in ONE batch tx  // H4
     for each foaf:knows obj (≤MAX_OUTLINKS, syntactic-canonical, not tombstoned):
        childDepth = (reachableFromTrustedSeed && isSolid) ? 0 : depth+1       // C2
        if childDepth ≤ MAX_DEPTH && underCaps && suggestBudget>0: enqueue(...) // syntactic; no DNS (M4)
     finalize(state='done', next_eligible_at = now + RECRAWL_INTERVAL, validators)  // fenced (H3/M2)
if more eligible work AND daily QStash budget not exhausted:
  publishSelf(delayMs)                          // ONE QStash msg per drained invocation, not per batch (C2)
```

### 3.4 Conditional re-crawl, liveness, provenance (corrects H3, M3)

- Re-crawl = the claim predicate accepts `state IN ('pending','done','error')` once
  `next_eligible_at ≤ now`; **no separate recheck-insert** (M2). `RECRAWL_INTERVAL` = 14d Solid / 30d
  non-Solid (M3, stretched so freshness never starves discovery; recheck is also de-prioritised in the
  claim `ORDER BY`).
- `304` **preserves validators** via `COALESCE(:etag, etag)` and touches only timing columns (H3) —
  this is what keeps inside Turso's 10M-writes/mo cap.
- `410 Gone` → auto-tombstone reason `erasure`. Persistent transient failure → `state='error'`,
  re-eligible after a long cooldown (never permanent `failed` for a flapping real pod — H7).
  Deterministic failures (parse error, SSRF refusal, content-type reject, body-too-large, 4xx≠429) →
  `state='skipped'` immediately, **no retries** (retrying is pointless + amplifies — H7).

### 3.5 Scheduling within free limits (corrects arch C2)

- **Vercel Cron** (Hobby = once/day floor) → `GET /api/_jobs/tick`: reseed catalog WebIDs, enqueue
  stale rows for recheck, drain unprocessed inbox, fire **one** QStash crawl message.
- **QStash schedule** (`*/15 * * * *`, within the 10-schedule free cap) is the real heartbeat.
- **Per invocation drains many batches** (the §3.3 loop), so 1,000 QStash msg/day → >100k docs/day
  capacity. Self-publish **one** message per drained invocation only when work remains AND the daily
  budget (`daily_counter.qstash_msgs`) isn't spent; else fall to the daily cron (M4 graceful
  degradation). Retries bill as messages → cap fan-out, idempotent finalize makes at-least-once safe.

---

## 4. Linked-Data HTTP API contract

Canonical origin `$ORIGIN` (e.g. `https://webid-index.example`). All identifiers on a dedicated path
(no file extensions — conneg picks serialisation). Routes are Next.js App-Router handlers,
`export const runtime = "nodejs"` (required — DNS-pin needs Node; boot-asserted — H8/§6).

### 4.0 Cross-cutting (every RDF response)

- **Conneg** via the house `prefersHtml` + `negotiateRdfType` (reuse `src/rdf/conneg.ts` verbatim — it
  already does q-values + `*/*`→Turtle + `Sec-Fetch`-independent browser detection; do **not** use the
  naive `Accept.includes("text/html")`). Default Turtle for `*/*`; `406` only when truly unsatisfiable.
- **JSON-LD is compacted by default** against the index's **own bundled context** via a *new*
  `serializeJsonLdCompacted(quads, contextDoc)` = `jsonld.fromRDF` → `jsonld.compact(..., {documentLoader: allowlistLoader})` (corrects sw C1 — the house `serializeJsonLd` emits expanded with
  no context and must NOT be reused for served docs). Honour the `profile` media-type param:
  `#expanded`→skip compaction, `#flattened`→`jsonld.flatten`. Served bodies **reference** the remote
  `$ORIGIN/ns/context.jsonld` (consumers fetch it; the index never dereferences a remote context — the
  two operations are distinct, sw C2). The published context: `"@version":1.1`, `@type:@id` on
  `knows`/`oidcIssuer`/`storage`/`img`/`sameAs`/`isPrimaryTopicOf`, `@container:@set` on multi-valued
  terms, identity terms `@protected:true`.
- **Bundled allowlist loader** (port `webidResolver.ts` `BUNDLED_CONTEXTS` + `allowlistLoader`, **not**
  the reject-all `parse.ts` loader) extended with **AS2** (`https://www.w3.org/ns/activitystreams`),
  the index context, foaf/vcard/schema/solid/pim/dcterms/skos. Without AS2 bundled the inbox would 400
  every conformant LDN sender (sw C2).
- **Headers:** `Vary: Accept` on **every** conneg response — stamped by non-bypassable middleware
  including the HTML render path (sw H4 / security L1; cache-poisoning is the failure mode);
  `Vary: Accept, Accept-Profile` where profile-negotiated; `Vary: Origin` on write surfaces. Strong
  `ETag = "sha256-{16hex}"` over (canonical N-Triples + media type + **profile param**) so compacted
  vs expanded JSON-LD never share a validator (sw H4). `Link: <…ldp#Resource>; rel="type"`;
  `Link: <…/ns/context.jsonld>; rel="http://www.w3.org/ns/json-ld#context"` on JSON-LD;
  `Link: <$ORIGIN/inbox/>; rel="http://www.w3.org/ns/ldp#inbox"` on `/` (only — sw H2);
  `Link: <$ORIGIN/.well-known/void>; rel="describedby"` on entries + `/`.
- **Caching:** `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=86400` on
  entries/dataset; `s-maxage=3600` on TPF (fragments cache perfectly); `no-store` on inbox/optout.
  Read path serves precomputed `ttl_cache`/`jsonld_cache`/`nt_cache` strings — **no N3/jsonld import on
  the hot path** (arch H2); dynamic-import serializers only on cache-miss fallback. Internally route
  conneg to a bounded set of representation cache keys so `Vary: Accept` (high-cardinality) doesn't
  shred CDN hit-rate (arch H2).
- **CORS:** reads `Access-Control-Allow-Origin: *` (GET/HEAD/OPTIONS; no credentials); writes (inbox,
  optout) reflect an allowlist (`PM_ORIGIN`, `$ORIGIN`) with `Vary: Origin`. `4.5 MB` function body cap
  → page everything; never serve a live full dump (arch H1).

### 4.1 Entry — `GET /p/{slug}` (LDP-RS) — *LDP §4.3, Solid Protocol, JSON-LD 1.1, Cool URIs*

`200` description document; the agent node is the upstream WebID, `<>` is the doc
(`foaf:primaryTopic`, `dcterms:source`, `dcterms:modified`, `prov:wasDerivedFrom`, `void:inDataset`,
`idx:crawlState <#Live>`). Statuses: `200`; `304`; `404` (unknown); `410 Gone` + `no-store` (tombstoned
— H1); `406`; `405` (`Allow: GET, HEAD, OPTIONS`). `HEAD`/`OPTIONS` supported.
`GET /lookup?webid=` → `303` to `/p/{slug}`.

### 4.2 Dataset & service description — *VoID, DCAT-3, SPARQL-SD, 5-star*

- `GET /.well-known/void` → `void:Dataset, dcat:Dataset` with access methods
  (`void:uriLookupEndpoint`=TPF, `void:dataDump`→**paged/Blob URL** not live function — arch H1),
  stats from the `stats` table (`void:triples/entities/classes/properties`, `void:classPartition`,
  `void:propertyPartition`), `void:vocabulary` for each vocab, `void:Linkset` for outbound `foaf:knows`
  (★★★★★). **SPARQL triples gated behind the flag** — absent by default (sw M2); when off, no
  `void:sparqlEndpoint`/no `/sparql` `DataService`. `dcterms:rights` clarifying indexed PII remains the
  subjects' (license covers index structure only — sw L2).
- `GET /` → `dcat:Catalog` + `dcat:Dataset` + `dcat:DataService` (search, TPF) + `ldp:inbox` triple +
  `hydra:search` entrypoint; HTML for browsers (the landing/search page).

### 4.3 Suggest — LDN inbox `POST/GET /inbox/` — *LDN (Rec), AS2, LDP §5.2*

**Discovery:** one `ldp:inbox` advertised on `/` (header + body). **Not** on `/p/{slug}` (that would
misuse `ldp:inbox` to mean "notifications about Alice" — sw H2; if a global suggest link is wanted on
entries, use a distinct `idx:suggestInbox`).

**`POST /inbox/`** — body = AS2 (`Content-Type: application/ld+json` MUST; `text/turtle` MAY;
`application/activity+json` accepted). Canonical verb **`as:Announce`** ("calling attention to an
existing WebID"); `as:Offer`/`as:Add` accepted leniently (sw L1). Algorithm:

1. Size guard: > 64 KiB → `413` **before** `JSON.parse` (C3).
2. Parse via the **allowlisted** loader (AS2 context bundled). Malformed RDF → `400`.
3. Extract `as:object` IRIs from **expanded quads** (predicate `…activitystreams#object`) via typed
   accessor, not JSON keys (sw M1 / security M1); accept ≥1 (≤10), store in `inbox_object`. None → `422`.
4. **Syntactic** SSRF gate on the candidate (https, public-looking host literal rejection, denylist) —
   **no DNS on the request path** (M4); the DNS-pinned check happens later in `guardedFetch`.
5. Canonicalise + dedup: known&live → `200` + `Link rel="related"`; tombstoned → `409`; rate-limit
   exceeded → `429` + `Retry-After`.
6. New&valid: persist notification at `/inbox/{ulid}` (honour `Slug`), `enqueue` (budget-gated — C2/M4),
   publish **one** QStash kick (fire-and-forget; **no inline `waitUntil` crawl** — arch M2). Respond
   `201` + `Location` (LDN MUST) — or `202` in async mode.

| Outcome | Status |
|---|---|
| New WebID stored | 201 + Location |
| Already live | 200 |
| Tombstoned/opted-out | 409 |
| Malformed RDF | 400 |
| No `as:object` / not a WebID-shaped https public IRI | 422 |
| Rate limited | 429 + Retry-After |
| Body too large | 413 |
| Unsupported Content-Type | 415 |

**`GET /inbox/`** → `200` `ldp:BasicContainer` + `as:Collection`, members via `ldp:contains`,
`hydra:totalItems` (advisory — M6), paged (`hydra:PartialCollectionView`, default 50). Honour `Prefer`
(`PreferMinimalContainer`/`PreferContainment`). `Accept-Post` on OPTIONS matches the parseable set
(post-context-fix — sw H2). Client `PUT`/`DELETE` on container or `/inbox/{id}` → `405`/`409`.

### 4.4 Search — Hydra `GET /search?q=` — *Hydra Core, LDP container*

`200` `hydra:Collection` with `hydra:member` (entries), `hydra:totalItems` (**advisory estimate** —
clients terminate on absent `hydra:next`, never on count — M6), `hydra:PartialCollectionView`
(`first/next/previous`). The entrypoint `/` advertises `hydra:search` → `hydra:IriTemplate`
(`hydra:template "$ORIGIN/search{?q}"`, `hydra:variableRepresentation hydra:BasicRepresentation`, one
mapping `q`→`idx:searchText` with `hydra:required true` — one property per mapping; "search across
name+webid+issuer" is the server's *implementation* of `q`, not multiple `hydra:property` — sw M3).
**Keyset pagination** with an opaque cursor encoding `(score, webid_id, as_of)` so concurrent crawls
can't dup/skip across pages, and a point-in-time `as_of` filter (`last_modified ≤ asOf`) gives a stable
session (corrects H5). Clients treat `next` as opaque and follow it (never reconstruct).

**FTS query building (security H4):** lowercase → strip all but `[a-z0-9]`+whitespace → split → drop
empties → cap ≤8 tokens × ≤32 chars → join as bound param `tok1* tok2*`. **Never** pass FTS operators
(`" NEAR ^ : * AND`). Fuzz-tested. Ranking: `bm25(webid_fts, 10, 3, 1)` (label≫webid≫issuer) minus
boosts (has-oidc-issuer −2, live −1, recency bucket −0.5, computed app-side — the dead `*0+0` SQL term
is removed — arch L4).

### 4.5 Triple Pattern Fragments — `GET /tpf?s=&p=&o=` — *TPF / LDF, Hydra, VoID*

A **conformant** fragment is one RDF graph with three parts (corrects sw H1): **data** (matching
triples from the indexed `triple` table — arch M1); **metadata** — the fragment resource typed
`hydra:Collection, void:Dataset` with `void:subset <$ORIGIN/#dataset>`, `void:triples` = the
**pattern** cardinality estimate (from `stats`, not live COUNT), `hydra:totalItems`,
`hydra:itemsPerPage`; **controls** — `<$ORIGIN/#dataset> hydra:search [a hydra:IriTemplate;
hydra:template "$ORIGIN/tpf{?s,p,o}"; hydra:mapping (s→rdf:subject, p→rdf:predicate, o→rdf:object)]`,
plus `hydra:first/next/previous`. Page-capped, `s-maxage=3600`, per-IP byte budget (security M3).

### 4.6 SPARQL (optional, off by default) — *SPARQL 1.1 SD*

`GET /sparql` with no query → SD graph (`sd:Service`, `sd:endpoint`, `sd:supportedLanguage
sd:SPARQL11Query`, `sd:resultFormat`) **only when the flag is on**. Default off on Hobby (cost);
VoID/DCAT advertise it only when enabled.

### 4.7 Minted `idx:` namespace — `GET /ns` (corrects sw C3)

`$ORIGIN/ns#` minted **only** for index-operational terms, shipped as a real conneg'd ontology
(Turtle/JSON-LD/HTML) **in the same change** as first use (house MAINTENANCE RULE). Terms:
`idx:Entry`, `idx:crawlState` (range a `skos:Concept`), `idx:Live`/`idx:Unreachable`/`idx:Stale`
(`skos:Concept` instances with `skos:prefLabel`), `idx:noIndex`, `idx:optOutToken`, `idx:reason`,
`idx:searchText`, `idx:suggestInbox`. Each carries `rdfs:label`/`comment`/`isDefinedBy`. **Drop
`idx:lastCrawl`** (use `dcterms:modified` + `prov:generatedAtTime` — sw C3). Context at
`/ns/context.jsonld` (`Cache-Control: public, max-age=86400, immutable`).

### 4.8 Opt-out / erasure — `POST /optout` (corrects security H1/H2)

Two proof paths, no account system: **Path A** Solid-OIDC DPoP token whose `webid` claim canonicalises
to an entry (verified via the issuer-agnostic DPoP verifier) → immediate erasure. **Path B**
challenge-response: `POST {webid}` → `202` + one-time `idx:optOutToken` nonce to publish in the
upstream profile (or `.well-known/solid-index-optout`); follow-up `POST` → guarded fetch confirms nonce
→ erase. **Erasure is one transaction over EVERY surface** (H1): delete `webid` + all child tables +
FTS + `triple` + caches + the `doc` row (incl. `raw_rdf`) + redact `inbox_notification.body`; insert a
permanent `tombstone` (canonical key) checked at **enqueue, fetch, and projection** (three gates); drop
`foaf:knows` edges *to* the tombstoned WebID from served output (projection is the enforcement point);
serve `/p/{slug}` as `410` + `no-store`; regenerate the (paged) dump tombstone-filtered. Also honour
**`noindex` at crawl time**: `idx:noIndex true` OR `X-Robots-Tag: noindex` on the profile doc OR
robots.txt Disallow → never index / erase if present (multiple signals, default-deny on the existing
`X-Robots-Tag` so it works today — H2).

### 4.9 Health — `GET /.well-known/health` → `200` JSON `{status, entries, lastCrawlAt, queueDepth,
version}` + `Link: <…/void>; rel="describedby"` (RDF stats are the single source — sw L4); `no-store`.

---

## 5. SSRF defense-in-depth (corrects security C1/C3/C4, validation F1)

**One primitive** `lib/security/guardedFetch.ts`; the ONLY external `fetch` in the codebase (ESLint
`no-restricted-imports` + CI grep enforce it). Vendor `@pss/guarded-fetch`
(`addresses.ts`/`ssrf.ts`/`body.ts`) **verbatim** with its tests; port the redirect-revalidation +
bundled-context loop from `webidResolver.ts`. **Do NOT reuse the parse path unmodified** — its
`new Parser().parse(body)` (sync, uninterruptible, uncapped) and `jsonld.toRDF` (no caps) are
parser-bomb vectors (security C3).

Ordered algorithm (every step fails closed): parse URL → scheme gate (https-only prod) → **port gate
(443 only; +80 for http→https pre-redirect — security C4)** → reject userinfo → feed
`new URL().hostname` (NFC) to classifier → DNS resolve-ALL + `isPublicAddress` every record (multi-
record rebinding) → **pin first validated IP** via `Agent({connect:{lookup: pinnedLookup(ip)}})` +
**belt-and-braces connect-by-IP with `Host` override** (so a future undici can't reopen the window —
security C1) → single AbortController over fetch+redirects+body → `redirect:"manual"` loop (≤3, each
hop re-classified + re-pinned, scheme-downgrade rejected) → **content-type allowlist** (Turtle/JSON-LD/
N-Triples; **exclude `text/html`/RDFa** — smaller surface; robots.txt uses a separate `text/plain`
path — L4) enforced on the **final** response → `readBoundedText` cap.

**Runtime is load-bearing (security C1, correctness H8):** every route calling `guardedFetch`
(`/inbox`, `/api/_jobs/*`) declares `export const runtime = "nodejs"` and has a **module-load boot
assertion** that throws if `process.env.NEXT_RUNTIME === 'edge'` or `node:dns.lookup` is absent — fail
closed at boot, with a unit test asserting the directive's presence. `undici` `fetch`+`Agent` imported
from the **same bundled copy** (dispatchers only interoperate within one undici). DNS-pin feasibility is
**verified empirically** on the actual Vercel Node runtime (rebinding + IMDS probe) as a **launch
gate**, not a flag (validation Q1). Hostname denylist for cloud-internal names (`*.internal`,
`metadata.google.internal`, `*.svc.cluster.local`, `*.vercel-internal.*`) on top of IP classification
(security C4).

**Parser caps (security C3):** pre-parse JSON node-count (≤10k) + depth (≤32) before `jsonld.toRDF`;
N3 in **streaming** mode with an `onQuad` counter aborting past 50k quads; same hard ceiling after
`toRDF`; per-doc parse respects the wall-clock budget. One parse helper (`parseRdf`) only.

**Anti-amplification (security C2 — the open-inbox cost bomb):** the depth-reset rule resets to 0
**only for trusted-seed-rooted reachability** — for `source ∈ {suggest, knows}` not descending from a
seed, depth **always increments** (a fully-connected attacker Solid graph can no longer stay at depth 0
forever). Per-suggestion subtree node budget (`suggest_budget`). Global **daily admission budget**
(`daily_counter`) on queue inserts + QStash msgs, shedding `suggest`/`knows` first. Per-IP token bucket
**before** any DB write/fetch (immediate-crawl privileged to a low budget, e.g. 3/IP/hr; slow drain
gets the rest). Re-suggest of a `done`/`failed`/tombstoned WebID blocked for a 7d cooldown
(`last_terminal_at`, not just `INSERT OR IGNORE`).

**Politeness race fix (security H3):** the `host_state` row + robots verdict is created/gated at
**enqueue** (one per distinct host); per-host concurrency = 1 for the first (robots) fetch then ≤2,
derived from `COUNT(state='claimed')` (H2); honour `Retry-After`/`429`/`503` by advancing
`next_allowed_at` (tested invariant); negative-cache SSRF refusals via long backoff (L6).

**Job-trigger auth fails closed (security H5):** missing/empty `QSTASH_*_SIGNING_KEY` ⇒ reject ALL
(boot assertion in prod); constant-time compare the cron bearer; even a forged trigger can't reach
internal IPs (it still routes through `guardedFetch`) but is also rate-limited. Tested: unsigned →
`401`.

---

## 6. Vercel free-tier deployment (corrects arch C1/C2/C3/H1/H3, validation L3)

**Verified envelope (Jun 2026):** Hobby with **Fluid Compute on** → 300s max duration; budget caps =
4 CPU-hr/mo Active CPU, 360 GB-hr Provisioned Memory, 1M invocations/mo, 100 GB transfer, **4.5 MB
function body cap**, **2 GB/1 vCPU** max memory, 100 deploys/day. Cron min interval = **daily**. Turso
free: 5 GB, 500M reads, 10M writes/mo, single-region. QStash free: **1,000 msgs/day**, 10 schedules,
1 MB/msg.

**`vercel.json`:**
```jsonc
{ "$schema": "https://openapi.vercel.sh/vercel.json",
  "fluid": true,
  "regions": ["iad1"],                         // co-locate with the Turso DB region (L2)
  "crons": [{ "path": "/api/_jobs/tick", "schedule": "0 2 * * *" }],
  "functions": {
    "app/api/_jobs/crawl/route.ts": { "maxDuration": 300, "memory": 1024 },
    "app/api/_jobs/index/route.ts": { "maxDuration": 300, "memory": 1024 },
    "app/api/**/route.ts":          { "maxDuration": 60,  "memory": 256 } } }
```

**Stays-free budget (≈5k WebIDs, frontier ≤20k):** Turso storage <50 MB; writes <200k/mo (the `304`
cheap path + content-hash gate are the economisers); reads ~1M/mo (FTS keeps per-query rows tiny);
invocations <1M (CDN cache absorbs reads — arch H2); Active CPU well under 4 CPU-hr (crawl is I/O-bound;
**read path precomputes serialisations so no jsonld CPU on the hot path** — arch H2); QStash a few
hundred/day (one msg per drained invocation, not per batch — C2). The two squeeze points
(invocations/CPU; QStash 1k/day) are **config knobs** (batch size, fan-out cap), not architecture. A
**circuit-breaker** (`daily_counter`) stops fan-out gracefully when a self-imposed daily budget is hit
and ships a once-per-invocation metric line off-platform (Hobby logs retain 1h — M4).

**Deploy-on-commit (corrects arch C1):** Hobby **cannot connect an org-owned repo**. Canonical lane =
deploy from a **personal mirror repo** (one-line mirror push from the canonical org repo → personal
mirror → Vercel auto-deploys). Build is from the git checkout → the data-exfil image-push guardrail
that blocks the EC2 deploys **does not apply** (generalisable suite recommendation). `NEXT_PUBLIC_*`
baked at build; server secrets (`TURSO_*`, `QSTASH_*`, `JOB_SHARED_SECRET`, `INDEX_BASE_URL`,
`CRAWL_CATALOG_URLS`, `CRAWL_DENY_CIDRS`) marked **Sensitive**, read at runtime only.

---

## 7. Pod Manager integration (consumer-side)

All client-only (`"use client"`), gated on a single env var, zero new PM server cost (PM is a static
export — calls are browser→index). New deps: **none** (`@jeswr/fetch-rdf`/`n3` already present).

- `src/lib/webid-index.ts`: `WEBID_INDEX_ORIGIN = (process.env.NEXT_PUBLIC_WEBID_INDEX ?? "").replace(/\/+$/,"")`; `WEBID_INDEX_ENABLED`. Unset ⇒ whole integration inert (no nav, no panels).
- `src/lib/index-client.ts`: typed UI-ready client (`IndexEntry`/`IndexPage`); `searchIndex`,
  `fetchIndexPage` (follows opaque `hydra:next` verbatim), `isIndexed`, `suggestWebId`. JSON-LD consumed
  **by stable compacted key** with defensive `asArray`/`id` normalisers + term-IRI aliasing (the index
  guarantees a stable compacted `@context` — relies on §4.0 compaction contract); single-entry detail
  uses full `parseRdf` + the PM `ProfileAgent` so name/avatar fallback chains match pod profiles.
- `src/components/use-webid-index.ts`: SWR-style hooks mirroring the PM `useResource` shape
  (loading/data/error + AbortController + 300ms debounce + 60s read cache); `useIndexSearch` (with
  `loadMore`), `useIsIndexed`.
- `src/components/index-result-card.tsx`: shared card (Avatar/Badge/Button), "Solid WebID" badge when
  issuers present; rejects non-https `img` (`javascript:`/`data:` → initials fallback — security mirror).
- `src/app/people/page.tsx`: new global-directory page (nav gated on `WEBID_INDEX_ENABLED`); search +
  "Add as contact" + "View profile" + "Suggest to index" (when `useIsIndexed === false`).
- `/contacts` + `/contacts/edit`: a "Find people" panel + name-autocomplete; "Add as contact"
  deep-links the existing editor with prefill (`?fn=&webid=`). Contact↔WebID link is **additive**
  `rdfs:seeAlso <webid>` + `vcard:url <webid>` via a new `ContactDoc.webIdUri` typed accessor (never
  hand-built) — owner sign-off needed (open question).
- `suggestWebId` POSTs an **`as:Announce`** AS2 notification to the inbox (`actor` = the user's WebID if
  available, else omitted); maps `201`/`202`→success, `409`/`200`→"already indexed", `400`→invalid,
  `5xx`→retry. **Plain unauthenticated `fetch`**, `mode:"cors"`, never `credentials:"include"`, never
  attach the user's DPoP token to the third-party origin (security note — verify the PM auth-patch
  scoping).

The index app's **own** UI vendors the PM `globals.css` + curated shadcn primitives (`button`, `input`,
`card`, `avatar`, `badge`, `skeleton`, `sonner`, `tooltip`) + `Brand`/`states`/`ThemeProvider`,
hash-pinned (re-sync on PM theme change). Pages: `/` search (results-in-URL, client-rendered to keep
off serverless functions), `/suggest`, `/docs` (human mirror of `hydra:ApiDocumentation`). The
HTML-vs-RDF dispatch at `/` and `/search` reuses the house `prefersHtml` (not a naive `includes`).

---

## 8. Test strategy (never hit the public internet)

- **Local fixture WebID server** (a tiny in-test HTTP server) serves canned Turtle/JSON-LD profiles,
  redirects, `304`, `410`, oversized bodies, parser bombs, RDFa-HTML (to assert rejection), and
  hostile `foaf:knows` fan-outs. Every crawler/inbox/SSRF test points at it (or `127.0.0.1` with
  `allowLoopback` dev) — **no test ever fetches a real URL**.
- **SSRF unit tests (exhaustive, security-critical):** vendored `@pss/guarded-fetch` suite +
  rebinding stub (public→private between guard and connect must refuse), all encoding evasions
  (decimal/octal/hex IPv4, IPv4-mapped/expanded IPv6, 6to4/NAT64-embedded-v4, ULA/link-local), redirect-
  to-private, port-gate, content-type allowlist on final hop, IDN/NFC homograph, parser-bomb caps.
  A test asserting `runtime === "nodejs"` + the boot assertion on inbox/job routes.
- **Concurrency test against a live libSQL instance** (launch-gate, correctness C1/C3/H4): two parallel
  `claimBatch` calls → disjoint result sets; interleave a search with an upsert → searcher sees old XOR
  new (never neither — the FTS delete+reinsert atomicity in `batch()`).
- **Conneg conformance matrix (sw H4):** `{browser Accept, */*, text/turtle, application/ld+json,
  …;profile=#expanded}` × `{/, /search, /p/{slug}}` → correct `Content-Type`, `Vary` present, distinct
  `ETag` per representation (incl. profile param), compacted-by-default JSON-LD validates against the
  context.
- **LD-conformance tests:** LDN inbox (`201`+`Location`, `GET`→`ldp:contains`, AS2 from a real remote
  context parses, `Accept-Post` matches parseable set, client mutation `405`); TPF fragment has
  data+metadata+control graph with pattern-cardinality `void:triples`; Hydra `IriTemplate`
  one-property-per-mapping + `variableRepresentation`; VoID/DCAT don't advertise the disabled SPARQL
  endpoint; keyset pagination stable under a concurrent insert.
- **FTS injection fuzz (security H4):** `" NEAR ^ : * AND ")(`-style payloads → no error, bounded plan.
- **Privacy/erasure completeness (security H1):** post-erasure, the WebID returns `410`/absent across
  entry, search, TPF, dump; `foaf:knows` edges to it are dropped; re-suggest → `409`.
- **Crawler termination/idempotency:** hostile fan-out + variant-flood bounded by caps; double-delivery
  (QStash at-least-once) idempotent; `304` sends original `If-None-Match` and does 0 profile writes.
- Gate: lint (Biome) + typecheck + `vitest run` + `next build`; security-critical paths exhaustive +
  roborev PASS before merge.

---

## 9. Spec-to-surface conformance map

| Surface | Route(s) | Governing spec(s) |
|---|---|---|
| Entry representation | `GET /p/{slug}`, `/lookup` | LDP §4.3, Solid Protocol, JSON-LD 1.1, Cool URIs (describe-only) |
| Suggest inbox | `POST/GET /inbox/`, `/inbox/{id}` | LDN (Rec), AS2, LDP §5.2 / §7.2 |
| Search | `GET /search?q=` | Hydra Core, LDP container |
| Triple-pattern query | `GET /tpf?s=&p=&o=` | TPF / LDF (+ Hydra controls, VoID metadata) |
| SPARQL (optional, off) | `GET /sparql` | SPARQL 1.1 SD |
| Opt-out / erasure | `POST /optout` | Solid-OIDC DPoP (Path A), challenge-response (Path B), GDPR erasure |
| Dataset / service desc | `GET /`, `/.well-known/void` | VoID, DCAT-3, SPARQL-SD, Cool URIs, 5★ |
| Namespace + context | `GET /ns`, `/ns/context.jsonld` | Cool URIs (hash ontology), JSON-LD 1.1, SKOS |
| Cross-cutting | all | RFC 7231 conneg, DX-Prof-ConNeg, RFC 6906, CORS |

**Reuse (absolute paths):** conneg `prefersHtml`/`negotiateRdfType` —
`/Users/jesght/Documents/GitHub/jeswr/prod-solid-server/src/rdf/conneg.ts` (verbatim); typed-accessor
graph builder template — `…/src/rdf/containerListing.ts`; SSRF primitives —
`…/packages/guarded-fetch/src/{addresses,ssrf,body}.ts` (verbatim, with tests); the bundled-context
**allowlist** loader to port (NOT the reject-all `parse.ts` loader) — `…/src/auth/webidResolver.ts`
(`BUNDLED_CONTEXTS`/`allowlistLoader`, `followRedirectsSafely`, single-controller timeout); DPoP
verifier for opt-out Path A — `…/src/auth/`. The compacted-JSON-LD serialiser is a **new delta** from
`…/src/rdf/parse.ts` (`jsonld.fromRDF` → `jsonld.compact`).