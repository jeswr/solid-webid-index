// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/url/slug.ts — deterministic, opaque, collision-resistant slug for a WebID.
 *
 * The entry document at `$ORIGIN/p/{slug}` is keyed on a slug derived purely from
 * the canonical WebID (DESIGN.md §2.1.c):
 *
 *     slug = base32(sha256(canonicalWebId))[0..24]   (lowercase, no padding)
 *
 * Properties:
 *  - Deterministic: the same WebID always maps to the same slug (so `/lookup` can
 *    compute the slug without a DB round-trip, and the projection can index it).
 *  - Opaque: the slug does NOT leak the WebID (no host/path embedded) — a person's
 *    pod URL is not exposed in the index URL space.
 *  - URL-safe: base32 lowercased uses only `[a-z2-7]`, so no percent-encoding and
 *    no case-collision on case-insensitive caches.
 *
 * NOT reversible — the reverse mapping (slug → WebID) is a DB lookup against the
 * stored slug column (see PgStore.getEntryBySlug). `/lookup?webid=` computes the
 * slug forward and 303-redirects to `/p/{slug}` (DESIGN.md §4.1).
 *
 * No I/O.  The caller is expected to pass an already-canonicalised WebID
 * (see lib/url/canonical.ts `canonicalWebId`); this module does not canonicalise.
 */

import { createHash } from "node:crypto";

/** RFC 4648 base32 alphabet, lowercased (we lowercase the whole slug). */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Slug length (chars taken from the front of the base32 digest). DESIGN.md §2.1.c. */
export const SLUG_LENGTH = 24;

/**
 * Base32-encode a byte buffer (RFC 4648, lowercase, NO padding).
 *
 * We implement this inline (rather than pulling a dependency) because the only
 * use is encoding a fixed-size sha256 digest; the 5-bit grouping is trivial and
 * keeps the slug computation dependency-free + identical across environments.
 */
function base32EncodeNoPad(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Compute the opaque slug for a canonical WebID.
 *
 * @param canonicalWebId  An already-canonicalised WebID IRI (with #fragment).
 * @returns The 24-char lowercase base32 slug.
 *
 * @example
 * slugForWebId("https://alice.example/card#me")  // → e.g. "k7r3..." (24 chars)
 */
export function slugForWebId(canonicalWebId: string): string {
  const digest = createHash("sha256").update(canonicalWebId, "utf8").digest();
  return base32EncodeNoPad(digest).slice(0, SLUG_LENGTH);
}

/**
 * Returns true when `slug` is well-formed (exactly {@link SLUG_LENGTH} chars from
 * the base32 alphabet).  A malformed slug can never match a stored slug, so the
 * entry route short-circuits to 404 without touching the DB.
 */
export function isValidSlug(slug: string): boolean {
  if (slug.length !== SLUG_LENGTH) return false;
  for (let i = 0; i < slug.length; i++) {
    if (!BASE32_ALPHABET.includes(slug[i])) return false;
  }
  return true;
}
