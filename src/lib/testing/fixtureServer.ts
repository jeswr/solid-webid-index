// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/testing/fixtureServer.ts — the shared, offline HTTP FIXTURE SERVER for the conformance +
 * security suites (pss-q2h).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY test that needs to dereference a URL MUST point at THIS server, never the public internet.
 * It binds an EPHEMERAL port on 127.0.0.1, so a crawl/inbox/SSRF/conneg test runs FULLY OFFLINE: the
 * crawler reaches it only with `allowLoopback: true` (the documented TEST-ONLY hook), and the SSRF
 * guard has already constrained the resolved address to loopback. The server serves CANNED responses
 * registered per-test: Turtle / JSON-LD WebID profiles, 30x redirect chains (including
 * redirect-to-private), 304 conditional, 410 gone, oversized bodies (over the fetch byte cap), parser
 * bombs (deeply-nested JSON-LD / huge Turtle), RDFa-in-HTML (to assert the crawler REJECTS it rather
 * than parsing RDFa), and hostile `foaf:knows` fan-outs (a profile linking thousands of WebIDs).
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Design:
 *  - ONE Node `http.Server` per test FILE (cheap; started in beforeAll, closed in afterAll via the
 *    returned handle). Routes are registered per-test and cleared between tests with `reset()`.
 *  - A route is keyed on the fragment-stripped PATH (the crawler keys the frontier on the
 *    fragment-stripped URL, and the server never sees the fragment anyway).
 *  - Convenience builders (`serveProfile`, `serveJsonLdProfile`, `serveRedirect`, `serveStatus`,
 *    `serveOversized`, `serveJsonLdBomb`, `serveTurtleBomb`, `serveRdfaHtml`, `serveFanout`) cover
 *    the canonical vectors so individual tests stay declarative.
 *  - `request.url` / `webid` / `doc` helpers derive the loopback URLs from the bound base.
 *
 * This module is TEST-ONLY infrastructure (under `src/lib/testing/`). It is never imported by route
 * or library code, so it adds nothing to the production bundle graph. `check:fetch` exempts test
 * files and this helper deals only in the FIXTURE side (the SERVER), never an outbound `fetch` of an
 * attacker URL — so it does not weaken the single-egress-chokepoint invariant.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

// ─── Route table ────────────────────────────────────────────────────────────────

/** A registered route handler — full control over the Node response. */
export type FixtureRoute = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => void;

/** The standard vocab IRIs the profile builders use (kept here so callers need not re-declare them). */
export const FOAF = "http://xmlns.com/foaf/0.1/";
export const SOLID = "http://www.w3.org/ns/solid/terms#";

/**
 * A running fixture server handle. Hold one per test file; `reset()` between tests; `close()` in
 * afterAll. Every URL it serves is on 127.0.0.1, so the whole suite is offline.
 */
export interface FixtureServer {
  /** Base origin, e.g. `http://127.0.0.1:54321` (no trailing slash). */
  readonly base: string;
  /** The bound port. */
  readonly port: number;
  /** The bound hostname — always `127.0.0.1`. */
  readonly host: "127.0.0.1";

  /** Register (or replace) a raw route handler for a path (must start with `/`). */
  route(path: string, handler: FixtureRoute): void;
  /** Clear every registered route + the per-host request counters (call in `beforeEach`). */
  reset(): void;
  /** Stop the server (call in `afterAll`). */
  close(): Promise<void>;

  // ── URL helpers ──────────────────────────────────────────────────────────────
  /** The absolute URL for a fixture path (fragment-stripped — the frontier key). */
  doc(path: string): string;
  /** The WebID (`…#me` by convention) for a fixture path. */
  webid(path: string, fragment?: string): string;

  // ── Canned-response builders (return the WebID / doc they registered) ──────────

  /**
   * Serve a Turtle WebID profile whose subject is `${base}${path}#me` (or `subject` when given).
   * Supports `knows` (foaf:knows fan-out), `solid` (whether to emit solid:oidcIssuer → isSolid),
   * conditional re-validation (`etag` returns 304 on a matching If-None-Match), and arbitrary
   * `extraHeaders` (e.g. `x-robots-tag: noindex`). Returns the subject WebID IRI.
   */
  serveProfile(path: string, opts?: ProfileOpts): string;

  /**
   * Serve a JSON-LD WebID profile (content-type application/ld+json) — proves the conneg / parser
   * path handles JSON-LD bodies. Same options as {@link serveProfile}. Returns the subject WebID.
   */
  serveJsonLdProfile(path: string, opts?: ProfileOpts): string;

  /** Serve a 3xx redirect from `path` to `location` (absolute or relative). Default 302. */
  serveRedirect(path: string, location: string, status?: number): void;

  /**
   * Serve a redirect CHAIN of `hops` same-host bounces that finally lands on a served Turtle profile.
   * Returns the final profile's WebID. Use to test the redirect cap + the cheap-path on a real chain.
   */
  serveRedirectChain(path: string, hops: number): string;

