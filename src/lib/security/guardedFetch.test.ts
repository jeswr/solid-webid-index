// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * Exhaustive SSRF tests for the guardedFetch chokepoint (docs/DESIGN.md §5, §8).
 *
 * NEVER hits the public internet. Guard-rejection tests throw BEFORE any socket opens (DNS is
 * stubbed or the host is a literal); end-to-end tests use a fixture HTTP server bound to 127.0.0.1
 * with `allowLoopback: true` (the documented TEST-ONLY hook — never set in production).
 *
 * Vectors covered (assert against the named ranges):
 *  - IPv4: loopback 127/8, RFC1918 10/8 · 172.16/12 · 192.168/16, link-local 169.254/16 (incl.
 *    169.254.169.254 metadata), CGNAT 100.64/10, 0.0.0.0/8, multicast, reserved/TEST-NET.
 *  - IPv6: ::1, ::, ULA fc00::/7, link-local fe80::/10, IPv4-mapped ::ffff:0:0/96 (compressed AND
 *    expanded form re-checking the embedded v4), 6to4 2002:: embedding a private v4, NAT64 64:ff9b::.
 *  - Alternate IPv4 encodings: decimal, octal, hex, short-form — normalised before classifying.
 *  - DNS rebinding: stub returns public-then-private (multi-record refusal); pin is used on connect.
 *  - Redirect → private (blocked), redirect cap, scheme downgrade, redirect loop.
 *  - Oversize body (aborted), timeout, disallowed content-type, non-http scheme, userinfo, port gate,
 *    cloud-internal hostname denylist.
 *  - Happy path: a real RDF doc from a 127.0.0.1 fixture server (loopback test hook only).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_REDIRECTS } from "../config";
import { isLoopbackAddress, isPublicAddress } from "./addresses";
import {
  BodyTooLargeError,
  GuardedFetchError,
  SsrfError,
  assertSchemeAndPort,
  guardedFetch,
} from "./guardedFetch";
import {
  assertNotSsrf,
  isDeniedHostname,
  normalizeHostForClassification,
} from "./ssrf";

// ───────────────────────── A fixture HTTP server bound to 127.0.0.1 ─────────────────────────

