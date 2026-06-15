// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/rdf/tpf.ts — build the Triple Pattern Fragment graph (DESIGN.md §4.5).
 *
 * A CONFORMANT fragment is ONE RDF graph with three parts (corrects sw H1):
 *
 *   1. DATA      — the matching triples from the materialised `triple` table
 *                  (tombstone-filtered upstream in the store).
 *   2. METADATA  — the fragment resource typed `hydra:Collection, void:Dataset`,
 *                  `void:subset <$ORIGIN/#dataset>`, `void:triples` = the PATTERN
 *                  cardinality ESTIMATE (from stats — NOT a live COUNT),
 *                  `hydra:totalItems`, `hydra:itemsPerPage`.
 *   3. CONTROLS  — `<$ORIGIN/#dataset> hydra:search [ a hydra:IriTemplate ;
 *                    hydra:template "$ORIGIN/tpf{?s,p,o}" ;
 *                    hydra:mapping ( s→rdf:subject, p→rdf:predicate, o→rdf:object ) ]`,
 *                  plus `hydra:first` / `hydra:next` / `hydra:previous` page controls
 *                  on the fragment's PartialCollectionView.
 *
 * ALL triples are built via the n3 DataFactory (RDF/JS) — NEVER hand-concatenated
 * (house rule); serialise the returned quads through lib/http/conneg.ts.
 *
 * @see docs/DESIGN.md §4.5
 */

import type { DatasetCore, Quad, Term } from "@rdfjs/types";
import { DataFactory } from "n3";

import { INDEX_BASE_URL } from "../config";
import { DATASET_IRI } from "./vocab";

const { namedNode, literal, blankNode, quad: q } = DataFactory;

// ─── Namespaces ────────────────────────────────────────────────────────────────

const HYDRA = "http://www.w3.org/ns/hydra/core#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const VOID = "http://rdfs.org/ns/void#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const hy = (l: string) => namedNode(`${HYDRA}${l}`);
const rdf = (l: string) => namedNode(`${RDF}${l}`);
const voidNs = (l: string) => namedNode(`${VOID}${l}`);

const xsdNonNegInt = namedNode(`${XSD}nonNegativeInteger`);

/** The TPF endpoint URL (no query). */
const TPF_ENDPOINT = `${INDEX_BASE_URL}/tpf`;

/** A matched triple to emit as DATA. `oIsIri` selects NamedNode vs Literal. */
export interface FragmentTriple {
  s: string;
  p: string;
  o: string;
  oIsIri: boolean;
}

/**
 * Project a parsed dataset into the flat `{ s, p, o, oIsIri }` triple shape the
 * materialised `triple` table stores (PgStore.upsertTriples).
 *
 * Only NamedNode subjects + predicates are materialised (a TPF index keys on IRIs);
 * a blank-node or variable subject/predicate is skipped — the TPF surface indexes
 * the public, dereferenceable graph, not internal blank-node structure.  The object
 * is recorded as an IRI (NamedNode) or a literal LEXICAL value (`oIsIri=false`);
 * blank-node objects are skipped for the same reason.
 */
export function datasetToTriples(dataset: DatasetCore): FragmentTriple[] {
  const out: FragmentTriple[] = [];
  for (const quad of dataset) {
    if (quad.subject.termType !== "NamedNode") continue;
    if (quad.predicate.termType !== "NamedNode") continue;
    if (quad.object.termType === "NamedNode") {
      out.push({
        s: quad.subject.value,
        p: quad.predicate.value,
        o: quad.object.value,
        oIsIri: true,
      });
    } else if (quad.object.termType === "Literal") {
      out.push({
        s: quad.subject.value,
        p: quad.predicate.value,
        o: quad.object.value,
        oIsIri: false,
      });
    }
    // BlankNode / Variable objects are not materialised for the public TPF index.
  }
  return out;
}

/** Inputs to {@link buildFragmentQuads}. */
export interface BuildFragmentOptions {
  /** The bound pattern terms (undefined = variable). Used to build the page URLs. */
  pattern: { s?: string; p?: string; o?: string };
  /** The matched triples on THIS page (already tombstone-filtered + page-capped). */
  triples: FragmentTriple[];
  /** The PATTERN cardinality estimate for `void:triples` (from stats, not a COUNT). */
  estimate: number;
  /** The page size (`hydra:itemsPerPage`). */
  itemsPerPage: number;
  /** The opaque cursor for THIS page (undefined = first page). */
  cursor?: string;
  /** The opaque cursor for the NEXT page, or null when this is the last page. */
  nextCursor: string | null;
}

/**
 * Build a fragment page URL for the given pattern + optional cursor.
 *
 * Only the BOUND pattern terms are added to the query string (an empty term is a
 * variable and is omitted), so the fragment URLs are canonical and cache-friendly.
 */
