// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * src/lib/url/canonical.test.ts — exhaustive tests for WebID/URI canonicalisation.
 *
 * SECURITY/CORRECTNESS: canonicalisation is the dedup PK. Wrong rules → either infinite re-crawl
 * of duplicates, or merging of distinct WebIDs. Tests cover every rule in DESIGN.md §2.2 and
 * every code path in canonical.ts.
 */
import { describe, expect, it } from "vitest";
import {
  CanonicalError,
  canonicalDocUrl,
  canonicalWebId,
  sameDocUrl,
  sameWebId,
} from "./canonical";

// ─── canonicalDocUrl ──────────────────────────────────────────────────────────

describe("canonicalDocUrl", () => {
  // ── Fragment stripping ──────────────────────────────────────────────────────

  describe("fragment stripping", () => {
    it("strips a #me fragment", () => {
      expect(canonicalDocUrl("https://alice.example/card#me")).toBe(
        "https://alice.example/card"
      );
    });

    it("strips an empty fragment (#)", () => {
      expect(canonicalDocUrl("https://alice.example/card#")).toBe(
        "https://alice.example/card"
      );
    });

    it("strips an arbitrary fragment", () => {
      expect(canonicalDocUrl("https://alice.example/profile/card#alice")).toBe(
        "https://alice.example/profile/card"
      );
    });

    it("returns the same doc key for /card and /card#me", () => {
      expect(canonicalDocUrl("https://alice.example/card")).toBe(
        canonicalDocUrl("https://alice.example/card#me")
      );
    });

    it("returns the same doc key for /card#me and /card#you (different subjects, same doc)", () => {
      expect(canonicalDocUrl("https://alice.example/card#me")).toBe(
        canonicalDocUrl("https://alice.example/card#you")
      );
    });
  });

  // ── Trailing slash normalisation ────────────────────────────────────────────

  describe("trailing slash", () => {
    it("strips a trailing slash on a path segment", () => {
      expect(canonicalDocUrl("https://alice.example/card/")).toBe(
        "https://alice.example/card"
      );
    });

    it("keeps root /", () => {
      expect(canonicalDocUrl("https://alice.example/")).toBe(
        "https://alice.example/"
      );
    });

    it("empty path → /", () => {
      // WHATWG URL normalises 'https://example.com' → 'https://example.com/' so this is implicit;
      // test it explicitly.
      expect(canonicalDocUrl("https://alice.example")).toBe(
        "https://alice.example/"
      );
    });

    it("does not double-strip (no trailing slash present)", () => {
      expect(canonicalDocUrl("https://alice.example/card")).toBe(
        "https://alice.example/card"
      );
    });

    it("strips only ONE trailing slash (not multiple slashes)", () => {
      // /profile// is a different path from /profile/ — we strip one slash then stop
      expect(canonicalDocUrl("https://alice.example/profile/card/")).toBe(
        "https://alice.example/profile/card"
      );
    });
  });

  // ── Host case normalisation ─────────────────────────────────────────────────

  describe("host case normalisation", () => {
    it("lowercases a mixed-case hostname", () => {
      expect(canonicalDocUrl("https://Alice.Example/card#me")).toBe(
        "https://alice.example/card"
      );
    });

    it("lowercases an all-caps hostname", () => {
      expect(canonicalDocUrl("https://ALICE.EXAMPLE/card")).toBe(
        "https://alice.example/card"
      );
    });

    it("treats same-host with different case as equal documents", () => {
      expect(canonicalDocUrl("https://Alice.example/card")).toBe(
        canonicalDocUrl("https://alice.example/card")
      );
    });
  });

  // ── Default-port removal ────────────────────────────────────────────────────

  describe("default port removal", () => {
    it("strips :443 from https URLs", () => {
      expect(canonicalDocUrl("https://alice.example:443/card")).toBe(
        "https://alice.example/card"
      );
    });

    it("strips :80 from http URLs (dev)", () => {
      expect(
        canonicalDocUrl("http://127.0.0.1:80/card", { allowLoopback: true })
      ).toBe("http://127.0.0.1/card");
    });

    it("preserves a non-standard port (allowLoopback)", () => {
      expect(
        canonicalDocUrl("http://127.0.0.1:3000/card", { allowLoopback: true })
      ).toBe("http://127.0.0.1:3000/card");
    });

    it("strips :443 combined with fragment", () => {
      expect(canonicalDocUrl("https://alice.example:443/card#me")).toBe(
        "https://alice.example/card"
      );
    });
  });

  // ── http vs https distinctness ──────────────────────────────────────────────

  describe("http vs https distinctness", () => {
    it("rejects http: in production (allowLoopback=false)", () => {
      expect(() => canonicalDocUrl("http://alice.example/card")).toThrow(
        CanonicalError
      );
    });

    it("accepts http: under allowLoopback", () => {
      expect(
        canonicalDocUrl("http://127.0.0.1/card", { allowLoopback: true })
      ).toBe("http://127.0.0.1/card");
    });

    it("http and https of the same loopback host+path are NOT equal (under allowLoopback)", () => {
      const http = canonicalDocUrl("http://127.0.0.1/card", {
        allowLoopback: true,
      });
      const https = canonicalDocUrl("https://127.0.0.1/card", {
        allowLoopback: true,
      });
      expect(http).not.toBe(https);
    });

    it("rejects http: for a NON-loopback host even under allowLoopback", () => {
      // allowLoopback must not turn into 'accept all cleartext origins'
      expect(() =>
        canonicalDocUrl("http://alice.example/card", { allowLoopback: true })
      ).toThrow(CanonicalError);
      expect(() =>
        canonicalWebId("http://alice.example/card#me", { allowLoopback: true })
      ).toThrow(CanonicalError);
    });

    it("accepts http: for localhost and 127.x under allowLoopback", () => {
      expect(
        canonicalDocUrl("http://localhost/card", { allowLoopback: true })
      ).toBe("http://localhost/card");
      expect(
        canonicalDocUrl("http://127.0.0.5/card", { allowLoopback: true })
      ).toBe("http://127.0.0.5/card");
    });
  });

  // ── Percent-encoding normalisation ──────────────────────────────────────────

  describe("percent-encoding normalisation", () => {
    it("passes the URL through WHATWG URL (round-trips without corruption)", () => {
      // WHATWG URL leaves reserved percent-encoded chars in path verbatim and is idempotent.
      // %2F is a reserved char (/) in the path — WHATWG URL preserves it.
      const a = canonicalDocUrl("https://alice.example/profile%2Fcard");
      expect(a).toBe("https://alice.example/profile%2Fcard");
    });

    it("is idempotent over an already-normalised percent-encoded URL", () => {
      // canonicalDocUrl applied twice must yield the same result (no further encoding changes).
      const once = canonicalDocUrl("https://alice.example/profile%2Fcard");
      const twice = canonicalDocUrl(once);
      expect(twice).toBe(once);
    });

    it("normalises the path through WHATWG URL (spaces encoded)", () => {
      // A raw space in a URL is invalid — WHATWG URL encodes it as %20.
      // This verifies the WHATWG normalisation pipeline runs.
      const canonical = canonicalDocUrl("https://alice.example/my%20card");
      expect(canonical).toBe("https://alice.example/my%20card");
    });
  });

  // ── Scheme gate ─────────────────────────────────────────────────────────────

  describe("scheme gate", () => {
    it("throws CanonicalError for ftp:", () => {
      expect(() => canonicalDocUrl("ftp://alice.example/card")).toThrow(
        CanonicalError
      );
    });

    it("throws CanonicalError for data:", () => {
      expect(() => canonicalDocUrl("data:text/plain,hello")).toThrow(
        CanonicalError
      );
    });

    it("throws CanonicalError for a malformed URL", () => {
      expect(() => canonicalDocUrl("not a url")).toThrow(CanonicalError);
    });

    it("throws CanonicalError for an empty string", () => {
      expect(() => canonicalDocUrl("")).toThrow(CanonicalError);
    });
  });

  // ── Userinfo rejection ──────────────────────────────────────────────────────

  describe("userinfo rejection", () => {
    it("throws when username is present", () => {
      expect(() => canonicalDocUrl("https://alice@alice.example/card")).toThrow(
        CanonicalError
      );
    });

    it("throws when username:password is present", () => {
      expect(() =>
        canonicalDocUrl("https://alice:secret@alice.example/card")
      ).toThrow(CanonicalError);
    });
  });

  // ── Idempotence ─────────────────────────────────────────────────────────────

  describe("idempotence — canonical(canonical(x)) === canonical(x)", () => {
    const cases = [
      "https://alice.example/card#me",
      "https://Alice.Example:443/card/",
      "https://bob.solidcommunity.net/profile/card#me",
      "https://carol.solidcommunity.net/",
    ];
    for (const raw of cases) {
      it(`is idempotent for ${raw}`, () => {
        const once = canonicalDocUrl(raw);
        const twice = canonicalDocUrl(once);
        expect(twice).toBe(once);
      });
    }
  });

  // ── Real WebID shapes ───────────────────────────────────────────────────────

  describe("real WebID shapes", () => {
    it("NSS-style /card#me", () => {
      expect(
        canonicalDocUrl("https://alice.solidcommunity.net/profile/card#me")
      ).toBe("https://alice.solidcommunity.net/profile/card");
    });

    it("CSS-style /card#me", () => {
      expect(canonicalDocUrl("https://my.pod.host/alice/profile/card#me")).toBe(
        "https://my.pod.host/alice/profile/card"
      );
    });

    it("root-path WebID (no fragment)", () => {
      expect(canonicalDocUrl("https://alice.example.org/")).toBe(
        "https://alice.example.org/"
      );
    });

    it("handles an IDN hostname (Punycode via WHATWG URL)", () => {
      // WHATWG URL punycode-encodes non-ASCII hostnames
      const result = canonicalDocUrl("https://xn--nxasmq6b.example/card");
      expect(result).toBe("https://xn--nxasmq6b.example/card");
    });
  });
});

