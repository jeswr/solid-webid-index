// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/rdf/inbox.ts — build the LDN inbox container graph (GET /inbox/) as RDF/JS quads.
 *
 * The container is BOTH an `ldp:BasicContainer` (LDP §5.2) and an `as:Collection` (AS2), its members
 * linked via `ldp:contains` and `as:items`, with Hydra paging metadata (`hydra:PartialCollectionView`,
 * `hydra:first`/`hydra:next`/`hydra:previous`, `hydra:totalItems` — advisory). `Prefer` is honoured
 * by the route, which passes `includeContainment` here.
 *
 * Built with the n3 DataFactory (RDF/JS typed accessors) and serialised via lib/http/conneg.ts —
 * NEVER hand-concatenated Turtle (house rule). See DESIGN.md §4.3.
 */

import type { Quad } from "@rdfjs/types";
import { DataFactory } from "n3";

const { namedNode, literal, quad: q } = DataFactory;

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const LDP = "http://www.w3.org/ns/ldp#";
const AS = "https://www.w3.org/ns/activitystreams#";
const HYDRA = "http://www.w3.org/ns/hydra/core#";
const DCT = "http://purl.org/dc/terms/";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const rdf = (l: string) => namedNode(`${RDF}${l}`);
const ldp = (l: string) => namedNode(`${LDP}${l}`);
const as = (l: string) => namedNode(`${AS}${l}`);
const hydra = (l: string) => namedNode(`${HYDRA}${l}`);
const dct = (l: string) => namedNode(`${DCT}${l}`);
const xsdInteger = namedNode(`${XSD}integer`);
const xsdDateTime = namedNode(`${XSD}dateTime`);

/** One inbox member rendered into the container. */
export interface InboxMember {
  /** The member resource IRI (`$ORIGIN/inbox/{id}`). */
  iri: string;
  /** The AS2 activity type IRI of the stored notification. */
  activityType: string;
  /** epoch ms the notification was received. */
  receivedAt: number;
}

export interface BuildInboxContainerOptions {
  /** The inbox container IRI (e.g. `$ORIGIN/inbox/`). */
  inboxIri: string;
  /** The members on THIS page. */
  members: InboxMember[];
  /** Advisory total notification count (`hydra:totalItems`). */
  totalItems: number;
  /** This page's view IRI (`$ORIGIN/inbox/?page=N`). */
  viewIri: string;
  /** First-page view IRI. */
  firstIri: string;
  /** Next-page view IRI, or null when this is the last page. */
  nextIri: string | null;
  /** Previous-page view IRI, or null when this is the first page. */
  previousIri: string | null;
  /** Items per page (`hydra:itemsPerPage`). */
  itemsPerPage: number;
  /**
   * Whether to include the containment triples (`ldp:contains` / `as:items` + per-member detail).
   * The route maps `Prefer: return=representation; omit="…#PreferContainment"` (or
   * `PreferMinimalContainer`) to `false` so a client can ask for a minimal container.
   */
  includeContainment: boolean;
}

/**
 * Build the inbox container + paging graph.
 *
 * Emits (always):
 *   <inbox> a ldp:BasicContainer, ldp:Container, as:Collection ;
 *     hydra:totalItems N ;
 *     as:totalItems N .
 *   <view> a hydra:PartialCollectionView ;
 *     hydra:first <…> ; [hydra:next <…> ;] [hydra:previous <…> ;]
 *     hydra:itemsPerPage K .
 *   <inbox> hydra:view <view> .
 *
 * Emits (only when includeContainment):
 *   <inbox> ldp:contains <member> ; as:items <member> .
 *   <member> a as:Activity ; dct:created "…"^^xsd:dateTime ; rdf:type <activityType> .
 */
export function buildInboxContainerQuads(
  opts: BuildInboxContainerOptions
): Quad[] {
  const {
    inboxIri,
    members,
    totalItems,
    viewIri,
    firstIri,
    nextIri,
    previousIri,
    itemsPerPage,
    includeContainment,
  } = opts;

  const inbox = namedNode(inboxIri);
  const view = namedNode(viewIri);
  const quads: Quad[] = [];

  // Container typing — LDP + AS2.
  quads.push(q(inbox, rdf("type"), ldp("BasicContainer")));
  quads.push(q(inbox, rdf("type"), ldp("Container")));
  quads.push(q(inbox, rdf("type"), as("Collection")));

  // Advisory totals (Hydra + AS2). Clients MUST terminate on absent hydra:next, never on count.
  quads.push(
    q(inbox, hydra("totalItems"), literal(String(totalItems), xsdInteger))
  );
  quads.push(
    q(inbox, as("totalItems"), literal(String(totalItems), xsdInteger))
  );

  // Paging view.
  quads.push(q(inbox, hydra("view"), view));
  quads.push(q(view, rdf("type"), hydra("PartialCollectionView")));
  quads.push(q(view, hydra("first"), namedNode(firstIri)));
  quads.push(
    q(view, hydra("itemsPerPage"), literal(String(itemsPerPage), xsdInteger))
  );
  if (nextIri) {
    quads.push(q(view, hydra("next"), namedNode(nextIri)));
  }
  if (previousIri) {
    quads.push(q(view, hydra("previous"), namedNode(previousIri)));
  }

  if (includeContainment) {
    for (const m of members) {
      const member = namedNode(m.iri);
      quads.push(q(inbox, ldp("contains"), member));
      quads.push(q(inbox, as("items"), member));
      quads.push(q(member, rdf("type"), as("Activity")));
      quads.push(q(member, rdf("type"), namedNode(m.activityType)));
      quads.push(
        q(
          member,
          dct("created"),
          literal(new Date(m.receivedAt).toISOString(), xsdDateTime)
        )
      );
    }
  }

  return quads;
}
