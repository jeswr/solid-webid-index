// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import { describe, expect, it } from "vitest";

import { isUlid, ulid } from "./ulid";

describe("ulid", () => {
  it("is 26 Crockford base32 chars", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isUlid(id)).toBe(true);
  });

  it("is lexicographically sortable by time", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a < b).toBe(true);
  });

  it("is unique across calls at the same instant (randomness)", () => {
    const now = 5_000_000;
    const ids = new Set(Array.from({ length: 100 }, () => ulid(now)));
    expect(ids.size).toBe(100);
  });

  it("isUlid rejects non-ULID strings", () => {
    expect(isUlid("")).toBe(false);
    expect(isUlid("too-short")).toBe(false);
    expect(isUlid("i".repeat(26))).toBe(false); // 'i'/'I' not in Crockford
    expect(isUlid("../etc/passwd")).toBe(false);
  });
});
