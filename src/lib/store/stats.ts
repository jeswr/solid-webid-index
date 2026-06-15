// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) -- re-review/upgrade candidate
/**
 * lib/store/stats.ts -- incremental dataset-statistics maths (DESIGN.md section 2.1.j / section 4.2).
 *
 * The VoID/DCAT dataset description (GET /.well-known/void, GET /) must read O(1)
 * aggregate counts, never a live COUNT(*) over the whole index. The stats counters
 * live in the shared `stats(k, v)` table and describe the SERVED query dataset -- the
 * materialised `triple` table that TPF serves -- so a single `void:triples` is
 * consistent across VoID and the TPF empty-pattern estimate.
 *
 * Division of maintenance with the TPF bead (pss-b0a), both writing `stats`
 * additively inside the same `upsertTriples` projection (which replaces a WebID's
 * triple set, and -- with an empty triple list -- erases it):
 *   - TPF owns the 'triples' (total) + 'p:<predicate>' (property-partition) counters.
 *   - This bead (pss-0zp) owns the 'entities' (indexed-WebID) counter + the
 *     'c:<classIri>' (class-partition entity) counters.
 *
 * This module is the PURE maths the store calls:
 *   - `classEntityContribution(triples)` -> the per-class DISTINCT-subject count this
 *     WebID's served triples contribute (its `rdf:type` triples), and whether this
 *     WebID is an entity at all (>=1 served triple).
 *   - `classDelta(old, next)` -> the signed per-class adjustment to apply when a
 *     WebID's contribution changes (insert: old empty; re-crawl: old previous;
 *     erase: next empty).
 *
 * Counts are maintained INCREMENTALLY on upsert AND erase (pss-0zp acceptance): the
 * store diffs the new contribution against the previous one and applies (next - old),
 * so maintenance is O(size of one WebID's triples), never O(dataset).
 *
 * NO I/O -- the store (pgStore.ts) calls these and applies the result to SQL.
 */

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** Minimal triple shape this module needs (a subset of ports.TpfTriple). */
export interface StatTriple {
  s: string;
  p: string;
  o: string;
  /** True when `o` is an IRI (a NamedNode) -- only IRI rdf:type objects are classes. */
  oIsIri: boolean;
}

/**
 * A WebID's contribution to the OWNED stats (entities + class partitions).
 *
 * - `isEntity`: 1 when this WebID has >=1 served triple (it counts toward
 *   `void:entities`), 0 otherwise (an erased / empty WebID).
 * - `classes`: class IRI -> DISTINCT-subject count this WebID contributes for that
 *   class (its `rdf:type <class>` triples, de-duplicated per subject). Summed across
 *   WebIDs this is the `void:classPartition` entity count.
 */
export interface ClassEntityContribution {
  isEntity: number;
  /** class IRI -> distinct-subject count within this WebID's triples. */
  classes: Record<string, number>;
}

/** The empty contribution -- an erased / never-served WebID contributes nothing. */
export const EMPTY_CLASS_CONTRIBUTION: ClassEntityContribution = {
  isEntity: 0,
  classes: {},
};

/**
 * Derive a WebID's entity + class-partition contribution from its served triples.
 *
 * @param triples  The WebID's materialised triple set (what TPF serves / what
 *                 `upsertTriples` is replacing). An empty array = an erased WebID
 *                 (contributes nothing).
 */
export function classEntityContribution(
  triples: StatTriple[]
): ClassEntityContribution {
  const classes: Record<string, number> = {};
  // De-duplicate (class, subject) pairs so a subject typed once per class counts
  // once for that class -- `void:classPartition` counts DISTINCT entities.
  const seen = new Set<string>();

  for (const t of triples) {
    if (t.p === RDF_TYPE && t.oIsIri) {
      const key = `${t.o} ${t.s}`;
      if (!seen.has(key)) {
        seen.add(key);
        classes[t.o] = (classes[t.o] ?? 0) + 1;
      }
    }
  }

  return { isEntity: triples.length > 0 ? 1 : 0, classes };
}

/** A signed adjustment to the OWNED stats counters (may be negative). */
export interface ClassEntityDelta {
  /** Signed change to the `entities` counter. */
  entities: number;
  /** class IRI -> signed change to that class partition's entity count. */
  classes: Record<string, number>;
}

/**
 * Compute the signed adjustment to apply when a WebID's contribution changes from
 * `old` to `next`. Deltas may be negative (re-crawl that drops a type, or erase).
 * Zero-net class deltas are omitted so the store issues no no-op writes; a class
 * counter that reaches 0 means that class no longer appears (its partition row is
 * removed by the store so `void:classes` stays exact).
 */
export function classDelta(
  old: ClassEntityContribution,
  next: ClassEntityContribution
): ClassEntityDelta {
  const classes: Record<string, number> = {};
  for (const [iri, n] of Object.entries(next.classes)) {
    classes[iri] = (classes[iri] ?? 0) + n;
  }
  for (const [iri, n] of Object.entries(old.classes)) {
    classes[iri] = (classes[iri] ?? 0) - n;
  }
  for (const [iri, n] of Object.entries(classes)) {
    if (n === 0) delete classes[iri];
  }

  return { entities: next.isEntity - old.isEntity, classes };
}

// --- stats key conventions (shared with the TPF bead's `stats` table) ----------
//
// The `stats(k, v)` table is shared. Keys use distinct namespaces so both beads
// write additively without collision:
//   'triples'       -- total triples              (TPF bead owns)
//   'p:<predicate>' -- per-predicate triple count (TPF bead owns; void:propertyPartition)
//   'entities'      -- number of indexed WebIDs    (THIS bead owns; void:entities)
//   'c:<classIri>'  -- per-class entity count      (THIS bead owns; void:classPartition)
// The distinct-class / distinct-property counts are DERIVED at read time (count of
// c:/p: keys with v > 0), avoiding a second counter to keep consistent.
//
// NOTE: a `sup` / `sp:<predicate>` suppressed-inbound-edge counter pair (object = a tombstoned
// WebID) used to live here to make the VoID `void:triples` / Hydra estimate subtract suppressed
// inbound edges exactly. It was REMOVED (roborev rounds 6–8): keeping it byte-exact across erase /
// tombstone / markDone / re-projection was too race-prone. The estimate now marginally over-counts
// suppressed inbound edges — spec-legal for TPF (estimates) — while SERVED TPF output still
// suppresses every such edge at read time (pgStore tombstoneObjectClause).

/** Scalar counter key for the total triple count (TPF bead owns; read here for VoID). */
export const STATS_KEY_TRIPLES = "triples";
/** Scalar counter key for the indexed-entity (WebID) count (this bead owns). */
export const STATS_KEY_ENTITIES = "entities";
/** Per-class partition key prefix (this bead owns). */
export const STATS_PREFIX_CLASS = "c:";
/** Per-predicate partition key prefix (TPF bead owns; read here for VoID). */
export const STATS_PREFIX_PROPERTY = "p:";

/** Build the `stats` row key for a class partition. */
export function classKey(classIri: string): string {
  return `${STATS_PREFIX_CLASS}${classIri}`;
}

/** Build the `stats` row key for a predicate partition. */
export function propertyKey(propertyIri: string): string {
  return `${STATS_PREFIX_PROPERTY}${propertyIri}`;
}
