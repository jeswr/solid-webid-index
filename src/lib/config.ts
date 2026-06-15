// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/config.ts — the single source of truth for every limit and runtime constant.
 * All later beads import from here; no magic numbers scattered across files.
 * Mirrors the bounds table in docs/DESIGN.md §3.2.
 *
 * Runtime: next-server (nodejs). Every value has a sensible coded default;
 * set the corresponding env var to override per-environment.
 */

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Read a boolean env flag.  Truthy values: "1" / "true" / "yes" / "on"
 * (case-insensitive).  Anything else (incl. unset / empty) → the fallback.
 */
function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

// ─── Crawler bounds (§3.2) ───────────────────────────────────────────────────

/** Maximum BFS depth from a seed. Termination is PK-dedup + FRONTIER_CAP; depth is a secondary guard. */
export const MAX_DEPTH = envInt("CRAWL_MAX_DEPTH", 3);

/** Cap on total frontier rows (pending+claimed) — the real termination bound together with PK dedup. */
export const FRONTIER_CAP = envInt("CRAWL_FRONTIER_CAP", 20_000);

/** Max docs enqueued per suggestion subtree (anti-amplification C2). */
export const SUGGEST_BUDGET = envInt("CRAWL_SUGGEST_BUDGET", 50);

/** Max rows per-host in the frontier (anti-starvation). */
export const PER_HOST_FRONTIER_CAP = envInt("CRAWL_PER_HOST_FRONTIER_CAP", 200);

/** Rows claimed per claimBatch() call. */
export const BATCH_SIZE = envInt("CRAWL_BATCH_SIZE", 8);

/** Max concurrent in-flight docs per host inside a single invocation (I/O-overlap only; 1 vCPU). */
export const PER_HOST_CONCURRENCY = envInt("CRAWL_PER_HOST_CONCURRENCY", 2);

/** Wall-clock budget (ms) per crawl invocation before the loop yields. Must be < maxDuration. */
export const TIME_BUDGET_MS = envInt("CRAWL_TIME_BUDGET_MS", 270_000);

/** Lease duration (ms) — must exceed maxDuration so a live invocation is never reclaimed (H2). */
export const LEASE_MS = envInt("CRAWL_LEASE_MS", 360_000);

/** Recrawl interval for solid WebIDs (ms). Default 14 days. */
export const RECRAWL_INTERVAL_SOLID_MS = envInt(
  "CRAWL_RECRAWL_INTERVAL_SOLID_MS",
  14 * 24 * 60 * 60 * 1000
);

/** Recrawl interval for non-solid docs (ms). Default 30 days. */
export const RECRAWL_INTERVAL_OTHER_MS = envInt(
  "CRAWL_RECRAWL_INTERVAL_OTHER_MS",
  30 * 24 * 60 * 60 * 1000
);

/** Max transient-failure retries before a doc is marked error (then re-eligible after cooldown). */
export const MAX_ATTEMPTS = envInt("CRAWL_MAX_ATTEMPTS", 5);

/**
 * Minimum delay (ms) between two fetches to the SAME host (politeness, §5). After each fetch the
 * host's `next_allowed_at` is stamped to `now + HOST_CRAWL_DELAY_MS`; the crawler skips a host whose
 * `next_allowed_at` is still in the future and re-pends its rows. Default 1s.
 */
export const HOST_CRAWL_DELAY_MS = envInt("CRAWL_HOST_DELAY_MS", 1_000);

/**
 * Base backoff (ms) applied to a doc's `next_eligible_at` after a TRANSIENT failure. The actual delay
 * grows exponentially with the doc's attempt count (`base * 2^(attempts-1)`), capped at
 * {@link TRANSIENT_BACKOFF_MAX_MS}. Default 60s.
 */
export const TRANSIENT_BACKOFF_BASE_MS = envInt(
  "CRAWL_TRANSIENT_BACKOFF_BASE_MS",
  60_000
);

/** Cap (ms) on the exponential transient-failure backoff. Default 6 hours. */
export const TRANSIENT_BACKOFF_MAX_MS = envInt(
  "CRAWL_TRANSIENT_BACKOFF_MAX_MS",
  6 * 60 * 60 * 1000
);

/**
 * Cooldown (ms) before a doc that exhausted {@link MAX_ATTEMPTS} transient retries (state `failed`)
 * becomes re-eligible. A flapping-but-real pod is never marked permanently dead (DESIGN.md §3.4 H7).
 * Default 24 hours.
 */
export const FAILED_COOLDOWN_MS = envInt(
  "CRAWL_FAILED_COOLDOWN_MS",
  24 * 60 * 60 * 1000
);

