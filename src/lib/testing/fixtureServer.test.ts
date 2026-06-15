// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * fixtureServer.test.ts — self-test for the shared offline fixture server (pss-q2h).
 *
 * Proves the canned-response builders behave as the conformance + security suites rely on, fetching
 * EXCLUSIVELY through guardedFetch (allowLoopback) against 127.0.0.1 — never the public internet.
 * If a builder ever regresses (wrong content-type, missing 304, redirect chain off-by-one) the
 * dependent suites would fail mysteriously; this file localises that.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { guardedFetch } from "@/lib/security/guardedFetch";
import { type FixtureServer, startFixtureServer } from "./fixtureServer";

let fx: FixtureServer;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  fx.reset();
});

const gf = (path: string, init = {}) =>
  guardedFetch(fx.doc(path), { allowLoopback: true, ...init });

describe("fixtureServer — binds 127.0.0.1 ephemeral port (offline)", () => {
  it("base is a loopback origin and the port is non-zero", () => {
    expect(fx.host).toBe("127.0.0.1");
    expect(fx.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(fx.port).toBeGreaterThan(0);
  });

  it("an unregistered path is 404", async () => {
    const r = await gf("/nope");
    expect(r.status).toBe(404);
  });
});

describe("fixtureServer — serveProfile (Turtle)", () => {
  it("serves a text/turtle profile with the #me subject + name", async () => {
    const subject = fx.serveProfile("/alice", { name: "Alice" });
    expect(subject).toBe(fx.webid("/alice"));
    const r = await gf("/alice");
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("text/turtle");
    expect(r.text).toContain(subject);
    expect(r.text).toContain("Alice");
    expect(r.text).toContain("solid:oidcIssuer"); // solid by default → isSolid
  });

  it("solid:false omits the oidcIssuer", async () => {
    fx.serveProfile("/nonsolid", { solid: false });
    const r = await gf("/nonsolid");
    expect(r.text).not.toContain("oidcIssuer");
  });

  it("etag returns 304 on a matching If-None-Match", async () => {
    fx.serveProfile("/etag", { etag: '"v1"' });
    const r = await gf("/etag", { conditional: { etag: '"v1"' } });
    expect(r.status).toBe(304);
  });

  it("extraHeaders are emitted (x-robots-tag)", async () => {
    fx.serveProfile("/robots", { extraHeaders: { "x-robots-tag": "noindex" } });
    const r = await gf("/robots", { honourNoindexHeader: true });
    expect(r.noindex).toBe(true);
  });
});

describe("fixtureServer — serveJsonLdProfile", () => {
  it("serves application/ld+json with the subject + knows", async () => {
    const child = fx.webid("/b");
    const subject = fx.serveJsonLdProfile("/a", { name: "A", knows: [child] });
    const r = await gf("/a");
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("application/ld+json");
    const json = JSON.parse(r.text);
    expect(json["@id"]).toBe(subject);
    expect(JSON.stringify(json)).toContain(child);
  });
});

describe("fixtureServer — redirects", () => {
  it("serveRedirect bounces to a served profile (final URL reported)", async () => {
    fx.serveProfile("/dest", {});
    fx.serveRedirect("/src", fx.doc("/dest"));
    const r = await gf("/src");
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(fx.doc("/dest"));
  });

  it("serveRedirectChain(N) needs N hops to resolve and lands on the profile", async () => {
    // A 2-hop chain resolves with maxRedirects >= 2.
    const finalWebId = fx.serveRedirectChain("/chain", 2);
    const ok = await gf("/chain", { maxRedirects: 2 });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain(finalWebId);
    // With maxRedirects too low it is rejected (proving the chain really is N hops).
    await expect(gf("/chain", { maxRedirects: 1 })).rejects.toThrow();
  });
});

describe("fixtureServer — statuses + bodies", () => {
  it("serveStatus(410) returns a bodyless 410", async () => {
    fx.serveStatus("/gone", 410);
    const r = await gf("/gone");
    expect(r.status).toBe(410);
  });

  it("serveOversized exceeds the byte cap (BodyTooLarge)", async () => {
    fx.serveOversized("/big");
    await expect(gf("/big", { maxBytes: 1024 })).rejects.toThrow();
  });

  it("serveRdfaHtml serves text/html (content-type the guard rejects for RDF)", async () => {
    fx.serveRdfaHtml("/rdfa");
    await expect(gf("/rdfa")).rejects.toThrow(/content-type/i);
  });
});

describe("fixtureServer — fan-out + hit counting", () => {
  it("serveFanout registers N children + the parent that knows them", async () => {
    const { parent, children } = fx.serveFanout("/root", 5);
    expect(children).toHaveLength(5);
    const r = await gf("/root");
    expect(r.text).toContain(parent);
    for (const c of children) expect(r.text).toContain(c);
  });

  it("hitCount tracks GETs per path; reset clears it", async () => {
    fx.serveProfile("/counted", {});
    expect(fx.hitCount("/counted")).toBe(0);
    await gf("/counted");
    await gf("/counted");
    expect(fx.hitCount("/counted")).toBe(2);
    fx.reset();
    expect(fx.hitCount("/counted")).toBe(0);
  });
});
