// The selectable sections of a composite document, DERIVED from its schema
// (#10600 follow-up).
//
// WHY THIS IS NOT A QUERY_ENUMS ENTRY. The 19 other vocabularies there are
// VALUE sets -- what a field may contain (`ok` | `degraded` | `failed`,
// `active` | `inactive`). Literals are their only possible source, which is
// exactly why that module is pure literals with zero imports.
//
// A section list is different in kind: it names the document's OWN top-level
// keys, and the artifact schema already declares those. Writing them out again
// created the only duplication in that file -- the first cut of `sections=`
// hand-listed 9 names for the detail route and 7 for the profile, of which 6
// were the same 6 names typed twice. Two lists that must agree with a third
// thing (the schema) and with each other is three ways to drift.
//
// WHY NOT ONE SHARED LIST INSTEAD. Because the two documents genuinely differ:
// the profile has no `economics`, `candidates` or `verified_surfaces`, and the
// detail has no `profile`. A single global vocabulary would let a caller ask
// `/profile?sections=economics` and get a 200 carrying nothing they asked for,
// with no error to explain it. The per-route subset is a FACT ABOUT THE
// DOCUMENT, not a policy choice -- so it should be read off the document rather
// than decided by hand.
//
// Deriving gets the property that neither hand-written option can: a route
// cannot advertise a section its document does not have, by construction. Add a
// key to an artifact schema and it becomes selectable; remove one and it stops
// being offered. No list to update, and nothing that can silently disagree.
//
// A DIFFERENT UNIT FROM `fields`, which is why it is a different parameter
// (#10600). `fields` picks columns out of the rows of a list, everywhere it
// appears; this picks whole cards out of one composite document. Same idea,
// different unit of selection -- and `fieldsSchema`'s published description
// says "row field names", so overloading the name would have meant one
// parameter with two meanings and nothing telling a caller which they got.
//
// WHY PAGING DOES NOT SUBSTITUTE. The detail route's 272,825 B is not one
// dominant list: `endpoints`, `surfaces`, `verified_surfaces` and
// `candidate_surfaces` are four parallel arrays over the same subject
// (76/76/76/16 on subnet 64). A query collection pages ONE data_key, so
// declaring one would narrow a quarter of the payload and leave the rest -- a
// response that looks bounded while staying fat.
import type { z } from "zod";

/**
 * Keys that identify the document rather than carrying its content.
 *
 * Never selectable and never projected away: a caller asking for `economics`
 * wants a smaller answer, not an anonymous one, and a document that cannot say
 * what it is or when it was built is the latter. Excluded from every derived
 * vocabulary for the same reason -- offering `?sections=schema_version` would
 * imply the envelope is optional.
 */
export const ENVELOPE_SECTIONS: readonly string[] = [
  "schema_version",
  "contract_version",
  "generated_at",
  "operational_observed_at",
  "health_source",
];

/**
 * A document's selectable sections, sorted.
 *
 * SORTED, not in declaration order: the vocabulary is published verbatim in an
 * OpenAPI `pattern` and description, and reordering keys inside an artifact
 * schema is a cosmetic edit that should not rewrite a public contract. Sorting
 * also keeps the two routes' patterns comparable by eye.
 *
 * Returns a non-empty tuple because `sectionsSchema` and `z.enum` both need
 * one, and because a composite document with no content keys is a developer
 * error rather than a route that serves an empty vocabulary -- it throws
 * instead of publishing a parameter that can accept nothing.
 */
export function sectionsOf(schema: {
  shape: Record<string, z.ZodType>;
}): readonly [string, ...string[]] {
  const sections = Object.keys(schema.shape)
    .filter((key) => !ENVELOPE_SECTIONS.includes(key))
    .sort();
  if (sections.length === 0) {
    throw new Error(
      "sectionsOf: this schema declares only envelope keys, so `sections=` " +
        "would publish a parameter with nothing to select",
    );
  }
  return sections as unknown as readonly [string, ...string[]];
}
