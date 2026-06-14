// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * Public-address classification for SSRF defence.
 *
 * VENDORED VERBATIM from prod-solid-server `packages/guarded-fetch/src/addresses.ts` (the
 * exhaustively-tested copy ported from the resource server's WebID resolver). Per docs/DESIGN.md §5
 * the SSRF primitives are vendored unchanged so the proven test suite carries over. Only the module
 * doc comment + ESM import extensions differ from the source.
 *
 * Refuses: loopback, link-local, IPv4 private (RFC 1918), CGNAT (RFC 6598), IPv4 reserved/test
 * ranges, multicast, broadcast, IPv4 `0.0.0.0/8`, IPv4-mapped IPv6, IPv6 ULA (`fc00::/7`), IPv6
 * unspecified, **6to4 (`2002::/16`) embedding a private v4**, **NAT64 (`64:ff9b::/96`) embedding a
 * private v4**. `allowLoopback` re-permits loopback only (dev / IT / tests).
 */
import { isIP } from "node:net";

/**
 * Classify an IPv4/IPv6 literal as public. Returns `false` for any non-public range, malformed
 * input, or a non-IP string. `allowLoopback` re-permits loopback (127/8, ::1, mapped 127.x) only.
 */
export function isPublicAddress(
  address: string,
  allowLoopback: boolean
): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPublicIpv4(address, allowLoopback);
  }
  if (family === 6) {
    return isPublicIpv6(address, allowLoopback);
  }
  return false;
}

/**
 * Whether `address` is loopback (127/8, ::1, or IPv4-mapped ::ffff:127.x.x.x). Used by the HTTPS
 * dev override to refuse `http:` URLs whose host resolves to anything other than loopback even when
 * `allowLoopback=true` — a dev box must not HTTP-fetch a public host.
 */
export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return address.startsWith("127.");
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") {
      return true;
    }
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice("::ffff:".length);
      return isIP(v4) === 4 && v4.startsWith("127.");
    }
  }
  return false;
}

function isPublicIpv4(address: string, allowLoopback: boolean): boolean {
  const parts = address.split(".").map((p) => Number.parseInt(p, 10));
  if (
    parts.length !== 4 ||
    parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) {
    return false; // 0.0.0.0/8
  }
  if (a === 127) {
    return allowLoopback;
  }
  if (a === 10) {
    return false; // RFC 1918
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false; // RFC 1918
  }
  if (a === 192 && b === 168) {
    return false; // RFC 1918
  }
  if (a === 169 && b === 254) {
    return false; // Link-local
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return false; // CGNAT 100.64.0.0/10
  }
  if (a >= 224 && a <= 239) {
    return false; // Multicast 224.0.0.0/4
  }
  if (a >= 240) {
    return false; // Reserved / broadcast
  }
  if (a === 192 && b === 0 && c === 2) {
    return false; // TEST-NET-1
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return false; // Benchmarking
  }
  if (a === 198 && b === 51 && c === 100) {
    return false; // TEST-NET-2
  }
  if (a === 203 && b === 0 && c === 113) {
    return false; // TEST-NET-3
  }
  return true;
}

/**
 * Pull the four IPv4 bytes from an IPv6 address starting at a given hextet pair index. Used by the
 * 6to4 + NAT64 checks to extract the embedded v4 address and recurse through the v4 classifier —
 * preventing an attacker reaching an internal v4 via an IPv6-tunnelling prefix.
 */
function extractEmbeddedV4(
  hextets: string[],
  startHextet: number
): string | undefined {
  const h1 = hextets[startHextet];
  const h2 = hextets[startHextet + 1];
  if (!h1 || !h2) {
    return undefined;
  }
  const w1 = Number.parseInt(h1, 16);
  const w2 = Number.parseInt(h2, 16);
  if (
    Number.isNaN(w1) ||
    Number.isNaN(w2) ||
    w1 < 0 ||
    w1 > 0xffff ||
    w2 < 0 ||
    w2 > 0xffff
  ) {
    return undefined;
  }
  return `${(w1 >> 8) & 0xff}.${w1 & 0xff}.${(w2 >> 8) & 0xff}.${w2 & 0xff}`;
}