function fragmentUrl(
  pattern: { s?: string; p?: string; o?: string },
  cursor?: string
): string {
  const url = new URL(TPF_ENDPOINT);
  if (pattern.s !== undefined) url.searchParams.set("s", pattern.s);
  if (pattern.p !== undefined) url.searchParams.set("p", pattern.p);
  if (pattern.o !== undefined) url.searchParams.set("o", pattern.o);
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  return url.toString();
}

/**
 * Build the full Triple Pattern Fragment graph (data + metadata + controls).
 *
 * @returns the quad array — serialise via lib/http/conneg.ts.
 */
export function buildFragmentQuads(opts: BuildFragmentOptions): Quad[] {
  const { pattern, triples, estimate, itemsPerPage, cursor, nextCursor } = opts;

  const quads: Quad[] = [];

  const dataset = namedNode(DATASET_IRI);
  // The fragment resource is THIS page's URL (pattern + this page's cursor).
  const fragmentIri = fragmentUrl(pattern, cursor);
  const fragment = namedNode(fragmentIri);
  // The first page is the same pattern with NO cursor.
  const firstIri = fragmentUrl(pattern);

  // ── 1. DATA — the matching triples ──────────────────────────────────────────
  for (const t of triples) {
    const obj: Term = t.oIsIri ? namedNode(t.o) : literal(t.o);
    quads.push(q(namedNode(t.s), namedNode(t.p), obj));
  }

  // ── 2. METADATA — the fragment resource ─────────────────────────────────────
  // Typed both hydra:Collection (the TPF view is a Hydra collection of triples)
  // and void:Dataset (a fragment is itself a sub-dataset of the full dataset).
  quads.push(q(fragment, rdf("type"), hy("Collection")));
  quads.push(q(fragment, rdf("type"), voidNs("Dataset")));

  // void:subset — this fragment is a subset of the full dataset.
  quads.push(q(dataset, voidNs("subset"), fragment));

  // void:triples — the PATTERN cardinality ESTIMATE (from stats; advisory).
  quads.push(
    q(fragment, voidNs("triples"), literal(String(estimate), xsdNonNegInt))
  );

  // hydra:totalItems — advisory; mirrors the estimate (clients terminate on the
  // absence of hydra:next, never on the count — DESIGN.md §4.4/§4.5 M6).
  quads.push(
    q(fragment, hy("totalItems"), literal(String(estimate), xsdNonNegInt))
  );

  // hydra:itemsPerPage — the page cap.
  quads.push(
    q(fragment, hy("itemsPerPage"), literal(String(itemsPerPage), xsdNonNegInt))
  );

  // ── 2b. PartialCollectionView paging controls ───────────────────────────────
  // hydra:first always; hydra:previous when on a non-first page; hydra:next when
  // more pages remain.  The view is the fragment resource itself (TPF convention:
  // the fragment IRI both identifies the page and carries the view controls).
  quads.push(q(fragment, rdf("type"), hy("PartialCollectionView")));
  quads.push(q(fragment, hy("first"), namedNode(firstIri)));
  if (cursor !== undefined) {
    // We do not retain back-cursors (forward-only keyset paging), so previous
    // points at the first page — a safe, spec-valid "go back to start" control.
    quads.push(q(fragment, hy("previous"), namedNode(firstIri)));
  }
  if (nextCursor !== null) {
    quads.push(
      q(fragment, hy("next"), namedNode(fragmentUrl(pattern, nextCursor)))
    );
  }

  // ── 3. CONTROLS — the hydra:search IriTemplate on the dataset ───────────────
  // <$ORIGIN/#dataset> hydra:search [ a hydra:IriTemplate ;
  //   hydra:template "$ORIGIN/tpf{?s,p,o}" ;
  //   hydra:mapping ( [s→rdf:subject] [p→rdf:predicate] [o→rdf:object] ) ] .
  const tmpl = blankNode("tpfTemplate");
  quads.push(q(dataset, hy("search"), tmpl));
  quads.push(q(tmpl, rdf("type"), hy("IriTemplate")));
  quads.push(q(tmpl, hy("template"), literal(`${TPF_ENDPOINT}{?s,p,o}`)));
  quads.push(q(tmpl, hy("variableRepresentation"), hy("BasicRepresentation")));

  // One mapping per variable, each binding to the corresponding rdf: term.
  const mapping = (variable: string, property: string): void => {
    const m = blankNode(`tpfMapping_${variable}`);
    quads.push(q(tmpl, hy("mapping"), m));
    quads.push(q(m, rdf("type"), hy("IriTemplateMapping")));
    quads.push(q(m, hy("variable"), literal(variable)));
    quads.push(q(m, hy("property"), rdf(property)));
  };
  mapping("s", "subject");
  mapping("p", "predicate");
  mapping("o", "object");

  return quads;
}
