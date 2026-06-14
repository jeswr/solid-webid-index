---
name: solid-server-matrix
description: >-
  Use when a Solid app works on one server and breaks on another — auth succeeds on PodSpaces but CSS rejects 'iat is not recent enough', 403 on PATCH after writing an ACL, missing type indexes, 500 on PUT, notifications that won't subscribe, or an apparent CORS error. Differential reference for CSS / ESS / NSS with runtime detection.
---

# Solid server matrix

Solid is a protocol with several independent server implementations, and they
diverge in ways the spec permits or doesn't yet pin down. An app written and
tested against one server silently depends on that server's behaviour. This
skill is the differential model: **identify which server you're on, then branch.**

It assumes the house stack from [`AGENTS.md`](../../AGENTS.md):
`@solid/reactive-authentication` (auth, DPoP), `@jeswr/fetch-rdf` (fetch+parse),
`@solid/object` + `@rdfjs/wrapper` (typed RDF), `n3`. Never `@inrupt/*`,
`@ldo/*`, or hand-built triples. RDF mutations go through `TermWrapper`
subclasses. This skill diagnoses *server* behaviour; it does not change the
client libraries.

Local two-instance setup (one WAC, one ACP CSS) is in AGENTS.md §"Servers —
develop, test, release". Exercise both from day one.

---

## The implementations

| Short | Full name | Maintainer | Status |
|---|---|---|---|
| **CSS** | Community Solid Server | Ruben Verborgh / university lab | Active, spec-tracking; house default for local dev |
| **ESS** | Enterprise Solid Server | Inrupt | Active, commercial; backs Inrupt PodSpaces |
| **NSS** | node-solid-server | Solid community | **Legacy** — preceded CSS, non-conformant in places; avoid for new work |

