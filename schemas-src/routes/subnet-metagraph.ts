// GET /api/v1/subnets/{netuid}/metagraph + .../neurons/{uid} +
// .../neurons/{uid}/history + .../validators (types-epic B batch 3, #8057).
// Live neurons/neuron_daily-tier data -- no static file. Modeled from
// src/metagraph-neurons.ts's formatNeuron()/buildSubnetMetagraph()/
// buildNeuronDetail()/buildSubnetValidators() and src/neuron-history.ts,
// cross-checked against the hand-edited SubnetMetagraphArtifact/
// NeuronDetailArtifact/SubnetValidatorsArtifact/NeuronHistoryArtifact
// components they replace, and against live get_subnet_metagraph/get_neuron/
// list_subnet_validators/get_neuron_history responses for subnet 1.
//
// Real finding (bucket b): formatNeuron() only emits immunity_expires_at_block/
// immunity_expires_at when the caller passes a resolved immunityPeriod AND the
// row is currently in its immunity window -- confirmed live (uid 0's is_immunity_
// period:true row on subnet 1 carries both fields; every other row omits them).
// The hand-edited Neuron component already declared both as optional, so this
// is a compatibility confirmation, not a correction.
//
// The Neuron shape is intentionally NOT registered as a shared component here
// (matching subnet-concentration.ts's ConcentrationLensSchema precedent) --
// SubnetMetagraphArtifact/NeuronDetailArtifact/SubnetValidatorsArtifact are its
// only three referrers anywhere in schemas/components/*.schema.json (verified
// via repo-wide $ref grep), and all three are converted together in this same
// batch, so the hand-edited Neuron component key becomes fully orphaned.
import { z } from "zod";

// Exported so the surfaces that serve these rows can derive `fields=`'s
// allowed set from the CONTRACT rather than from a second list (#9082) --
// see src/metagraph-neurons.ts's NEURON_PROJECTABLE_FIELDS.
export const NeuronSchema = z
  .object({
    uid: z.int().min(0),
    hotkey: z.string().nullable(),
    coldkey: z.string().nullable(),
    active: z.boolean(),
    validator_permit: z.boolean(),
    rank: z
      .number()
      .nullable()
      .optional()
      .describe(
        "1-based position by incentive, descending. dTAO has no chain rank storage, " +
          "so this is DERIVED by the producer and assigned only to neurons with " +
          "non-zero incentive -- null for the whole incentive == 0 population, which " +
          "is most validators. Verified on netuid 64: non-null on exactly the 16 UIDs " +
          "with incentive > 0. Null means unranked, not rank-last (#9541).",
      ),
    trust: z.number().nullable().optional(),
    validator_trust: z.number().nullable().optional(),
    consensus: z.number().nullable().optional(),
    incentive: z.number().nullable().optional(),
    dividends: z.number().nullable().optional(),
    emission_tao: z
      .number()
      .nullable()
      .optional()
      .describe(
        "This row's emission in the subnet named by the sibling `netuid`, alpha-denominated for the same reason as the sibling stake field and under the same deliberate on-chain naming (#2550/#8945). netuid 0 (root) is genuine TAO.",
      ),
    stake_tao: z
      .number()
      .nullable()
      .optional()
      .describe(
        "This row's stake in the subnet named by the sibling `netuid`. ALPHA for non-root subnets -- a non-root neuron's stake is that subnet's own alpha token, not TAO (#2550); netuid 0 (root) stake is genuine TAO. Comparable within one subnet, never summable across subnets: the cross-subnet totals that ARE safe to read as TAO convert through each subnet's alpha price first (#9051/#8803). Kept under the on-chain column name deliberately (#8945).",
      ),
    registered_at_block: z.int().nullable().optional(),
    is_immunity_period: z.boolean().optional(),
    // registered_at_block+immunity_period; present only while is_immunity_period
    // is true and both inputs are known (#6640) -- omitted, not null, otherwise.
    immunity_expires_at_block: z
      .int()
      .optional()
      .describe(
        "The block immunity ends (registered_at_block + the subnet's live immunity_period); only present while is_immunity_period is true (#6640).",
      ),
    // Wall-clock ETA for immunity_expires_at_block, extrapolated at ~12s/block;
    // only present alongside immunity_expires_at_block.
    immunity_expires_at: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Estimated wall-clock ETA for immunity_expires_at_block, extrapolated from this snapshot's own block/timestamp at ~12s/block; null if that anchor is unavailable (#6640).",
      ),
    axon: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The neuron's announced serving endpoint (ip:port), emitted only when the " +
          "on-chain axon IP is non-zero. Null means NOT SERVING, which is the normal " +
          "state for a validator -- so validator-scoped views read null throughout " +
          "while miner rows on the same table carry a value. There is no alternate " +
          "carrier: AxonServed stores only [netuid, hotkey] (#9541).",
      ),
    // Only present on SubnetValidatorsArtifact rows (a real Set is always
    // passed there); omitted (not false) on metagraph/neuron-detail rows.
    featured: z.boolean().optional(),
    // Validator take/commission (#2548), global per-hotkey. Null if the
    // hotkey had no Delegates entry at capture time.
    take: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Validator take/commission (0..1) from SubtensorModule::Delegates; null when no Delegates entry at capture.",
      ),
  })
  .strict()
  .describe(
    "One UID's live metagraph state within a subnet (hot/cold keys, scores, stake/emission, axon, take).",
  );

