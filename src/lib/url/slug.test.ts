// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * slug.test.ts — deterministic opaque WebID slug (DESIGN.md §2.1.c).
 */

import { describe, expect, it } from "vitest";

import { SLUG_LENGTH, isValidSlug, slugForWebId } from "./slug";

describe("slugForWebId", () => {
  it("is deterministic — same WebID → same slug", () => {
    const w = "https://alice.example/card#me";
    expect(slugForWebId(w)).toBe(slugForWebId(w));
  });

  it("produces a SLUG_LENGTH base32 string", () => {
    const s = slugForWebId("https://alice.example/card#me");
    expect(s).toHaveLength(SLUG_LENGTH);
    expect(s).toMatch(/^[a-z2-7]+$/);
  });

  it("differs for different WebIDs (collision-resistant)", () => {
    const a = slugForWebId("https://alice.example/card#me");
    const b = slugForWebId("https://bob.example/card#me");
    expect(a).not.toBe(b);
  });

  it("distinguishes the fragment (different subjects → different slugs)", () => {
    const a = slugForWebId("https://x.example/card#me");
    const b = slugForWebId("https://x.example/card#you");
    expect(a).not.toBe(b);
  });

  it("is opaque — does NOT embed the host or path", () => {
    const s = slugForWebId("https://alice.example/card#me");
    expect(s).not.toContain("alice");
    expect(s).not.toContain("example");
    expect(s).not.toContain("card");
  });
});

describe("isValidSlug", () => {
  it("accepts a freshly minted slug", () => {
    expect(isValidSlug(slugForWebId("https://alice.example/card#me"))).toBe(
      true
    );
  });

  it("rejects the wrong length", () => {
    expect(isValidSlug("abc")).toBe(false);
    expect(isValidSlug("a".repeat(SLUG_LENGTH + 1))).toBe(false);
  });

  it("rejects out-of-alphabet characters (0, 1, 8, 9, uppercase, punctuation)", () => {
    const bad = `0189ABCD${"a".repeat(SLUG_LENGTH - 8)}`;
    expect(isValidSlug(bad)).toBe(false);
    expect(isValidSlug(`../${"a".repeat(SLUG_LENGTH - 3)}`)).toBe(false);
  });
});
