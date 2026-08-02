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
  REQUEST_ECHO_FIELDS,
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
import {
  SubnetBurnArtifactSchema,
  SubnetRecycledArtifactSchema,
} from "../schemas-src/routes/subnet-registration-cost.ts";
import { SUBNET_BURN_FIELD_SOURCES } from "../src/subnet-burn.ts";
import { SUBNET_RECYCLED_FIELD_SOURCES } from "../src/subnet-recycled.ts";
import { SubnetEconomicsSchema } from "../schemas-src/shared.ts";
import { ECONOMICS_FIELD_SOURCES } from "../src/economics-field-sources.ts";
import { AccountBalanceArtifactSchema } from "../schemas-src/routes/account-balance.ts";
import { AccountRootClaimArtifactSchema } from "../schemas-src/routes/account-root-claim.ts";
import { EvmAddressMappingArtifactSchema } from "../schemas-src/routes/network-singletons.ts";
import { SubnetLeaseArtifactSchema } from "../schemas-src/routes/subnet-lease.ts";
import {
  AccountChildrenArtifactSchema,
  AccountParentsArtifactSchema,
} from "../schemas-src/routes/account-child-delegation.ts";
import { ACCOUNT_BALANCE_FIELD_SOURCES } from "../src/account-balance.ts";
import { ACCOUNT_ROOT_CLAIM_FIELD_SOURCES } from "../src/account-root-claim.ts";
import { ADDRESS_MAPPING_FIELD_SOURCES } from "../src/address-mapping.ts";
import { SUBNET_LEASE_FIELD_SOURCES } from "../src/subnet-lease.ts";
import { SubnetConvictionArtifactSchema } from "../schemas-src/routes/subnet-conviction.ts";
import { SUBNET_CONVICTION_FIELD_SOURCES } from "../src/subnet-conviction.ts";
import {
  ACCOUNT_CHILDREN_FIELD_SOURCES,
  ACCOUNT_PARENTS_FIELD_SOURCES,
} from "../src/child-hotkey-delegation.ts";

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
    name: "GET /api/v1/subnets/{netuid}/burn",
    schema: SubnetBurnArtifactSchema,
    sources: SUBNET_BURN_FIELD_SOURCES,
  },
  {
    name: "GET /api/v1/subnets/{netuid}/recycled",
    schema: SubnetRecycledArtifactSchema,
    sources: SUBNET_RECYCLED_FIELD_SOURCES,
  },
  {
    name: "GET /api/v1/accounts/{ss58}/balance",
    schema: AccountBalanceArtifactSchema,
    sources: ACCOUNT_BALANCE_FIELD_SOURCES,
  },
  {
    name: "GET /api/v1/accounts/{ss58}/root-claim",
    schema: AccountRootClaimArtifactSchema,
    sources: ACCOUNT_ROOT_CLAIM_FIELD_SOURCES,
  },
  {
    name: "GET /api/v1/accounts/{ss58}/children",
    schema: AccountChildrenArtifactSchema,
    sources: ACCOUNT_CHILDREN_FIELD_SOURCES,
  },
  {
    name: "GET /api/v1/accounts/{ss58}/parents",
    schema: AccountParentsArtifactSchema,
    sources: ACCOUNT_PARENTS_FIELD_SOURCES,
  },
  {
    name: "GET /api/v1/evm/address/{h160}",
    schema: EvmAddressMappingArtifactSchema,
    sources: ADDRESS_MAPPING_FIELD_SOURCES,
  },
  {
    name: "GET /api/v1/subnets/{netuid}/conviction",
    schema: SubnetConvictionArtifactSchema,
    sources: SUBNET_CONVICTION_FIELD_SOURCES,
  },
  {
    name: "GET /api/v1/subnets/{netuid}/lease",
    schema: SubnetLeaseArtifactSchema,
    sources: SUBNET_LEASE_FIELD_SOURCES,
  },
  {
    // The map describes the SUBNET ROW, not the artifact envelope -- same
    // relationship the emission pipeline's map has to its per-subnet rows.
    name: "GET /api/v1/economics (subnet row)",
    schema: SubnetEconomicsSchema,
    sources: ECONOMICS_FIELD_SOURCES,
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
  route = "",
): string[] {
  const echoes = new Set(REQUEST_ECHO_FIELDS[route] ?? []);
  return Object.keys(schema.shape).filter(
    (field) =>
      field !== "field_sources" &&
      !PROVENANCE_EXEMPT_FIELDS.has(field) &&
      !echoes.has(field),
  );
}

