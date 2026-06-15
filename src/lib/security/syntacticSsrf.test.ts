// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * syntacticSsrf.test.ts — the request-path (no-DNS) SSRF gate for suggestion candidates.
 *
 * Asserts the SYNTACTIC checks decidable without any DNS: scheme/port/userinfo, the cloud-internal
 * denylist, IP-LITERAL classification (incl. alternate encodings), and that a REAL hostname passes
 * (deferred to the DNS-pinned guardedFetch at crawl time).
 */
import { describe, expect, it } from "vitest";

import { syntacticSsrfCheck } from "./syntacticSsrf";

describe("syntacticSsrfCheck — accepts real hostnames (DNS deferred)", () => {
  it("passes a normal public https WebID (no DNS performed)", () => {
    expect(syntacticSsrfCheck("https://alice.pod/card#me").ok).toBe(true);
    expect(syntacticSsrfCheck("https://example.com/profile").ok).toBe(true);
  });
});

describe("syntacticSsrfCheck — scheme / port / userinfo", () => {
  it("rejects non-https schemes in production", () => {
    expect(syntacticSsrfCheck("http://alice.pod/card").ok).toBe(false);
    expect(syntacticSsrfCheck("ftp://alice.pod/card").ok).toBe(false);
    expect(syntacticSsrfCheck("file:///etc/passwd").ok).toBe(false);
    expect(syntacticSsrfCheck("javascript:alert(1)").ok).toBe(false);
  });

  it("rejects a non-443 explicit port", () => {
    expect(syntacticSsrfCheck("https://alice.pod:8080/card").ok).toBe(false);
    expect(syntacticSsrfCheck("https://alice.pod:22/card").ok).toBe(false);
    expect(syntacticSsrfCheck("https://alice.pod:443/card").ok).toBe(true);
  });

  it("rejects userinfo", () => {
    expect(syntacticSsrfCheck("https://user:pass@alice.pod/card").ok).toBe(
      false
    );
    expect(syntacticSsrfCheck("https://user@alice.pod/card").ok).toBe(false);
  });

  it("rejects an unparseable URL", () => {
    expect(syntacticSsrfCheck("not a url").ok).toBe(false);
    expect(syntacticSsrfCheck("").ok).toBe(false);
  });
});

describe("syntacticSsrfCheck — cloud-internal denylist", () => {
  it("rejects metadata + internal names", () => {
    expect(syntacticSsrfCheck("https://metadata.google.internal/").ok).toBe(
      false
    );
    expect(syntacticSsrfCheck("https://foo.svc.cluster.local/x").ok).toBe(
      false
    );
    expect(syntacticSsrfCheck("https://x.internal/y").ok).toBe(false);
  });
});

describe("syntacticSsrfCheck — IP-literal classification (no DNS)", () => {
  it("rejects loopback / private / link-local IP literals", () => {
    expect(syntacticSsrfCheck("https://127.0.0.1/x").ok).toBe(false);
    expect(syntacticSsrfCheck("https://10.0.0.5/x").ok).toBe(false);
    expect(syntacticSsrfCheck("https://192.168.1.1/x").ok).toBe(false);
    expect(syntacticSsrfCheck("https://169.254.169.254/x").ok).toBe(false); // cloud metadata
    expect(syntacticSsrfCheck("https://[::1]/x").ok).toBe(false);
  });

  it("rejects alternate IPv4 encodings of loopback (decimal / hex / short)", () => {
    // 2130706433 == 127.0.0.1 ; 0x7f000001 == 127.0.0.1 ; 127.1 == 127.0.0.1
    expect(syntacticSsrfCheck("https://2130706433/x").ok).toBe(false);
    expect(syntacticSsrfCheck("https://0x7f000001/x").ok).toBe(false);
    expect(syntacticSsrfCheck("https://127.1/x").ok).toBe(false);
  });

  it("accepts a public IP literal", () => {
    expect(syntacticSsrfCheck("https://8.8.8.8/x").ok).toBe(true);
  });
});

describe("syntacticSsrfCheck — allowLoopback dev hook", () => {
  it("permits loopback http under allowLoopback (dev/test fixture)", () => {
    expect(
      syntacticSsrfCheck("http://127.0.0.1:12345/card", { allowLoopback: true })
        .ok
    ).toBe(true);
  });

  it("permits a loopback IPv6 http fixture under allowLoopback", () => {
    expect(
      syntacticSsrfCheck("http://[::1]:8080/card", { allowLoopback: true }).ok
    ).toBe(true);
  });
});

describe("syntacticSsrfCheck — allowLoopback is SCOPED to loopback only (M4)", () => {
  // Setting allowLoopback must relax http:/arbitrary-port ONLY for an actual loopback host. A
  // misconfigured allowLoopback in production must NEVER admit a public http: URL or a non-443
  // public host — the strict https-and-443 gate still applies to every non-loopback host.

  it("STILL rejects a PUBLIC http: URL even with allowLoopback set", () => {
    expect(
      syntacticSsrfCheck("http://alice.pod/card", { allowLoopback: true }).ok
    ).toBe(false);
    expect(
      syntacticSsrfCheck("http://example.com/profile", { allowLoopback: true })
        .ok
    ).toBe(false);
  });

  it("STILL rejects a PUBLIC http: IP literal even with allowLoopback set", () => {
    expect(
      syntacticSsrfCheck("http://8.8.8.8/x", { allowLoopback: true }).ok
    ).toBe(false);
  });

  it("STILL rejects a non-443 PUBLIC host even with allowLoopback set", () => {
    expect(
      syntacticSsrfCheck("https://alice.pod:8080/card", {
        allowLoopback: true,
      }).ok
    ).toBe(false);
    expect(
      syntacticSsrfCheck("https://8.8.8.8:8443/x", { allowLoopback: true }).ok
    ).toBe(false);
  });

  it("STILL rejects a non-loopback PRIVATE host even with allowLoopback set", () => {
    // allowLoopback re-permits ONLY loopback (127/8, ::1), never RFC1918/link-local.
    expect(
      syntacticSsrfCheck("http://10.0.0.5:9000/x", { allowLoopback: true }).ok
    ).toBe(false);
    expect(
      syntacticSsrfCheck("https://169.254.169.254/x", { allowLoopback: true })
        .ok
    ).toBe(false);
  });

  it("STILL permits a normal public https:443 host under allowLoopback", () => {
    // The relaxation does not break the ordinary production-shaped candidate.
    expect(
      syntacticSsrfCheck("https://alice.pod/card#me", { allowLoopback: true })
        .ok
    ).toBe(true);
  });
});
