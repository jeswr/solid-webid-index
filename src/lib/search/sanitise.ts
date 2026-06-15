// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/search/sanitise.ts — FTS query sanitisation for the SEARCH API.
 *
 * Extracted into a lib module so it can be imported by both the route handler
 * (app/search/route.ts) and its unit tests without triggering Next.js route
 * type constraints (which disallow non-HTTP-method named exports on route files).
 *
 * Security H4 (DESIGN.md §4.4): never pass FTS operators (", NEAR, ^, :, *, AND).
 */

import { FTS_MAX_TOKENS, FTS_MAX_TOKEN_LEN } from "@/lib/config";

/**
 * Sanitise a raw ?q= value into a safe FTS query string.
 *
 * Algorithm: lowercase → keep only [a-z0-9] + spaces → split on whitespace →
 * drop empty tokens → cap each token to FTS_MAX_TOKEN_LEN chars →
 * take at most FTS_MAX_TOKENS → rejoin with spaces.
 *
 * Returns null when the sanitised query is empty (callers return an empty collection).
 */
export function sanitiseFtsQuery(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    // Strip every character that is not a-z, 0-9, or whitespace.
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.slice(0, FTS_MAX_TOKEN_LEN))
    .slice(0, FTS_MAX_TOKENS);

  return tokens.length > 0 ? tokens.join(" ") : null;
}
