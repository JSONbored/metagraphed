// GET /api/v1/chain/axon-removals + .../deregistrations + .../prometheus +
// .../registrations + .../serving + .../stake-moves + .../stake-transfers +
// .../weights (types-epic B batch 6, #8060). Live account_events-stream
// data -- no static file. All eight share one shape family: a network
// rollup + a null-when-cold intensity distribution (count/mean/min/p25/
// p50/p75/p90/max) + a per-subnet leaderboard, driven by
// src/chain-axon-removals.ts, src/chain-deregistrations.ts,
// src/chain-prometheus.ts, src/chain-registrations.ts, src/chain-serving.ts,
// src/chain-stake-moves.ts, src/chain-stake-transfers.ts, and
// src/chain-weights.ts respectively -- each builder takes
// `(subnetRows, {window, limit, networkDistinct})` and differs only in its
// field-name prefix (removers/removals, deregistered_hotkeys/
// deregistrations, exporters/announcements, registrants/registrations,
// servers/announcements, movers/movements, senders/transfers,
// setters/weight_sets). Cross-checked against the 8 matching hand-edited
// components they replace.
import { z } from "zod";
import { distributionStatsSchema } from "../shared.ts";
import {
  DeregistrationDerivationSchema,
  EventStreamDegradedSchema,
} from "./event-stream-honesty.ts";

export const IntensityDistributionSchema = distributionStatsSchema(
  z.number().min(0),
).describe(
  "A count and the spread of a per-subnet intensity: mean, min, max, and the 25th/50th/75th/90th percentiles. WHAT is being counted is stated by the field carrying this block, since the same summary describes registrations per hotkey, announcements per server, and transfers per sender alike.",
);

export const ChainAxonRemovalsArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        distinct_removers: z.int().min(0),
        removals: z.int().min(0),
        removals_per_remover: z
          .number()
          .min(0)
          .nullable()
          .describe(
            "Null when distinct_removers is 0 (no defined intensity without removers).",
          ),
      })
      .strict()
      .describe(
        "Network-wide axon-removal rollup: every subnet with AxonInfoRemoved events in the window, combined. distinct_removers counts a hotkey once even when it tears endpoints down on several subnets, so it is NOT the sum of the per-subnet counts.",
      ),
    intensity_distribution: IntensityDistributionSchema.nullable().describe(
      "Spread of per-subnet teardown intensity (AxonInfoRemoved events per remover) across EVERY subnet with removals in the window -- network-wide even when limit truncates the leaderboard.",
    ),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_removers: z.int().min(0),
          removals: z.int().min(0),
          removals_per_remover: z.number().min(0).nullable(),
        })
        .strict()
        .describe(
          "One subnet's axon-removal activity in the window, ranked by removals.",
        ),
    ),
    // #9307: AxonInfoRemoved has never been emitted, so the empty answer this
    // route can only ever give is not a measurement.
    degraded: EventStreamDegradedSchema.nullable().optional(),
  })
  .strict();
export type ChainAxonRemovalsArtifact = z.infer<
  typeof ChainAxonRemovalsArtifactSchema
>;

// #9742: how long the slots that turned over had been held. Optional so a
// body published before this shipped still validates.
const SlotTenureSchema = z
  .object({
    sample_count: z.int().min(0),
    median_blocks: z.int().min(0).nullable(),
    p10_blocks: z.int().min(0).nullable(),
    p90_blocks: z.int().min(0).nullable(),
    min_blocks: z.int().min(0).nullable(),
    max_blocks: z.int().min(0).nullable(),
    // Always true, and published rather than assumed: only a slot that has
    // ALREADY turned over contributes a sample, so the distribution is
    // censored toward short tenures and understates how long slots last.
    censored: z.boolean(),
  })
  .strict();

