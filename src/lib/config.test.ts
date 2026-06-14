// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import { describe, expect, it } from "vitest";
import {
  BATCH_SIZE,
  FETCH_TIMEOUT_MS,
  FTS_MAX_TOKENS,
  INDEX_BASE_URL,
  LEASE_MS,
  MAX_BYTES_INBOX,
  MAX_BYTES_PROFILE,
  MAX_DEPTH,
  SEARCH_PAGE_SIZE,
  TIME_BUDGET_MS,
} from "./config";

describe("lib/config — owned constants", () => {
  it("MAX_DEPTH has a sensible default", () => {
    expect(MAX_DEPTH).toBe(3);
  });

  it("BATCH_SIZE has a sensible default", () => {
    expect(BATCH_SIZE).toBe(8);
  });

  it("FETCH_TIMEOUT_MS is 8 seconds", () => {
    expect(FETCH_TIMEOUT_MS).toBe(8_000);
  });

  it("MAX_BYTES_PROFILE is 256 KiB", () => {
    expect(MAX_BYTES_PROFILE).toBe(256 * 1024);
  });

  it("MAX_BYTES_INBOX is 64 KiB", () => {
    expect(MAX_BYTES_INBOX).toBe(64 * 1024);
  });

  it("SEARCH_PAGE_SIZE has a sensible default", () => {
    expect(SEARCH_PAGE_SIZE).toBe(20);
  });

  it("LEASE_MS is greater than TIME_BUDGET_MS (lease outlives invocation)", () => {
    expect(LEASE_MS).toBeGreaterThan(TIME_BUDGET_MS);
  });

  it("INDEX_BASE_URL has no trailing slash", () => {
    expect(INDEX_BASE_URL).not.toMatch(/\/$/);
  });

  it("FTS_MAX_TOKENS limits query tokens", () => {
    expect(FTS_MAX_TOKENS).toBe(8);
  });
});
