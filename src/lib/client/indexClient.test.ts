// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * indexClient.test.ts — tests for the framework-agnostic consumer client (DESIGN.md §7).
 *
 * NO network: every test injects a stub `fetch` that returns canned RDF / status
 * codes. The search-projection tests serialise REAL Hydra collection RDF via the
 * server's own conneg serialiser (serializeTurtle / serializeJsonLdCompacted) so
 * the client is exercised against the exact wire format the `/search` route emits —
 * Turtle AND compacted JSON-LD round-trip through the same client parser.
 */

import type { Quad } from "@rdfjs/types";
import { DataFactory } from "n3";
import { describe, expect, it, vi } from "vitest";

import { serializeJsonLdCompacted, serializeTurtle } from "@/lib/http/conneg";
import { createIndexClient } from "./indexClient";

const { namedNode, literal, quad: q } = DataFactory;

const HYDRA = "http://www.w3.org/ns/hydra/core#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const DCT = "http://purl.org/dc/terms/";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const ORIGIN = "https://idx.example";

/** Build a Hydra search-collection quad graph (the shape /search emits — DESIGN.md §4.4). */
function buildSearchQuads(opts: {
  members: Array<{
    webid: string;
    name?: string;
    img?: string;
    modified?: string;
  }>;
  nextCursor?: string;
}): Quad[] {
  const collection = namedNode(`${ORIGIN}/search`);
  const view = namedNode(`${ORIGIN}/search?q=x`);
  const quads: Quad[] = [];

  quads.push(
    q(collection, namedNode(`${RDF}type`), namedNode(`${HYDRA}Collection`))
  );
  quads.push(q(collection, namedNode(`${HYDRA}view`), view));
  quads.push(
    q(view, namedNode(`${RDF}type`), namedNode(`${HYDRA}PartialCollectionView`))
  );
  if (opts.nextCursor) {
    quads.push(
      q(
        view,
        namedNode(`${HYDRA}next`),
        namedNode(`${ORIGIN}/search?q=x&cursor=${opts.nextCursor}`)
      )
    );
  }

  for (const m of opts.members) {
    const mn = namedNode(m.webid);
    quads.push(q(collection, namedNode(`${HYDRA}member`), mn));
    quads.push(q(mn, namedNode(`${RDF}type`), namedNode(`${FOAF}Person`)));
    if (m.name) quads.push(q(mn, namedNode(`${FOAF}name`), literal(m.name)));
    if (m.img) quads.push(q(mn, namedNode(`${FOAF}img`), namedNode(m.img)));
    if (m.modified) {
      quads.push(
        q(
          mn,
          namedNode(`${DCT}modified`),
          literal(m.modified, namedNode(`${XSD}dateTime`))
        )
      );
    }
  }
  return quads;
}

/** A stub fetch that returns Turtle (or a given content-type body) with 200. */
function rdfFetch(
  body: string,
  contentType = "text/turtle"
): typeof globalThis.fetch {
  return vi.fn(
    async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": contentType },
      })
  ) as unknown as typeof globalThis.fetch;
}

// ─── Factory / inert behaviour ──────────────────────────────────────────────

describe("createIndexClient", () => {
  it("returns null for an empty origin (integration inert)", () => {
    expect(createIndexClient({ origin: "" })).toBeNull();
    expect(createIndexClient({ origin: "   " })).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: testing undefined origin
    expect(createIndexClient({ origin: undefined as any })).toBeNull();
  });

  it("strips a trailing slash from the origin", () => {
    const c = createIndexClient({ origin: `${ORIGIN}/` });
    expect(c?.origin).toBe(ORIGIN);
  });

  it("throws on a non-URL origin", () => {
    expect(() => createIndexClient({ origin: "not a url" })).toThrow(
      /invalid origin/
    );
  });
});

// ─── search + projection ─────────────────────────────────────────────────────