export const ChainDeregistrationsArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        distinct_deregistered_hotkeys: z.int().min(0),
        deregistrations: z.int().min(0),
        deregistrations_per_hotkey: z
          .number()
          .min(0)
          .nullable()
          .describe(
            "Null when distinct_deregistered_hotkeys is 0 (no defined intensity without hotkeys).",
          ),
        tenure: SlotTenureSchema.optional(),
      })
      .strict()
      .describe(
        "Network-wide deregistration rollup: every subnet with a derived deregistration in the window, combined. distinct_deregistered_hotkeys counts a hotkey once even when it is deregistered from several subnets, so it is NOT the sum of the per-subnet counts.",
      ),
    intensity_distribution: IntensityDistributionSchema.nullable().describe(
      "Spread of per-subnet churn intensity (derived deregistrations per hotkey) across EVERY subnet with deregistrations in the window -- network-wide even when limit truncates the leaderboard.",
    ),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_deregistered_hotkeys: z.int().min(0),
          deregistrations: z.int().min(0),
          deregistrations_per_hotkey: z.number().min(0).nullable(),
          tenure: SlotTenureSchema.optional(),
        })
        .strict()
        .describe(
          "One subnet's neuron-deregistration activity in the window, ranked by deregistrations.",
        ),
    ),
    // #9307: derived from UID reuse, with the derivation's own lower-bound
    // statement; `degraded` when nothing derived it.
    derivation: DeregistrationDerivationSchema.optional(),
    degraded: EventStreamDegradedSchema.nullable().optional(),
  })
  .strict();
export type ChainDeregistrationsArtifact = z.infer<
  typeof ChainDeregistrationsArtifactSchema
>;

export const ChainPrometheusArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        distinct_exporters: z.int().min(0),
        announcements: z.int().min(0),
        announcements_per_exporter: z
          .number()
          .min(0)
          .nullable()
          .describe(
            "Null when distinct_exporters is 0 (no defined intensity without exporters).",
          ),
      })
      .strict()
      .describe(
        "Network-wide Prometheus-serving rollup: every subnet with PrometheusServed announcements in the window, combined. distinct_exporters counts a hotkey once even when it announces on several subnets, so it is NOT the sum of the per-subnet counts.",
      ),
    intensity_distribution: IntensityDistributionSchema.nullable().describe(
      "Spread of per-subnet re-announcement intensity (PrometheusServed events per exporter) across EVERY subnet with announcements in the window -- network-wide even when limit truncates the leaderboard.",
    ),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_exporters: z.int().min(0),
          announcements: z.int().min(0),
          announcements_per_exporter: z.number().min(0).nullable(),
        })
        .strict()
        .describe(
          "One subnet's Prometheus telemetry-serving activity in the window, ranked by announcements.",
        ),
    ),
    // #9307: the chain emits PrometheusServed and our account_events curation
    // drops it, so the empty answer is not a measurement.
    degraded: EventStreamDegradedSchema.nullable().optional(),
  })
  .strict();
export type ChainPrometheusArtifact = z.infer<
  typeof ChainPrometheusArtifactSchema
>;

export const ChainRegistrationsArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        distinct_registrants: z.int().min(0),
        registrations: z.int().min(0),
        registrations_per_registrant: z
          .number()
          .min(0)
          .nullable()
          .describe(
            "Null when distinct_registrants is 0 (no defined intensity without hotkeys).",
          ),
      })
      .strict()
      .describe(
        "Network-wide registration rollup: every subnet with NeuronRegistered events in the window, combined. distinct_registrants counts a hotkey once even when it registers on several subnets, so it is NOT the sum of the per-subnet counts.",
      ),
    intensity_distribution: IntensityDistributionSchema.nullable().describe(
      "Spread of per-subnet registration intensity (NeuronRegistered events per hotkey) across EVERY subnet with registrations in the window -- network-wide even when limit truncates the leaderboard.",
    ),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_registrants: z.int().min(0),
          registrations: z.int().min(0),
          registrations_per_registrant: z.number().min(0).nullable(),
        })
        .strict()
        .describe(
          "One subnet's neuron-registration activity in the window, ranked by registrations.",
        ),
    ),
  })
  .strict();
export type ChainRegistrationsArtifact = z.infer<
  typeof ChainRegistrationsArtifactSchema
>;

export const ChainServingArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        distinct_servers: z.int().min(0),
        announcements: z.int().min(0),
        announcements_per_server: z
          .number()
          .min(0)
          .nullable()
          .describe(
            "Null when distinct_servers is 0 (no defined intensity without servers).",
          ),
      })
      .strict()
      .describe(
        "Network-wide axon-serving rollup: every subnet with AxonServed announcements in the window, combined.",
      ),
    intensity_distribution: IntensityDistributionSchema.nullable().describe(
      "Spread of per-subnet re-announcement intensity (AxonServed events per server) across EVERY subnet with announcements in the window -- network-wide even when limit truncates the leaderboard.",
    ),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_servers: z.int().min(0),
          announcements: z.int().min(0),
          announcements_per_server: z.number().min(0).nullable(),
        })
        .strict()
        .describe(
          "One subnet's axon-serving activity in the window, ranked by announcements.",
        ),
    ),
  })
  .strict()
  .describe(
    "Network-wide axon-serving announcement leaderboard (#5873). The network-wide counterpart of subnet_serving. Mirrors GET /api/v1/chain/serving's data envelope.",
  );
