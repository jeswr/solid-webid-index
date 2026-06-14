---
name: solid-scale-and-sharding
description: >-
  Use when deciding how to lay out an app's data across pod documents — how many documents,
  when to split, where collection data goes (notes, bookmarks, messages, chat) — or when reads
  have grown slow (a flat container heading past hundreds of members, a monolithic file
  re-downloaded on every view, wanting SPARQL over a pod). Covers the one-document default,
  permission-driven splitting, interop with existing Solid data models, and the hard limits.
---

# Solid document layout, scale, and sharding

A Solid pod is a **document store, not a query engine**. There is no `WHERE`, no `ORDER BY`, no
`LIMIT` you can push to the server. Layout is therefore a design decision you make up front —
and the first rule is to keep it simple.

This skill assumes the house stack in [`AGENTS.md`](../../AGENTS.md): read/parse with
`@jeswr/fetch-rdf`, typed access via `@solid/object` + `@rdfjs/wrapper`, mutations through
`TermWrapper` subclasses, conditional `PUT` writes. Never hand-built triples, never
`@inrupt/*` / `@ldo/*`.

## Rule 1 — start with one document

**The main reason to split data across documents is access control**: permissions apply
per-resource, so data with different audiences needs different documents. The corollary: while
your app's data all shares one audience — which is normal in early development — **put it all
in a single document**. One read, one write, one ETag, trivially consistent, easy to inspect.

Split when (in priority order):

1. **Permissioning** — part of the data needs a different audience (shared with another user,
   public, app-private). Split along the permission boundary, nothing else.
2. **Interop** — an existing Solid data model prescribes a layout (see Rule 2); follow it.
3. **Size/performance** — the single document is genuinely too big to re-download/re-PUT per
   interaction (a deployed bookmark collection famously hit ~12 MB
   ([forum 6886](https://forum.solidproject.org/t/social-bookmarking-as-an-example-where-we-need-queries-instead-of-documents/6886))).
   This comes *last* — don't pre-shard for scale you don't have.

## Rule 2 — reuse existing Solid data models before designing a layout

If the functionality you're building exists in the Solid ecosystem, **use its data model and
storage pattern** so your app interoperates with deployed apps rather than creating a private
silo:

- **Chat**: follow the [chat client-to-client specification](https://github.com/solid/chat) —
  same model and layout as existing Solid chat apps.
- **Shapes for common domains** — chat, bookmarks, address books, people, events, meetings,
  issue tracking — are in the
  [Solid SHACL Shapes Catalogue](https://github.com/solid/shapes) (`chat.ttl`, `bookmark.ttl`,
  `address_book.ttl`, …). Conform to them.
- Survey what deployed apps do: [solidproject.org/apps](https://solidproject.org/apps).

See `docs/data-modelling.md` in this repo for vocabulary selection; this rule is about
*document layout* matching the ecosystem.

## When you do split: shard along meaningful boundaries

Once a split is justified, keep each container to **hundreds of members, not thousands** —
listing cost grows with membership, and a 1,411-document container took >1 s to list and ~3
minutes to load fully
([forum 3320](https://forum.solidproject.org/t/state-of-the-art-for-querying-large-containers/3320)).

| Strategy | Layout | Use when |
|---|---|---|
| By permission boundary | `shared/<id>.ttl` vs `private/notes.ttl` | Always first — mirrors who can see what |
| By date | `messages/2026/06/<id>.ttl` | Append-mostly time series (chat, logs); gives natural pagination |
| By hash | `bookmarks/a3/<id>.ttl` | Random access by id, no time dimension; fixed fan-out |

- **Container URLs end in `/`** — always.
- Derive paths from the pod root discovered via `pim:storage` (`agent.storageUrls` — if there
  are several, the user chooses), under a path your app owns.
- Create intermediate containers explicitly; don't assume deep paths auto-create everywhere.

## Finding data again: the Type Index

Use the **Solid Type Index** as the locator — register each class of data your app stores
(`solid:forClass` → `solid:instance`/`solid:instanceContainer`) and look data up the same way.
That is its job, it is the ecosystem's shared discovery mechanism, and it covers most needs —
see the companion `solid-type-index` skill for the read/write/bootstrap implementation.

Only if your UI needs ordered, field-level access the Type Index cannot express (sort by date
across shards, filter by tag) keep a *small* app-maintained summary resource alongside the data
— update it in the same read-modify-write cycle as the record, through a `TermWrapper`
subclass, and treat it as rebuildable from a container walk. Prefer not to need one.

## Querying: keep expectations low

There is no server-side SPARQL on standard pods. If you genuinely need ad-hoc queries across
pod documents, [Comunica](https://comunica.dev/) can evaluate SPARQL client-side by traversing
links — but it is **slow and rough; not a robust foundation**. Keep it for exploration and
one-off reads, never on a render-blocking path. Design reads around your layout (Rules 1–2 +
the Type Index) instead.

## Hard limits to design around

| Limit | Implication | Evidence |
|---|---|---|
| No server-side SPARQL | All filtering/sorting is client-side | [forum 3320](https://forum.solidproject.org/t/state-of-the-art-for-querying-large-containers/3320) |
| Container listing is membership-only, no LIMIT/offset | You get the whole `ldp:contains` set; paginate via layout (date shards), not the listing | same |
| `glob` removed | No bulk child-content reads; the old extension OOM'd servers | same |
| ETags inconsistent (legacy NSS) | `If-Match` may be unavailable — handle a `null` etag | same; see `solid-server-matrix` |
| One big file at scale | Re-downloaded + re-PUT whole on every change | [forum 6886](https://forum.solidproject.org/t/social-bookmarking-as-an-example-where-we-need-queries-instead-of-documents/6886) |

N3 Patch for partial updates: servers advertising `PATCH` accept it, but no sanctioned library
builds patch bodies yet and hand-building them is banned — conditional `PUT` until one ships
(`AGENTS.md` §Writing data).

## Decision checklist

1. **Does any of the data need a different audience?** No → one document; stop here.
2. **Is there an existing Solid model for this domain** (chat, bookmarks, contacts)? Yes →
   follow its spec/shape and layout.
3. Split along the permission boundary; shard by date/hash only when a container would
   otherwise grow past hundreds of members.
4. Register every stored class in the **Type Index**; look data up through it.
5. Resist client-side SPARQL on hot paths; design reads around the layout.
