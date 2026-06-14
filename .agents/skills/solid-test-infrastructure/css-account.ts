/**
 * css-account.ts — per-test CSS account fixture. Creates a fresh account + pod
 * (and optionally seeds the profile with foaf:name + pim:storage, which fresh
 * CSS pods lack) so write-heavy tests get isolation without restarting CSS.
 *
 * Usage in a spec:
 *   const acct = await createCssAccount({ pod: `w${testInfo.workerIndex}-${Date.now()}` });
 *   // acct.webId / acct.email / acct.password / acct.podRoot / acct.token (DPoP-bound)
 *
 * Deps: jose (dev). Companion to global-setup.ts / dev.mjs in this skill —
 * same verified account-API recipe, packaged per-test.
 */
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { randomUUID, createHash } from "node:crypto";

export interface CssAccountOptions {
  base?: string;        // CSS base URL; default http://localhost:3000
  pod: string;          // pod name — MUST be unique per call (CSS rejects duplicates)
  name?: string;        // foaf:name to seed; default derived from pod
  email?: string;       // default `${pod}@example.com`
  password?: string;    // default `${pod}-pass-123`
  seedProfile?: boolean; // default true — add foaf:name + pim:storage to the bare profile
}

export interface CssAccount {
  webId: string;
  email: string;
  password: string;
  podRoot: string;
  /** DPoP-bound access token (client-credentials) for fixture reads/writes. */
  token: string;
  /** Mint a DPoP proof for a request with this account's key (htu/htm + ath). */
  proof: (method: string, url: string) => Promise<string>;
}

interface Jar { cookie?: string }

async function jsonPost(url: string, body: unknown, jar: Jar): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jar.cookie) headers.cookie = jar.cookie;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  const sc = res.headers.get("set-cookie");
  if (sc) jar.cookie = sc.split(";")[0];
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function createCssAccount(options: CssAccountOptions): Promise<CssAccount> {
  const base = options.base ?? "http://localhost:3000";
  const pod = options.pod;
  const email = options.email ?? `${pod}@example.com`;
  const password = options.password ?? `${pod}-pass-123`;
  const name = options.name ?? `Test ${pod}`;
  const webId = `${base}/${pod}/profile/card#me`;
  const podRoot = `${base}/${pod}/`;

  // 1. account -> password -> pod -> client credentials (the verified recipe)
  const jar: Jar = {};
  await jsonPost(`${base}/.account/account/`, {}, jar); // send {} — with content-type: application/json, an EMPTY body 500s
  const { controls } = (await (
    await fetch(`${base}/.account/`, { headers: jar.cookie ? { cookie: jar.cookie } : {} })
  ).json()) as { controls: { password: { create: string }; account: { pod: string; clientCredentials: string } } };
  await jsonPost(controls.password.create, { email, password }, jar);
  await jsonPost(controls.account.pod, { name: pod }, jar);
  const cc = (await jsonPost(controls.account.clientCredentials, { name: "fixture", webId }, jar)) as {
    id: string; secret: string;
  };

  // 2. exchange for a DPoP-bound token
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), alg: "ES256" };
  const mintProof = (htm: string, htu: string, ath?: string) =>
    new SignJWT({ htu, htm, jti: randomUUID(), ...(ath ? { ath } : {}) })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .setIssuedAt()
      .sign(privateKey);
  const tokenEndpoint = `${base}/.oidc/token`;
  const basic = Buffer.from(
    `${encodeURIComponent(cc.id)}:${encodeURIComponent(cc.secret)}`,
  ).toString("base64");
  const tokenRes = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      dpop: await mintProof("POST", tokenEndpoint),
    },
    body: "grant_type=client_credentials&scope=webid",
  });
  if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}: ${await tokenRes.text()}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const ath = createHash("sha256").update(access_token).digest("base64url");
  const proof = (method: string, url: string) => mintProof(method, url, ath);

  // 3. seed the bare profile (skippable when a custom pod template already does this)
  if (options.seedProfile !== false) {
    const profileDoc = `${base}/${pod}/profile/card`;
    const put = await fetch(profileDoc, {
      method: "PUT",
      headers: {
        authorization: `DPoP ${access_token}`,
        dpop: await proof("PUT", profileDoc),
        "content-type": "text/turtle",
      },
      body: `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix pim: <http://www.w3.org/ns/pim/space#>.
<> a foaf:PersonalProfileDocument; foaf:maker <${webId}>; foaf:primaryTopic <${webId}>.
<${webId}> a foaf:Person;
  solid:oidcIssuer <${base}/>;
  pim:storage <${podRoot}>;
  foaf:name "${name}".
`,
    });
    if (!put.ok && put.status !== 205) {
      throw new Error(`profile seed ${put.status}: ${await put.text()}`);
    }
  }

  return { webId, email, password, podRoot, token: access_token, proof };
}