// ─── canonicalWebId ───────────────────────────────────────────────────────────

describe("canonicalWebId", () => {
  // ── Fragment retention ──────────────────────────────────────────────────────

  describe("fragment retention", () => {
    it("keeps the #me fragment", () => {
      expect(canonicalWebId("https://alice.example/card#me")).toBe(
        "https://alice.example/card#me"
      );
    });

    it("keeps an empty fragment (#)", () => {
      // An empty fragment is a valid URI but unusual for WebIDs; we keep it.
      expect(canonicalWebId("https://alice.example/card#")).toBe(
        "https://alice.example/card#"
      );
    });

    it("keeps an arbitrary fragment", () => {
      expect(canonicalWebId("https://alice.example/profile/card#alice")).toBe(
        "https://alice.example/profile/card#alice"
      );
    });

    it("/card#me and /card are DIFFERENT WebIDs (different subjects)", () => {
      expect(canonicalWebId("https://alice.example/card#me")).not.toBe(
        canonicalWebId("https://alice.example/card")
      );
    });

    it("/card#me and /card#you are DIFFERENT WebIDs (different subjects)", () => {
      expect(canonicalWebId("https://alice.example/card#me")).not.toBe(
        canonicalWebId("https://alice.example/card#you")
      );
    });
  });

  // ── All other normalisation rules match canonicalDocUrl ─────────────────────

  describe("same normalisation rules as canonicalDocUrl (minus fragment stripping)", () => {
    it("strips :443", () => {
      expect(canonicalWebId("https://alice.example:443/card#me")).toBe(
        "https://alice.example/card#me"
      );
    });

    it("lowercases host", () => {
      expect(canonicalWebId("https://Alice.Example/card#me")).toBe(
        "https://alice.example/card#me"
      );
    });

    it("strips trailing slash from path (before fragment)", () => {
      expect(canonicalWebId("https://alice.example/card/#me")).toBe(
        "https://alice.example/card#me"
      );
    });

    it("rejects http: in production", () => {
      expect(() => canonicalWebId("http://alice.example/card#me")).toThrow(
        CanonicalError
      );
    });

    it("rejects userinfo", () => {
      expect(() =>
        canonicalWebId("https://alice@alice.example/card#me")
      ).toThrow(CanonicalError);
    });

    it("rejects malformed URI", () => {
      expect(() => canonicalWebId(":::bad")).toThrow(CanonicalError);
    });
  });

  // ── Idempotence ─────────────────────────────────────────────────────────────

  describe("idempotence — canonical(canonical(x)) === canonical(x)", () => {
    const cases = [
      "https://alice.example/card#me",
      "https://Alice.Example:443/card/#me",
      "https://bob.solidcommunity.net/profile/card#me",
      "https://carol.solidcommunity.net/",
    ];
    for (const raw of cases) {
      it(`is idempotent for ${raw}`, () => {
        const once = canonicalWebId(raw);
        const twice = canonicalWebId(once);
        expect(twice).toBe(once);
      });
    }
  });

  // ── Real WebID shapes ───────────────────────────────────────────────────────

  describe("real WebID shapes", () => {
    it("NSS /profile/card#me", () => {
      expect(
        canonicalWebId("https://alice.solidcommunity.net/profile/card#me")
      ).toBe("https://alice.solidcommunity.net/profile/card#me");
    });

    it("CSS /alice/profile/card#me", () => {
      expect(canonicalWebId("https://my.pod.host/alice/profile/card#me")).toBe(
        "https://my.pod.host/alice/profile/card#me"
      );
    });

    it("root-path WebID (no fragment)", () => {
      expect(canonicalWebId("https://alice.example.org/")).toBe(
        "https://alice.example.org/"
      );
    });

    it("normalises host case + port in NSS WebID", () => {
      expect(
        canonicalWebId("https://Alice.SolidCommunity.Net:443/profile/card#me")
      ).toBe("https://alice.solidcommunity.net/profile/card#me");
    });
  });
});