/** `GET /api/v1/x (note)` -> `/api/v1/x`, to look up that route's echoes. */
function routeOf(name: string): string {
  return name.replace(/^[A-Z]+ /, "").replace(/ \(.*\)$/, "");
}

describe("published field_sources maps match the fields they describe (#9078)", () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      test("every published field carries provenance", () => {
        const undeclared = provenanceRequiredFields(
          surface.schema,
          routeOf(surface.name),
        ).filter((field) => !(field in surface.sources));
        assert.deepEqual(
          undeclared,
          [],
          `${surface.name} serves fields with no field_sources entry: ${undeclared.join(", ")}`,
        );
      });

      test("no provenance entry describes a field that is not served", () => {
        const served = new Set(
          provenanceRequiredFields(surface.schema, routeOf(surface.name)),
        );
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

  // #9106. `read_at` exists for exactly one reason, so it gets asserted
  // directly rather than left to the generic per-surface checks.
  describe("the economics read instants", () => {
    test("the two same-item pairs are distinguished, not conflated", () => {
      // alpha_price_tao and moving_price_pinned are the SAME chain item read at
      // two heights, and exist separately BECAUSE they disagree. A map that
      // labelled them identically would assert they are interchangeable --
      // worse than publishing nothing.
      for (const [capture, pinned] of [
        ["alpha_price_tao", "moving_price_pinned"],
        ["registration_allowed", "registration_allowed_pinned"],
      ] as const) {
        const a = ECONOMICS_FIELD_SOURCES[capture];
        const b = ECONOMICS_FIELD_SOURCES[pinned];
        assert.equal(a.read_at, "capture", `${capture} is the bulk-call read`);
        assert.equal(
          b.read_at,
          "chain_state.block",
          `${pinned} is the pinned read`,
        );
        assert.notEqual(
          a.read_at,
          b.read_at,
          `${capture} and ${pinned} must not claim the same instant`,
        );
      }
      // And the price pair really is one chain item, seen from both sides.
      assert.equal(
        ECONOMICS_FIELD_SOURCES.moving_price_pinned.storage,
        "SubtensorModule.SubnetMovingPrice",
      );
    });

    test("only the surface that mixes instants declares one", () => {
      // Every other map must stay silent: a read_at on a single-instant
      // response would imply the others are different, which they are not.
      for (const surface of SURFACES) {
        const labelled = Object.entries(surface.sources).filter(
          ([, source]) => source.read_at !== undefined,
        );
        const expected = surface.name.startsWith("GET /api/v1/economics");
        assert.equal(
          labelled.length > 0,
          expected,
          `${surface.name} ${expected ? "must" : "must not"} declare read_at`,
        );
      }
    });

    test("a reconstruction spanning instants declares none", () => {
      // The price changes combine the capture-instant price with a DAILY
      // rollup, so no single instant is true of them. Absent must mean "no
      // single instant applies" -- if one of these ever gained a read_at it
      // would be claiming a precision it does not have.
      // Read through the PUBLISHED shape, not the literal type. `as const`
      // narrows these four to a type with no `read_at` at all -- which is the
      // compiler agreeing with the assertion, but leaves nothing to assert
      // against. A JSON consumer sees the wider shape, so the check does too.
      const published = ECONOMICS_FIELD_SOURCES as FieldSources;
      for (const field of [
        "alpha_price_change_1h",
        "alpha_price_change_1d",
        "alpha_price_change_7d",
        "alpha_price_change_1m",
      ]) {
        assert.equal(
          published[field].read_at,
          undefined,
          `${field} spans instants and must not claim one`,
        );
      }
    });
  });

  test("the conviction leaderboard stays an extrapolation", () => {
    // The load-bearing claim on that route, and the generic checks cannot make
    // it: `measured` + a plausible-looking `SubtensorModule.SubnetLocks` passes
    // every shape rule while asserting the chain published these numbers at
    // this block. It did not -- each row is rolled forward from its own
    // last_update, replicating roll_forward_lock. Verified by mutation that the
    // generic rules alone let that through.
    for (const field of ["leaderboard", "king", "count"] as const) {
      assert.equal(
        SUBNET_CONVICTION_FIELD_SOURCES[field].kind,
        "reconstructed",
        `${field} is rolled forward to queried_at_block, not read at it`,
      );
    }
    // The inputs that make the extrapolation checkable ARE reads.
    for (const field of ["unlock_rate", "maturity_rate"] as const) {
      assert.equal(SUBNET_CONVICTION_FIELD_SOURCES[field].kind, "measured");
    }
  });

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
