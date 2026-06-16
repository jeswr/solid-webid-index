# solid-webid-index

> ⚠️ **Experimental — AI-agent-generated.** This project was created by an AI coding agent (Claude Opus 4.8, @jeswr's PSS agent) and is under active development. It is not yet production-hardened; review before relying on it.

A public, Linked-Data-native index of Solid WebIDs — feature parity with `solid-contrib/webid-search` plus a real search index (Postgres full-text search), real freshness, and a proper SSRF/privacy posture.

## Hard constraints

1. **LD/SW-native every surface.** Content negotiation (Turtle + JSON-LD 1.1 + N-Triples), dereferenceable cool URIs, standard vocabularies (foaf, vcard, schema.org, solid, pim), LDN inbox for suggestions, Hydra + TPF for query.
2. **Vercel Hobby, serverless, zero hosting cost.** No long-running process; storage = Neon (serverless Postgres; native `tsvector` FTS; pglite in tests); crawl = durable DB frontier + Vercel Cron + self-chaining bounded batches. (See the `docs/DESIGN.md` decision addendum — this supersedes the earlier Turso/libSQL + QStash plan.)
3. **UI reuses the Pod Manager design system** — same oklch teal theme, shadcn/ui primitives. Machines get RDF via conneg; browsers get HTML.

## Status

Under active development. The Linked-Data server surfaces are in place — the SSRF-guarded
crawler, the LDN suggest inbox (`POST /inbox/`), content-negotiated entry (`/p/{slug}`,
`/lookup`), Hydra search (`/search`), Triple Pattern Fragments (`/tpf`), the VoID/DCAT dataset
description (`/.well-known/void`), the minted `idx:` namespace (`/ns`), opt-out/erasure
(`/optout`), and a liveness probe (`GET /.well-known/health`).

### Consuming the index from an app

A framework-agnostic consumer client (`src/lib/client`) turns those RDF surfaces into UI-ready
plain objects, so an app (the Pod Manager, any suite app) consumes the index without
re-implementing RDF parsing, Hydra pagination, or the AS2 suggest POST:

```ts
import { createIndexClient } from "solid-webid-index/client"; // src/lib/client

const idx = createIndexClient({ origin: process.env.NEXT_PUBLIC_WEBID_INDEX ?? "" });
if (idx) {
  const page = await idx.search("alice");           // { entries: IndexEntry[]; next: string | null }
  if (page.next) await idx.fetchPage(page.next);     // opaque hydra:next, followed same-origin only
  await idx.isIndexed("https://alice.pod/card#me");  // /lookup 303 → true
  await idx.suggestWebId("https://bob.pod/card#me", { actor: myWebId }); // AS2 Announce → /inbox/
  await idx.checkHealth();                           // /.well-known/health liveness
}
```

`createIndexClient` returns `null` when no origin is configured, so the whole integration is
gated on a single env var. The client never attaches credentials cross-origin and rejects a
cross-origin `hydra:next` or a non-`https:` photo URL.

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture and build spec.

## License

MIT — Copyright (c) 2026 Jesse Wright
