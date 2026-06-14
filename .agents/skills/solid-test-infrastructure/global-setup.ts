// Runs once after webServer (CSS + Next) are up. Creates a fresh test account + pod and seeds
// the profile (foaf:name + pim:storage + photo) via a client-credentials DPoP PUT — a freshly
// created CSS pod profile has NONE of those (verified). Self-contained: a cross-file .ts/.mjs
// import from here trips Playwright's config transpiler (CJS/ESM mismatch), so it's all inline.
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { randomUUID, createHash } from "node:crypto";

const BASE = "http://localhost:3000";
const ISSUER = `${BASE}/`;
const TOKEN_ENDPOINT = `${BASE}/.oidc/token`;
const POD = "alice";
const WEBID = `${BASE}/${POD}/profile/card#me`;
const NAME = "Alice Verify";
const EMAIL = "alice@example.com";
const PASSWORD = "test-password-123";

interface Jar {
  cookie?: string;
}

async function jsonPost(url: string, body: unknown, jar: Jar) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jar.cookie) headers.cookie = jar.cookie;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  const sc = res.headers.get("set-cookie");
  if (sc) jar.cookie = sc.split(";")[0];
  return { status: res.status, json: await res.json() };
}

async function controls(jar: Jar) {
  const res = await fetch(`${BASE}/.account/`, {
    headers: jar.cookie ? { cookie: jar.cookie } : {},
  });
  return (await res.json()).controls;
}

async function seedProfile(ccId: string, ccSecret: string) {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "ES256";
  const proof = (method: string, url: string, ath?: string) =>
    new SignJWT({ htu: url, htm: method, jti: randomUUID(), ...(ath ? { ath } : {}) })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .setIssuedAt()
      .sign(privateKey);

  const basic = Buffer.from(
    `${encodeURIComponent(ccId)}:${encodeURIComponent(ccSecret)}`,
  ).toString("base64");
  const tr = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      dpop: await proof("POST", TOKEN_ENDPOINT),
    },
    body: "grant_type=client_credentials&scope=webid",
  });
  if (!tr.ok) throw new Error(`token ${tr.status}: ${await tr.text()}`);
  const { access_token } = await tr.json();
  const ath = createHash("sha256").update(access_token).digest("base64url");

  const profileDoc = `${BASE}/${POD}/profile/card`;
  const turtle = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix pim: <http://www.w3.org/ns/pim/space#>.
@prefix vcard: <http://www.w3.org/2006/vcard/ns#>.
<> a foaf:PersonalProfileDocument; foaf:maker <${WEBID}>; foaf:primaryTopic <${WEBID}>.
<${WEBID}> a foaf:Person;
  solid:oidcIssuer <${ISSUER}>;
  pim:storage <${BASE}/${POD}/>;
  foaf:name "${NAME}";
  vcard:hasPhoto <https://avatars.githubusercontent.com/u/9132?v=4>.
`;
  const put = await fetch(profileDoc, {
    method: "PUT",
    headers: {
      authorization: `DPoP ${access_token}`,
      dpop: await proof("PUT", profileDoc, ath),
      "content-type": "text/turtle",
    },
    body: turtle,
  });
  if (!put.ok && put.status !== 205) {
    throw new Error(`seed profile PUT ${put.status}: ${await put.text()}`);
  }
}

export default async function globalSetup() {
  // Guard: make sure :3000 is actually a CSS — a stray dev server (e.g. a `next dev`
  // with its default port) answers 200 on "/" and poisons everything downstream
  // with cryptic 308/HTML responses.
  const probe = await fetch(`${BASE}/.account/`, { headers: { accept: "application/json" } });
  if (!probe.ok || !(probe.headers.get("content-type") ?? "").includes("json")) {
    throw new Error(
      `Whatever is listening on ${BASE} is not a Community Solid Server ` +
        `(/.account/ -> ${probe.status} ${probe.headers.get("content-type")}). ` +
        `Check 'lsof -i :3000' — a stray 'next dev' (default port 3000) is the usual culprit.`,
    );
  }
  const jar: Jar = {};
  await jsonPost(`${BASE}/.account/account/`, {}, jar);
  const c = await controls(jar);
  await jsonPost(c.password.create, { email: EMAIL, password: PASSWORD }, jar);
  const pod = await jsonPost(c.account.pod, { name: POD }, jar);
  if (pod.status >= 400) throw new Error(`pod create failed: ${JSON.stringify(pod.json)}`);
  const cc = await jsonPost(c.account.clientCredentials, { name: "seed", webId: WEBID }, jar);
  await seedProfile(cc.json.id, cc.json.secret);
  // eslint-disable-next-line no-console
  console.log(`[global-setup] seeded pod for ${WEBID}`);
}
