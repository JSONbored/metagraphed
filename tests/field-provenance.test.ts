// #9078: prove every published `field_sources` map describes exactly the
// fields its route actually serves.
//
// ── The split, and why it is this one ────────────────────────────────────────
//
// The SET of served fields is derived — read off the published Zod route
// schema, so a field added tomorrow is checked tonight. The KIND and the
// STORAGE ITEM are declared, because "which chain storage item is behind this
// value" is not a property to infer from a function body and then publish as a
// contract. Same division as tests/mcp-schema-enforcement.test.ts (derived) and
// AUTH_REQUIRED_TOOL_NAMES (declared, proven), for the same reason.
//
// What that buys: a declaration cannot go stale. Both directions are failures.
// A served field with no entry is a number with no provenance — the defect
// #9078 exists to fix. An entry naming a field the schema does not serve is
// provenance for nothing, which is worse than silence because it reads as
// coverage. That second direction is not hypothetical: it caught
// EMISSION_FIELD_SOURCES declaring `tao_emission`, a field served nowhere in
// the repo, while `tao_total` and `ineligible_reason` — on every row of the
// flagship provenance endpoint — had no entry at all.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import {
  PROVENANCE_EXEMPT_FIELDS,
  STORAGE_ITEM_PATTERN,
  type FieldSources,
} from "../src/field-provenance.ts";
import { EMISSION_FIELD_SOURCES } from "../src/emission-decomposition.ts";
import { NETWORK_PARAMETERS_FIELD_SOURCES } from "../src/network-parameters.ts";
import { RANDOMNESS_FIELD_SOURCES } from "../src/randomness.ts";
import { SUDO_KEY_FIELD_SOURCES } from "../src/sudo-key.ts";
import { SubnetEmissionDecompositionSchema } from "../schemas-src/routes/emission-pipeline.ts";
import {
  NetworkParametersArtifactSchema,
  RandomnessArtifactSchema,
  SudoKeyArtifactSchema,
} from "../schemas-src/routes/network-singletons.ts";

/**
 * One surface's contract, paired with the map that claims to describe it.
 *
 * `schema` is the PUBLISHED shape, not the runtime interface: the contract is
 * what a consumer reads, so it is what the map has to agree with.
 */
const SURFACES: {
  name: string;
  schema: z.ZodObject<z.ZodRawShape>;
  sources: FieldSources;
}[] = [
  {
    name: "GET /api/v1/network/parameters",
    schema: NetworkParametersArtifactSchema,
    sources: NETWORK_PARAMETERS_FIELD_SOURCES,
  },
  {
    name: "GET /api/v1/network/randomness",
    schema: RandomnessArtifactSchema,
    sources: RANDOMNESS_FIELD_SOURCES,
  },
  {
    name: "GET /api/v1/sudo/key",
    schema: SudoKeyArtifactSchema,
    sources: SUDO_KEY_FIELD_SOURCES,
  },
  {
    // The map describes the per-subnet ROW, not the artifact envelope — the
    // decomposition's own aggregate/verification/chain_state blocks are
    // response metadata, the same way queried_at is elsewhere.
    name: "GET /api/v1/chain/emission-pipeline (per-subnet row)",
    schema: SubnetEmissionDecompositionSchema,
    sources: EMISSION_FIELD_SOURCES,
  },
];

/**
 * The field names a provenance map must account for: everything the schema
 * publishes, minus its own metadata and minus `field_sources` itself.
 *
 * A map that described the map would be a fixed point with nothing to say.
 */
function provenanceRequiredFields(
  schema: z.ZodObject<z.ZodRawShape>,
): string[] {
  return Object.keys(schema.shape).filter(
    (field) =>
      field !== "field_sources" && !PROVENANCE_EXEMPT_FIELDS.has(field),
  );
}

describe("published field_sources maps match the fields they describe (#9078)", () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      test("every published field carries provenance", () => {
        const undeclared = provenanceRequiredFields(surface.schema).filter(
          (field) => !(field in surface.sources),
        );
        assert.deepEqual(
          undeclared,
          [],
          `${surface.name} serves fields with no field_sources entry: ${undeclared.join(", ")}`,
        );
      });

      test("no provenance entry describes a field that is not served", () => {
        const served = new Set(provenanceRequiredFields(surface.schema));
        const orphans = Object.keys(surface.sources).filter(
          (field) => !served.has(field),
        );
        assert.deepEqual(
          orphans,
          [],
          `${surface.name} declares provenance for fields it does not serve: ${orphans.join(", ")}`,
        );
      });

      test("measurements name a pallet-qualified storage item", () => {
        const bad = Object.entries(surface.sources)
          .filter(
            ([, source]) =>
              source.kind === "measured" &&
              !(
                typeof source.storage === "string" &&
                STORAGE_ITEM_PATTERN.test(source.storage)
              ),
          )
          .map(([field]) => field);
        assert.deepEqual(
          bad,
          [],
          `${surface.name} claims a measurement without naming Pallet.Item: ${bad.join(", ")}`,
        );
      });

      test("reconstructions name no storage item", () => {
        // A derived value carrying a storage item would read as a chain
        // publication, which is the exact confusion the map exists to prevent.
        const bad = Object.entries(surface.sources)
          .filter(
            ([, source]) =>
              source.kind === "reconstructed" && source.storage !== null,
          )
          .map(([field]) => field);
        assert.deepEqual(
          bad,
          [],
          `${surface.name} dresses a reconstruction as a read: ${bad.join(", ")}`,
        );
      });
    });
  }

  test("the three reconstructions on /network/parameters stay reconstructions", () => {
    // Named rather than left to the generic checks above: these are the three
    // values a caller is most likely to cite as chain readings, and the
    // consequence of a wrong label here is a model attributing our own
    // constant to Bittensor. block_emission_* are issuance-derived and NOT the
    // stale BlockEmission item (#8747); emission_gate_exponent_effective is
    // DEFAULT_EMISSION_GATE_EXPONENT whenever the item is unset, which is its
    // current on-chain state.
    for (const field of [
      "block_emission_tao",
      "block_emission_halvings",
      "emission_gate_exponent_effective",
    ]) {
      assert.equal(
        NETWORK_PARAMETERS_FIELD_SOURCES[
          field as keyof typeof NETWORK_PARAMETERS_FIELD_SOURCES
        ].kind,
        "reconstructed",
        `${field} is ours, not the chain's`,
      );
    }
  });
});
