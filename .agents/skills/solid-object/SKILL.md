---
name: solid-object
description: >-
  Use when reading Solid data through @solid/object — WebID profiles (WebIdDataset/Agent), container listings (ContainerDataset), .acl/.acr documents, wacToAcp/acpToWac conversion — or when rendering a profile needs fallback chains (bundled ProfileAgent reference class). Documents the published 0.6.x API: not in context7, README is one line.
---

# @solid/object — typed wrappers for Solid data

Pre-built `@rdfjs/wrapper` classes for the Solid data you read most (companion guide:
[`AGENTS.md`](../../AGENTS.md)). **Check here before writing your own wrapper** — profile and
container reading already exist.

```sh
npm install @solid/object n3     # n3 is required at runtime but NOT a dependency — install it
```

Pure ESM, Node ≥ 24. `@rdfjs/wrapper` comes transitively. Root import re-exports everything;
subpaths `./webid`, `./solid`, `./acp` also exist.

## What ships (v0.6.0)

| Class | Entry pattern | Key members |
|---|---|---|
| `WebIdDataset` (DatasetWrapper) | `new WebIdDataset(dataset, DataFactory).mainSubject` | `mainSubject: Agent \| undefined` — the subject carrying `solid:oidcIssuer` |
| `Agent` (TermWrapper) | `new Agent(webIdIri, dataset, DataFactory)` | `name` (vcard:fn → foaf:name → IRI tail), `vcardFn`, `foafName`, `email`, `phone`, `website`, `photoUrl`, `organization`, `role`, `title`, `pimStorage` / `solidStorage` / `storageUrls: Set<string>`, `oidcIssuer: Set<string>`, `knows: Set<string>`, `hasEmail`, `hasTelephone` |
| `ContainerDataset` | `new ContainerDataset(dataset, DataFactory).container` | `container: Container \| undefined` |
| `Container` / `Resource` | via `ContainerDataset` | `contains: Set<Resource>`; per resource: `id`, `name`, `isContainer`, `title`, `label`, `modified`, `size`, `type`, `mimeType` |
| `Email` / `Telephone` (+ datasets) | | the only classes **with setters** (`emailAddress = …`) |
| WAC: `AclResource`, `Authorization`, `Group` | | typed `.acl` access |
| ACP: `AccessControlResource`, `Policy`, `Matcher` | | typed `.acr` access |
| Converters | `wacToAcp(source: AclResource, target: DatasetCore)` / `acpToWac(source, target)` | translate between the two languages; throw `WacToAcpError` / `AcpToWacError` (extend `TranslationError`) |

## Reading a profile

```ts
import { fetchRdf } from "@jeswr/fetch-rdf";
import { WebIdDataset } from "@solid/object";
import { DataFactory } from "n3";

const { dataset } = await fetchRdf(webId);
const me = new WebIdDataset(dataset, DataFactory).mainSubject;
console.log(me?.name, [...(me?.storageUrls ?? [])]);
```

**Multiple storages:** `storageUrls` is a `Set` because WebIDs may advertise several
`pim:storage` values. When the app needs one, **present the list and let the user choose —
never silently take the first.**

## Rendering a profile — `ProfileAgent` reference class

`Agent.name` covers `vcard:fn → foaf:name` only. For UI rendering you want the full fallback
chains (name, avatar, bio, nickname, homepage). That class does not exist upstream yet, so this
skill bundles a compile-verified reference implementation —
[`profile-agent.ts`](./profile-agent.ts) — extending `Agent`. Copy it into `src/lib/` and adapt;
it is a candidate for upstreaming into `@solid/object`, at which point prefer the upstream
version. Pattern: each getter tries predicates in a documented preference order and survives
wrong term types (a literal where an IRI is expected skips to the next candidate, never throws).

## Writing

All the classes above (except `Email`/`Telephone`) are **read-only getters**. The write path is
always your own `TermWrapper` subclass with `…As` setters over the same dataset, then serialise
+ conditional `PUT` — `AGENTS.md` §Writing data. Do not look for a `save()` here.

## Gotchas

| Gotcha | Detail |
|---|---|
| `mainSubject` is `undefined` when the profile carries no `solid:oidcIssuer` | Surface a clear error: the WebID is not usable for Solid login |
| Fresh CSS pod profiles are bare | Only `foaf:Person` + `solid:oidcIssuer` — `name` is `undefined` and `storageUrls` is empty until the profile is seeded (AGENTS.md §Servers) |
| `organization` / `role` / `title` expect **NamedNode** objects | A literal value in the data throws `TermTypeError` — wrap reads of untrusted profiles (see `first()` in `profile-agent.ts`) |
| `n3` must be installed explicitly | It is a devDependency upstream, not a runtime dependency |
| One `DataFactory` everywhere | Mixing factories breaks term equality |
| Access control | Never hand-parse `.acl`/`.acr` — these typed classes + the converters are the only sanctioned path (`AGENTS.md` §Access control) |