type RouteFn = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let server: http.Server;
let base: string; // e.g. http://127.0.0.1:PORT
const routes = new Map<string, RouteFn>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const fn = routes.get(req.url ?? "");
    if (fn) {
      fn(req, res);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

/** A DNS stub returning a fixed list of addresses for any host. */
function stubDns(...addrs: { address: string; family: number }[]) {
  return vi.fn(async () => addrs);
}

const TTL =
  '<https://alice.example/card#me> <http://www.w3.org/2000/01/rdf-schema#label> "Alice" .';

// ════════════════════════════════ 1. Address classifier ════════════════════════════════

describe("isPublicAddress — IPv4 ranges", () => {
  const blocked: [string, string][] = [
    ["0.0.0.0", "0.0.0.0/8 unspecified"],
    ["0.1.2.3", "0/8"],
    ["127.0.0.1", "loopback 127/8"],
    ["127.255.255.255", "loopback 127/8 upper"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["10.255.255.255", "RFC1918 10/8 upper"],
    ["172.16.0.1", "RFC1918 172.16/12 lower"],
    ["172.31.255.255", "RFC1918 172.16/12 upper"],
    ["192.168.0.1", "RFC1918 192.168/16"],
    ["169.254.0.1", "link-local 169.254/16"],
    ["169.254.169.254", "cloud metadata 169.254.169.254"],
    ["100.64.0.1", "CGNAT 100.64/10 lower"],
    ["100.127.255.255", "CGNAT 100.64/10 upper"],
    ["224.0.0.1", "multicast 224/4"],
    ["239.255.255.255", "multicast 224/4 upper"],
    ["240.0.0.1", "reserved 240/4"],
    ["255.255.255.255", "broadcast"],
    ["192.0.2.1", "TEST-NET-1"],
    ["198.18.0.1", "benchmarking 198.18/15"],
    ["198.51.100.1", "TEST-NET-2"],
    ["203.0.113.1", "TEST-NET-3"],
  ];
  for (const [ip, label] of blocked) {
    it(`blocks ${ip} (${label})`, () => {
      expect(isPublicAddress(ip, false)).toBe(false);
    });
  }

  it("allows public v4 (e.g. 8.8.8.8, 1.1.1.1)", () => {
    expect(isPublicAddress("8.8.8.8", false)).toBe(true);
    expect(isPublicAddress("1.1.1.1", false)).toBe(true);
    // 172.15 and 172.32 are PUBLIC (just outside the /12).
    expect(isPublicAddress("172.15.0.1", false)).toBe(true);
    expect(isPublicAddress("172.32.0.1", false)).toBe(true);
  });

  it("re-permits loopback only under allowLoopback", () => {
    expect(isPublicAddress("127.0.0.1", true)).toBe(true);
    expect(isPublicAddress("10.0.0.1", true)).toBe(false); // still blocked
  });

  it("rejects malformed / out-of-range octets", () => {
    expect(isPublicAddress("999.1.1.1", false)).toBe(false);
    expect(isPublicAddress("not-an-ip", false)).toBe(false);
  });
});

describe("isPublicAddress — IPv6 ranges", () => {
  const blocked: [string, string][] = [
    ["::1", "loopback ::1"],
    ["0:0:0:0:0:0:0:1", "loopback expanded"],
    ["::", "unspecified ::"],
    ["fc00::1", "ULA fc00::/7 lower"],
    ["fdff::1", "ULA fc00::/7 upper (fd00)"],
    ["fe80::1", "link-local fe80::/10"],
    ["febf::1", "link-local fe80::/10 upper"],
    ["ff02::1", "multicast ff00::/8"],
    ["::ffff:10.0.0.1", "IPv4-mapped private (compressed)"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback (compressed)"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    [
      "0:0:0:0:0:ffff:0a00:0001",
      "IPv4-mapped private (EXPANDED hextet form = 10.0.0.1)",
    ],
    ["2002:0a00:0001::", "6to4 embedding 10.0.0.1"],
    ["2002:7f00:0001::", "6to4 embedding 127.0.0.1"],
    ["64:ff9b::10.0.0.1", "NAT64 embedding 10.0.0.1"],
    ["64:ff9b::a9fe:a9fe", "NAT64 embedding 169.254.169.254"],
  ];
  for (const [ip, label] of blocked) {
    it(`blocks ${ip} (${label})`, () => {
      expect(isPublicAddress(ip, false)).toBe(false);
    });
  }

  it("allows public v6 (e.g. 2606:4700::1, public IPv4-mapped)", () => {
    expect(isPublicAddress("2606:4700::1", false)).toBe(true);
    expect(isPublicAddress("::ffff:8.8.8.8", false)).toBe(true);
    expect(isPublicAddress("2002:0808:0808::", false)).toBe(true); // 6to4 embedding 8.8.8.8
  });

  it("re-permits loopback ::1 only under allowLoopback", () => {
    expect(isPublicAddress("::1", true)).toBe(true);
    expect(isPublicAddress("fc00::1", true)).toBe(false);
  });
});

describe("isLoopbackAddress", () => {
  it("identifies v4/v6 loopback incl. mapped", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.9.9.9")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackAddress("::ffff:8.8.8.8")).toBe(false);
  });
});

// ════════════════════════════════ 2. Hostname normalisation + denylist ════════════════════════════════

describe("normalizeHostForClassification — alternate IPv4 encodings", () => {
  const cases: [string, string][] = [
    ["2130706433", "127.0.0.1"], // decimal
    ["0x7f000001", "127.0.0.1"], // hex
    ["0177.0.0.1", "127.0.0.1"], // octal
    ["127.1", "127.0.0.1"], // short form
    ["0x7f.0.0.1", "127.0.0.1"], // mixed hex
    ["017700000001", "127.0.0.1"], // full octal
    ["0", "0.0.0.0"],
    ["0x0", "0.0.0.0"],
  ];
  for (const [input, expected] of cases) {
    it(`normalises ${input} → ${expected}`, () => {
      expect(normalizeHostForClassification(input)).toBe(expected);
    });
  }

  it("leaves a real hostname unchanged (lowercased)", () => {
    expect(normalizeHostForClassification("Alice.Example")).toBe(
      "alice.example"
    );
    expect(normalizeHostForClassification("127.0.0.1.evil.com")).toBe(
      "127.0.0.1.evil.com"
    );
  });

  it("strips IPv6 brackets", () => {
    expect(normalizeHostForClassification("[::1]")).toBe("::1");
  });
});

describe("isDeniedHostname — cloud-internal denylist", () => {
  const denied = [
    "metadata.google.internal",
    "x.metadata.google.internal",
    "foo.internal",
    "kubernetes.default.svc.cluster.local",
    "anything.vercel-internal.com",
    "localhost",
    "service.local",
  ];
  for (const h of denied) {
    it(`denies ${h}`, () => {
      expect(isDeniedHostname(h)).toBe(true);
    });
  }
  it("allows a normal public hostname", () => {
    expect(isDeniedHostname("alice.solidcommunity.net")).toBe(false);
    expect(isDeniedHostname("example.com")).toBe(false);
  });
  it("is case-insensitive and trailing-dot tolerant", () => {
    expect(isDeniedHostname("LOCALHOST.")).toBe(true);
    expect(isDeniedHostname("Metadata.Google.Internal")).toBe(true);
  });
});

// ════════════════════════════════ 3. assertNotSsrf (no socket) ════════════════════════════════

describe("assertNotSsrf — scheme / port / userinfo gates", () => {
  it("rejects non-http(s) schemes", async () => {
    for (const u of [
      "ftp://x/",
      "file:///etc/passwd",
      "gopher://x/",
      "data:text/plain,hi",
    ]) {
      await expect(
        assertNotSsrf(u, { allowLoopback: false })
      ).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("rejects http: in prod (enforceHttpsExceptLoopback)", async () => {
    await expect(
      assertNotSsrf("http://example.com/", {
        allowLoopback: false,
        enforceHttpsExceptLoopback: true,
        dnsLookup: stubDns({ address: "8.8.8.8", family: 4 }),
      })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects userinfo in the URL", async () => {
    await expect(
      assertNotSsrf("https://user:pass@example.com/", { allowLoopback: false })
    ).rejects.toThrow(/userinfo/i);
  });

  it("rejects a malformed URL", async () => {
    await expect(
      assertNotSsrf("http://[bad", { allowLoopback: false })
    ).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("assertNotSsrf — IP literal targets (no DNS)", () => {
  it("refuses private/loopback/metadata literals", async () => {
    for (const h of [
      "https://127.0.0.1/",
      "https://10.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/",
      "https://[fc00::1]/",
      "https://[fe80::1]/",
      "https://[::ffff:10.0.0.1]/",
    ]) {
      await expect(
        assertNotSsrf(h, { allowLoopback: false })
      ).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("refuses alternate-encoded loopback literals (decimal/hex/octal/short)", async () => {
    for (const h of [
      "https://2130706433/", // 127.0.0.1 decimal
      "https://0x7f000001/", // 127.0.0.1 hex
      "https://0177.0.0.1/", // 127.0.0.1 octal
      "https://127.1/", // 127.0.0.1 short
    ]) {
      await expect(
        assertNotSsrf(h, { allowLoopback: false })
      ).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("returns the pinned address for a public literal", async () => {
    const pin = await assertNotSsrf("https://8.8.8.8/", {
      allowLoopback: false,
    });
    expect(pin).toEqual({ address: "8.8.8.8", family: 4 });
  });
});

describe("assertNotSsrf — DNS resolution + rebinding", () => {
  it("refuses a host that resolves to a private IP", async () => {
    await expect(
      assertNotSsrf("https://evil.example/", {
        allowLoopback: false,
        dnsLookup: stubDns({ address: "10.0.0.1", family: 4 }),
      })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("DNS-REBINDING: refuses when ANY resolved record is private (public + private)", async () => {
    await expect(
      assertNotSsrf("https://rebind.example/", {
        allowLoopback: false,
        dnsLookup: stubDns(
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 }
        ),
      })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("resolves DNS exactly ONCE and pins the first validated record", async () => {
    const dns = stubDns({ address: "93.184.216.34", family: 4 });
    const pin = await assertNotSsrf("https://good.example/", {
      allowLoopback: false,
      dnsLookup: dns,
    });
    expect(dns).toHaveBeenCalledTimes(1);
    expect(pin).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("refuses a host that resolves to no addresses", async () => {
    await expect(
      assertNotSsrf("https://empty.example/", {
        allowLoopback: false,
        dnsLookup: stubDns(),
      })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("refuses a denied hostname BEFORE DNS (denylist short-circuits)", async () => {
    const dns = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    await expect(
      assertNotSsrf("https://metadata.google.internal/", {
        allowLoopback: false,
        dnsLookup: dns,
      })
    ).rejects.toBeInstanceOf(SsrfError);
    expect(dns).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════ 4. guardedFetch — guard rejections ════════════════════════════════

describe("guardedFetch — rejects forbidden targets (no socket)", () => {
  it("rejects a non-http scheme", async () => {
    await expect(guardedFetch("file:///etc/passwd")).rejects.toBeInstanceOf(
      GuardedFetchError
    );
  });

  it("rejects http: without allowLoopback", async () => {
    await expect(guardedFetch("http://example.com/")).rejects.toBeInstanceOf(
      GuardedFetchError
    );
  });

  it("rejects a non-default port (port gate)", async () => {
    await expect(
      guardedFetch("https://8.8.8.8:8080/", {
        dnsLookup: stubDns({ address: "8.8.8.8", family: 4 }),
      })
    ).rejects.toBeInstanceOf(GuardedFetchError);
  });

  it("rejects a private-IP literal target", async () => {
    await expect(
      guardedFetch("https://169.254.169.254/latest/meta-data/")
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects a host that resolves private (rebinding multi-record)", async () => {
    await expect(
      guardedFetch("https://rebind.example/", {
        dnsLookup: stubDns(
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 }
        ),
      })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects a cloud-internal hostname (denylist)", async () => {
    await expect(
      guardedFetch("https://metadata.google.internal/")
    ).rejects.toBeInstanceOf(SsrfError);
  });
});

// ════════════════════════════════ 5. guardedFetch — end-to-end (127.0.0.1 fixture) ════════════════════════════════

describe("guardedFetch — happy path (loopback test hook)", () => {
  it("fetches an allowed RDF doc and returns body + finalUrl + content-type", async () => {
    routes.set("/card", (_req, res) => {
      res.writeHead(200, { "content-type": "text/turtle; charset=utf-8" });
      res.end(TTL);
    });
    const r = await guardedFetch(`${base}/card`, { allowLoopback: true });
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("text/turtle");
    expect(r.text).toBe(TTL);
    expect(r.bytes.byteLength).toBe(Buffer.byteLength(TTL));
    expect(r.finalUrl).toBe(`${base}/card`);
  });

  it("accepts application/ld+json", async () => {
    routes.set("/jsonld", (_req, res) => {
      res.writeHead(200, { "content-type": "application/ld+json" });
      res.end('{"@id":"https://alice.example/card#me"}');
    });
    const r = await guardedFetch(`${base}/jsonld`, { allowLoopback: true });
    expect(r.contentType).toBe("application/ld+json");
  });

  it("PIN PROOF: connects to the guard-validated IP, not a re-resolution", async () => {
    // Fetch a hostname that does NOT exist in real DNS. The stub resolves it to 127.0.0.1 (allowed
    // under allowLoopback). If the pin is honoured, undici connects to 127.0.0.1 and reaches the
    // fixture — even though `pinned.test` is unresolvable in real DNS. Resolving exactly once + the
    // pin closing the gap is the rebinding mitigation.
    const port = (server.address() as AddressInfo).port;
    routes.set("/pinned", (_req, res) => {
      res.writeHead(200, { "content-type": "text/turtle" });
      res.end(TTL);
    });
    const dns = stubDns({ address: "127.0.0.1", family: 4 });
    const r = await guardedFetch(`http://pinned.test:${port}/pinned`, {
      allowLoopback: true,
      dnsLookup: dns,
    });
    expect(dns).toHaveBeenCalledTimes(1); // resolved once
    expect(r.status).toBe(200);
    expect(r.text).toBe(TTL);
  });

  it("forwards conditional validators and surfaces 304", async () => {
    routes.set("/cond", (req, res) => {
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304, { "content-type": "text/turtle" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/turtle" });
      res.end(TTL);
    });
    const r = await guardedFetch(`${base}/cond`, {
      allowLoopback: true,
      conditional: { etag: '"v1"' },
    });
    expect(r.status).toBe(304);
  });

  it("accepts a 304 with NO content-type (bodyless status bypasses the allowlist)", async () => {
    routes.set("/cond-noct", (req, res) => {
      if (req.headers["if-none-match"] === '"v2"') {
        res.writeHead(304); // real 304s commonly omit Content-Type
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/turtle" });
      res.end(TTL);
    });
    const r = await guardedFetch(`${base}/cond-noct`, {
      allowLoopback: true,
      conditional: { etag: '"v2"' },
    });
    expect(r.status).toBe(304);
    expect(r.text).toBe("");
    expect(r.bytes.length).toBe(0);
  });

  it.each([204, 205])(
    "accepts a bodyless %i (No Content / Reset) with no content-type",
    async (code) => {
      routes.set(`/empty${code}`, (_req, res) => {
        res.writeHead(code);
        res.end();
      });
      const r = await guardedFetch(`${base}/empty${code}`, {
        allowLoopback: true,
      });
      expect(r.status).toBe(code);
      expect(r.text).toBe("");
      expect(r.bytes.length).toBe(0);
    }
  );

  it("sends a descriptive User-Agent", async () => {
    let seenUa = "";
    routes.set("/ua", (req, res) => {
      seenUa = String(req.headers["user-agent"] ?? "");
      res.writeHead(200, { "content-type": "text/turtle" });
      res.end(TTL);
    });
    await guardedFetch(`${base}/ua`, { allowLoopback: true });
    expect(seenUa).toMatch(/solid-webid-index/);
  });
});

describe("guardedFetch — error statuses bypass the content-type allowlist", () => {
  // An error response body is never RDF we would parse, so guardedFetch returns it bodyless (the
  // body is cancelled, not read) and surfaces the status — the crawler classifies 5xx/429 transient
  // vs other 4xx deterministic. This does NOT widen the SSRF surface (no attacker bytes ingested).
  it.each([404, 401, 403, 429, 500, 503])(
    "returns a bodyless result for HTTP %i with a non-RDF (text/plain) body",
    async (code) => {
      routes.set(`/err${code}`, (_req, res) => {
        res.writeHead(code, { "content-type": "text/plain" });
        res.end(`error ${code}`);
      });
      const r = await guardedFetch(`${base}/err${code}`, {
        allowLoopback: true,
      });
      expect(r.status).toBe(code);
      expect(r.text).toBe(""); // body cancelled, not read
      expect(r.bytes.length).toBe(0);
    }
  );

  it("returns a bodyless result for a 410 Gone with no content-type", async () => {
    routes.set("/gone", (_req, res) => {
      res.writeHead(410);
      res.end("gone");
    });
    const r = await guardedFetch(`${base}/gone`, { allowLoopback: true });
    expect(r.status).toBe(410);
    expect(r.text).toBe("");
  });
});

describe("guardedFetch — content-type allowlist", () => {
  it("rejects text/html (RDFa excluded)", async () => {
    routes.set("/html", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>nope</body></html>");
    });
    await expect(
      guardedFetch(`${base}/html`, { allowLoopback: true })
    ).rejects.toBeInstanceOf(GuardedFetchError);
  });

  it("rejects a missing content-type", async () => {
    routes.set("/noct", (_req, res) => {
      res.writeHead(200);
      res.end("data");
    });
    await expect(
      guardedFetch(`${base}/noct`, { allowLoopback: true })
    ).rejects.toBeInstanceOf(GuardedFetchError);
  });
});

describe("guardedFetch — body cap", () => {
  it("aborts an oversize body (streamed past the cap)", async () => {
    routes.set("/big", (_req, res) => {
      res.writeHead(200, { "content-type": "text/turtle" }); // no content-length → streamed check
      res.end("x".repeat(5000));
    });
    await expect(
      guardedFetch(`${base}/big`, { allowLoopback: true, maxBytes: 1000 })
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("rejects an over-cap declared Content-Length up front", async () => {
    routes.set("/biglen", (_req, res) => {
      const body = "y".repeat(5000);
      res.writeHead(200, {
        "content-type": "text/turtle",
        "content-length": String(body.length),
      });
      res.end(body);
    });
    await expect(
      guardedFetch(`${base}/biglen`, { allowLoopback: true, maxBytes: 1000 })
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("guardedFetch — timeout", () => {
  it("aborts a slow response after timeoutMs", async () => {
    routes.set("/slow", (_req, res) => {
      // Never respond within the window.
      setTimeout(() => {
        try {
          res.writeHead(200, { "content-type": "text/turtle" });
          res.end(TTL);
        } catch {
          /* socket already torn down */
        }
      }, 2000);
    });
    await expect(
      guardedFetch(`${base}/slow`, { allowLoopback: true, timeoutMs: 150 })
    ).rejects.toBeInstanceOf(GuardedFetchError);
  });

  it("surfaces a body-stream timeout (after headers) as GuardedFetchError", async () => {
    routes.set("/slowbody", (_req, res) => {
      // Headers + an allowed content-type arrive immediately (passing the allowlist),
      // then the body stalls past the timeout — readBoundedBytes must abort and the
      // failure must surface as GuardedFetchError, not a raw abort/stream error.
      res.writeHead(200, { "content-type": "text/turtle" });
      res.write("<https://a.example/#me> ");
      // intentionally never res.end() within the window
    });
    await expect(
      guardedFetch(`${base}/slowbody`, { allowLoopback: true, timeoutMs: 150 })
    ).rejects.toBeInstanceOf(GuardedFetchError);
  });
});

// ════════════════════════════════ 6. guardedFetch — redirects ════════════════════════════════

describe("guardedFetch — redirects (each hop re-validated)", () => {
  it("follows a same-host redirect to an allowed doc and reports the final URL", async () => {
    routes.set("/r1", (_req, res) => {
      res.writeHead(302, { location: `${base}/r2` });
      res.end();
    });
    routes.set("/r2", (_req, res) => {
      res.writeHead(200, { "content-type": "text/turtle" });
      res.end(TTL);
    });
    const r = await guardedFetch(`${base}/r1`, { allowLoopback: true });
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`${base}/r2`);
    expect(r.text).toBe(TTL);
  });

  it("BLOCKS a redirect to a private address", async () => {
    routes.set("/redir-private", (_req, res) => {
      res.writeHead(302, {
        location: "https://169.254.169.254/latest/meta-data/",
      });
      res.end();
    });
    await expect(
      guardedFetch(`${base}/redir-private`, { allowLoopback: true })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("BLOCKS a redirect whose host resolves private (re-runs the guard per hop)", async () => {
    routes.set("/redir-rebind", (_req, res) => {
      res.writeHead(302, { location: "https://internal.example/" });
      res.end();
    });
    await expect(
      guardedFetch(`${base}/redir-rebind`, {
        allowLoopback: true,
        dnsLookup: stubDns({ address: "10.1.2.3", family: 4 }),
      })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("caps redirects at MAX_REDIRECTS", async () => {
    // Build a chain longer than the cap; each hop bounces to the next.
    for (let i = 0; i <= MAX_REDIRECTS + 2; i += 1) {
      routes.set(`/chain${i}`, (_req, res) => {
        res.writeHead(302, { location: `${base}/chain${i + 1}` });
        res.end();
      });
    }
    await expect(
      guardedFetch(`${base}/chain0`, { allowLoopback: true, maxRedirects: 2 })
    ).rejects.toBeInstanceOf(GuardedFetchError);
  });

  it("rejects a redirect loop", async () => {
    routes.set("/loopA", (_req, res) => {
      res.writeHead(302, { location: `${base}/loopB` });
      res.end();
    });
    routes.set("/loopB", (_req, res) => {
      res.writeHead(302, { location: `${base}/loopA` });
      res.end();
    });
    await expect(
      guardedFetch(`${base}/loopA`, { allowLoopback: true, maxRedirects: 5 })
    ).rejects.toBeInstanceOf(GuardedFetchError);
  });
});

// ════════════════════════════════ 7. scheme / port / downgrade gate (unit) ════════════════════════════════

describe("assertSchemeAndPort — scheme, port, and downgrade branches", () => {
  it("accepts https on the default port", () => {
    expect(() =>
      assertSchemeAndPort(new URL("https://example.com/"), false, false)
    ).not.toThrow();
    expect(() =>
      assertSchemeAndPort(new URL("https://example.com:443/"), false, false)
    ).not.toThrow();
  });

  it("rejects http: without allowLoopback", () => {
    expect(() =>
      assertSchemeAndPort(new URL("http://example.com/"), false, false)
    ).toThrow(GuardedFetchError);
  });

  it("accepts http: on port 80 ONLY under allowLoopback", () => {
    expect(() =>
      assertSchemeAndPort(new URL("http://127.0.0.1/"), true, false)
    ).not.toThrow();
    expect(() =>
      assertSchemeAndPort(new URL("http://127.0.0.1:80/"), true, false)
    ).not.toThrow();
  });

  it("rejects a non-default https port (8080, 8443)", () => {
    expect(() =>
      assertSchemeAndPort(new URL("https://example.com:8080/"), false, false)
    ).toThrow(GuardedFetchError);
    expect(() =>
      assertSchemeAndPort(new URL("https://example.com:8443/"), false, false)
    ).toThrow(GuardedFetchError);
  });

  it("REJECTS a scheme-downgrade redirect (prevWasHttps && http target)", () => {
    expect(() =>
      assertSchemeAndPort(
        new URL("http://127.0.0.1/"),
        true,
        /*prevWasHttps*/ true
      )
    ).toThrow(/downgrade/i);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() =>
      assertSchemeAndPort(new URL("ftp://example.com/"), true, false)
    ).toThrow(GuardedFetchError);
  });
});

// ════════════════════════════════ 8. Runtime boot assertion (Edge fails closed) ════════════════════════════════

describe("guardedFetch — runtime boot assertion (docs/DESIGN.md §5)", () => {
  it("THROWS at module load on the Edge runtime (NEXT_RUNTIME=edge) — fail closed", async () => {
    const prev = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = "edge";
    vi.resetModules();
    try {
      // Re-importing evaluates the module top-level boot assertion under the Edge env.
      await expect(import("./guardedFetch")).rejects.toThrow(
        /Node\.js runtime|Edge runtime/i
      );
    } finally {
      if (prev === undefined) {
        process.env.NEXT_RUNTIME = undefined;
        // biome-ignore lint/performance/noDelete: restore the absent env var for other tests.
        delete process.env.NEXT_RUNTIME;
      } else {
        process.env.NEXT_RUNTIME = prev;
      }
      vi.resetModules();
    }
  });
});
