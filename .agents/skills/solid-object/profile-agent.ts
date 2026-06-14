// ProfileAgent — reference implementation for profile rendering on top of @solid/object.
// Candidate for upstreaming into @solid/object; bundled with the solid-object skill until then.
import { Agent } from "@solid/object";
import { OptionalFrom, LiteralAs, NamedNodeAs } from "@rdfjs/wrapper";

const FOAF = "http://xmlns.com/foaf/0.1/";
const SCHEMA = "http://schema.org/";
const VCARD = "http://www.w3.org/2006/vcard/ns#";
const AS = "https://www.w3.org/ns/activitystreams#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const SIOC = "http://rdfs.org/sioc/ns#";

const first = <T>(...reads: (() => T | undefined)[]): T | undefined => {
  for (const read of reads) {
    try {
      const v = read();
      if (v !== undefined) return v;
    } catch {
      // a predicate present with an unexpected term type (e.g. literal where an
      // IRI is expected) should not abort the chain — fall through
    }
  }
  return undefined;
};

export class ProfileAgent extends Agent {
  /**
   * Display name with the full fallback chain:
   * foaf:name → schema:name → vcard:fn → as:name → rdfs:label → the WebID IRI.
   * (The base Agent.name getter covers vcard:fn → foaf:name only.)
   * Order is a suggested preference — adjust to the ecosystem you integrate with.
   */
  get displayName(): string {
    return (
      first(
        () => OptionalFrom.subjectPredicate(this, FOAF + "name", LiteralAs.string),
        () => OptionalFrom.subjectPredicate(this, SCHEMA + "name", LiteralAs.string),
        () => OptionalFrom.subjectPredicate(this, VCARD + "fn", LiteralAs.string),
        () => OptionalFrom.subjectPredicate(this, AS + "name", LiteralAs.string),
        () => OptionalFrom.subjectPredicate(this, RDFS + "label", LiteralAs.string),
      ) ?? this.value
    );
  }

  /**
   * Avatar/photo IRI: vcard:hasPhoto → as:image → foaf:img → schema:image →
   * vcard:photo → sioc:avatar → foaf:depiction. (Base Agent has photoUrl with a
   * shorter chain; this is the full rendering chain.)
   */
  get avatarUrl(): string | undefined {
    return first(
      () => OptionalFrom.subjectPredicate(this, VCARD + "hasPhoto", NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, AS + "image", NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, FOAF + "img", NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, SCHEMA + "image", NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, VCARD + "photo", NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, SIOC + "avatar", NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, FOAF + "depiction", NamedNodeAs.string),
    );
  }

  /** Short bio: vcard:note → schema:description. */
  get bio(): string | undefined {
    return first(
      () => OptionalFrom.subjectPredicate(this, VCARD + "note", LiteralAs.string),
      () => OptionalFrom.subjectPredicate(this, SCHEMA + "description", LiteralAs.string),
    );
  }

  /** Nickname: foaf:nick → vcard:nickname. */
  get nickname(): string | undefined {
    return first(
      () => OptionalFrom.subjectPredicate(this, FOAF + "nick", LiteralAs.string),
      () => OptionalFrom.subjectPredicate(this, VCARD + "nickname", LiteralAs.string),
    );
  }

  /** Homepage: foaf:homepage → schema:url → vcard:url. */
  get homepage(): string | undefined {
    return first(
      () => OptionalFrom.subjectPredicate(this, FOAF + "homepage", NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, SCHEMA + "url", NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, VCARD + "url", NamedNodeAs.string),
    );
  }
}

// usage shape — wire into WebIdDataset-derived data
import { WebIdDataset } from "@solid/object";
import { DataFactory } from "n3";
import { fetchRdf } from "@jeswr/fetch-rdf";

export async function renderable(webId: string) {
  const { dataset } = await fetchRdf(webId);
  const me = new WebIdDataset(dataset, DataFactory).mainSubject;
  if (!me) throw new Error("No Solid-OIDC subject found in profile");
  const profile = new ProfileAgent(me.value, dataset, DataFactory); // pass the IRI string

  // Multiple storages: surface ALL of them and let the USER choose — never pick silently.
  const storages = [...profile.storageUrls];

  return { name: profile.displayName, avatar: profile.avatarUrl, storages };
}
