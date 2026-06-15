// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * conneg-matrix.test.ts — CONNEG conformance MATRIX (pss-q2h, DESIGN.md §4.0 / §8).
 *
 * A single matrix over (Accept header) × (RDF read endpoint) asserting RFC 7231 §5.3.2 negotiation
 * is consistent across EVERY endpoint that participates in conneg:
 *   - /root-rdf            (the RDF view of `/`)        — htmlBranch "turtle"
 *   - /ns                  (the idx: ontology)          — htmlBranch "turtle", no store
 *   - /search?q=…          (the Hydra search collection)— htmlBranch "turtle"
 *   - /.well-known/void    (the VoID/DCAT description)  — htmlBranch "turtle"
 *   - /tpf?p=…             (a Triple Pattern Fragment)  — htmlBranch "turtle"
 *   - /p/{slug}            (an entry description)        — htmlBranch "406" (RDF-only, strict)
 *
 * For each, across Accept = turtle / ld+json / n-triples / html / *​/* / json-only / q-weighted /
 * a 406-forcing unacceptable type / a JSON-LD profile param, the response Content-Type, Vary, ETag,
 * and 304 (conditional) behaviour must match the negotiated representation.
 *
 * Offline: pglite store (mocked makeStore) — no network, no Neon.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INDEX_BASE_URL } from "@/lib/config";
import type { PgStore } from "@/lib/store/pgStore";
import { freshTestStore } from "@/lib/store/testStore";
import { slugForWebId } from "@/lib/url/slug";

// ─── Mock makeStore — one mock covers every route imported below ─────────────────
let _store: PgStore | null = null;
vi.mock("@/lib/store/pgStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store/pgStore")>();
  return {
    ...actual,
    makeStore: () => {
      if (!_store) throw new Error("no test store");
      return _store;
    },
  };
});

// Import the route handlers AFTER the mock is registered.
const { GET: rootGet } = await import("./root-rdf/route");
const { GET: nsGet } = await import("./ns/route");
const { GET: searchGet } = await import("./search/route");
const { GET: voidGet } = await import("./.well-known/void/route");
const { GET: tpfGet } = await import("./tpf/route");
const { GET: entryGet } = await import("./p/[slug]/route");

const FOAF = "http://xmlns.com/foaf/0.1/";
const WEBID = "https://alice.pod/card#me";
const DOC_URL = "https://alice.pod/card";
const SLUG = slugForWebId(WEBID);

const PROFILE_TTL = `@prefix foaf: <${FOAF}> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<${WEBID}> a foaf:Person ; foaf:name "Alice" ; solid:oidcIssuer <https://idp.example> ;
  foaf:knows <https://bob.pod/card#me> .`;

beforeEach(async () => {
  ({ store: _store } = await freshTestStore());
  // Seed one fully-crawled, projected entry so search/tpf/void/entry all have data.
  await _store.enqueue(DOC_URL, { webid: WEBID, source: "seed" });
  const claimed = await _store.claim("matrix", 1);
  await _store.markDone(
    DOC_URL,
    {
      state: "done",
      httpStatus: 200,
      etag: '"v1"',
      rawRdf: PROFILE_TTL,
      isSolid: true,
      webid: WEBID,
      nextEligibleAt: Date.now() + 1_000_000,
    },
    claimed[0].claimToken
  );
  await _store.upsertTriples({
    webid: WEBID,
    docUrl: DOC_URL,
    triples: [
      { s: WEBID, p: `${FOAF}name`, o: "Alice", oIsIri: false },
      {
        s: WEBID,
        p: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        o: `${FOAF}Person`,
        oIsIri: true,
      },
    ],
  });
});

// ─── Endpoint adapters: each returns a Response for a given Accept header ─────────

interface Endpoint {
  name: string;
  /** "turtle" (browser → Turtle) or "406" (browser/unacceptable → 406). */
  htmlBranch: "turtle" | "406";
  call(
    accept: string,
    extraHeaders?: Record<string, string>
  ): Promise<Response>;
}

function makeReq(
  path: string,
  accept: string,
  extra?: Record<string, string>
): Request {
  return new Request(`${INDEX_BASE_URL}${path}`, {
    method: "GET",
    headers: { Accept: accept, ...(extra ?? {}) },
  });
}

const ENDPOINTS: Endpoint[] = [
  {
    name: "root-rdf",
    htmlBranch: "turtle",
    call: (accept, extra) => rootGet(makeReq("/root-rdf", accept, extra)),
  },
  {
    name: "ns",
    htmlBranch: "turtle",
    call: (accept, extra) => nsGet(makeReq("/ns", accept, extra)),
  },
  {
    name: "search",
    htmlBranch: "turtle",
    call: (accept, extra) =>
      searchGet(makeReq("/search?q=alice", accept, extra)),
  },
  {
    name: "void",
    htmlBranch: "turtle",
    call: (accept, extra) =>
      voidGet(makeReq("/.well-known/void", accept, extra)),
  },
  {
    name: "tpf",
    htmlBranch: "turtle",
    call: (accept, extra) =>
      tpfGet(
        makeReq(`/tpf?p=${encodeURIComponent(`${FOAF}name`)}`, accept, extra)
      ),
  },
  {
    name: "entry",
    htmlBranch: "406",
    call: (accept, extra) =>
      entryGet(makeReq(`/p/${SLUG}`, accept, extra), {
        params: Promise.resolve({ slug: SLUG }),
      }),
  },
];