describe("IndexClient.search", () => {
  it("projects a Hydra collection (Turtle) into UI entries + next cursor", async () => {
    const quads = buildSearchQuads({
      members: [
        {
          webid: "https://alice.pod/card#me",
          name: "Alice",
          img: "https://alice.pod/me.png",
          modified: "2026-06-10T00:00:00.000Z",
        },
        { webid: "https://bob.pod/card#me", name: "Bob" },
      ],
      nextCursor: "CUR123",
    });
    const ttl = await serializeTurtle(quads);
    const fetchStub = rdfFetch(ttl);

    const client = createIndexClient({ origin: ORIGIN, fetch: fetchStub });
    expect(client).not.toBeNull();
    const page = await client?.search("alice");

    expect(page?.entries).toHaveLength(2);
    const alice = page?.entries.find(
      (e) => e.webid === "https://alice.pod/card#me"
    );
    expect(alice?.name).toBe("Alice");
    expect(alice?.photoUrl).toBe("https://alice.pod/me.png");
    expect(alice?.modified).toBe("2026-06-10T00:00:00.000Z");

    const bob = page?.entries.find(
      (e) => e.webid === "https://bob.pod/card#me"
    );
    expect(bob?.name).toBe("Bob");
    expect(bob?.photoUrl).toBeNull();
    expect(bob?.modified).toBeNull();

    expect(page?.next).toBe(`${ORIGIN}/search?q=x&cursor=CUR123`);
  });

  it("projects the same collection serialised as compacted JSON-LD", async () => {
    const quads = buildSearchQuads({
      members: [{ webid: "https://carol.pod/card#me", name: "Carol" }],
    });
    const jsonld = await serializeJsonLdCompacted(quads);
    const fetchStub = rdfFetch(jsonld, "application/ld+json");

    const client = createIndexClient({ origin: ORIGIN, fetch: fetchStub });
    const page = await client?.search("carol");

    expect(page?.entries).toHaveLength(1);
    expect(page?.entries[0].webid).toBe("https://carol.pod/card#me");
    expect(page?.entries[0].name).toBe("Carol");
    expect(page?.next).toBeNull();
  });

  it("returns an empty page (no next) for an empty collection", async () => {
    const ttl = await serializeTurtle(buildSearchQuads({ members: [] }));
    const client = createIndexClient({ origin: ORIGIN, fetch: rdfFetch(ttl) });
    const page = await client?.search("nobody");
    expect(page?.entries).toEqual([]);
    expect(page?.next).toBeNull();
  });

  it("sends q + limit query params and a credentials-omitting GET", async () => {
    const ttl = await serializeTurtle(buildSearchQuads({ members: [] }));
    const fetchStub = vi.fn(async (url: unknown, init: unknown) => {
      const u = new URL(String(url));
      expect(u.pathname).toBe("/search");
      expect(u.searchParams.get("q")).toBe("alice smith");
      expect(u.searchParams.get("limit")).toBe("5");
      expect((init as RequestInit).credentials).toBe("omit");
      return new Response(ttl, {
        status: 200,
        headers: { "Content-Type": "text/turtle" },
      });
    });
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: fetchStub as unknown as typeof globalThis.fetch,
    });
    await client?.search("alice smith", { limit: 5 });
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it("rejects a non-https photo URL (javascript:/data:) → null", async () => {
    const quads = buildSearchQuads({
      members: [{ webid: "https://mallory.pod/card#me", name: "Mallory" }],
    });
    // Inject a hostile foaf:img by hand (a non-https IRI).
    quads.push(
      q(
        namedNode("https://mallory.pod/card#me"),
        namedNode(`${FOAF}img`),
        namedNode("http://mallory.pod/insecure.png")
      )
    );
    const ttl = await serializeTurtle(quads);
    const client = createIndexClient({ origin: ORIGIN, fetch: rdfFetch(ttl) });
    const page = await client?.search("mallory");
    expect(page?.entries[0].photoUrl).toBeNull();
  });

  it("throws on a non-2xx search response", async () => {
    const fetchStub = vi.fn(
      async () => new Response("boom", { status: 500 })
    ) as unknown as typeof globalThis.fetch;
    const client = createIndexClient({ origin: ORIGIN, fetch: fetchStub });
    await expect(client?.search("x")).rejects.toThrow(/failed: 500/);
  });
});