function isPublicIpv6(address: string, allowLoopback: boolean): boolean {
  const lower = address.toLowerCase();
  // Normalise loopback variants (some runtimes expand to `0:0:0:0:0:0:0:1`).
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") {
    return allowLoopback;
  }
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") {
    return false; // Unspecified
  }
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) — classify per the embedded v4. **Detect via full
  // expansion** so EVERY form is covered: the compressed `::ffff:...` AND the expanded
  // `0:0:0:0:0:ffff:HHHH:HHHH`, with the embedded v4 written dotted or as two hextets. A naive
  // `startsWith("::ffff:")` check misses the expanded form, letting `0:0:0:0:0:ffff:0a00:0001`
  // (= 10.0.0.1) be treated as public. The mapped prefix is hextets [0..5] = [0,0,0,0,0,ffff].
  const mappedExpanded = expandIpv6(lower);
  if (
    mappedExpanded &&
    mappedExpanded[0] === "0" &&
    mappedExpanded[1] === "0" &&
    mappedExpanded[2] === "0" &&
    mappedExpanded[3] === "0" &&
    mappedExpanded[4] === "0" &&
    mappedExpanded[5] === "ffff"
  ) {
    const v4 = extractEmbeddedV4(mappedExpanded, 6);
    // Undecodable mapped address → fail closed (non-public).
    return v4 !== undefined && isPublicIpv4(v4, allowLoopback);
  }
  // First hextet determines the high-order bits.
  const head = lower.split(":")[0] ?? "";
  const high = Number.parseInt(head, 16);
  if (Number.isNaN(high)) {
    return false;
  }
  // fe80::/10 link-local
  if ((high & 0xffc0) === 0xfe80) {
    return false;
  }
  // fc00::/7 unique-local
  if ((high & 0xfe00) === 0xfc00) {
    return false;
  }
  // ff00::/8 multicast
  if ((high & 0xff00) === 0xff00) {
    return false;
  }
  // 2002::/16 6to4 — encodes a v4 address in hextets [1..2]. Block when the embedded v4 is
  // non-public (RFC 3056); a NAT'd 6to4 deployment could otherwise tunnel to an internal range.
  if (high === 0x2002) {
    const expanded = expandIpv6(lower);
    if (expanded) {
      const v4 = extractEmbeddedV4(expanded, 1);
      if (v4 && !isPublicIpv4(v4, allowLoopback)) {
        return false;
      }
    } else {
      // Failed to expand — be fail-closed.
      return false;
    }
  }
  // 64:ff9b::/96 NAT64 well-known prefix (RFC 6052): the last 32 bits are a v4 address. Block
  // when the embedded v4 is non-public; a NAT64 gateway could otherwise translate to an internal
  // v4.
  if (high === 0x0064) {
    const expanded = expandIpv6(lower);
    // The well-known prefix is `64:ff9b:0:0:0:0:a.b.c.d` — hextets [0..5] must be
    // [64, ff9b, 0, 0, 0, 0]. Anything else is not the well-known prefix.
    if (
      expanded &&
      expanded[0] === "64" &&
      expanded[1] === "ff9b" &&
      expanded[2] === "0" &&
      expanded[3] === "0" &&
      expanded[4] === "0" &&
      expanded[5] === "0"
    ) {
      const v4 = extractEmbeddedV4(expanded, 6);
      if (v4 && !isPublicIpv4(v4, allowLoopback)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Expand an IPv6 address to exactly 8 hextets so a downstream classifier can index by position.
 * Returns the array of lower-cased hextet strings (no leading zeros), or undefined if the input is
 * malformed. Handles `::` compression and trailing IPv4-dotted notation. Defensive — Node's `isIP`
 * has already validated the input as a valid IPv6, but we do not trust that this code sees only
 * canonical forms.
 */
function expandIpv6(addr: string): string[] | undefined {
  let s = addr;
  // If the tail has dotted v4, convert it to two hextets first.
  const dot = s.lastIndexOf(".");
  if (dot !== -1) {
    const colon = s.lastIndexOf(":", dot);
    if (colon === -1) {
      return undefined;
    }
    const v4 = s.slice(colon + 1);
    if (isIP(v4) !== 4) {
      return undefined;
    }
    const [a, b, c, d] = v4.split(".").map((p) => Number.parseInt(p, 10));
    if (
      a === undefined ||
      b === undefined ||
      c === undefined ||
      d === undefined
    ) {
      return undefined;
    }
    s = `${s.slice(0, colon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  // Expand `::`.
  const doubleColon = s.indexOf("::");
  let hextets: string[];
  if (doubleColon === -1) {
    hextets = s.split(":");
  } else {
    const head =
      s.slice(0, doubleColon) === "" ? [] : s.slice(0, doubleColon).split(":");
    const tail =
      s.slice(doubleColon + 2) === ""
        ? []
        : s.slice(doubleColon + 2).split(":");
    const fill = 8 - head.length - tail.length;
    if (fill < 0) {
      return undefined;
    }
    hextets = [...head, ...Array<string>(fill).fill("0"), ...tail];
  }
  if (hextets.length !== 8) {
    return undefined;
  }
  return hextets.map((h) => {
    const n = Number.parseInt(h, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) {
      return "BAD";
    }
    return n.toString(16);
  });
}