export const SubnetMetagraphArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    neuron_count: z.int().min(0),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    neurons: z.array(NeuronSchema),
  })
  .strict();
export type SubnetMetagraphArtifact = z.infer<
  typeof SubnetMetagraphArtifactSchema
>;

export const NeuronDetailArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    neuron: NeuronSchema.nullable().describe(
      "The UID's live metagraph row; null when absent from the latest snapshot.",
    ),
  })
  .strict()
  .describe(
    "One neuron's live metagraph detail card (#5900). Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}: neuron is null when that UID is absent from the latest snapshot.",
  );
export type NeuronDetailArtifact = z.infer<typeof NeuronDetailArtifactSchema>;

export const SubnetValidatorsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    validator_count: z.int().min(0),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    validators: z
      .array(NeuronSchema)
      .describe(
        "Each permitted validator's live metagraph row -- the same NeuronState shape the neuron field returns.",
      ),
  })
  .strict()
  .describe(
    "One subnet's current validator set (#6979). Mirrors GET /api/v1/subnets/{netuid}/validators' data envelope.",
  );
export type SubnetValidatorsArtifact = z.infer<
  typeof SubnetValidatorsArtifactSchema
>;

// Per-day neuron_daily rollup point: a Neuron's state on one snapshot_date
// (every Neuron field, always present per the live neuron_daily rollup query,
// plus the per-point stamp fields) -- confirmed live via get_neuron_history.
const NeuronHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
  })
  .extend(NeuronSchema.shape)
  .strict()
  .describe(
    "One day's metagraph state for a single UID (NeuronState fields plus snapshot_date/captured_at/block_number).",
  );

export const NeuronHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    uid: z.int().min(0),
    window: z.string().nullable().optional(),
    point_count: z.int().min(0),
    /**
     * WHAT THE RESPONSE ACTUALLY COVERED, beside what was asked for (#10788).
     *
     * `window` echoes the REQUEST -- ask for `1y` and this says `1y` -- so
     * without these a consumer receiving 33 points could not tell "that is all
     * that happened" from "that is all we hold". Same reasoning, and the same
     * shape, as /health/failure-reasons: depth counted from the ROWS rather
     * than the requested window.
     *
     * `days_covered` counts DISTINCT days present rather than the span, so a
     * gap in the middle is visible instead of implied away by oldest/newest.
     */
    oldest_day: z.string().nullable(),
    newest_day: z.string().nullable(),
    days_covered: z.int().min(0),
    points: z.array(NeuronHistoryPointSchema),
  })
  .strict()
  .describe(
    "One neuron's per-day metagraph history. Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}/history.",
  );
export type NeuronHistoryArtifact = z.infer<typeof NeuronHistoryArtifactSchema>;