Authorship + "ACL implemented for NSS, ACP on ESS" confirmed:
[forum/bridging-solid-with-peergos/5494](https://forum.solidproject.org/t/bridging-solid-with-peergos/5494).
"NSS isn't an Inrupt product, it is a legacy community project that preceded CSS":
[forum/usage-of-as-uri/6462](https://forum.solidproject.org/t/usage-of-as-uri-www-authenticate-parameter/6462).

The canonical list of what is deployable and deployed is
[solidproject.org/users/get-a-pod](https://solidproject.org/users/get-a-pod). It names **six
self-hostable implementations** — CSS, ESS,
[Trinpod](https://graphmetrix.com/trinpod-server),
[Manas](https://manomayam.github.io/manas/introduction.html), NSS, and
[PHP Solid Server](https://pdsinterop.org/php-solid-server/) — of which this matrix
characterises the three you will meet at a hackathon (CSS / ESS / NSS); treat the other three
as "detect at runtime" (next section).

### Hosted providers (get-a-pod, June 2026 × [solid/catalog](https://github.com/solid/catalog) `catalog-data.ttl`)

| Provider | Operator | Region | Implementation (per catalog) |
|---|---|---|---|
| `solidcommunity.net` | Solid Project | UK | **Pivot** (CSS remix) + SolidOS |
| Inrupt Pod Spaces (`storage.inrupt.com`) | Inrupt | US, EU, APAC | **ESS** |
| `*.inrupt.net` | Inrupt | — | NSS (legacy) — *community knowledge, not in catalog* |
| Data Pod (`datapod.igrant.io`) | iGrant.io | EU | **NSS** |
| `redpencil.io` | redpencil.io | EU | **CSS** |
| `solidcommunity.au` | Solid Community AU | Australia | *not in catalog* |
| `solidweb.me` | Meisdata | EU | **CSS** + SolidOS |
| `teamid.live` | Meisdata | EU | **Pivot** + SolidOS (catalog status: Exploration) |
| `solidweb.app` | Meisdata | EU | *not in catalog* |
| `solidweb.org` | Solid Grassroots | EU | **NSS** + SolidOS (catalog status: Exploration) |
| `trinpod.eu` / `trinpod.us` | Graphmetrix | EU / US | **Trinpod** |
| `use.id` | Digita | EU | **CSS** |
| `localhost:3000` (default config) | you | — | local CSS (this repo's AGENTS.md) |

Most hosted pods run CSS or its Pivot remix — but **two get-a-pod providers run legacy NSS**
(Data Pod, solidweb.org), so the NSS column of the matrix is live, not historical. Use the
table as the first guess, then **confirm at runtime** (next section); never branch on the
hostname alone. The final-stage test matrix in `AGENTS.md` §Servers is exactly this provider
list.

---

## Compatibility matrix

Branch on these. Each cell carries evidence or is marked **[unverified]**.

| Dimension | CSS | ESS | NSS (legacy) |
|---|---|---|---|
| **Auth** | Solid-OIDC + DPoP, strict | Solid-OIDC + DPoP | Older WebID-OIDC; non-conformant discovery [u] |
| **DPoP `iat` unit** | **Rejects ms** — needs seconds¹ | **Tolerates anything** (ms, 0, future) ¹ | unverified |
| **DPoP `ath` enforcement** | varies — a strict RS rejects an `ath`-less proof ¹⁰ | tolerant ¹⁰ | unverified |
| **UMA `as_uri` in `WWW-Authenticate`** | Implemented (per thread) ² | Yes — UMA-compliant ² | No ² |
| **Access control** | WAC (`.acl`) default ³ | ACP (`.acr`) ³ | WAC (`.acl`) ³ |
| **Type-index auto-seed** | **No** — app must create + link ⁴ | unverified (commonly seeded) [u] | NSS historically seeds [u] |
| **Content-Type required on write** | strict per protocol ⁵ | strict | **5.x: 500 without it** ⁵ |
| **ETag reliability** | available | available [u] | **Not supported** ⁶ |
| **Notifications** | Notifications Protocol / `WebSocketChannel2023` ⁷ | `@inrupt/solid-client-notifications` (ESS-only) ⁸ | legacy `wss://` channel ⁸ |
| **Large-container listing** | slow at scale (LDP) [u] | slow at scale [u] | very slow; glob OOMs; no SPARQL ⁹ |

[u] = unverified in this trawl. Footnotes:

1. DPoP proof `iat` must be **seconds** since epoch (`Math.floor(Date.now()/1000)`),
   not ms. ESS "doesn't appear to check the IAT at all"; CSS rejects with
   `400 invalid_dpop_proof / "iat is not recent enough"`.
   [forum/.../dpop-rejects-iat-on-community-solid-server/7444](https://forum.solidproject.org/t/solid-oidc-primer-works-great-for-inrupt-pods-but-dpop-rejects-iat-on-community-solid-server/7444).
   The house auth lib (`@solid/reactive-authentication`) gets this right — if you
   hit it, suspect a *second* auth layer you added (AGENTS.md §Authentication).
2. ESS "returns a UMA-compliant `WWW-Authenticate` header with an `as_uri`
   parameter on unauthenticated requests"; NSS does not; CSS has since implemented
   it. [forum/usage-of-as-uri/6462](https://forum.solidproject.org/t/usage-of-as-uri-www-authenticate-parameter/6462).
3. WAC on NSS+CSS, ACP on ESS:
   [forum/bridging-solid-with-peergos/5494](https://forum.solidproject.org/t/bridging-solid-with-peergos/5494),
   [forum/solid-servers-and-custom-ontologies/7208](https://forum.solidproject.org/t/solid-servers-and-custom-ontologies/7208).
   Deployment count (March 2026 community survey): WAC 13 implementations / 11 live; ACP 4 / 1.
4. CSS does not provision type-index / preferences / inbox: "things like
   typeIndexes and preferences and even the inbox are not available." TBL, asked
   whether apps should create them: "Yes" … "The same place they are now."
   [forum/data-discovery-on-community-solid-server/4695](https://forum.solidproject.org/t/data-discovery-on-community-solid-server/4695).
   Convention, not server-enforced: "a type index is not enforced by the server, it
   requires each app to enforce the type index."
   [forum/solid-interop-in-practice/7701](https://forum.solidproject.org/t/solid-interop-in-practice/7701).
5. "Version 5.x NSS currently gives a 500 error for attempts to create a resource
   without a content-type … it is actually invalid to try to create a resource
   without a specified content-type."
   [forum/handling-duplicate-file-names/2016](https://forum.solidproject.org/t/handling-duplicate-file-names/2016).
   Also: force `Content-Type` on Turtle writes or it is parsed as N3:
   [forum/create-a-acl-with-solid-file-client/1538](https://forum.solidproject.org/t/create-a-acl-with-solid-file-client/1538).
6. "ETags are not supported in node-solid-server."
   [forum/state-of-the-art-for-querying-large-containers/3320](https://forum.solidproject.org/t/state-of-the-art-for-querying-large-containers/3320).
   Implication for the conditional-PUT write path: NSS may give you no ETag, so
   `If-Match` is unavailable — handle a `null` etag (AGENTS.md §Writing data).
7. WebSocketChannel2023 type IRI `http://www.w3.org/ns/solid/notification#WebSocketChannel2023`:
   [spec](https://solid.github.io/notifications/websocket-channel-2023). Discovery
   via `Link rel="describedby"` (resource) / `rel="…#storageDescription"` (storage):
   [Solid Notifications Protocol](https://solidproject.org/TR/notifications-protocol).
8. "currently `@inrupt/solid-client-notifications` only works with ESS"; NSS uses an
   older websocket "and I don't know if it will be ported." Do **not** adopt that
   Inrupt lib (banned stack); use plain WebSocket + discovery.
   [forum/does-solid-client-notifications-only-works-with-ess-pods/5401](https://forum.solidproject.org/t/does-solid-client-notifications-only-works-with-ess-pods/5401).
9. 1411 documents: container GET "takes more than a second", loading all ~3 min;
   glob "500 error (probably … out-of-memory)"; "SPARQL is still not supported".
   [forum/state-of-the-art-for-querying-large-containers/3320](https://forum.solidproject.org/t/state-of-the-art-for-querying-large-containers/3320).
   That thread's OP worked around it by **local caching, not sharding** — sharding is
   a design recommendation, not a quoted fix.
10. RFC 9449 DPoP defines an optional `ath` claim (base64url SHA-256 of the access
    token) that binds a proof to one specific token. Several **deployed Solid apps
    send proofs without `ath`** (observed: Penny, Pod Drive, Tired Bike), so an RS
    that strictly enforces `ath` rejects their requests — login succeeds but every
    read/write 401s. ESS-style verifiers tolerate the omission; a strict
    `oauth4webapi`-based RS does not unless it opts to accept an *absent* (never a
    *wrong*) `ath`. You won't hit this from the house stack —
    `@solid/reactive-authentication` is the proof generator, not the verifier — but
    know it when integrating a third-party app against a strict server, or when your
    own app talks to a server that enforces it. (Observed during prod-solid-server
    app-compatibility testing; the RFC-9449 `ath` requirement is
    [§4.2/§7.1](https://www.rfc-editor.org/rfc/rfc9449#section-4.2).)

---

## Runtime detection — what am I talking to?

Don't trust the hostname. Probe the live server.

**1. Access-control language (WAC vs ACP).** GET (or HEAD) the resource and read
its `Link: <…>; rel="acl"` header — never guess the URL. Then fetch that document
and inspect it: WAC documents use `acl:` (`AclResource`/`Authorization`); ACP
documents use `acp:` (`AccessControlResource`/`Policy`/`Matcher`). The local ACP
CSS instance in AGENTS.md advertises `Link: <…/.acr>; rel="acl"`. Parse only
through `@solid/object`'s typed classes; convert with `wacToAcp` / `acpToWac` —
never hand-parse the Turtle.

**2. Auth model (Solid-OIDC + UMA).** Hit a protected resource unauthenticated and
read `WWW-Authenticate`. An `as_uri=` parameter → UMA flow (ESS). Absent → plain
Solid-OIDC. Parse the header with the `content-type`-style approach, not regex
guessing.

**3. Notifications.** GET the resource and the storage root; look for
`Link rel="describedby"` (resource-level subscription service) and
`rel="…/solid/terms#storageDescription"` (storage-level). Fetch the description,
read the offered `notify:channelType`; branch CSS-modern (`WebSocketChannel2023`)
vs NSS-legacy (`wss://`). Discovery, not hardcoded endpoints.

**4. ETag presence.** First write returns the ETag (or doesn't, on NSS). If `null`,
skip `If-Match` and accept last-write-wins, or refuse to write — your call, but
detect it; don't assume an ETag exists.

---

## "Where does this app's data live?" — decision tree

For a hackathon or first integration:

1. **Local CSS, in-memory** (AGENTS.md). Two instances, WAC + ACP. Disposable,
   pristine on restart, both auth languages from day one. Default for build/iterate.
2. **solidcommunity.net** (hosted CSS) — real-network smoke test, WAC. Community
   service, **no SLA**. On the auth issuer list.
3. **Inrupt PodSpaces** (ESS) — the *only* place you exercise **ACP + UMA `as_uri`**
   in production. On the auth issuer list. Catches WAC-only code that breaks on ESS.
4. **NSS / inrupt.net** — only if you must interop with a legacy pod. Expect
   non-conformant OIDC discovery, no ETags, 500-without-Content-Type. New work: avoid.

Rule: if it works on CSS **and** ESS, it works almost everywhere; testing one alone
hides the WAC↔ACP and DPoP-strictness divergences above.

---

## Common misdiagnoses

- **"CORS error."** Most browser-reported CORS failures on Solid are really a
  **401 surfaced as CORS**, or a reverse proxy in front of self-hosted CSS
  stripping `Access-Control-Allow-*` / `-Expose-Headers` (notably the auth and
  `Location` headers). Solid *mandates* permissive CORS by design — security rests
  on WAC/OIDC, not origin. Check the actual status and the proxy before chasing CORS
  config. *The canonical working proxy snippet was **not** found in the forum trawl
  (it lives in CSS GitHub Discussions) — unverified here.*
  ([forum/cors-error-in-solidserver/6549](https://forum.solidproject.org/t/cors-error-in-solidserver/6549),
  [forum/noobie-question-isnt-it-really-bad-to-mandate-permissive-cors/3439](https://forum.solidproject.org/t/noobie-question-isnt-it-really-bad-to-mandate-permissive-cors/3439))
- **"Auth works on PodSpaces, breaks on CSS with `iat is not recent enough`."** A
  DPoP proof carrying `iat` in ms. ESS tolerates it, CSS rejects it. See footnote 1.
- **`403` on PATCH right after writing an ACL.** URI-unsafe characters — notably a
  colon `:` — in the resource name break ACL matching (encoded-vs-unencoded
  mismatch). Rename to URI-safe characters.
  [forum/error-403-for-patch-after-creating-document-acl/3426](https://forum.solidproject.org/t/error-403-for-patch-after-creating-document-acl/3426).
- **Type-index reads return nothing / writes have nowhere to go.** CSS didn't seed
  the index; your app must create-and-link it. Footnote 4.
- **`500` on PUT.** NSS 5.x with no `Content-Type`. Always send it. Footnote 5.
- **Session dropped after navigation/reload.** A hard reload drops in-memory tokens;
  full-page reloads destroy the auth context. Use client-side navigation; the house
  auth lib re-runs `prompt=none` silently while the IdP cookie lives (AGENTS.md
  §Authentication).
  [forum/losing-session-when-going-to-different-page-after-login/5077](https://forum.solidproject.org/t/losing-session-when-going-to-different-page-after-login/5077).
- **Container request 301-redirects / relative IRIs resolve wrong.** Missing trailing
  slash. Container URLs end in `/`; the IdP/login URL is **not** the container URL.
  [forum/basic-question-about-url-to-use-when-making-a-request/4605](https://forum.solidproject.org/t/basic-question-about-url-to-use-when-making-a-request/4605).