// ─── Fetch / guardedFetch limits (§5) ────────────────────────────────────────

/** Total fetch timeout per document in ms (covers DNS + connect + TLS + response body). */
export const FETCH_TIMEOUT_MS = envInt("FETCH_TIMEOUT_MS", 8_000);

/** Max HTTP redirects followed per fetch; each hop is re-SSRF-classified (§5). */
export const MAX_REDIRECTS = envInt("FETCH_MAX_REDIRECTS", 3);

/** Max response body size for a profile document in bytes (256 KiB). */
export const MAX_BYTES_PROFILE = envInt("FETCH_MAX_BYTES_PROFILE", 256 * 1024);

/** Max response body size for an inbox notification in bytes (64 KiB). */
export const MAX_BYTES_INBOX = envInt("FETCH_MAX_BYTES_INBOX", 64 * 1024);

/** Additional hostnames (beyond IP classification) to deny — comma-separated. */
export const DENY_CIDRS = envStr("CRAWL_DENY_CIDRS", "");

/**
 * Descriptive User-Agent for every guardedFetch (§5). A real UA string with a contact URL is good
 * crawler citizenship and lets origin operators identify / block us.
 */
export const FETCH_USER_AGENT = envStr(
  "FETCH_USER_AGENT",
  "solid-webid-index/0.1 (+https://github.com/jeswr/solid-webid-index; SSRF-guarded crawler)"
);

/**
 * Cloud-internal hostname suffixes denied on top of IP classification (§5 security C4). A host whose
 * lowercased name equals or ends with one of these is refused BEFORE any DNS resolution, so a name
 * that an internal resolver would map to a metadata/cluster endpoint can never be reached. Defence in
 * depth: the IP classifier already blocks the addresses these names resolve to, but a denied name is
 * cheaper and closes split-horizon DNS gaps.
 */