  /** Serve a bare status with a `text/plain` body (e.g. 410 Gone, 503, 429). */
  serveStatus(path: string, status: number, body?: string): void;

  /**
   * Serve a Turtle body LARGER than `bytes` (default just over 256 KiB, the profile cap) with a valid
   * RDF content-type — to assert the guarded fetch aborts past the byte cap (BodyTooLargeError).
   */
  serveOversized(path: string, bytes?: number): void;

  /**
   * Serve a JSON-LD PARSER BOMB: a body whose nesting depth (default) or node count vastly exceeds the
   * parse caps, with a `application/ld+json` content-type — to assert the parser rejects it
   * (ParseLimitError) without stack-overflowing or OOMing. `kind` selects "depth" or "nodes".
   */
  serveJsonLdBomb(path: string, kind?: "depth" | "nodes"): void;

  /**
   * Serve a Turtle PARSER BOMB: a body with far more than MAX_QUADS triples, valid Turtle, to assert
   * the streaming quad cap fires (ParseLimitError).
   */
  serveTurtleBomb(path: string, triples?: number): void;

  /**
   * Serve an HTML document carrying RDFa markup with content-type `text/html` — to assert the crawler
   * REJECTS it on the content-type allowlist (RDFa is NOT parsed; DESIGN.md §5 step 9).
   */
  serveRdfaHtml(path: string): void;

  /**
   * Serve a profile that `knows` a LARGE number of distinct served children (hostile fan-out) so the
   * anti-amplification budget is exercised. Each child is a served Solid profile with no further
   * knows. Returns the parent WebID + the array of child WebIDs.
   */
  serveFanout(
    path: string,
    childCount: number
  ): { parent: string; children: string[] };

  /** How many GET requests this server has received for a given fragment-stripped path. */
  hitCount(path: string): number;
}

/** Options shared by the Turtle / JSON-LD profile builders. */
export interface ProfileOpts {
  /** Display name (foaf:name). Defaults to the path. */
  name?: string;
  /** foaf:knows targets (absolute WebID IRIs). */
  knows?: string[];
  /** Whether to emit a solid:oidcIssuer (→ isSolid true). Default true. */
  solid?: boolean;
  /** An explicit subject IRI (overrides the `${base}${path}#me` convention). */
  subject?: string;
  /** A strong ETag; a matching If-None-Match returns 304. */
  etag?: string;
  /** Extra response headers merged over the defaults (e.g. `x-robots-tag`). */
  extraHeaders?: Record<string, string>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Start a fixture server on an ephemeral 127.0.0.1 port. Resolves once it is listening, so a caller
 * can `const fx = await startFixtureServer()` in `beforeAll` and use `fx.base` immediately.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const routes = new Map<string, FixtureRoute>();
  const hits = new Map<string, number>();

