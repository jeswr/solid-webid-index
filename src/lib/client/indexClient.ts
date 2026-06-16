// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/client/indexClient.ts — the framework-agnostic WebID-index consumer client
 * (DESIGN.md §7). This is the piece that feeds the Pod Manager's people/contacts
 * search: it turns the index's Linked-Data responses into UI-ready plain objects.
 *
 * Surfaces consumed:
 *   - `GET /search?q=`               → {@link IndexClient.search}      (Hydra collection)
 *   - opaque `hydra:next` URL        → {@link IndexClient.fetchPage}   (verbatim follow)
 *   - `GET /lookup?webid=` (303/404) → {@link IndexClient.isIndexed}   (existence check)
 *   - `GET /.well-known/health`      → {@link IndexClient.checkHealth} (liveness)
 *   - `POST /inbox/` (AS2 Announce)  → {@link IndexClient.suggestWebId} (LDN suggest)
 *
 * RDF is parsed via `@jeswr/fetch-rdf` `parseRdf` (the ONLY sanctioned parser —
 * never inline `new Parser().parse`), then read with RDF/JS `DatasetCore.match`
 * typed term matching (never JSON-key access). The suggest body is built as an
 * AS2 JSON-LD `as:Announce` — built as a JS object then `JSON.stringify`d, which
 * is the canonical JSON-LD form (not a hand-concatenated triple string).
 *
 * SECURITY POSTURE (consumer side): unlike the server's crawler, this client only
 * ever talks to ITS OWN configured index origin (`origin`), not arbitrary URLs —
 * so the SSRF surface is narrow. Two defensive guards still apply:
 *   1. {@link IndexClient.fetchPage} REJECTS any `next` URL whose origin differs
 *      from the configured index origin (a malicious `hydra:next` cannot redirect
 *      a consuming app to a third-party host).
 *   2. Extracted `foaf:img` photo URLs are rejected unless `https:` (a
 *      `javascript:`/`data:` URL never reaches the consuming UI's <img src>).
 * The client NEVER attaches credentials: every request is `credentials: "omit"`,
 * so a consuming app's DPoP/cookie auth is never leaked to the index origin (§7).
 *
 * This module DOES call `fetch` (it is a network client), so it lives OUTSIDE the
 * server `check:fetch` chokepoint — the script's allowlist must permit it.
 */

import { parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore, Quad, Term } from "@rdfjs/types";
import { DataFactory } from "n3";

import type {
  IndexClientOptions,
  IndexEntry,
  IndexHealth,
  IndexPage,
  SearchOptions,
  SuggestOptions,
  SuggestOutcome,
} from "./types";

const { namedNode } = DataFactory;

// ─── Vocabulary IRIs ─────────────────────────────────────────────────────────

const HYDRA = "http://www.w3.org/ns/hydra/core#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const DCT = "http://purl.org/dc/terms/";

/** The AS2 context IRI — the `@context` of the suggest Announce body (DESIGN.md §4.3). */
const AS2_CONTEXT_IRI = "https://www.w3.org/ns/activitystreams";

const HYDRA_MEMBER = `${HYDRA}member`;
const HYDRA_VIEW = `${HYDRA}view`;
const HYDRA_NEXT = `${HYDRA}next`;
const FOAF_NAME = `${FOAF}name`;
const FOAF_IMG = `${FOAF}img`;
const DCT_MODIFIED = `${DCT}modified`;

/** The Accept header for RDF reads — Turtle preferred (the index's server default). */
const RDF_ACCEPT =
  "text/turtle, application/ld+json;q=0.9, application/n-triples;q=0.8";

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Iterate quads with a given predicate IRI via RDF/JS match (never key access). */
function matchP(dataset: DatasetCore, predicate: string): Iterable<Quad> {
  return dataset.match(
    null,
    namedNode(predicate),
    null,
    null
  ) as Iterable<Quad>;
}

/** Iterate quads with a given subject + predicate. */
function matchSP(
  dataset: DatasetCore,
  subject: Term,
  predicate: string
): Iterable<Quad> {
  return dataset.match(
    subject,
    namedNode(predicate),
    null,
    null
  ) as Iterable<Quad>;
}

/**
 * The first literal value for (subject, predicate), or null. Only literal objects
 * are returned — an IRI/blank-node object is not a display value here.
 */
function firstLiteral(
  dataset: DatasetCore,
  subject: Term,
  predicate: string
): string | null {
  for (const q of matchSP(dataset, subject, predicate)) {
    if (q.object.termType === "Literal") return q.object.value;
  }
  return null;
}

/**
 * The first IRI value for (subject, predicate), or null. Only NamedNode objects
 * are returned.
 */
function firstIri(
  dataset: DatasetCore,
  subject: Term,
  predicate: string
): string | null {
  for (const q of matchSP(dataset, subject, predicate)) {
    if (q.object.termType === "NamedNode") return q.object.value;
  }
  return null;
}

/** Accept only an `https:` photo URL; everything else (incl. javascript:/data:) → null. */
function safePhotoUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Build the UI-ready entries from a parsed Hydra collection dataset, and resolve
 * the opaque `hydra:next` URL.
 *
 * Members are `hydra:member` objects (the upstream WebID IRIs); each is described
 * by `foaf:name` / `foaf:img` / `dcterms:modified` triples on that same subject.
 * The next-page URL is `?:collection hydra:view ?view . ?view hydra:next ?next`.
 */
function projectCollection(dataset: DatasetCore): IndexPage {
  const entries: IndexEntry[] = [];
  const seen = new Set<string>();

  for (const q of matchP(dataset, HYDRA_MEMBER)) {
    const member = q.object;
    if (member.termType !== "NamedNode") continue;
    const webid = member.value;
    if (seen.has(webid)) continue;
    seen.add(webid);

    entries.push({
      webid,
      name: firstLiteral(dataset, member, FOAF_NAME),
      photoUrl: safePhotoUrl(firstIri(dataset, member, FOAF_IMG)),
      modified: firstLiteral(dataset, member, DCT_MODIFIED),
    });
  }

  // Resolve hydra:next via the PartialCollectionView (collection → view → next).
  let next: string | null = null;
  for (const viewQ of matchP(dataset, HYDRA_VIEW)) {
    for (const nextQ of matchSP(dataset, viewQ.object, HYDRA_NEXT)) {
      if (nextQ.object.termType === "NamedNode") {
        next = nextQ.object.value;
        break;
      }
    }
    if (next) break;
  }

  return { entries, next };
}

// ─── The client ──────────────────────────────────────────────────────────────

/** The public consumer-client surface (see {@link createIndexClient}). */
export interface IndexClient {
  /** The configured index origin (no trailing slash). */
  readonly origin: string;
  /** Search the index. Returns the first page; follow `.next` with {@link fetchPage}. */
  search(query: string, opts?: SearchOptions): Promise<IndexPage>;
  /** Follow an opaque `hydra:next` URL verbatim (same-origin enforced). */
  fetchPage(
    nextUrl: string,
    opts?: { signal?: AbortSignal }
  ): Promise<IndexPage>;
  /** True when the WebID is indexed (a `/lookup` 303), false on 404. */
  isIndexed(webid: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
  /** Read the index liveness snapshot. */
  checkHealth(opts?: { signal?: AbortSignal }): Promise<IndexHealth>;
  /** Suggest a WebID via the LDN inbox (AS2 `as:Announce`). */
  suggestWebId(webid: string, opts?: SuggestOptions): Promise<SuggestOutcome>;
}

class IndexClientImpl implements IndexClient {
  readonly origin: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly clientSignal?: AbortSignal;

  constructor(origin: string, opts: IndexClientOptions) {
    this.origin = origin;
    this.doFetch = opts.fetch ?? globalThis.fetch;
    this.clientSignal = opts.signal;
  }

  /** Resolve the effective AbortSignal (per-call overrides the client-level one). */
  private signalFor(callSignal?: AbortSignal): AbortSignal | undefined {
    return callSignal ?? this.clientSignal;
  }

  /**
   * GET an RDF resource and parse it. Reads always omit credentials (public,
   * cross-origin). Throws on a non-2xx status.
   */
  private async getRdf(
    url: string,
    signal?: AbortSignal
  ): Promise<DatasetCore> {
    const res = await this.doFetch(url, {
      method: "GET",
      headers: { Accept: RDF_ACCEPT },
      credentials: "omit",
      // Reads follow the server's own 303/etc; the client never crosses origins
      // (fetchPage enforces same-origin before calling here).
      signal,
    });
    if (!res.ok) {
      throw new Error(`webid-index GET ${url} failed: ${res.status}`);
    }
    const contentType = res.headers.get("Content-Type");
    const body = await res.text();
    return parseRdf(body, contentType, { baseIRI: url });
  }

  async search(query: string, opts?: SearchOptions): Promise<IndexPage> {
    const url = new URL(`${this.origin}/search`);
    url.searchParams.set("q", query);
    if (opts?.limit !== undefined) {
      url.searchParams.set("limit", String(opts.limit));
    }
    const dataset = await this.getRdf(
      url.toString(),
      this.signalFor(opts?.signal)
    );
    return projectCollection(dataset);
  }

  async fetchPage(
    nextUrl: string,
    opts?: { signal?: AbortSignal }
  ): Promise<IndexPage> {
    // Same-origin guard: an opaque hydra:next is followed VERBATIM, but only when
    // it points back at the configured index origin. A malicious next URL pointing
    // at a third-party host (cache-poisoning / open-redirect) is refused — the
    // consuming app never fetches an attacker-chosen origin through this client.
    let parsed: URL;
    try {
      parsed = new URL(nextUrl);
    } catch {
      throw new Error(`webid-index: invalid next URL: ${nextUrl}`);
    }
    if (parsed.origin !== new URL(this.origin).origin) {
      throw new Error(
        `webid-index: refusing cross-origin next URL (${parsed.origin} ≠ ${this.origin})`
      );
    }
    const dataset = await this.getRdf(
      parsed.toString(),
      this.signalFor(opts?.signal)
    );
    return projectCollection(dataset);
  }

  async isIndexed(
    webid: string,
    opts?: { signal?: AbortSignal }
  ): Promise<boolean> {
    const url = new URL(`${this.origin}/lookup`);
    url.searchParams.set("webid", webid);
    // `manual` redirect: a 303 (indexed) must NOT be auto-followed into the entry
    // doc — we only need the existence signal. 303 → indexed; 404 → not; 400 →
    // malformed webid (treated as not-indexed, not an error).
    const res = await this.doFetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      signal: this.signalFor(opts?.signal),
    });
    // The /lookup route's ONLY redirect is a `303` for an indexed WebID (404/400
    // for not-indexed/malformed are non-redirect statuses). So we match the 303
    // EXACTLY, not "any 3xx" — a stray 301/302/307 from middleware, a deployment
    // redirect, or an auth/login bounce must NOT be misread as "indexed".
    //
    // In Node/undici a manual-redirect response carries its real status (303). In a
    // browser, `redirect: "manual"` yields an OPAQUE redirect (status 0, type
    // "opaqueredirect") whose status code is unreadable — but since /lookup only
    // ever redirects with 303, an opaque redirect FROM /lookup is necessarily that
    // 303, so we accept it. Everything else (404, 400, non-3xx, an unexpected 3xx
    // we can read and isn't 303) is "not indexed".
    if (res.type === "opaqueredirect") return true;
    return res.status === 303;
  }

  async checkHealth(opts?: { signal?: AbortSignal }): Promise<IndexHealth> {
    const res = await this.doFetch(`${this.origin}/.well-known/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      signal: this.signalFor(opts?.signal),
    });
    if (!res.ok) {
      throw new Error(`webid-index health check failed: ${res.status}`);
    }
    const body = (await res.json()) as Partial<IndexHealth>;
    return {
      status: body.status === "ok" ? "ok" : "degraded",
      entries: typeof body.entries === "number" ? body.entries : 0,
      triples: typeof body.triples === "number" ? body.triples : 0,
      queueDepth: typeof body.queueDepth === "number" ? body.queueDepth : 0,
      version: typeof body.version === "string" ? body.version : "unknown",
    };
  }

  async suggestWebId(
    webid: string,
    opts?: SuggestOptions
  ): Promise<SuggestOutcome> {
    // Validate the WebID shape client-side (https IRI) before any network call —
    // a non-https / unparseable value is rejected without a wasted round-trip.
    let canonical: string;
    try {
      const u = new URL(webid);
      if (u.protocol !== "https:") return "invalid";
      canonical = u.toString();
    } catch {
      return "invalid";
    }

    // Build the AS2 Announce as a JSON-LD object (canonical JSON-LD form, NOT a
    // hand-built triple string). `as:object` carries the candidate WebID; an
    // optional `actor` records provenance.
    const activity: Record<string, unknown> = {
      "@context": AS2_CONTEXT_IRI,
      type: "Announce",
      object: canonical,
    };
    if (opts?.actor) {
      activity.actor = opts.actor;
    }

    let res: Response;
    try {
      res = await this.doFetch(`${this.origin}/inbox/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/ld+json",
          Accept: "application/ld+json",
        },
        body: JSON.stringify(activity),
        // NEVER credentialed: the user's auth must not be attached to the
        // third-party index origin (§7 security note). CORS mode is implied.
        credentials: "omit",
        signal: this.signalFor(opts?.signal),
      });
    } catch {
      // Network failure / abort → transient, the caller may retry.
      return "error";
    }

    return mapSuggestStatus(res.status);
  }
}

