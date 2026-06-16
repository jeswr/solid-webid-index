// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/client/types.ts — public types for the framework-agnostic WebID-index
 * consumer client (DESIGN.md §7).
 *
 * This client is what lets the Pod Manager (and any suite app) consume the
 * index's Linked-Data surfaces — `/search`, `/lookup`, `/.well-known/health`,
 * and the LDN suggest inbox — WITHOUT each app re-implementing RDF parsing,
 * Hydra pagination, and the AS2 POST. The pattern lives ONCE here so apps inherit
 * it (the suite "fix the pattern in a shared place" rule), rather than copying it.
 *
 * Every shape here is plain data, framework-agnostic (no React, no Next.js), so
 * it is consumable from a browser app, a server, or a test.
 */

/** A single search/index entry, projected from the Hydra collection RDF into UI-ready data. */
export interface IndexEntry {
  /** The upstream WebID IRI (the agent's canonical identity — never an index-minted URI). */
  webid: string;
  /** Best-effort display name (foaf:name), or null when the entry carries no label. */
  name: string | null;
  /**
   * Avatar/photo URL, or null. Only an `https:` URL survives — a `javascript:` /
   * `data:` / non-https `foaf:img` is rejected to null (defensive; the consuming
   * UI must fall back to initials). Mirrors the §7 security note.
   */
  photoUrl: string | null;
  /** `dcterms:modified` (last-crawled) as an ISO-8601 string, or null. */
  modified: string | null;
}

/** One page of search results, plus the opaque cursor to fetch the next page. */
export interface IndexPage {
  /** The entries on this page. */
  entries: IndexEntry[];
  /**
   * The OPAQUE `hydra:next` URL for the following page, or null when this is the
   * last page. Clients MUST treat this as opaque and pass it verbatim to
   * {@link IndexClient.fetchPage} — never reconstruct it (keyset pagination).
   */
  next: string | null;
}

/** Liveness snapshot from `GET /.well-known/health`. */
export interface IndexHealth {
  /** "ok" when the store responded; "degraded" when the DB was unreachable. */
  status: "ok" | "degraded";
  /** Number of served WebID entries (void:entities). */
  entries: number;
  /** Total served triples (void:triples). */
  triples: number;
  /** Live crawl frontier depth (pending + claimed). */
  queueDepth: number;
  /** The index build version string. */
  version: string;
}

/** The outcome of a {@link IndexClient.suggestWebId} call. */
export type SuggestOutcome =
  | "submitted" // 201/202 — newly accepted (or accepted, crawl pending)
  | "already-indexed" // 200/409 — the WebID is already known / tombstoned
  | "invalid" // 400/415/422 — malformed or not a WebID-shaped IRI
  | "rate-limited" // 429 — too many suggestions; retry later
  | "error"; // 5xx / network — transient, safe to retry

/** Options accepted by the client factory. */
export interface IndexClientOptions {
  /**
   * The canonical origin of the index deployment (e.g. `https://webid-index.example`).
   * A trailing slash is stripped. When empty/undefined the whole client is INERT —
   * {@link createIndexClient} returns `null` so a consuming app can gate the entire
   * integration on a single env var (DESIGN.md §7).
   */
  origin: string;
  /**
   * The `fetch` implementation to use. Injectable so a consuming app can pass its
   * own (e.g. one with a timeout) and so tests can stub it without a network. NEVER
   * pass an authenticated / credentialed fetch: index reads are public and the
   * suggest POST is unauthenticated cross-origin — a user's DPoP token must never be
   * attached to the third-party index origin (§7 security note). Defaults to the
   * global `fetch`.
   */
  fetch?: typeof globalThis.fetch;
  /** Optional AbortSignal forwarded to every request (cancellation). */
  signal?: AbortSignal;
}

/** Options for a single search call. */
export interface SearchOptions {
  /** Page size hint forwarded as `?limit=` (the server clamps it). */
  limit?: number;
  /** Per-call AbortSignal (overrides the client-level signal for this call). */
  signal?: AbortSignal;
}

/** Options for a suggest call. */
export interface SuggestOptions {
  /**
   * The suggesting user's WebID, recorded as the AS2 `actor` (provenance, optional).
   * Omit for an anonymous suggestion.
   */
  actor?: string;
  /** Per-call AbortSignal. */
  signal?: AbortSignal;
}