  const server = http.createServer((req, res) => {
    // The crawler/guard strip the fragment before requesting, and HTTP never carries it, but split
    // defensively. The query string is also stripped for the route key (fixtures key on the path).
    const rawPath = (req.url ?? "").split("#")[0].split("?")[0];
    hits.set(rawPath, (hits.get(rawPath) ?? 0) + 1);
    const handler = routes.get(rawPath);
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const base = `http://127.0.0.1:${port}`;

  const doc = (path: string): string => `${base}${path}`;
  const webid = (path: string, fragment = "me"): string =>
    `${base}${path}#${fragment}`;

  function turtleProfile(subject: string, opts: ProfileOpts): string {
    const knowsTtl =
      opts.knows && opts.knows.length > 0
        ? `; foaf:knows ${opts.knows.map((k) => `<${k}>`).join(", ")} `
        : "";
    const oidc =
      opts.solid !== false ? "; solid:oidcIssuer <https://idp.example> " : "";
    return `@prefix foaf: <${FOAF}> .
@prefix solid: <${SOLID}> .
<${subject}> a foaf:Person ; foaf:name "${opts.name ?? subject}" ${oidc}${knowsTtl}.
`;
  }

  function jsonLdProfile(subject: string, opts: ProfileOpts): string {
    const node: Record<string, unknown> = {
      "@id": subject,
      "@type": "foaf:Person",
      "foaf:name": opts.name ?? subject,
    };
    if (opts.solid !== false) {
      node["solid:oidcIssuer"] = { "@id": "https://idp.example" };
    }
    if (opts.knows && opts.knows.length > 0) {
      node["foaf:knows"] = opts.knows.map((k) => ({ "@id": k }));
    }
    return JSON.stringify({
      "@context": { foaf: FOAF, solid: SOLID },
      ...node,
    });
  }

  function registerProfile(
    path: string,
    contentType: string,
    body: string,
    opts: ProfileOpts
  ): void {
    routes.set(path, (req, res) => {
      if (opts.etag && req.headers["if-none-match"] === opts.etag) {
        res.writeHead(304, { "content-type": contentType, etag: opts.etag });
        res.end();
        return;
      }
      const headers: Record<string, string> = {
        "content-type": contentType,
        ...(opts.etag ? { etag: opts.etag } : {}),
        ...(opts.extraHeaders ?? {}),
      };
      res.writeHead(200, headers);
      res.end(body);
    });
  }

  const fx: FixtureServer = {
    base,
    port,
    host: "127.0.0.1",

    route(path, handler) {
      routes.set(path, handler);
    },
    reset() {
      routes.clear();
      hits.clear();
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },

    doc,
    webid,

    serveProfile(path, opts = {}) {
      const subject = opts.subject ?? webid(path);
      registerProfile(path, "text/turtle", turtleProfile(subject, opts), opts);
      return subject;
    },

    serveJsonLdProfile(path, opts = {}) {
      const subject = opts.subject ?? webid(path);
      registerProfile(
        path,
        "application/ld+json",
        jsonLdProfile(subject, opts),
        opts
      );
      return subject;
    },

    serveRedirect(path, location, status = 302) {
      routes.set(path, (_req, res) => {
        res.writeHead(status, { location });
        res.end();
      });
    },

    serveRedirectChain(path, hops) {
      // Build `hops` same-host 302 bounces /path0 → /path1 → … → /pathN (a served profile).
      for (let i = 0; i < hops; i += 1) {
        const here = i === 0 ? path : `${path}-h${i}`;
        const next = `${path}-h${i + 1}`;
        fx.serveRedirect(here, `${base}${next}`);
      }
      const finalPath = `${path}-h${hops}`;
      return fx.serveProfile(finalPath, {});
    },

    serveStatus(path, status, body) {
      routes.set(path, (_req, res) => {
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(body ?? `status ${status}`);
      });
    },

    serveOversized(path, bytes = 256 * 1024 + 4096) {
      routes.set(path, (_req, res) => {
        // A valid RDF content-type so the body cap (not the content-type allowlist) is the gate; no
        // content-length so the guard's STREAMING byte check is what aborts.
        res.writeHead(200, { "content-type": "text/turtle" });
        // A long Turtle comment line is valid Turtle but trivially over the cap.
        res.end(`# ${"x".repeat(bytes)}\n`);
      });
    },

    serveJsonLdBomb(path, kind = "depth") {
      routes.set(path, (_req, res) => {
        res.writeHead(200, { "content-type": "application/ld+json" });
        res.end(kind === "depth" ? deepJsonLd(2_000) : wideJsonLd(50_000));
      });
    },

    serveTurtleBomb(path, triples = 200_000) {
      routes.set(path, (_req, res) => {
        res.writeHead(200, { "content-type": "text/turtle" });
        // Stream so we never build the whole giant string in memory at once.
        res.write("@prefix ex: <http://example.org/> .\n");
        const subject = webid(path);
        for (let i = 0; i < triples; i += 1) {
          res.write(`<${subject}> ex:p${i} "v${i}" .\n`);
        }
        res.end();
      });
    },

    serveRdfaHtml(path) {
      const subject = webid(path);
      routes.set(path, (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        // A valid RDFa document — the crawler must NOT parse this; it must be rejected on the
        // content-type allowlist (text/html is excluded).
        res.end(
          `<!DOCTYPE html><html><head><title>x</title></head>
<body vocab="${FOAF}" resource="${subject}" typeof="Person">
  <span property="name">RDFa Person</span>
</body></html>`
        );
      });
    },

    serveFanout(path, childCount) {
      const children: string[] = [];
      for (let i = 0; i < childCount; i += 1) {
        const childPath = `${path}-c${i}`;
        fx.serveProfile(childPath, {});
        children.push(webid(childPath));
      }
      const parent = fx.serveProfile(path, { knows: children });
      return { parent, children };
    },

    hitCount(path) {
      return hits.get(path) ?? 0;
    },
  };

  return fx;
}

// ─── Parser-bomb body generators ──────────────────────────────────────────────

/** A deeply-NESTED JSON-LD body (`{"@graph":[{"@graph":[…]}]}`) `depth` levels deep. */
function deepJsonLd(depth: number): string {
  // Build from the inside out so we never recurse: an explicit string concatenation.
  let inner = '{"@id":"https://x.example/leaf#me"}';
  for (let i = 0; i < depth; i += 1) {
    inner = `{"@graph":[${inner}]}`;
  }
  return `{"@context":{"foaf":"${FOAF}"},"@graph":[${inner}]}`;
}

/** A WIDE JSON-LD body — one subject with `nodes` distinct nested object nodes (huge node count). */
function wideJsonLd(nodes: number): string {
  const parts: string[] = [];
  for (let i = 0; i < nodes; i += 1) {
    parts.push(`{"@id":"https://x.example/n${i}#me","foaf:name":"n${i}"}`);
  }
  return `{"@context":{"foaf":"${FOAF}"},"@graph":[${parts.join(",")}]}`;
}
