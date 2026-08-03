// GET /api/v1/subnets/{netuid}/yield + .../yield/history (types-epic B
// batch 2, #8056). Live neurons/neuron_daily-tier stats -- no static file.
// Modeled from src/subnet-yield.ts's buildSubnetYield()/
// buildSubnetYieldHistory(), cross-checked against the hand-edited
// SubnetYieldArtifact/SubnetYieldHistoryArtifact components they replace.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const SubnetYieldNeuronSchema = z
  .object({
    uid: z.int().min(0),
    hotkey: z.string().nullable(),
    role: z.enum(["validator", "miner"]),
    stake_tao: z
      .number()
      .describe(
        "This row's stake in the subnet named by the sibling `netuid`. ALPHA for non-root subnets -- a non-root neuron's stake is that subnet's own alpha token, not TAO (#2550); netuid 0 (root) stake is genuine TAO. Comparable within one subnet, never summable across subnets: the cross-subnet totals that ARE safe to read as TAO convert through each subnet's alpha price first (#9051/#8803). Kept under the on-chain column name deliberately (#8945).",
      ),
    emission_tao: z
      .number()
      .nullable()
      .describe(
        "This row's emission in the subnet named by the sibling `netuid`, alpha-denominated for the same reason as the sibling stake field and under the same deliberate on-chain naming (#2550/#8945). netuid 0 (root) is genuine TAO.",
      ),
    yield: z.number().nullable(),
    vs_median: z.enum(["above", "below", "at"]).nullable(),
  })
  .strict();

export const SubnetYieldArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    captured_at: z.iso.datetime().nullable(),
    block_number: z.int().nullable(),
    neuron_count: z.int().min(0),
    validator_count: z.int().min(0),
    miner_count: z.int().min(0),
    total_stake_alpha: z.number(),
    total_emission_alpha: z.number(),
    subnet_yield: z.number().nullable(),
    mean_yield: z.number().nullable(),
    median_yield: z.number().nullable(),
    p25_yield: z.number().nullable(),
    p75_yield: z.number().nullable(),
    p90_yield: z.number().nullable(),
    neurons: z.array(SubnetYieldNeuronSchema),
  })
  .strict();
export type SubnetYieldArtifact = z.infer<typeof SubnetYieldArtifactSchema>;
export const SubnetYieldResponseSchema = successEnvelopeSchema(
  SubnetYieldArtifactSchema,
);
export const SubnetYieldQuerySchema = z.object({}).strict();
export type SubnetYieldQuery = z.infer<typeof SubnetYieldQuerySchema>;

const SubnetYieldHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    neuron_count: z.int().min(0).optional(),
    validator_count: z.int().min(0).optional(),
    yield_count: z.int().min(0).optional(),
    subnet_yield: z.number().nullable().optional(),
    mean_yield: z.number().nullable().optional(),
    median_yield: z.number().nullable().optional(),
    p25_yield: z.number().nullable().optional(),
    p75_yield: z.number().nullable().optional(),
    p90_yield: z.number().nullable().optional(),
  })
  .passthrough();

export const SubnetYieldHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    point_count: z.int().min(0),
    points: z.array(SubnetYieldHistoryPointSchema),
  })
  .passthrough()
  .describe(
    "Per-day emission-yield distribution trend for one subnet (newest first) over a 7d/30d/90d window: the subnet-wide return plus the mean/median/p25/p75/p90 of the per-UID emission-per-stake yields. The return-rate twin of /concentration/history and the time-series companion to the /yield snapshot — the per-UID yield distribution (median/percentiles) is not reconstructable from the stake+emission totals in /history. Computed live from the neuron_daily D1 rollup.",
  );
export type SubnetYieldHistoryArtifact = z.infer<
  typeof SubnetYieldHistoryArtifactSchema
>;
export const SubnetYieldHistoryResponseSchema = successEnvelopeSchema(
  SubnetYieldHistoryArtifactSchema,
);
export const SubnetYieldHistoryQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d"]).optional(),
  })
  .strict();
export type SubnetYieldHistoryQuery = z.infer<
  typeof SubnetYieldHistoryQuerySchema
>;
