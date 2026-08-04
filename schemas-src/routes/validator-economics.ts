// GET /api/v1/subnets/{netuid}/validator-economics (#9323, #9327) — computed-payload
// envelope, the same shape as stake-quote: no artifact read, pure derivation
// (src/validator-economics.ts's buildValidatorEconomics) over the neurons tier plus the
// live economics-tier pool reserves and the two governance parameters.
//
// Every derived numeric is nullable on purpose. A confident 0 here reads as "free to
// validate", which is the specific wrong answer the module degrades to avoid — see
// #9285/#9114/#9121 for the same class. `degraded_reason` names the missing input
// whenever a field was withheld, so a caller can tell "unknown" from "zero".
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { FieldSourcesSchema } from "../shared.ts";

// Permitted / active / earning are three DIFFERENT sets and are published separately
// rather than collapsed. Network-wide 2026-08-03: 1,523 / 1,137 / 1,117; SN83 is
// 64 / 8 / 7. A caller asking "how many validators does this subnet have" can get three
// defensible answers, so the route gives all three instead of picking one.
export const ValidatorSetCompositionSchema = z
  .object({
    permitted: z.int().min(0),
    active: z.int().min(0),
    earning: z.int().min(0),
  })
  .strict();

// The derived floor is only publishable while the rule still reproduces the permits the
// chain actually granted. This is the route telling a caller when its own model has
// drifted, rather than asserting confidence it has not earned.
export const ValidatorPermitModelAgreementSchema = z
  .object({
    matched: z.int().min(0),
    over_predicted: z.int().min(0),
    under_predicted: z.int().min(0),
    observed_permits: z.int().min(0),
    agreement: z.number().min(0).max(1).nullable(),
    publishable: z.boolean(),
  })
  .strict();

// The shape is the information (#9327): SN64's permit-holders sat at
// `0, 0, 0.001, 0.01, 0.0135, 0.06, 0.09, 0.18 x9` — a median of 0.18 against a cohort
// competing at zero, with validators earning at both ends. `distribution` carries the
// sorted vector so a caller can see that; a lone median cannot.
export const ValidatorTakeDistributionSchema = z
  .object({
    median: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    distribution: z.array(z.number()),
    median_earning: z.number().nullable(),
    sample_size: z.int().min(0),
  })
  .strict();

export const SubnetValidatorEconomicsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),

    // Floors are in total_stake UNITS (alpha + tao_weight * root), not alpha alone —
    // the quantity the chain threshold actually tests.
    permit_floor_units: z.number().nullable(),
    permit_floor_cost_tao: z.number().nullable(),
    permit_entry_cost_tao: z.number().nullable(),
    earning_floor_units: z.number().nullable(),
    earning_floor_cost_tao: z.number().nullable(),
    earning_entry_cost_tao: z.number().nullable(),
    permit_to_earning_multiple: z.number().nullable(),

    // Root is not split: this one figure clears the threshold on EVERY subnet the
    // hotkey is registered on at once, which is the cross-subnet alternative to the
    // per-subnet alpha costs above.
    root_tao_to_clear_threshold: z.number().nullable(),

    max_validators: z.int().min(0).nullable(),
    validator_slots_open: z.int().min(0).nullable(),
    uids_above_threshold: z.int().min(0).nullable(),
    cap_binding: z.boolean().nullable(),
    composition: ValidatorSetCompositionSchema.nullable(),

    takes: ValidatorTakeDistributionSchema.nullable(),
    min_childkey_take_ratio: z.number().nullable(),

    // Reported, never scored. Gate-closed subnets still emit alpha at a comparable rate
    // and are less contested, so per unit of stake they pay MORE — the gate is an
    // exit-liquidity question, not an eligibility one.
    emission_gate_open: z.boolean().nullable(),
    tao_inflow_per_day: z.number().nullable(),
    registration_cost_tao: z.number().nullable(),

    // Echoed so a caller never has to guess what the floor was computed against. Both
    // are sudo-settable, so a cached copy on the caller's side would silently rot.
    stake_threshold_units: z.number().nullable(),
    tao_weight: z.number().nullable(),

    model_agreement: ValidatorPermitModelAgreementSchema.nullable(),
    degraded_reason: z.string().nullable(),
    // Required by the chain-read route convention. Nearly every field here is
    // DERIVED — there is no storage item behind `permit_floor_units` — so those
    // carry `kind: "reconstructed", storage: null`, and `measured` is reserved for
    // the echoed hyperparameters that genuinely are single reads.
    field_sources: FieldSourcesSchema,
  })
  .strict();
export type SubnetValidatorEconomicsArtifact = z.infer<
  typeof SubnetValidatorEconomicsArtifactSchema
>;

export const SubnetValidatorEconomicsResponseSchema = successEnvelopeSchema(
  SubnetValidatorEconomicsArtifactSchema,
);

export const SubnetValidatorEconomicsQuerySchema = z.object({}).strict();
export type SubnetValidatorEconomicsQuery = z.infer<
  typeof SubnetValidatorEconomicsQuerySchema
>;
