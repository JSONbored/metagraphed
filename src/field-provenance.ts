// Per-field provenance: which published values the chain gave us, and which
// ones are our own arithmetic (#9078).
//
// ADR 0023 decision 5 made provenance a CONTRACT rather than prose, and
// /api/v1/chain/emission-pipeline was where it landed first. This module is
// that vocabulary lifted out of src/emission-decomposition.ts so every surface
// that publishes a `field_sources` map publishes the SAME map — one shape a
// consumer learns once, not one per endpoint.
//
// The map itself is DECLARED per module, never inferred: which storage item a
// value came from is not a property to read off a function body and then
// publish as a contract. What keeps a declaration honest is
// tests/field-provenance.test.ts, which derives the set of served fields from
// the published route schema and fails when the two disagree in either
// direction.

/**
 * `measured` — the value is ONE chain read, decoded. Unit conversion and
 * fixed-point decoding preserve it: rao divided by 1e9 is still that one read.
 *
 * `reconstructed` — anything else. Two or more reads combined, or a value we
 * supply (a runtime default, a constant). The chain did not publish this
 * number; we computed it.
 *
 * The line is deliberately mechanical rather than a judgement call about how
 * much arithmetic is "too much" — a map whose entries are arguable is a map
 * nobody can review.
 */
export type FieldSourceKind = "measured" | "reconstructed";

/** One published field's provenance. */
export interface FieldSource {
  kind: FieldSourceKind;
  /**
   * The pallet-qualified storage item behind a measurement
   * (`SubtensorModule.TaoWeight`, `Drand.LastStoredRound`), and null for
   * everything reconstructed.
   *
   * Named `storage` rather than `source` because that is what
   * /api/v1/chain/emission-pipeline already publishes, and a second name for
   * the same thing is how a shared vocabulary stops being shared.
   */
  storage: string | null;
}

/**
 * A response's whole provenance map, keyed by published field name.
 *
 * Every declaration is written `{ ... } as const satisfies FieldSources`, not
 * annotated `: FieldSources`. An annotation would widen the key set to `string`
 * and `kind` to the union, which is exactly the information a surface type
 * wants to keep — `field_sources: typeof NETWORK_PARAMETERS_FIELD_SOURCES`
 * should say WHICH fields, not "some fields".
 */
export type FieldSources = Record<string, FieldSource>;

/**
 * A measurement's `storage` must name a pallet and an item — `Pallet.Item`,
 * both PascalCase.
 *
 * Exported because the enforcement test asserts against it rather than
 * re-deriving the rule: a test that carries its own copy of the shape it is
 * checking proves the copies agree, not that the shape is right.
 */
export const STORAGE_ITEM_PATTERN = /^[A-Z][A-Za-z0-9]*\.[A-Z][A-Za-z0-9]*$/;

/**
 * Field names every provenance map leaves out: the response's own metadata,
 * not measurements of anything on chain.
 *
 * `queried_at` is our clock, `schema_version` is our contract version, and
 * `netuid` on a per-subnet route is the caller's own path segment echoed back.
 * Labelling any of them `measured` would be a false claim and `reconstructed`
 * an empty one — /api/v1/chain/emission-pipeline draws the same line, mapping
 * its row fields and none of its envelope.
 */
export const PROVENANCE_EXEMPT_FIELDS = new Set([
  "schema_version",
  "queried_at",
  "netuid",
]);
