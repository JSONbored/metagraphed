// MCP tools `get_validator_detail`, `list_global_validators`,
// `get_validator_history`, `get_validator_nominators`.
// Mirror GET /api/v1/validators/{hotkey}, GET /api/v1/validators, GET
// /api/v1/validators/{hotkey}/history, GET
// /api/v1/validators/{hotkey}/nominators.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_validator_detail: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  NeuronFieldsInputSchema,
  accountKeySchema,
  limitSchema,
  netuidSchema,
  offsetSchema,
  sortSchema,
  windowSchema,
} from "./shared.ts";
import {
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { GlobalValidatorsArtifactSchema } from "../routes/global-validators.ts";
import { ValidatorDetailArtifactSchema } from "../routes/validator-detail.ts";
import { ValidatorHistoryArtifactSchema } from "../routes/validator-history.ts";
import { ValidatorNominatorsArtifactSchema } from "../routes/validator-nominators.ts";
import { NeuronSchema } from "../routes/subnet-metagraph.ts";
import { CompareValidatorEntrySchema } from "../routes/compare-validators.ts";
import { GLOBAL_VALIDATORS_VALIDATOR_SORTS_VALUES } from "../routes/global-validators.ts";
import {
  VALIDATOR_NOMINATORS_NOMINATOR_SORTS_VALUES,
  VALIDATOR_NOMINATORS_WINDOW_VALUES,
} from "../routes/validator-nominators.ts";

// Mirrors workers/config.ts's SS58_ADDRESS_PATTERN (inlined rather than
// cross-imported from workers/, matching this directory's existing
// convention of inlining its own regex constants, e.g. subnets.ts's
// HttpUrlSchema).
const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const ListSubnetValidatorsInputSchema = z
  .object({
    netuid: netuidSchema(),
    // NOT limitSchema(): that helper takes the mirrored route's ceiling, and
    // this parameter has none to take. It is an MCP-only post-filter applied
    // after the loader returns (see this tool's handler), so the REST route
    // enforces nothing here and the subnet's own validator set is the bound.
    // Publishing an invented `maximum` would advertise a constraint the
    // handler does not apply -- the same defect as declaring a ceiling a route
    // rejects, in reverse. Described, deliberately unbounded.
    limit: z
      .int()
      .min(1)
      .describe(
        "Keep only the highest-stake N validators. Applied after the set is " +
          "fetched, so it trims the response rather than the query, and has " +
          "no fixed ceiling: the subnet's own validator count is the bound.",
      )
      .optional()
      .meta({ examples: [20] }),
    min_stake_tao: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Drop rows whose stake is below this many TAO. Applied after the set is fetched.",
      )
      .meta({ examples: [1000] }),
    // #9082: narrow each returned row to these fields. Omit for the full
    // row. Valid names are NeuronSchema's own, so this enum cannot drift
    // from what the route can project.
    fields: NeuronFieldsInputSchema.meta({ examples: ["netuid,name,slug"] }),
  })
  .strict();
export type ListSubnetValidatorsInput = z.infer<
  typeof ListSubnetValidatorsInputSchema
>;

export const ListSubnetValidatorsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    validator_count: z.int(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    // Typed from the route's own NeuronSchema (#9797), PARTIAL because this
    // tool advertises `fields`: a caller who projects the row must still
    // satisfy the schema the tool publishes, which is the contract #9884
    // restored after the derivation in #9855/#9859 broke it. Verified against
    // production 2026-08-07, whole and projected.
    validators: z.array(NeuronSchema.partial()),
  })
  .passthrough();
export type ListSubnetValidatorsOutput = z.infer<
  typeof ListSubnetValidatorsOutputSchema
>;

