---
name: solid-client-id
description: >-
  Use when an app must log into Solid with a STABLE, named client identity instead of throwaway dynamic client registration — publishing a Client Identifier Document so the OIDC consent screen shows your app's name, or fixing a deployed app whose client_id keeps changing. Trigger symptoms: consent screen shows a random/blank client name or a long opaque registration id; "redirect_uri did not match"/"redirect mismatch" after deploy; "client_id must match"/"client registration client_id field must match" from CSS; "SSL is required for client_id authentication"; deciding between dynamic registration and a static client_id; serving a .jsonld client doc from Next.js/Vercel.
---

# Solid static Client Identifier Document

A **Client Identifier Document** is a dereferenceable JSON-LD document hosted by your app whose
**URL is the application's `client_id`** (Solid-OIDC §Client Identifiers,
[solidproject.org/TR/oidc#clientids](https://solidproject.org/TR/oidc#clientids)). During the
authorization-code flow the OP (the user's Solid identity provider) fetches that URL, reads the
client's metadata from it, and matches the Client-supplied `redirect_uri` against the
`redirect_uris` listed in the document. No registration call, no client secret.

## Why — static client_id vs dynamic registration

| | Dynamic client registration (the default) | Static Client Identifier Document |
|---|---|---|
| Client identity | A throwaway client minted per session by the OP | A stable URL you host — the same `client_id` forever |
| Consent screen name | Server-generated / blank — users see no recognisable app | Your `client_name`, `logo_uri`, `client_uri` on every login |
| Redirect safety | Registered ad-hoc each time | OP matches against your published `redirect_uris` |
| Setup | Zero (works out of the box) | Host one document; URL must equal `client_id` exactly |
| Best for | Quick local dev / experiments | **Any deployed app** (the user-facing default) |

Precedent: [theodi/solid-browser-extension](https://github.com/theodi/solid-browser-extension)
authenticates with a dereferenceable client identifier rather than registering dynamically.

## The document (verified template)

Verified against the published `@context`
([www.w3.org/ns/solid/oidc-context.jsonld](https://www.w3.org/ns/solid/oidc-context.jsonld)) and
the Solid-OIDC spec example, and **E2E-driven through a real CSS login** (see the verification
record in
[`../solid-reactive-authentication/webid-token-provider.e2e.md`](../solid-reactive-authentication/webid-token-provider.e2e.md)).

```json
{
  "@context": ["https://www.w3.org/ns/solid/oidc-context.jsonld"],
  "client_id": "https://app.example.com/clientid.jsonld",
  "client_name": "Your App Name",
  "redirect_uris": ["https://app.example.com/callback.html"],
  "scope": "openid webid offline_access",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "client_uri": "https://app.example.com/",
  "logo_uri": "https://app.example.com/logo.png"
}
```

### Field requirements

| Field | Required | Rule (verified) |
|---|---|---|
| `@context` | **Yes** | MUST include the string `https://www.w3.org/ns/solid/oidc-context.jsonld` (an array is fine). CSS rejects the doc without it. |
| `client_id` | **Yes** | MUST equal this document's own URL **byte-for-byte** (scheme, host, port, path, trailing slash). CSS error otherwise: *"The client registration `client_id` field must match the client ID"*. |
| `redirect_uris` | **Yes** | Array of IRIs. MUST list every callback URL the app uses; the OP matches the Client's `redirect_uri` against this list. In the context it is `@type: @id`, `@container: [@id, @set]` — so always an array of absolute URLs. |
| `scope` | Yes (for Solid) | Space-delimited string. MUST include `webid` (and `openid`). Without `webid` the token is not WebID-bound and the Pod won't treat the request as the user. |
| `grant_types` | Recommended | `["authorization_code"]`; add `"refresh_token"` if you want refresh. |
| `response_types` | Recommended | `["code"]` for the authorization-code flow. |
| `token_endpoint_auth_method` | Recommended | `"none"` — a public browser client has no secret. CSS forces this server-side regardless, but stricter OPs require you to declare it. |
| `client_name` | Optional | Shown on the consent screen. The whole point of going static. |
| `logo_uri`, `client_uri`, `tos_uri`, `policy_uri`, `contacts` | Optional | All in the context; surfaced by some consent screens. |

The full context defines exactly these terms (all under `oidc:` except `client_id` → `@id`):
`client_id, client_uri, logo_uri, policy_uri, tos_uri, redirect_uris, require_auth_time,
default_max_age, application_type, client_name, contacts, grant_types, response_types, scope,
token_endpoint_auth_method`. Anything else you add is dropped on JSON-LD expansion.

## Hosting rules

| Rule | Detail |
|---|---|
| **URL === `client_id`** | The location you serve from must equal the `client_id` value exactly. Pick the URL first, then bake it into the doc (or derive it from the request — see recipe). |
| **HTTPS in production** | The OP requires `https:` for non-local client ids. CSS makes ONE exception: `http://localhost[:port]` is allowed for dev (see findings). Anything else over HTTP → *"SSL is required for client_id authentication unless working locally."* |
| **Content-Type** | Spec: a dereferenced Client Identifier MUST be `application/ld+json` (unless content negotiation says otherwise). Set it. (Empirically CSS 7 ignores it — it `JSON.parse`s the body regardless — but stricter OPs check, so don't rely on that.) |
| **Caching** | OPs may cache the document. A short `cache-control` (e.g. `max-age=300`) lets edits propagate without forcing a re-fetch every login. |
| **Must stay reachable** | The OP fetches it live during every fresh login. If the URL 404s or moves, login breaks. |

Any host works provided the serving URL equals `client_id` and the Content-Type is right —
the recipe below is the verified Next.js/Vercel variant; adapt the same shape to your
framework's route/handler mechanism.

### Next.js / Vercel hosting recipe (verified)

Do **not** drop the file in `public/` — `next dev` serves a `public/*.jsonld` file as **404**
(empirically verified; Next's static handler doesn't map that extension). Use a **route
handler** so you control the Content-Type and can derive `client_id` from the request origin
(self-consistent across `localhost` in dev and the Vercel URL in prod):

```ts
// src/app/clientid.jsonld/route.ts  (App Router — a dot in the segment is fine; resolves to /clientid.jsonld)
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const clientId = new URL("/clientid.jsonld", request.url).toString(); // URL === client_id
  const callback = new URL("/callback.html", request.url).toString();
  const document = {
    "@context": ["https://www.w3.org/ns/solid/oidc-context.jsonld"],
    client_id: clientId,
    client_name: "Your App Name",
    redirect_uris: [callback],
    scope: "openid webid offline_access",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_uri: new URL("/", request.url).toString(),
  };
  return new Response(JSON.stringify(document, null, 2), {
    status: 200,
    headers: { "content-type": "application/ld+json", "cache-control": "public, max-age=300" },
  });
}
```

A static-export site can instead ship a real file at the exact path, served with
`application/ld+json` (configure your host's MIME mapping for `.jsonld`).

## Wiring into the bundled provider

The published `@solid/reactive-authentication` **`DPoPTokenProvider` (0.1.2) has no static
client_id hook** — its constructor is `(callbackUri, getCodeCallback)`, full stop, and it always
dynamically registers. Use the bundled
[`WebIdDPoPTokenProvider`](../solid-reactive-authentication/webid-token-provider.ts) (companion
skill `solid-reactive-authentication`), which adds an optional `clientId`:

```ts
import { WebIdDPoPTokenProvider, promptWebIdDialog } from "@/lib/webid-token-provider";

new ReactiveFetchManager([
  new WebIdDPoPTokenProvider(
    new URL("/callback.html", location.href).toString(),
    ui.getCode.bind(ui),
    promptWebIdDialog,
    {
      clientId: new URL("/clientid.jsonld", location.href).toString(), // ← static client id
      allowInsecureLoopback: true,  // local CSS over HTTP; remote issuers stay HTTPS-strict
    },
  ),
]);
```

When `clientId` is set the provider **skips dynamic registration** and authenticates as a public
client whose `client_id` is that URL with `token_endpoint_auth_method: "none"`. When `clientId`
is **absent** it falls back to dynamic registration — so the same provider serves both modes.

## Where a static client id can — and cannot — work

The IdP must **dereference** the `client_id` URL during login. That single fact decides every
combination:

| App runs at | IdP | Static client id? |
|---|---|---|
| `localhost` | **local CSS** | ✅ `http://localhost:<port>/clientid.jsonld` — CSS's explicit localhost exception (verified) |
| `localhost` | **live server** (solidcommunity.net, PodSpaces, any hosted IdP) | ❌ **Impossible.** The remote IdP cannot reach your `localhost` document, and rejects non-HTTPS client ids anyway. **Use dynamic registration for this combination** — omit `clientId`. |
| Deployed (HTTPS) | live server | ✅ The production default — `https://your-app.vercel.app/clientid.jsonld` |

So the development progression is: local dev against local CSS may use the static path;
**initial testing against live servers from localhost runs with dynamic registration**; the
static client id becomes permanent once the app is deployed to a public HTTPS URL. Don't fight
this — no tunnel-free workaround exists, and the failure mode (IdP can't fetch the doc) wastes
hours if you expect it to work.

## Gotchas

| Gotcha | Symptom | Fix |
|---|---|---|
| `client_id` ≠ document URL | *"The client registration `client_id` field must match the client ID"* | Make `client_id` equal the served URL byte-for-byte (watch trailing slash, port, `http`/`https`). Deriving it from `request.url` avoids drift. |
| Missing `webid` scope | Login "works" but Pod reads are still 401 / treated as public | Put `webid` (and `openid`) in `scope`. |
| `redirect_uri` not listed | *"redirect_uri did not match"* after deploy | Add the deployed callback (and every environment's callback) to `redirect_uris`. |
| Wrong / no Content-Type | Some OPs reject the doc (CSS tolerates it) | Serve `application/ld+json`. |
| HTTP in production | *"SSL is required for client_id authentication unless working locally."* | Use HTTPS for any non-`localhost` client id. |
| Stale cache after editing the doc | OP keeps using the old metadata | Lower `cache-control max-age`; bump it back up once stable. |
| Using published `DPoPTokenProvider` and expecting static client_id | Always dynamically registers; no name on consent | 0.1.2 has no hook — use the bundled `WebIdDPoPTokenProvider` with `clientId`. |
| Static `localhost` client id against a **live** IdP | Login fails — the IdP cannot fetch your document | Impossible combination; use dynamic registration until the app is deployed (see the matrix above). |
| Dropped doc in `public/*.jsonld` | 404 in `next dev` | Use a route handler (recipe above). |
