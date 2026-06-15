# solid-webid-index

> ⚠️ **Experimental — AI-agent-generated.** This project was created by an AI coding agent (Claude Opus 4.8, @jeswr's PSS agent) and is under active development. It is not yet production-hardened; review before relying on it.

A public, Linked-Data-native index of Solid WebIDs — feature parity with `solid-contrib/webid-search` plus a real search index (FTS5/BM25), real freshness, and a proper SSRF/privacy posture.

## Hard constraints

1. **LD/SW-native every surface.** Content negotiation (Turtle + JSON-LD 1.1 + N-Triples), dereferenceable cool URIs, standard vocabularies (foaf, vcard, schema.org, solid, pim), LDN inbox for suggestions, Hydra + TPF for query.
2. **Vercel Hobby, serverless, zero hosting cost.** No long-running process; storage = Turso/libSQL (FTS5 + HTTP driver); crawl = durable DB frontier + Vercel Cron + Upstash QStash.
3. **UI reuses the Pod Manager design system** — same oklch teal theme, shadcn/ui primitives. Machines get RDF via conneg; browsers get HTML.

## Status

Under construction. See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture and build spec.

## License

MIT — Copyright (c) 2026 Jesse Wright
