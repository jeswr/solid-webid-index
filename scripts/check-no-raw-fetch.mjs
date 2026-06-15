#!/usr/bin/env node
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * check-no-raw-fetch — CI guard for the single-egress-chokepoint invariant (docs/DESIGN.md §5).
 *
 * Fails (exit 1) if any source file OTHER than the guard itself calls a raw external-fetch
 * primitive: the global `fetch(`, `undici.fetch`, `undici.request`, or `import ... from "undici"`.
 * Every attacker-influenced dereference MUST go through `src/lib/security/guardedFetch.ts`.
 *
 * Allowlist (files permitted to use the raw primitives):
 *   - src/lib/security/guardedFetch.ts  (the chokepoint — imports undici fetch/Agent)
 *   - src/lib/security/ssrf.ts          (vendored SSRF guard)
 *   - src/lib/security/body.ts          (vendored bounded reader)
 * Test files (*.test.ts / *.test.tsx) are exempt — they spin up fixture servers and exercise the
 * guard directly. Client-side browser code (third-party APIs, never attacker-controlled internal
 * targets) is out of scope here; this guard protects the SERVER egress path.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/**
 * Files allowed to reference the raw primitives (relative to repo root, POSIX slashes).
 *
 * Allowlist rationale:
 *  - src/lib/security/guardedFetch.ts  — the SSRF chokepoint; imports undici directly.
 *  - src/lib/security/ssrf.ts          — vendored SSRF guard.
 *  - src/lib/security/body.ts          — vendored bounded reader.
 *  - src/app/api/_jobs/crawl/route.ts  — self-chain trigger: fires a POST to its OWN
 *    deployment URL (always HTTPS on Vercel, never attacker-controlled).  This is an
 *    internal relay, not an external fetch of user-supplied content.
 *  - src/app/api/_jobs/tick/route.ts   — tick→crawl relay: same reasoning as above.
 *  - src/lib/crawl/triggerCrawl.ts     — LDN-inbox→crawl relay: fires a POST to its
 *    own deployment URL when a new suggestion arrives; same reasoning.
 */
const ALLOWLIST = new Set([
  "src/lib/security/guardedFetch.ts",
  "src/lib/security/ssrf.ts",
  "src/lib/security/body.ts",
  "src/app/api/_jobs/crawl/route.ts",
  "src/app/api/_jobs/tick/route.ts",
  "src/lib/crawl/triggerCrawl.ts",
]);

/** Patterns that indicate a raw external-fetch call. Comment-only lines are skipped. */
const PATTERNS = [
  { re: /(?<![.\w])fetch\s*\(/, label: "global fetch(" },
  { re: /\bundici\b/, label: 'reference to "undici"' },
  { re: /from\s+["']undici["']/, label: 'import from "undici"' },
];

/** True for files we scan (TS/TSX source, not tests, not type decls). */
function isScannable(rel) {
  if (!/\.(ts|tsx)$/.test(rel)) return false;
  if (/\.test\.(ts|tsx)$/.test(rel)) return false;
  if (rel.endsWith(".d.ts")) return false;
  return true;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "out") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
}

function stripLineComment(line) {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

const files = [];
walk(SRC, files);

const violations = [];
for (const full of files) {
  const rel = relative(ROOT, full).split("\\").join("/");
  if (!isScannable(rel)) continue;
  if (ALLOWLIST.has(rel)) continue;
  const text = readFileSync(full, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const code = stripLineComment(lines[i]);
    for (const { re, label } of PATTERNS) {
      if (re.test(code)) {
        violations.push(
          `${rel}:${i + 1}: ${label} — route through guardedFetch instead.`
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    "check:fetch FAILED — raw external-fetch outside the guarded chokepoint:\n"
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nEvery attacker-influenced fetch MUST go through src/lib/security/guardedFetch.ts (docs/DESIGN.md §5)."
  );
  process.exit(1);
}

console.log(
  `check:fetch OK — ${files.filter((f) => isScannable(relative(ROOT, f).split("\\").join("/"))).length} source files scanned, no raw external fetch.`
);