// ─── fetchPage same-origin guard ──────────────────────────────────────────────

describe("IndexClient.fetchPage", () => {
  it("follows a same-origin opaque next URL verbatim", async () => {
    const ttl = await serializeTurtle(
      buildSearchQuads({ members: [{ webid: "https://d.pod/card#me" }] })
    );
    const fetchStub = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe(`${ORIGIN}/search?q=x&cursor=ABC`);
      return new Response(ttl, {
        status: 200,
        headers: { "Content-Type": "text/turtle" },
      });
    });
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: fetchStub as unknown as typeof globalThis.fetch,
    });
    const page = await client?.fetchPage(`${ORIGIN}/search?q=x&cursor=ABC`);
    expect(page?.entries[0].webid).toBe("https://d.pod/card#me");
  });

  it("REFUSES a cross-origin next URL (no fetch issued)", async () => {
    const fetchStub = vi.fn();
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: fetchStub as unknown as typeof globalThis.fetch,
    });
    await expect(
      client?.fetchPage("https://evil.example/search?cursor=ABC")
    ).rejects.toThrow(/cross-origin/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("throws on a malformed next URL", async () => {
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });
    await expect(client?.fetchPage("::::")).rejects.toThrow(/invalid next URL/);
  });
});

// ─── isIndexed ────────────────────────────────────────────────────────────────

describe("IndexClient.isIndexed", () => {
  /**
   * Build a fetch stub that mimics `redirect: "follow"` resolving to a FINAL
   * response with the given status + final URL (the client reads res.ok +
   * res.url, never the redirect status itself — that's the roborev hardening).
   */
  function followFetch(
    status: number,
    finalUrl: string
  ): typeof globalThis.fetch {
    return vi.fn(async (_url: unknown, init: unknown) => {
      expect((init as RequestInit).redirect).toBe("follow");
      expect((init as RequestInit).credentials).toBe("omit");
      const r = new Response(null, { status });
      Object.defineProperty(r, "url", { value: finalUrl });
      return r;
    }) as unknown as typeof globalThis.fetch;
  }

  it("true when /lookup follows to a 200 /p/{slug} entry doc", async () => {
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: followFetch(200, `${ORIGIN}/p/abc123`),
    });
    expect(await client?.isIndexed("https://a.pod/card#me")).toBe(true);
  });

  it("false on a 404 (not indexed — /lookup did not redirect)", async () => {
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: followFetch(404, `${ORIGIN}/lookup?webid=x`),
    });
    expect(await client?.isIndexed("https://a.pod/card#me")).toBe(false);
  });

  it("false on a 410 (followed to /p/{slug} but the entry is tombstoned)", async () => {
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: followFetch(410, `${ORIGIN}/p/abc123`),
    });
    expect(await client?.isIndexed("https://a.pod/card#me")).toBe(false);
  });

  it("false when a spurious redirect resolves to a 200 NOT under /p/", async () => {
    // A middleware/auth bounce landing on a 200 login page must NOT be misread as
    // indexed — the final URL is not an /p/ entry doc (roborev Medium follow-up).
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: followFetch(200, `${ORIGIN}/login`),
    });
    expect(await client?.isIndexed("https://a.pod/card#me")).toBe(false);
  });

  it("false when a redirect resolves to a 200 on a DIFFERENT origin", async () => {
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: followFetch(200, "https://evil.example/p/abc123"),
    });
    expect(await client?.isIndexed("https://a.pod/card#me")).toBe(false);
  });

  it("false on a 400 (malformed webid, treated as not-indexed)", async () => {
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: followFetch(400, `${ORIGIN}/lookup?webid=bad`),
    });
    expect(await client?.isIndexed("not-a-webid")).toBe(false);
  });
});

// ─── checkHealth ──────────────────────────────────────────────────────────────

