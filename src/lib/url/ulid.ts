// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/url/ulid.ts — a small, dependency-free, lexicographically-sortable id (ULID-shaped).
 *
 * Used for inbox notification ids (`$ORIGIN/inbox/{id}`). A ULID is sortable by creation time —
 * `received_at DESC` listing and id-ordering agree — and URL-safe (Crockford base32, no padding).
 * We implement it inline rather than pulling the `ulid` npm package: the algorithm is trivial and a
 * server needs few RDF/util deps (house "conservative dependencies" posture).
 *
 * Format: 26 chars = 10 (48-bit ms timestamp) + 16 (80 bits randomness), Crockford base32.
 *
 * No I/O beyond `crypto.getRandomValues`.
 */

/** Crockford base32 (excludes I, L, O, U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const TIME_LEN = 10; // 48 bits → 10 base32 chars
const RAND_LEN = 16; // 80 bits → 16 base32 chars

/** Encode a non-negative integer (≤ 48 bits) as `len` Crockford base32 chars (big-endian). */
function encodeTime(ms: number, len: number): string {
  let n = Math.floor(ms);
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    out.push(CROCKFORD[n % 32]);
    n = Math.floor(n / 32);
  }
  return out.reverse().join("");
}

/** Encode `len` chars of randomness (5 bits per char) from a CSPRNG. */
function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    // Map each byte's low 5 bits to a base32 symbol — uniform enough for an id nonce.
    out += CROCKFORD[bytes[i] & 0x1f];
  }
  return out;
}

/**
 * Generate a lexicographically-sortable ULID-shaped id.
 *
 * @param now  epoch ms (injectable for deterministic tests). Defaults to `Date.now()`.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, TIME_LEN) + encodeRandom(RAND_LEN);
}

/**
 * Validate that a string is a syntactically-valid ULID (26 Crockford base32 chars).
 * Used to vet a client `Slug` before adopting it as a notification id.
 */
export function isUlid(s: string): boolean {
  if (s.length !== TIME_LEN + RAND_LEN) return false;
  for (const ch of s) {
    if (!CROCKFORD.includes(ch)) return false;
  }
  return true;
}
