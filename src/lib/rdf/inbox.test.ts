// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * inbox.test.ts — the LDN inbox container graph builder (lib/rdf/inbox.ts).
 */
import type { Quad } from "@rdfjs/types";
import { describe, expect, it } from "vitest";

import { buildInboxContainerQuads } from "./inbox";

const LDP = "http://www.w3.org/ns/ldp#";
const AS = "https://www.w3.org/ns/activitystreams#";
const HYDRA = "http://www.w3.org/ns/hydra/core#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const INBOX = "https://index.example/inbox/";

function has(quads: Quad[], s: string, p: string, o?: string): boolean {
  return quads.some(
    (q) =>
      q.subject.value === s &&
      q.predicate.value === p &&
      (o === undefined || q.object.value === o)
  );
}

const member = {
  iri: `${INBOX}01ARZ3NDEKTSV4RRFFQ69G5FAV`,
  activityType: `${AS}Announce`,
  receivedAt: 1_700_000_000_000,
};

describe("buildInboxContainerQuads", () => {
  it("types the container as ldp:BasicContainer + ldp:Container + as:Collection", () => {
    const quads = buildInboxContainerQuads({
      inboxIri: INBOX,
      members: [member],
      totalItems: 1,
      viewIri: INBOX,
      firstIri: INBOX,
      nextIri: null,
      previousIri: null,
      itemsPerPage: 50,
      includeContainment: true,
    });
    expect(has(quads, INBOX, RDF_TYPE, `${LDP}BasicContainer`)).toBe(true);
    expect(has(quads, INBOX, RDF_TYPE, `${LDP}Container`)).toBe(true);
    expect(has(quads, INBOX, RDF_TYPE, `${AS}Collection`)).toBe(true);
  });

  it("emits ldp:contains + as:items members when includeContainment", () => {
    const quads = buildInboxContainerQuads({
      inboxIri: INBOX,
      members: [member],
      totalItems: 1,
      viewIri: INBOX,
      firstIri: INBOX,
      nextIri: null,
      previousIri: null,
      itemsPerPage: 50,
      includeContainment: true,
    });
    expect(has(quads, INBOX, `${LDP}contains`, member.iri)).toBe(true);
    expect(has(quads, INBOX, `${AS}items`, member.iri)).toBe(true);
    expect(has(quads, member.iri, RDF_TYPE, member.activityType)).toBe(true);
  });

  it("OMITS containment triples for a minimal container", () => {
    const quads = buildInboxContainerQuads({
      inboxIri: INBOX,
      members: [member],
      totalItems: 1,
      viewIri: INBOX,
      firstIri: INBOX,
      nextIri: null,
      previousIri: null,
      itemsPerPage: 50,
      includeContainment: false,
    });
    expect(has(quads, INBOX, `${LDP}contains`)).toBe(false);
    expect(has(quads, INBOX, `${AS}items`)).toBe(false);
    // ... but the container typing + totals stay.
    expect(has(quads, INBOX, RDF_TYPE, `${LDP}BasicContainer`)).toBe(true);
    expect(has(quads, INBOX, `${HYDRA}totalItems`)).toBe(true);
  });

  it("emits Hydra paging (first/next/previous) on the view", () => {
    const view = `${INBOX}?page=2`;
    const quads = buildInboxContainerQuads({
      inboxIri: INBOX,
      members: [member],
      totalItems: 120,
      viewIri: view,
      firstIri: INBOX,
      nextIri: `${INBOX}?page=3`,
      previousIri: `${INBOX}?page=1`,
      itemsPerPage: 50,
      includeContainment: true,
    });
    expect(has(quads, INBOX, `${HYDRA}view`, view)).toBe(true);
    expect(has(quads, view, RDF_TYPE, `${HYDRA}PartialCollectionView`)).toBe(
      true
    );
    expect(has(quads, view, `${HYDRA}first`, INBOX)).toBe(true);
    expect(has(quads, view, `${HYDRA}next`, `${INBOX}?page=3`)).toBe(true);
    expect(has(quads, view, `${HYDRA}previous`, `${INBOX}?page=1`)).toBe(true);
  });

  it("omits hydra:next on the last page", () => {
    const quads = buildInboxContainerQuads({
      inboxIri: INBOX,
      members: [],
      totalItems: 0,
      viewIri: INBOX,
      firstIri: INBOX,
      nextIri: null,
      previousIri: null,
      itemsPerPage: 50,
      includeContainment: true,
    });
    expect(has(quads, INBOX, `${HYDRA}next`)).toBe(false);
  });
});