// ─── sameWebId ────────────────────────────────────────────────────────────────

describe("sameWebId", () => {
  it("returns true for identical canonical WebIDs", () => {
    expect(
      sameWebId(
        "https://alice.example/card#me",
        "https://alice.example/card#me"
      )
    ).toBe(true);
  });

  it("returns true for equivalent but unnormalised forms (host case, port)", () => {
    expect(
      sameWebId(
        "https://Alice.Example:443/card#me",
        "https://alice.example/card#me"
      )
    ).toBe(true);
  });

  it("returns true for trailing-slash variant", () => {
    expect(
      sameWebId(
        "https://alice.example/card/#me",
        "https://alice.example/card#me"
      )
    ).toBe(true);
  });

  it("returns false for different fragments (different WebIDs)", () => {
    expect(
      sameWebId(
        "https://alice.example/card#me",
        "https://alice.example/card#you"
      )
    ).toBe(false);
  });

  it("returns false for different hosts", () => {
    expect(
      sameWebId("https://alice.example/card#me", "https://bob.example/card#me")
    ).toBe(false);
  });

  it("propagates CanonicalError for a malformed URL", () => {
    expect(() =>
      sameWebId("not-a-url", "https://alice.example/card#me")
    ).toThrow(CanonicalError);
  });
});

