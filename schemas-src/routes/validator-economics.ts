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
  .strict()
  .describe(
    "Permitted, active and earning are three DIFFERENT sets. Network-wide 2026-08-03: 1,523 / 1,137 / 1,117; SN83 is 64 / 8 / 7. Published separately rather than collapsed, because 'how many validators does this subnet have' has three defensible answers.",
  );

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
  .strict()
  .describe(
    "How well the derived permit rule still reproduces the permits the chain actually granted. Published so a caller can see when the model has drifted rather than trusting a floor it no longer supports.",
  );

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
    median_earning: z
      .number()
      .nullable()
      .describe(
        "Median restricted to permit-holders that actually earn -- takes among validators nobody delegates to are noise.",
      ),
    sample_size: z.int().min(0),
  })
  .strict()
  .describe(
    "The commission picture across permit-holders. The sorted vector is published because the shape is the information: it is genuinely bimodal, with a cohort competing at or near zero against a median at the effective ceiling, and validators earning at both ends.",
  );

export const SubnetValidatorEconomicsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),

    // Floors are in total_stake UNITS (alpha + tao_weight * root), not alpha alone —
    // the quantity the chain threshold actually tests.
    permit_floor_units: z
      .number()
      .nullable()
      .describe(
        "Floors are in total_stake UNITS (alpha + tao_weight * root), the quantity the chain threshold actually tests -- not alpha alone.",
      ),
    permit_floor_cost_tao: z.number().nullable(),
    permit_entry_cost_tao: z
      .number()
      .nullable()
      .describe(
        "Floor cost plus the registration burn. Entry is two spends; publishing one understates it.",
      ),
    // The EARNING floors exclude the subnet owner: its permit is unconditional,
    // so an owner earning on ~0 stake reported a floor of 0 -- "free to earn here" -- and
    // a 0-alpha buy cannot be priced, which then dropped the subnet out of the
    // cross-subnet ranking as unpriceable. Null means no NON-OWNER has earned here,
    // which is a real answer about the subnet rather than a missing reading.
    earning_floor_units: z
      .number()
      .nullable()
      .describe(
        "The smallest stake that actually EARNS dividends here, excluding the subnet owner -- its permit is unconditional, so an owner earning on ~0 stake would report a floor of 0. Null when NO non-owner has earned on this subnet, which is a real answer (the owner is taking the dividends), not a missing one.",
      ),
    earning_floor_cost_tao: z.number().nullable(),
    earning_entry_cost_tao: z.number().nullable(),
    permit_to_earning_multiple: z
      .number()
      .nullable()
      .describe("How much more it takes to EARN than merely to hold a permit."),

    // Root is not split: this one figure clears the threshold on EVERY subnet the
    // hotkey is registered on at once, which is the cross-subnet alternative to the
    // per-subnet alpha costs above.
    root_tao_to_clear_threshold: z
      .number()
      .nullable()
      .describe(
        "Root is not split: this much root clears the threshold on EVERY subnet the hotkey is registered on at once.",
      ),

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
    emission_gate_open: z
      .boolean()
      .nullable()
      .describe(
        "Reported, never scored. Gate-closed subnets still emit alpha at a comparable rate and are less contested, so per unit of stake they pay MORE -- the gate is an exit-liquidity question, not an eligibility one.",
      ),
    tao_inflow_per_day: z.number().nullable(),
    registration_cost_tao: z.number().nullable(),

    // Echoed so a caller never has to guess what the floor was computed against. Both
    // are sudo-settable, so a cached copy on the caller's side would silently rot.
    stake_threshold_units: z
      .number()
      .nullable()
      .describe(
        "Echoed so a caller never has to guess what the floor was computed against. Both are sudo-settable, so a cached copy would silently rot.",
      ),
    tao_weight: z.number().nullable(),

    model_agreement: ValidatorPermitModelAgreementSchema.nullable(),
    degraded_reason: z
      .string()
      .nullable()
      .describe(
        "Names the missing input whenever a field above was withheld, so a caller can tell 'unknown' from 'zero'.",
      ),
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

// GET /api/v1/validators/economics (#9324) — the cross-subnet ranking.
//
// One row per subnet, reusing the per-subnet artifact shape so a caller reading
// both surfaces never has to reconcile two vocabularies for the same fields.
//
// `excluded` is part of the contract, not a debug aid: a ranking that silently
// drops a subnet cannot answer "why is SN45 not in this list", which is the next
// question it gets asked.
export const ValidatorEconomicsExclusionSchema = z
  .object({
    netuid: z.int().min(0),
    reason: z.string(),
  })
  .strict()
  .describe(
    "One subnet the ranking dropped, and why, so that a caller can tell an omitted subnet from an absent one without re-deriving the ranking.",
  );

