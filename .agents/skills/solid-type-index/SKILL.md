---
name: solid-type-index
description: >-
  Use when an app must find where another app stored a given RDF class in the pod, register its
  own data so other apps can find it, or bootstrap missing indexes — solid:publicTypeIndex /
  solid:privateTypeIndex absent from a profile (CSS does not seed them), solid:TypeRegistration,
  solid:forClass lookups. Includes a compile-verified TermWrapper implementation and the
  create-and-link fallback.
---

# Solid Type Index

The Type Index is the convention by which a pod owner advertises *where in the
pod a given RDF class is stored*, so independent apps can discover each other's
data instead of hard-coding paths. Two indexes per profile: a **public** one
(discoverable types) and a **private** one (sensitive types).

This skill resolves the deferral in `AGENTS.md` §Writing data ("the type index
is the discovery mechanism for *other* apps' data; no typed wrapper ships for it
yet… out of scope"). No `@solid/object` wrapper ships for it, so you implement
read+write through your own `TermWrapper` subclasses — never inline quads, never
string-concatenated Turtle. Follow the house stack in `AGENTS.md`: auth via
`@solid/reactive-authentication` (plain `fetch`), I/O via `@jeswr/fetch-rdf`,
serialisation via `n3`.

> **Stay in scope.** Use the Type Index for *interop* — locating/exposing data
> other apps share. For data only your own app touches, derive paths from the
> pod root (`AGENTS.md` §Writing data); you do not need a registration.

## Vocabulary

The `solid:` namespace is `http://www.w3.org/ns/solid/terms#`
([type-indexes spec](https://solid.github.io/type-indexes/)). Predicate/class
IRIs (verified against the spec):

| Term | IRI suffix on `solid:` | Role |
|---|---|---|
| `solid:publicTypeIndex` | `publicTypeIndex` | profile → public index doc |
| `solid:privateTypeIndex` | `privateTypeIndex` | profile → private index doc |
| `solid:TypeIndex` | `TypeIndex` | `rdf:type` of an index document |
| `solid:ListedDocument` | `ListedDocument` | extra `rdf:type` on a **public** index |
| `solid:UnlistedDocument` | `UnlistedDocument` | extra `rdf:type` on a **private** index |
| `solid:TypeRegistration` | `TypeRegistration` | `rdf:type` of one registration entry |
| `solid:forClass` | `forClass` | registration → the RDF class it indexes (IRI) |
| `solid:instance` | `instance` | registration → a single resource (IRI) |
| `solid:instanceContainer` | `instanceContainer` | registration → a container to list (IRI) |

`rdf:type` is `http://www.w3.org/1999/02/22-rdf-syntax-ns#type`. A registration
uses `solid:instance` (one resource) **or** `solid:instanceContainer` (a
container of many) — not both.

## Read path: discover an index, then a class

1. Fetch the WebID profile (`AGENTS.md` §Reading data); read `solid:publicTypeIndex`
   / `solid:privateTypeIndex` off the WebID subject. (The private index typically
   sits behind `pim:preferencesFile` and needs auth to read.)
2. Fetch the index document; find `solid:TypeRegistration` subjects whose
   `solid:forClass` matches the class you want; read `solid:instance` /
   `solid:instanceContainer`.
3. **Discovery is a hint, not a grant.** A registration tells you *where* data
   *might* be — you must still GET the resource to learn your actual access
   ([forum](https://forum.solidproject.org/t/questions-about-apps-behavior-regarding-missing-data-in-users-pod/5277.json)).

Reading the registry can also be done with a SPARQL query that pairs
`solid:forClass` with `solid:instance`/`solid:instanceContainer`
([forum](https://forum.solidproject.org/t/fun-fact-using-sparql-to-query-the-type-registry/776.json));
the wrapper approach below is the house default.

## Convention, not enforcement — always fallback-and-create

The server does **not** maintain the index. It is convention-only: every app
must cooperate, and an app cannot assume another app registered correctly
([forum](https://forum.solidproject.org/t/solid-interop-in-practice/7701.json)).

The Community Solid Server **does not seed** type-index files. Tim Berners-Lee:
apps/providers must create them, in "the same place they are now"
([forum](https://forum.solidproject.org/t/data-discovery-on-community-solid-server/4695.json)).
NSS auto-seeds; CSS does not. So **never assume the indexes exist** — read,
and if absent, create-and-link.

> When creating a *preferences*/profile file to host the private index, do not
> clobber an existing one you merely failed to read (e.g. on a 403). Treat
> unreadable as "may exist", not "absent" (TBL, same thread).

## Create-and-link recipe (when an index is absent)

1. Choose a location near the profile — convention: `<podRoot>settings/publicTypeIndex.ttl`
   and `<podRoot>settings/privateTypeIndex.ttl` (the spec's examples use
   `/settings/`).
2. **PUT** the index document, typed `solid:TypeIndex` **and**
   `solid:ListedDocument` (public) / `solid:UnlistedDocument` (private).
3. **PUT** the profile with the `solid:publicTypeIndex` / `solid:privateTypeIndex`
   triple added (conditional PUT, keep the ETag — `AGENTS.md` §Writing data).
   The base WebID card must stay world-readable; protect the private index via
   WAC instead of locking the card.

Spec-exact shapes ([type-indexes](https://solid.github.io/type-indexes/)):

```turtle
# public index document
<> a solid:TypeIndex, solid:ListedDocument .
<#registration-ab09fd> a solid:TypeRegistration ;
    solid:forClass vcard:AddressBook ;
    solid:instance </public/contacts/myPublicAddressBook.ttl> .

# private index document
<> a solid:TypeIndex, solid:UnlistedDocument .
<#registration-ab09fd> a solid:TypeRegistration ;
    solid:forClass vcard:AddressBook ;
    solid:instanceContainer </private/myBookmarks/> .
```

## Worked TermWrapper implementation

Two wrappers: `TypeIndexDataset` (the whole index document — a `DatasetWrapper`,
because registrations are *sibling subjects* in the document, not objects
reachable from the document's own subject) and `TypeRegistration` (one entry —
a `TermWrapper`). All `forClass`/`instance`/`instanceContainer` values are
IRIs, so use the `NamedNode*` mappers; `rdf:type` is a set, so use `SetFrom`.
**Compile-verified (`tsc --strict`) against the published `@rdfjs/wrapper`
0.34.0 + `@jeswr/fetch-rdf` 0.1.0.**

```ts
import {
  TermWrapper, DatasetWrapper,
  OptionalFrom, OptionalAs,
  SetFrom,
  NamedNodeAs, NamedNodeFrom,
} from "@rdfjs/wrapper";

const SOLID = "http://www.w3.org/ns/solid/terms#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

/** One `solid:TypeRegistration` entry. */
class TypeRegistration extends TermWrapper {
  /** The RDF class this entry indexes (an IRI). */
  get forClass(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SOLID + "forClass", NamedNodeAs.string);
  }
  set forClass(v: string | undefined) {
    OptionalAs.object(this, SOLID + "forClass", v, NamedNodeFrom.string);
  }

  /** A single resource holding instances of `forClass`. */
  get instance(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SOLID + "instance", NamedNodeAs.string);
  }
  set instance(v: string | undefined) {
    OptionalAs.object(this, SOLID + "instance", v, NamedNodeFrom.string);
  }

  /** A container listing instances of `forClass`. */
  get instanceContainer(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SOLID + "instanceContainer", NamedNodeAs.string);
  }
  set instanceContainer(v: string | undefined) {
    OptionalAs.object(this, SOLID + "instanceContainer", v, NamedNodeFrom.string);
  }

  /** Stamp the entry as a TypeRegistration (call once when minting). */
  markRegistration(): void {
    this.types.add(SOLID + "TypeRegistration");
  }

  /** Live set of `rdf:type` IRIs. */
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF + "type", NamedNodeAs.string, NamedNodeFrom.string);
  }
}

/** A type-index document, wrapped whole. */
class TypeIndexDataset extends DatasetWrapper {
  /** Every `solid:TypeRegistration` subject in the document. */
  get registrations(): Iterable<TypeRegistration> {
    return this.instancesOf(SOLID + "TypeRegistration", TypeRegistration);
  }

  /** Find the location(s) registered for a class IRI. */
  locate(classIri: string): { instance?: string; container?: string }[] {
    const out: { instance?: string; container?: string }[] = [];
    for (const reg of this.registrations) {
      if (reg.forClass === classIri) {
        out.push({ instance: reg.instance, container: reg.instanceContainer });
      }
    }
    return out;
  }

  /** Add a registration; serialise + conditional PUT afterwards to persist. */
  register(
    indexUrl: string,            // the type-index document URL
    fragment: string,            // e.g. "#registration-notes"
    classIri: string,
    location: { instance?: string; container?: string },
  ): TypeRegistration {
    // `this` IS a DatasetCore (DatasetWrapper implements it), so the new
    // wrapper writes into the same underlying dataset.
    const reg = new TypeRegistration(indexUrl + fragment, this, this.factory);
    reg.markRegistration();
    reg.forClass = classIri;
    if (location.instance) reg.instance = location.instance;
    if (location.container) reg.instanceContainer = location.container;
    return reg;
  }
}

// usage
import { fetchRdf } from "@jeswr/fetch-rdf";
import { DataFactory } from "n3";

const { dataset, etag } = await fetchRdf(indexUrl);
const index = new TypeIndexDataset(dataset, DataFactory);
const where = index.locate("https://schema.org/TextDigitalDocument");
index.register(indexUrl, "#registration-notes", "https://schema.org/TextDigitalDocument", {
  container: new URL("notes/", podRoot).toString(),
});
```

Then mint + persist exactly as `AGENTS.md` §Writing data prescribes: mutate the
in-memory dataset through these wrappers, serialise the whole dataset with
`n3.Writer`, and conditional-`PUT` with `if-match` and an explicit
`content-type: text/turtle`. Handle `412` by re-fetching and re-applying.

### Notes / caveats

- `SetFrom.subjectPredicate(this, iri, readMapper, writeMapper)` returns a
  **live** Set — adding/removing mutates the dataset (used by
  `markRegistration`). `instancesOf(classIri, Ctor)` is a `protected` helper on
  `DatasetWrapper` — callable only from a subclass, which is why
  `TypeIndexDataset` exists rather than scanning quads by hand.
- Use **one** `DataFactory` (n3's) throughout, as elsewhere in the stack.
- Public index = types discoverable by others (access may still be restricted);
  private index = owner-only, behind WAC
  ([forum](https://forum.solidproject.org/t/questions-about-apps-behavior-regarding-missing-data-in-users-pod/5277.json)).
- A registration may carry an `solid:instance` *and* be one of several entries
  for a class; treat `locate()` as returning a list.

## Cross-references

- `AGENTS.md` §Writing data — read-modify-write, ETags, explicit Content-Type,
  trailing-slash rule (containers end in `/`). This skill **closes** that
  section's type-index deferral.
- `solid-rdf` skill — Turtle/JSON-LD parse + serialise, the "never hand-build
  triples" rule.
- `solid-server-matrix` (proposed) — type-index *seeding* differs by server
  (NSS auto-seeds; CSS does not), which is the whole reason fallback-and-create
  is mandatory.

## Could not verify

- Embedded-entity declaration in the registry (forum thread
  `t/how-should-embedded-entities-be-declared-in-the-type-index-registry/3023`)
  — out of scope here; not fetched.
- ~~Exact `@rdfjs/wrapper` member names~~ — resolved: the worked example above
  was compiled (`tsc --strict`) against the published `@rdfjs/wrapper` 0.34.0
  `.d.ts` (incl. `instancesOf(klass: string, ctor)` on `DatasetWrapper`,
  `NamedNodeAs.string` / `NamedNodeFrom.string`, 4-arg
  `SetFrom.subjectPredicate`) on 2026-06-05.