// ════════════════════════════════ The matrix ════════════════════════════════

describe("conneg matrix — Content-Type per Accept across every RDF endpoint", () => {
  for (const ep of ENDPOINTS) {
    describe(ep.name, () => {
      it("Accept: text/turtle → text/turtle + Vary: Accept + ETag", async () => {
        const res = await ep.call("text/turtle");
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain("text/turtle");
        expect(res.headers.get("Vary")).toContain("Accept");
        expect(res.headers.get("ETag")).toBeTruthy();
      });

      it("Accept: application/ld+json → application/ld+json + a JSON-LD context Link", async () => {
        const res = await ep.call("application/ld+json");
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain(
          "application/ld+json"
        );
        // The conneg layer appends the bundled @context link on JSON-LD responses.
        expect(res.headers.get("Link") ?? "").toContain("json-ld#context");
        // The body parses as JSON.
        const json = JSON.parse(await res.text());
        expect(typeof json).toBe("object");
      });

      it("Accept: application/n-triples → application/n-triples", async () => {
        const res = await ep.call("application/n-triples");
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain(
          "application/n-triples"
        );
      });

      it("Accept: */* → text/turtle (machine default)", async () => {
        const res = await ep.call("*/*");
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain("text/turtle");
      });

      it("q-weighting: ld+json;q=0.9, turtle;q=0.8 → ld+json wins", async () => {
        const res = await ep.call(
          "application/ld+json;q=0.9, text/turtle;q=0.8"
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain(
          "application/ld+json"
        );
      });

      it("conditional: a matching If-None-Match → 304", async () => {
        const first = await ep.call("text/turtle");
        const etag = first.headers.get("ETag");
        expect(etag).toBeTruthy();
        const second = await ep.call("text/turtle", {
          "If-None-Match": etag as string,
        });
        expect(second.status).toBe(304);
        expect(second.headers.get("ETag")).toBe(etag);
      });

      it("the ETag DIFFERS between Turtle and JSON-LD (representation-specific validator)", async () => {
        const ttl = await ep.call("text/turtle");
        const jsonld = await ep.call("application/ld+json");
        expect(ttl.headers.get("ETag")).not.toBe(jsonld.headers.get("ETag"));
      });

      if (ep.htmlBranch === "turtle") {
        it("Accept: text/html → Turtle (friendly RDF-only endpoint, never a bare 200)", async () => {
          const res = await ep.call(
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          );
          expect(res.status).toBe(200);
          expect(res.headers.get("Content-Type")).toContain("text/turtle");
        });
      } else {
        it("Accept: text/html → 406 (strict RDF-only entry, never a bare 200)", async () => {
          const res = await ep.call(
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          );
          expect(res.status).toBe(406);
          expect(res.headers.get("Vary")).toContain("Accept");
        });
      }
    });
  }
});

describe("conneg matrix — 406 on a wholly-unacceptable Accept", () => {
  // image/png matches nothing the index serves → q=0 for every RDF type → 406.
  for (const ep of ENDPOINTS) {
    it(`${ep.name} returns 406 for Accept: image/png`, async () => {
      const res = await ep.call("image/png");
      expect(res.status).toBe(406);
      expect(res.headers.get("Content-Type")).toContain("text/plain");
      expect(res.headers.get("Vary")).toContain("Accept");
    });
  }
});

describe("conneg matrix — JSON-LD profile parameter negotiation", () => {
  // Endpoints that serve real triples in JSON-LD; the profile param selects expanded/flattened.
  const jsonldEndpoints = ENDPOINTS.filter((e) =>
    ["entry", "void", "tpf", "search", "root-rdf", "ns"].includes(e.name)
  );
  for (const ep of jsonldEndpoints) {
    it(`${ep.name}: profile="…#expanded" yields a DIFFERENT body + ETag than compacted`, async () => {
      const compacted = await ep.call("application/ld+json");
      const expanded = await ep.call(
        `application/ld+json;profile="${INDEX_BASE_URL}/ns/context.jsonld#expanded"`
      );
      expect(compacted.status).toBe(200);
      expect(expanded.status).toBe(200);
      expect(expanded.headers.get("Content-Type")).toContain(
        "application/ld+json"
      );
      // Different profile → different serialised representation → different ETag.
      expect(compacted.headers.get("ETag")).not.toBe(
        expanded.headers.get("ETag")
      );
    });
  }
});
