---
name: solid-fetch-rdf
description: >-
  Use when code fetches or parses RDF from a Solid pod — importing @jeswr/fetch-rdf, calling fetchRdf/parseRdf, handling RdfFetchError, or keeping the ETag for a conditional write. Documents the published 0.1.x API: this package is not in context7 and its README lags the npm dist.
---

# @jeswr/fetch-rdf — fetch + parse Solid RDF

The only sanctioned way to GET and parse a Solid RDF resource (companion guide:
[`AGENTS.md`](../../AGENTS.md)). One HTTP GET + content-type-dispatched parse, returning an
in-memory dataset plus the validators you need for conditional writes. Never parse RDF inline
(`new Parser().parse(await res.text())`) and never use `rdf-parse`.

```sh
npm install @jeswr/fetch-rdf      # deps (content-type, jsonld-streaming-parser, n3) come with it
```

Pure ESM, Node ≥ 20. The README's "until we publish, use a git dep" note is stale — it **is**
published.

## API surface (complete, v0.1.0)

```ts
import {
  fetchRdf, parseRdf, extractMediaType,
  SUPPORTED_RDF_MEDIA_TYPES, DEFAULT_ACCEPT,
  RdfFetchError,
} from "@jeswr/fetch-rdf";
import type { FetchRdfOptions, ParseRdfOptions, FetchedRdf, RdfFetchErrorOptions } from "@jeswr/fetch-rdf";
```

```ts
function fetchRdf(url: string, options?: FetchRdfOptions): Promise<FetchedRdf>;
function parseRdf(body: string | ReadableStream<Uint8Array>, contentTypeHeader: string | null,
                  options?: ParseRdfOptions): Promise<Store>;   // n3.Store

interface FetchRdfOptions {
  fetch?: typeof fetch;   // defaults to globalThis.fetch — see auth note below
  accept?: string;        // defaults to DEFAULT_ACCEPT: "text/turtle, application/ld+json;q=0.9"
  headers?: HeadersInit;  // merged in; any `accept` here is overridden by the option above
  signal?: AbortSignal;
}
interface ParseRdfOptions { baseIRI?: string }  // set this to the resource URL

interface FetchedRdf {
  dataset: DatasetCore;        // n3.Store at runtime; type via @rdfjs/types
  etag: string | null;         // strong validator — keep for If-Match on writes
  contentType: string | null;  // media type, parameters stripped, lowercased
  response: Response;          // raw response for further headers
  url: string;                 // final URL after redirects
}
```

## Usage

```ts
const { dataset, etag } = await fetchRdf(resourceUrl);
```

- **Auth**: pass no `fetch` — `@solid/reactive-authentication` patches `globalThis.fetch`, so
  authentication is automatic. The package's own TSDoc suggests passing a fetch from
  `@uvdsl/solid-oidc-client-browser` — **ignore that** (banned in this stack).
- **Errors**: non-2xx, network, and parse failures all throw `RdfFetchError` with `.status`,
  `.url`, `.contentType`, `.cause`. Branch with `instanceof` + `.status`, never string-match:

  ```ts
  try { await fetchRdf(url); }
  catch (e) {
    if (e instanceof RdfFetchError && e.status === 404) { /* create the resource */ }
    else throw e;
  }
  ```

- **Pure parse** (body already in hand): `await parseRdf(turtle, "text/turtle", { baseIRI: url })`.
  A `null` content-type defaults to `text/turtle`.
- **Formats** (`SUPPORTED_RDF_MEDIA_TYPES`): `text/turtle`, `application/n-triples`,
  `application/n-quads`, `application/trig` (via n3) and `application/ld+json` (via
  jsonld-streaming-parser). Anything else throws — no RDF/XML by design.

## What this package does NOT do

- **No writes.** The write path is yours: mutate the dataset through `@rdfjs/wrapper` typed
  accessors, serialise with `n3.Writer`, conditional `PUT` with `If-Match: <etag>` — see
  `AGENTS.md` §Writing data.
- **No wrapping.** Feed `dataset` to `@solid/object` / your `TermWrapper` subclasses
  (`new WebIdDataset(dataset, DataFactory)`) — see the `solid-object` skill.

## Gotchas

| Gotcha | Detail |
|---|---|
| `headers.accept` is ignored | Set the `accept` *option*, not an `accept` header |
| `etag` may be `null` | Some servers (legacy NSS) send no ETag — handle the degraded no-`If-Match` write path (see `solid-server-matrix`) |
| `dataset` typed as `DatasetCore` | It is an `n3.Store` at runtime, but write code against the RDF/JS interface |
| README lags | Trust this skill + the `.d.ts` in `node_modules` over the repo README |