// Symbolic in the hand-written original (src/metagraph-neurons.ts's
// GLOBAL_VALIDATORS_VALIDATOR_SORTS_VALUES/DEFAULT_GLOBAL_VALIDATOR_SORT/*_LIMIT_*), cross-
// checked against the actual runtime source at the time of writing.
export const ListGlobalValidatorsInputSchema = z
  .object({
    sort: sortSchema(GLOBAL_VALIDATORS_VALIDATOR_SORTS_VALUES).optional(),
    // Was a hardcoded 100 while this tool's own description — interpolated from
    // GLOBAL_VALIDATOR_LIMIT_MAX — said "max 2000", and the handler clamped to 2000.
    // The tool advertised 2000 in prose, 100 in schema, and served 2000. Now the
    // constant is the only declaration, as src/route-limits.ts intended.
    limit: limitSchema(
      GLOBAL_VALIDATOR_LIMIT_MAX,
      GLOBAL_VALIDATOR_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type ListGlobalValidatorsInput = z.infer<
  typeof ListGlobalValidatorsInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const ListGlobalValidatorsOutputSchema = GlobalValidatorsArtifactSchema;
export type ListGlobalValidatorsOutput = z.infer<
  typeof ListGlobalValidatorsOutputSchema
>;

export const GetValidatorDetailInputSchema = z
  .object({
    hotkey: accountKeySchema("hotkey"),
  })
  .strict();
export type GetValidatorDetailInput = z.infer<
  typeof GetValidatorDetailInputSchema
>;

export const GetValidatorDetailOutputSchema = ValidatorDetailArtifactSchema;
export type GetValidatorDetailOutput = z.infer<
  typeof GetValidatorDetailOutputSchema
>;

// src/analytics-live.ts's COMPARE_VALIDATORS_MAX, cross-checked against the
// actual runtime value at the time of writing.
const COMPARE_VALIDATORS_MAX = 16;

export const CompareValidatorsInputSchema = z
  .object({
    hotkeys: z
      .array(Ss58Schema)
      .min(1)
      .max(COMPARE_VALIDATORS_MAX)
      .describe(
        "SS58 hotkeys to compare, as an array. Each is a validator/neuron key, not a coldkey.",
      )
      .meta({
        examples: [["5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV"]],
      }),
    netuid: netuidSchema().optional(),
  })
  .strict();
export type CompareValidatorsInput = z.infer<
  typeof CompareValidatorsInputSchema
>;

export const CompareValidatorsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema().nullable().optional(),
    validator_count: z.int(),
    // Typed from the route's own CompareValidatorEntrySchema (#9797). This
    // is the SECOND `validators` site in this file -- list_subnet_validators'
    // is a neuron row, compare_validators' is the side-by-side comparison
    // entry, and they are deliberately different shapes. Verified against
    // production 2026-08-07.
    validators: z.array(CompareValidatorEntrySchema),
  })
  .passthrough();
export type CompareValidatorsOutput = z.infer<
  typeof CompareValidatorsOutputSchema
>;

// Symbolic in the hand-written original (src/validator-nominators.ts's
// VALIDATOR_NOMINATORS_WINDOW_VALUES/VALIDATOR_NOMINATORS_NOMINATOR_SORTS_VALUES/*_LIMIT_*), cross-checked against the
// actual runtime source at the time of writing.
export const GetValidatorNominatorsInputSchema = z
  .object({
    hotkey: accountKeySchema("hotkey"),
    window: windowSchema(VALIDATOR_NOMINATORS_WINDOW_VALUES).optional(),
    sort: sortSchema(VALIDATOR_NOMINATORS_NOMINATOR_SORTS_VALUES).optional(),
    limit: limitSchema(100).optional(),
    offset: offsetSchema().optional(),
    coldkey: accountKeySchema("coldkey").optional(),
  })
  .strict();
export type GetValidatorNominatorsInput = z.infer<
  typeof GetValidatorNominatorsInputSchema
>;

// objectItems(...) properties, none required at the item level.
export const GetValidatorNominatorsOutputSchema =
  ValidatorNominatorsArtifactSchema;
export type GetValidatorNominatorsOutput = z.infer<
  typeof GetValidatorNominatorsOutputSchema
>;

export const GetValidatorHistoryInputSchema = z
  .object({
    hotkey: accountKeySchema("hotkey"),
    window: windowSchema(["7d", "30d", "90d", "1y", "all"]).optional(),
    // #9383: scopes the series to one subnet and switches the points to the
    // per-subnet shape (vTrust, consensus, dividends, take, native alpha).
    netuid: netuidSchema().optional(),
  })
  .strict();
export type GetValidatorHistoryInput = z.infer<
  typeof GetValidatorHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level.
export const GetValidatorHistoryOutputSchema = ValidatorHistoryArtifactSchema;
export type GetValidatorHistoryOutput = z.infer<
  typeof GetValidatorHistoryOutputSchema
>;