describe("IndexClient.checkHealth", () => {
  it("parses the health JSON snapshot", async () => {
    const body = JSON.stringify({
      status: "ok",
      entries: 42,
      triples: 999,
      queueDepth: 3,
      version: "0.1.0",
    });
    const fetchStub = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof globalThis.fetch;
    const client = createIndexClient({ origin: ORIGIN, fetch: fetchStub });
    const h = await client?.checkHealth();
    expect(h).toEqual({
      status: "ok",
      entries: 42,
      triples: 999,
      queueDepth: 3,
      version: "0.1.0",
    });
  });

  it("defends against a malformed health body (defaults, status degraded)", async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ junk: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof globalThis.fetch;
    const client = createIndexClient({ origin: ORIGIN, fetch: fetchStub });
    const h = await client?.checkHealth();
    expect(h?.status).toBe("degraded");
    expect(h?.entries).toBe(0);
    expect(h?.version).toBe("unknown");
  });
});

// ─── suggestWebId ─────────────────────────────────────────────────────────────

describe("IndexClient.suggestWebId", () => {
  function captureBody() {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchStub = vi.fn(async (url: unknown, init: unknown) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response(null, { status: 201 });
    });
    return {
      fetchStub: fetchStub as unknown as typeof globalThis.fetch,
      get captured() {
        return captured;
      },
    };
  }

  it("POSTs an AS2 Announce JSON-LD to the inbox (no credentials)", async () => {
    const cap = captureBody();
    const client = createIndexClient({ origin: ORIGIN, fetch: cap.fetchStub });
    const outcome = await client?.suggestWebId("https://alice.pod/card#me", {
      actor: "https://me.pod/card#me",
    });
    expect(outcome).toBe("submitted");

    expect(cap.captured?.url).toBe(`${ORIGIN}/inbox/`);
    expect(cap.captured?.init.method).toBe("POST");
    expect(cap.captured?.init.credentials).toBe("omit");
    expect(
      (cap.captured?.init.headers as Record<string, string>)["Content-Type"]
    ).toBe("application/ld+json");

    const sent = JSON.parse(cap.captured?.init.body as string);
    expect(sent["@context"]).toBe("https://www.w3.org/ns/activitystreams");
    expect(sent.type).toBe("Announce");
    expect(sent.object).toBe("https://alice.pod/card#me");
    expect(sent.actor).toBe("https://me.pod/card#me");
  });

  it("omits actor when not provided", async () => {
    const cap = captureBody();
    const client = createIndexClient({ origin: ORIGIN, fetch: cap.fetchStub });
    await client?.suggestWebId("https://alice.pod/card#me");
    const sent = JSON.parse(cap.captured?.init.body as string);
    expect(sent.actor).toBeUndefined();
  });

  it("rejects a non-https webid client-side without a network call", async () => {
    const fetchStub = vi.fn();
    const client = createIndexClient({
      origin: ORIGIN,
      fetch: fetchStub as unknown as typeof globalThis.fetch,
    });
    expect(await client?.suggestWebId("http://alice.pod/card#me")).toBe(
      "invalid"
    );
    expect(await client?.suggestWebId("not a url")).toBe("invalid");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each([
    [201, "submitted"],
    [202, "submitted"],
    [200, "already-indexed"],
    [409, "already-indexed"],
    [429, "rate-limited"],
    [400, "invalid"],
    [415, "invalid"],
    [422, "invalid"],
    [413, "invalid"],
    [500, "error"],
    [503, "error"],
  ])("maps inbox status %i → %s", async (status, expected) => {
    const fetchStub = vi.fn(
      async () => new Response(null, { status })
    ) as unknown as typeof globalThis.fetch;
    const client = createIndexClient({ origin: ORIGIN, fetch: fetchStub });
    expect(await client?.suggestWebId("https://x.pod/card#me")).toBe(expected);
  });

  it("maps a network failure → error (retryable)", async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;
    const client = createIndexClient({ origin: ORIGIN, fetch: fetchStub });
    expect(await client?.suggestWebId("https://x.pod/card#me")).toBe("error");
  });
});