export const FETCH_HOSTNAME_DENYLIST: readonly string[] = envStr(
  "FETCH_HOSTNAME_DENYLIST",
  [
    "metadata.google.internal",
    "metadata.goog",
    ".internal",
    ".svc.cluster.local",
    ".cluster.local",
    ".vercel-internal.com",
    "localhost",
    ".localhost",
    ".local",
  ].join(",")
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * Response content-type allowlist for guardedFetch (§5). Only the RDF serialisations the app accepts
 * are permitted on the FINAL response; `text/html`/RDFa is excluded (smaller attack surface — the
 * robots.txt path uses its own `text/plain` allowlist). Matched against the bare media type (the part
 * before `;`), case-insensitively.
 */
export const FETCH_RDF_CONTENT_TYPES: readonly string[] = [
  "text/turtle",
  "application/ld+json",
  "application/json", // some servers serve JSON-LD as application/json
  "application/n-triples",
  "application/n-quads",
  "application/trig",
  "text/n3",
  "application/rdf+xml",
];

/** The `Accept` header guardedFetch sends for RDF documents (mirrors {@link FETCH_RDF_CONTENT_TYPES}). */
export const FETCH_RDF_ACCEPT =
  "text/turtle, application/ld+json;q=0.9, application/n-triples;q=0.8, */*;q=0.1";

// ─── Parser bomb caps (§5 security C3) ───────────────────────────────────────

/** Max quads from a single RDF parse (applies to N3 streaming counter + post-toRDF ceiling). */
export const MAX_QUADS = envInt("PARSE_MAX_QUADS", 50_000);

/** Max JSON nodes before jsonld.toRDF (pre-parse node count). */
export const MAX_JSON_NODES = envInt("PARSE_MAX_JSON_NODES", 10_000);

/** Max JSON nesting depth. */
export const MAX_JSON_DEPTH = envInt("PARSE_MAX_JSON_DEPTH", 32);

/** Max outbound foaf:knows links extracted per document. */
export const MAX_OUTLINKS_PER_DOC = envInt("CRAWL_MAX_OUTLINKS_PER_DOC", 500);

// ─── Search / API pagination (§4.4) ──────────────────────────────────────────

/** Default page size for search results (keyset paginated). */
export const SEARCH_PAGE_SIZE = envInt("SEARCH_PAGE_SIZE", 20);

/** Default page size for inbox listing. */
export const INBOX_PAGE_SIZE = envInt("INBOX_PAGE_SIZE", 50);

/** Default page size for TPF fragments. */
export const TPF_PAGE_SIZE = envInt("TPF_PAGE_SIZE", 100);

/**
 * Hard ceiling on the BOUNDED COUNT used for the TPF `void:triples` cardinality
 * ESTIMATE when no `stats` counter covers the pattern (DESIGN.md §4.5 arch M1).
 * The estimate is capped at this value so a hot/degenerate pattern can never
 * trigger an unbounded scan on the hot path; the served `void:triples` is an
 * advisory estimate, not an exact total.
 */
export const TPF_ESTIMATE_COUNT_CAP = envInt("TPF_ESTIMATE_COUNT_CAP", 10_000);

/**
 * Per-IP response byte budget for `GET /tpf` (DESIGN.md §4.5 security M3).  A
 * single fragment response body larger than this is refused with 413; combined
 * with the page cap it bounds the bytes any one client can pull per request.
 */
export const TPF_MAX_RESPONSE_BYTES = envInt(
  "TPF_MAX_RESPONSE_BYTES",
  512 * 1024
);

// ─── SPARQL (optional, OFF by default — §4.6) ────────────────────────────────

/**
 * Whether the optional SPARQL endpoint (`GET /sparql`) is enabled.  Default OFF
 * (Hobby cost / no SPARQL engine): when false the dataset description routes
 * (`/.well-known/void`, `/`) MUST NOT advertise a `void:sparqlEndpoint` /
 * `sd:Service` / SPARQL `dcat:DataService` — never advertise an endpoint that would
 * 404 (DESIGN.md §4.2 / §4.6 sw M2).
 */
export const SPARQL_ENABLED = envBool("SPARQL_ENABLED", false);

/** Max FTS tokens after tokenisation (security H4 — never pass operators). */
export const FTS_MAX_TOKENS = envInt("FTS_MAX_TOKENS", 8);

/** Max chars per FTS token after tokenisation. */
export const FTS_MAX_TOKEN_LEN = envInt("FTS_MAX_TOKEN_LEN", 32);

// ─── Rate limiting (§5, §4.3) ────────────────────────────────────────────────

/** Max inbox POST submissions per IP per hour (immediate-crawl path). */
export const INBOX_RATE_LIMIT_PER_IP_PER_HOUR = envInt(
  "INBOX_RATE_PER_IP_PER_HOUR",
  3
);

/** Re-suggest cooldown for a known/terminal WebID in ms. Default 7 days. */
export const RESUGGEST_COOLDOWN_MS = envInt(
  "CRAWL_RESUGGEST_COOLDOWN_MS",
  7 * 24 * 60 * 60 * 1000
);

// ─── QStash / scheduling (§3.5) ──────────────────────────────────────────────

/** Daily QStash message budget (free tier = 1000/day). */
export const QSTASH_DAILY_BUDGET = envInt("QSTASH_DAILY_BUDGET", 900);

/** Daily crawl-fetch budget (write-budget guard for Turso free tier). */
export const CRAWL_DAILY_FETCH_BUDGET = envInt(
  "CRAWL_DAILY_FETCH_BUDGET",
  8_000
);

// ─── Public origin ────────────────────────────────────────────────────────────

/** The canonical base URL of this deployment (e.g. https://webid-index.example). No trailing slash. */
export const INDEX_BASE_URL = envStr(
  "INDEX_BASE_URL",
  process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000"
).replace(/\/+$/, "");

/** Catalog seed URLs — comma-separated list of Turtle/JSON-LD catalogs to seed from. */
export const CRAWL_CATALOG_URLS = envStr("CRAWL_CATALOG_URLS", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ─── Job scheduling / self-chaining (§3.5) ───────────────────────────────────

/**
 * Name of the environment variable that holds the shared CRON_SECRET.
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` on every invocation;
 * the /api/_jobs/tick and /api/_jobs/crawl routes verify against this value.
 */
export const CRON_SECRET_ENV = "CRON_SECRET";

/**
 * Max self-chain hops an /api/_jobs/crawl invocation may trigger before stopping
 * (prevents an unbounded cascade).  The daily Vercel Cron resets the cycle.
 */
export const CRAWL_JOB_MAX_CHAIN_DEPTH = envInt(
  "CRAWL_JOB_MAX_CHAIN_DEPTH",
  10
);

/**
 * Return the shared CRON_SECRET from the environment, or null when unset.
 * Used by all job routes and the triggerCrawl helper to authenticate calls.
 * Throws at boot in production when the variable is absent so the route fails
 * closed rather than silently accepting unsigned requests.
 */
export function getCronSecret(): string {
  const v = process.env[CRON_SECRET_ENV];
  if (!v) {
    throw new Error(
      `[solid-webid-index] ${CRON_SECRET_ENV} env var is not set — job routes will not authenticate requests`
    );
  }
  return v;
}