/** Map an inbox POST HTTP status to a {@link SuggestOutcome} (DESIGN.md §4.3 table). */
function mapSuggestStatus(status: number): SuggestOutcome {
  if (status === 201 || status === 202) return "submitted";
  if (status === 200 || status === 409) return "already-indexed";
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 415 || status === 422) return "invalid";
  if (status === 413) return "invalid"; // body too large (shouldn't happen for our small body)
  return "error"; // 5xx and anything unexpected — transient
}

/**
 * Create a WebID-index consumer client, or `null` when no origin is configured.
 *
 * Returning `null` for an empty origin lets a consuming app gate the entire
 * integration on a single env var (DESIGN.md §7): `const idx = createIndexClient({
 * origin: process.env.NEXT_PUBLIC_WEBID_INDEX ?? "" })` — `idx === null` means the
 * whole feature is inert (no nav, no panels).
 *
 * @param opts.origin  the index origin; empty/whitespace ⇒ `null` (inert).
 * @param opts.fetch   injectable fetch impl (defaults to global); tests stub it.
 * @param opts.signal  client-level AbortSignal forwarded to every request.
 */
export function createIndexClient(
  opts: IndexClientOptions
): IndexClient | null {
  const origin = (opts.origin ?? "").trim().replace(/\/+$/, "");
  if (!origin) return null;
  // Validate the origin is a parseable absolute URL — a bad value is a config
  // error, surfaced loudly here rather than as a confusing fetch failure later.
  if (URL.canParse(origin) === false) {
    throw new Error(`createIndexClient: invalid origin: ${opts.origin}`);
  }
  return new IndexClientImpl(origin, opts);
}
