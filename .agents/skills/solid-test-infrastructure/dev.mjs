#!/usr/bin/env node
/**
 * dev.mjs — one-command Solid dev environment:
 *   1. starts an in-memory Community Solid Server (CSS@7) on :3000,
 *   2. seeds a test account + pod + profile (same recipe as global-setup.ts —
 *      a fresh CSS profile has no foaf:name / pim:storage without this),
 *   3. PRINTS THE CREDENTIALS so the developer can log in immediately,
 *   4. starts the app dev server on :3200 (CSS must own :3000 — auth issuer map).
 *
 * CSS is SLOW to start (~13-15s Components.js parse) — avoid restarting it.
 * This script therefore REUSES a CSS already listening on :3000 (skipping the
 * boot and tolerating already-seeded accounts), so you can restart the app
 * freely while CSS stays up. Tip: run `node scripts/dev.mjs --no-app` once in
 * its own terminal (CSS + seeds, stays up), then start/stop the app however
 * often you like (`next dev -p 3200` or this script again).
 *
 * Usage:  node scripts/dev.mjs            # CSS (reused if up) + seed + app
 *         node scripts/dev.mjs --no-app   # CSS + seed only (keep this running)
 * package.json:  "dev": "node scripts/dev.mjs"
 * Deps: jose (dev dependency). Ctrl-C kills what THIS process started.
 */
import { spawn } from "node:child_process";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { randomUUID, createHash } from "node:crypto";

const CSS_PORT = 3000;
const APP_PORT = 3200;
const BASE = `http://localhost:${CSS_PORT}`;
const ACCOUNTS = [
  { pod: "alice", name: "Alice Dev", email: "alice@example.com", password: "alice-pass-123" },
  { pod: "bob", name: "Bob Dev", email: "bob@example.com", password: "bob-pass-123" },
];

const children = [];
const start = (cmd, args) => {
  const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
  children.push(c);
  return c;
};
process.on("SIGINT", () => { children.forEach((c) => c.kill()); process.exit(0); });

const up = async (url) => {
  for (let i = 0; i < 120; i++) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw new Error(`timed out waiting for ${url}`);
};

async function jsonPost(url, body, jar) {
  const headers = { "content-type": "application/json", ...(jar.cookie ? { cookie: jar.cookie } : {}) };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  const sc = res.headers.get("set-cookie");
  if (sc) jar.cookie = sc.split(";")[0];
  if (!res.ok) throw new Error(`${url} -> ${res.status}`); // e.g. already-seeded account on a reused CSS
  return res.json();
}

async function seed({ pod, name, email, password }) {
  const webId = `${BASE}/${pod}/profile/card#me`;
  const jar = {};
  await jsonPost(`${BASE}/.account/account/`, {}, jar);
  const { controls } = await (await fetch(`${BASE}/.account/`, { headers: { cookie: jar.cookie } })).json();
  await jsonPost(controls.password.create, { email, password }, jar);
  await jsonPost(controls.account.pod, { name: pod }, jar);
  const cc = await jsonPost(controls.account.clientCredentials, { name: "seed", webId }, jar);

  // Client-credentials DPoP token, then seed the (otherwise bare) profile.
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), alg: "ES256" };
  const proof = (htm, htu, ath) =>
    new SignJWT({ htu, htm, jti: randomUUID(), ...(ath ? { ath } : {}) })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .setIssuedAt()
      .sign(privateKey);
  const tokenEndpoint = `${BASE}/.oidc/token`;
  const basic = Buffer.from(`${encodeURIComponent(cc.id)}:${encodeURIComponent(cc.secret)}`).toString("base64");
  const tr = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      dpop: await proof("POST", tokenEndpoint),
    },
    body: "grant_type=client_credentials&scope=webid",
  });
  if (!tr.ok) throw new Error(`token ${tr.status}: ${await tr.text()}`);
  const { access_token } = await tr.json();
  const ath = createHash("sha256").update(access_token).digest("base64url");
  const profileDoc = `${BASE}/${pod}/profile/card`;
  const put = await fetch(profileDoc, {
    method: "PUT",
    headers: {
      authorization: `DPoP ${access_token}`,
      dpop: await proof("PUT", profileDoc, ath),
      "content-type": "text/turtle",
    },
    body: `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix pim: <http://www.w3.org/ns/pim/space#>.
<> a foaf:PersonalProfileDocument; foaf:maker <${webId}>; foaf:primaryTopic <${webId}>.
<${webId}> a foaf:Person;
  solid:oidcIssuer <${BASE}/>;
  pim:storage <${BASE}/${pod}/>;
  foaf:name "${name}".
`,
  });
  if (!put.ok && put.status !== 205) throw new Error(`profile PUT ${put.status}: ${await put.text()}`);
  return { webId, email, password, podRoot: `${BASE}/${pod}/` };
}

/** On the tolerant path, only claim "ready" if the pod really is seeded. */
async function verifySeeded(pod) {
  const res = await fetch(`${BASE}/${pod}/profile/card`, { headers: { accept: "text/turtle" } });
  if (!res.ok) return false;
  const ttl = await res.text();
  // CSS serialises with prefixes — match the prefixed AND full-IRI forms.
  return ttl.includes("pim:storage") || ttl.includes("pim/space#storage");
}

let cssAlreadyUp = false;
try { await fetch(`${BASE}/`); cssAlreadyUp = true; } catch { /* not running */ }
if (cssAlreadyUp) {
  console.log("♻️  reusing the CSS already on :%d (startup is slow — keep it running)", CSS_PORT);
} else {
  console.log("⏳ starting Community Solid Server (in-memory) on :%d (~15s) …", CSS_PORT);
  start("npx", ["-y", "@solid/community-server@7", "-p", String(CSS_PORT), "-l", "warn"]);
  await up(`${BASE}/`);
}

const seeded = [];
for (const account of ACCOUNTS) {
  try {
    seeded.push(await seed(account));
  } catch (e) {
    // Likely already seeded on a reused CSS — but VERIFY before claiming ready.
    if (await verifySeeded(account.pod)) {
      seeded.push({
        webId: `${BASE}/${account.pod}/profile/card#me`,
        email: account.email,
        password: account.password,
        podRoot: `${BASE}/${account.pod}/`,
      });
    } else {
      console.error(`✗ seeding ${account.pod} failed and the pod is not usable: ${e.message}`);
      console.error("  The environment is NOT ready — fix the error above and re-run.");
      children.forEach((c) => c.kill());
      process.exit(1); // never print credentials or start the app on a broken seed
    }
  }
}

console.log("\n" + "═".repeat(64));
console.log("  🟢 Solid dev environment ready — TEST ACCOUNTS (in-memory,");
console.log("     reset on restart):");
for (const a of seeded) {
  console.log("─".repeat(64));
  console.log(`   WebID:    ${a.webId}`);
  console.log(`   email:    ${a.email}`);
  console.log(`   password: ${a.password}`);
  console.log(`   pod root: ${a.podRoot}`);
}
console.log("═".repeat(64));
console.log(`   IdP / CSS UI: ${BASE}/   |   app: http://localhost:${APP_PORT}\n`);

if (!process.argv.includes("--no-app")) {
  // Default is Next.js; any framework works — set APP_CMD to your dev command,
  // e.g. APP_CMD="npx vite --port 3200" node scripts/dev.mjs
  const appCmd = process.env.APP_CMD ?? `npx next dev -p ${APP_PORT}`;
  const [cmd, ...args] = appCmd.split(" ");
  start(cmd, args);
} else {
  console.log("(--no-app: CSS only — press Ctrl-C to stop)");
}
