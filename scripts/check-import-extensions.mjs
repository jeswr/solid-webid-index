#!/usr/bin/env node
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * check-import-extensions — enforce the EXTENSIONLESS relative-import policy (pss-hsga).
 *
 * The project compiles under `moduleResolution: "bundler"` (tsconfig.json) and runs through
 * webpack (Next.js), so relative module specifiers MUST be written WITHOUT a file extension.
 * Mixing styles (`./foo` vs `./foo.js`) drifts over time and a `.js` specifier on a `.ts` source
 * file is a TypeScript-NodeNext-ism that does not belong under bundler resolution — one of those
 * was added only to work around webpack and the rest of the tree is inconsistent.
 *
 * This guard FAILS (exit 1) if any source file imports a RELATIVE (`./`, `../`) or path-aliased
 * (`@/…`) specifier that ends in a module extension (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`).
 * It checks `import … from "…"`, `import "…"`, `export … from "…"`, and dynamic `import("…")`.
 *
 * Out of scope (NOT flagged):
 *  - bare package specifiers (e.g. `n3`, `next/server`, `@solid/object`) — no leading `./`/`../`/`@/`;
 *  - non-module asset imports such as `.css` / `.json` / `.sql` / `.svg` (a bundler resolves these
 *    with their extension; only JS/TS module extensions are forbidden);
 *  - test files are INCLUDED — the policy is repo-wide so the style cannot drift in test code.
 *
 * Wired like `check:fetch` (scripts/check-no-raw-fetch.mjs): a plain Node script, no deps, run in
 * the gate. Biome 1.9.x cannot express "forbid an extension on a relative specifier", hence a guard.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Module extensions that must NOT appear on a relative / aliased specifier. */
const FORBIDDEN_EXT = "(?:js|jsx|ts|tsx|mjs|cjs)";

/**
 * Specifier forms we inspect. Each captures the quoted specifier in group 1.
 *  - `from "…"`     — static import / re-export `from` clause.
 *  - `import "…"`   — bare side-effect import.
 *  - `import("…")`  — dynamic import.
 * A relative (`./`, `../`) or aliased (`@/`) specifier ending in a forbidden extension is a hit.
 */
const PATTERNS = [
  new RegExp(`\\bfrom\\s+(["'])((?:\\.\\.?/|@/)[^"']*\\.${FORBIDDEN_EXT})\\1`),
  new RegExp(
    `\\bimport\\s+(["'])((?:\\.\\.?/|@/)[^"']*\\.${FORBIDDEN_EXT})\\1`
  ),
  new RegExp(
    `\\bimport\\s*\\(\\s*(["'])((?:\\.\\.?/|@/)[^"']*\\.${FORBIDDEN_EXT})\\1`
  ),
];

/** True for files we scan (TS/TSX source; type-decls excluded). */
function isScannable(rel) {
  if (!/\.(ts|tsx)$/.test(rel)) return false;
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
let scanned = 0;
for (const full of files) {
  const rel = relative(ROOT, full).split("\\").join("/");
  if (!isScannable(rel)) continue;
  scanned += 1;
  const lines = readFileSync(full, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const code = stripLineComment(lines[i]);
    for (const re of PATTERNS) {
      const m = re.exec(code);
      if (m) {
        violations.push(
          `${rel}:${i + 1}: relative import "${m[2]}" has a module extension — drop it (extensionless policy).`
        );
        break;
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    "check:imports FAILED — relative/aliased imports must be EXTENSIONLESS (pss-hsga):\n"
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    '\nWrite `from "./foo"`, not `from "./foo.js"`. The project uses moduleResolution: "bundler" + webpack.'
  );
  process.exit(1);
}

console.log(
  `check:imports OK — ${scanned} source files scanned, all relative imports extensionless.`
);