// ─── sameDocUrl ──────────────────────────────────────────────────────────────

describe("sameDocUrl", () => {
  it("returns true for the same document URL", () => {
    expect(
      sameDocUrl("https://alice.example/card", "https://alice.example/card")
    ).toBe(true);
  });

  it("returns true when one has a fragment and the other does not", () => {
    expect(
      sameDocUrl("https://alice.example/card#me", "https://alice.example/card")
    ).toBe(true);
  });

  it("returns true for different fragments of the same document", () => {
    expect(
      sameDocUrl(
        "https://alice.example/card#me",
        "https://alice.example/card#you"
      )
    ).toBe(true);
  });

  it("returns false for different documents", () => {
    expect(
      sameDocUrl(
        "https://alice.example/card",
        "https://alice.example/profile/card"
      )
    ).toBe(false);
  });

  it("returns false for different hosts", () => {
    expect(
      sameDocUrl("https://alice.example/card", "https://bob.example/card")
    ).toBe(false);
  });

  it("treats trailing slash and no-trailing slash as same document", () => {
    expect(
      sameDocUrl("https://alice.example/card/", "https://alice.example/card")
    ).toBe(true);
  });

  it("propagates CanonicalError for a malformed URL", () => {
    expect(() => sameDocUrl("https://alice.example/card", "bad url")).toThrow(
      CanonicalError
    );
  });
});

// ─── CanonicalError shape ─────────────────────────────────────────────────────

describe("CanonicalError", () => {
  it("has .name === 'CanonicalError'", () => {
    let err: unknown;
    try {
      canonicalDocUrl("not-a-url");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CanonicalError);
    expect((err as CanonicalError).name).toBe("CanonicalError");
  });

  it("exposes the .raw field with the original input", () => {
    let err: unknown;
    try {
      canonicalDocUrl("ftp://alice.example/card");
    } catch (e) {
      err = e;
    }
    expect((err as CanonicalError).raw).toBe("ftp://alice.example/card");
  });

  it("message includes the raw URL for easy debugging", () => {
    let err: unknown;
    try {
      canonicalDocUrl("ftp://alice.example/card");
    } catch (e) {
      err = e;
    }
    expect((err as CanonicalError).message).toContain(
      "ftp://alice.example/card"
    );
  });
});