export type ChainServingArtifact = z.infer<typeof ChainServingArtifactSchema>;

export const ChainStakeMovesArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        distinct_movers: z.int().min(0),
        movements: z.int().min(0),
        movements_per_mover: z
          .number()
          .min(0)
          .nullable()
          .describe("Null when distinct_movers is 0."),
      })
      .strict()
      .describe(
        "Network-wide stake-move rollup: every subnet with StakeMoved events in the window, combined. distinct_movers counts a `coldkey` once even when it moves on several subnets.",
      ),
    intensity_distribution: IntensityDistributionSchema.nullable().describe(
      "Spread of per-subnet movements-per-mover intensity across EVERY subnet with moves in the window.",
    ),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_movers: z.int().min(0),
          movements: z.int().min(0),
          movements_per_mover: z.number().min(0).nullable(),
        })
        .strict()
        .describe(
          "One subnet's stake-movement activity in the window, ranked by movements.",
        ),
    ),
  })
  .strict()
  .describe(
    "Network-wide stake-movement (re-delegation) leaderboard over a lookback window, summed live from the account_events StakeMoved stream. Mirrors GET /api/v1/chain/stake-moves's data envelope.",
  );
export type ChainStakeMovesArtifact = z.infer<
  typeof ChainStakeMovesArtifactSchema
>;

export const ChainStakeTransfersArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        distinct_senders: z.int().min(0),
        transfers: z.int().min(0),
        transfers_per_sender: z
          .number()
          .min(0)
          .nullable()
          .describe("Null when distinct_senders is 0."),
      })
      .strict()
      .describe(
        "Network-wide stake-transfer rollup: every subnet with StakeTransferred events in the window, combined. distinct_senders counts an origin `coldkey` once even when it transfers out of several subnets.",
      ),
    intensity_distribution: IntensityDistributionSchema.nullable().describe(
      "Spread of per-subnet transfers-per-sender intensity across EVERY subnet with transfers in the window.",
    ),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_senders: z.int().min(0),
          transfers: z.int().min(0),
          transfers_per_sender: z.number().min(0).nullable(),
        })
        .strict()
        .describe(
          "One subnet's stake-transfer activity in the window, ranked by transfers.",
        ),
    ),
  })
  .strict()
  .describe(
    "Network-wide stake-transfer (between-coldkeys) leaderboard over a lookback window, summed live from the account_events StakeTransferred stream. Mirrors GET /api/v1/chain/stake-transfers's data envelope.",
  );
export type ChainStakeTransfersArtifact = z.infer<
  typeof ChainStakeTransfersArtifactSchema
>;

export const ChainWeightsArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d"]).nullable(),
    observed_at: z.string().nullable(),
    subnet_count: z.int().min(0),
    network: z
      .object({
        distinct_setters: z.int().min(0),
        weight_sets: z.int().min(0),
        sets_per_setter: z
          .number()
          .min(0)
          .nullable()
          .describe(
            "Null when distinct_setters is 0 (no defined intensity without setters).",
          ),
      })
      .strict()
      .describe(
        "Network-wide weight-setting rollup: every subnet that set weights in the window, combined.",
      ),
    intensity_distribution: IntensityDistributionSchema.nullable().describe(
      "Spread of per-subnet update intensity (WeightsSet events per validator) across every subnet that set weights in the window.",
    ),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_setters: z.int().min(0),
          weight_sets: z.int().min(0),
          sets_per_setter: z.number().min(0).nullable(),
        })
        .strict()
        .describe(
          "One subnet's weight-setting activity in the window, ranked by weight_sets.",
        ),
    ),
  })
  .strict()
  .describe(
    "Network-wide validator weight-setting activity over a lookback window, summed live from the account_events WeightsSet stream. Mirrors GET /api/v1/chain/weights.",
  );
export type ChainWeightsArtifact = z.infer<typeof ChainWeightsArtifactSchema>;