export const ValidatorEconomicsRankingArtifactSchema = z
  .object({
    schema_version: z.int(),
    sort: z.string(),
    order: z.enum(["asc", "desc"]),
    total: z
      .int()
      .min(0)
      .describe(
        "Rows matching the filters, BEFORE limit/offset -- so a caller can page without re-counting.",
      ),
    rows: z.array(SubnetValidatorEconomicsArtifactSchema),
    excluded: z.array(ValidatorEconomicsExclusionSchema),
    // Echoed once for the whole ranking rather than repeated per row: both are
    // network-wide and sudo-settable, and the floors in every row were derived
    // against exactly these values.
    stake_threshold_units: z
      .number()
      .nullable()
      .describe(
        "Echoed once for the whole ranking: every row's floors were derived against exactly these values, and both are sudo-settable.",
      ),
    tao_weight: z.number().nullable(),
    root_tao_to_clear_threshold: z.number().nullable(),
    field_sources: FieldSourcesSchema,
  })
  .strict();
export type ValidatorEconomicsRankingArtifact = z.infer<
  typeof ValidatorEconomicsRankingArtifactSchema
>;

// GET /api/v1/subnets/{netuid}/validator-economics/history (#9326).
//
// The floors here are OBSERVED, not re-derived — the smallest stake that actually
// held a permit that day. `StakeThreshold` is sudo-settable, so re-running today's
// threshold against a historical snapshot would report what the floor WOULD have
// been under today's rules and show a flat line across a governance change that
// actually moved it.
//
// Cost fields are deliberately absent: a historical TAO cost needs the pool reserves
// as they were, priced at the time, and reconstructing one from today's reserves
// would be wrong in exactly the way the moving-price trap catches elsewhere. Alpha
// floors are unambiguous; cost is a present-tense question the per-subnet route
// answers.
//
// The cap WAS omitted here, because `subnet_snapshots` carries no historical
// `max_validators` and applying today's cap to an old snapshot would manufacture a
// transition that never happened. That reasoning was right about the hazard and wrong
// about the remedy: `permit_floor_alpha` is the observed floor REGARDLESS of cap
// state, so without a cap the series cannot be read at all, and every consumer joined
// today's cap off the current record — committing the same error, silently, and getting
// it wrong for any subnet whose cap moved inside the window.
//
// So the cap ships, resolved per day from the `subnet_hyperparams_history` change-log,
// with `max_validators_source` naming the days that fall back to the live value. An
// approximation the caller can see is not the failure mode being guarded against.
export const ValidatorEconomicsHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    permit_floor_alpha: z.number().nullable(),
    earning_floor_alpha: z.number().nullable(),
    validators_permitted: z.int().min(0),
    validators_active: z.int().min(0),
    validators_earning: z.int().min(0),
    emission_gate_open: z.boolean().nullable(),
    tao_inflow_per_day: z.number().nullable(),
    max_validators: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "The validator cap in force on this day. permit_floor_alpha is the observed floor REGARDLESS of cap state, so it cannot be read without this -- and joining today's cap onto an old point is wrong for any subnet whose cap moved.",
      ),
    max_validators_source: z
      .enum(["observed", "current"])
      .nullable()
      .describe(
        "Where max_validators came from: observed = the hyperparameter change-log recorded it at or before this day; current = the change-log does not reach this far back, so the LIVE cap is reported.",
      ),
    permit_set_full: z
      .boolean()
      .nullable()
      .describe(
        "Whether the permit set was full on this day (validators_permitted >= max_validators). NOT the same measure as the current record's cap_binding, which counts UIDs clearing the threshold against slots -- only the permitted set survives in a daily snapshot.",
      ),
  })
  .strict()
  .describe(
    "One day's observed economics. The floors are read off the snapshot, not re-derived: StakeThreshold is sudo-settable, so re-running today's threshold against an old day would show a flat line across a governance change that actually moved the floor.",
  );

export const SubnetValidatorEconomicsHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string(),
    points: z
      .array(ValidatorEconomicsHistoryPointSchema)
      .describe("Newest first."),
    field_sources: FieldSourcesSchema,
  })
  .strict();
export type SubnetValidatorEconomicsHistoryArtifact = z.infer<
  typeof SubnetValidatorEconomicsHistoryArtifactSchema
>;
