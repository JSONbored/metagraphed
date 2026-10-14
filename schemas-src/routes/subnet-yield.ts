// GET /api/v1/subnets/{netuid}/yield + .../yield/history (types-epic B
// batch 2, #8056). Live neurons/neuron_daily-tier stats -- no static file.
// Modeled from src/subnet-yield.ts's buildSubnetYield()/
// buildSubnetYieldHistory(), cross-checked against the hand-edited
// SubnetYieldArtifact/SubnetYieldHistoryArtifact components they replace.
import { z } from "zod";
import { HoldingsUnavailableSchema } from "../alpha-quantity.ts";
import { subnetHistoryArtifactSchema } from "../shared.ts";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const SUBNET_YIELD_WINDOW_VALUES = ["7d", "30d", "90d"] as const;

const SubnetYieldNeuronSchema = z
  .object({
    uid: z.int().min(0),
    hotkey: z.string().nullable(),
    role: z.enum(["validator", "miner"]),
    voting_weight: z
      .number()
      .nullable()
      .describe("Effective voting weight; unavailable cells remain null."),
    stake_tao: z
      .number()
      .nullable()
      .describe("Deprecated unsupported native holdings amount; always null."),
    emission_tao: z
      .number()
      .nullable()
      .describe(
        "This row's emission in the subnet named by the sibling `netuid`, alpha-denominated for the same reason as the sibling stake field and under the same deliberate on-chain naming (#2550/#8945). netuid 0 (root) is genuine TAO. The RATE PERIOD is one TEMPO -- the subnet's `tempo` hyperparameter, 360 blocks (~20 tempos/day) on effectively every subnet -- not one day: multiply by tempos/day before deriving a daily figure.",
      ),
    yield: z.number().nullable(),
    vs_median: z.enum(["above", "below", "at"]).nullable(),
  })
  .strict()
  .describe(
    "One UID observation. Voting weights are retained; native holdings and investment yield remain unqualified.",
  );

export const SubnetYieldArtifactSchema = z
  .object({
    schema_version: z.literal(2),
    netuid: z.int().min(0),
    captured_at: z.iso.datetime().nullable(),
    block_number: z.int().nullable(),
    neuron_count: z.int().min(0),
    validator_count: z.int().min(0),
    miner_count: z.int().min(0),
    total_stake_alpha: z
      .number()
      .nullable()
      .describe("Deprecated unsupported holdings total; always null."),
    total_emission_alpha: z.number(),
    subnet_yield: z.number().nullable(),
    mean_yield: z.number().nullable(),
    median_yield: z.number().nullable(),
    p25_yield: z.number().nullable(),
    p75_yield: z.number().nullable(),
    p90_yield: z.number().nullable(),
    neurons: z.array(SubnetYieldNeuronSchema),
    degraded: HoldingsUnavailableSchema,
  })
  .strict();
export type SubnetYieldArtifact = z.infer<typeof SubnetYieldArtifactSchema>;

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
  .strict();

export const SubnetYieldHistoryArtifactSchema = subnetHistoryArtifactSchema(
  SubnetYieldHistoryPointSchema,
)
  .extend({
    schema_version: z.literal(2),
    degraded: HoldingsUnavailableSchema,
  })
  .describe(
    "Per-day emission-yield distribution trend for one subnet (newest first) over a 7d/30d/90d window: the subnet-wide return plus the mean/median/p25/p75/p90 of the per-UID emission-per-stake yields. The return-rate twin of /concentration/history and the time-series companion to the /yield snapshot — the per-UID yield distribution (median/percentiles) is not reconstructable from the stake+emission totals in /history. Computed live from the neuron_daily rollup.",
  );
export type SubnetYieldHistoryArtifact = z.infer<
  typeof SubnetYieldHistoryArtifactSchema
>;
