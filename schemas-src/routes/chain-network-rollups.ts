// GET /api/v1/chain/axon-removals + .../deregistrations + .../prometheus +
// .../registrations + .../serving + .../stake-moves + .../stake-transfers +
// .../weights (types-epic B batch 6, #8060). Live account_events-stream
// data -- no static file. All eight share one shape family: a network
// rollup + a null-when-cold intensity distribution (count/mean/min/p25/
// median/p75/p90/max) + a per-subnet leaderboard, driven by
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
import { successEnvelopeSchema } from "../envelope.ts";
import {
  DeregistrationDerivationSchema,
  EventStreamDegradedSchema,
} from "./event-stream-honesty.ts";

const IntensityDistributionSchema = z
  .object({
    count: z.int().min(0),
    mean: z.number().min(0),
    min: z.number().min(0),
    p25: z.number().min(0),
    median: z.number().min(0),
    p75: z.number().min(0),
    p90: z.number().min(0),
    max: z.number().min(0),
  })
  .strict();

const WindowQuerySchema = z
  .object({
    window: z.enum(["7d", "30d"]).optional(),
    limit: z.int().min(1).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();

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
        removals_per_remover: z.number().min(0).nullable(),
      })
      .strict(),
    intensity_distribution: IntensityDistributionSchema.nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_removers: z.int().min(0),
          removals: z.int().min(0),
          removals_per_remover: z.number().min(0).nullable(),
        })
        .strict(),
    ),
    // #9307: AxonInfoRemoved has never been emitted, so the empty answer this
    // route can only ever give is not a measurement.
    degraded: EventStreamDegradedSchema.optional(),
  })
  .strict();
export type ChainAxonRemovalsArtifact = z.infer<
  typeof ChainAxonRemovalsArtifactSchema
>;
export const ChainAxonRemovalsResponseSchema = successEnvelopeSchema(
  ChainAxonRemovalsArtifactSchema,
);
export const ChainAxonRemovalsQuerySchema = WindowQuerySchema;
export type ChainAxonRemovalsQuery = z.infer<
  typeof ChainAxonRemovalsQuerySchema
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
        deregistrations_per_hotkey: z.number().min(0).nullable(),
        tenure: SlotTenureSchema.optional(),
      })
      .strict(),
    intensity_distribution: IntensityDistributionSchema.nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_deregistered_hotkeys: z.int().min(0),
          deregistrations: z.int().min(0),
          deregistrations_per_hotkey: z.number().min(0).nullable(),
          tenure: SlotTenureSchema.optional(),
        })
        .strict(),
    ),
    // #9307: derived from UID reuse, with the derivation's own lower-bound
    // statement; `degraded` when nothing derived it.
    derivation: DeregistrationDerivationSchema.optional(),
    degraded: EventStreamDegradedSchema.optional(),
  })
  .strict();
export type ChainDeregistrationsArtifact = z.infer<
  typeof ChainDeregistrationsArtifactSchema
>;
export const ChainDeregistrationsResponseSchema = successEnvelopeSchema(
  ChainDeregistrationsArtifactSchema,
);
export const ChainDeregistrationsQuerySchema = WindowQuerySchema;
export type ChainDeregistrationsQuery = z.infer<
  typeof ChainDeregistrationsQuerySchema
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
        announcements_per_exporter: z.number().min(0).nullable(),
      })
      .strict(),
    intensity_distribution: IntensityDistributionSchema.nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_exporters: z.int().min(0),
          announcements: z.int().min(0),
          announcements_per_exporter: z.number().min(0).nullable(),
        })
        .strict(),
    ),
    // #9307: the chain emits PrometheusServed and our account_events curation
    // drops it, so the empty answer is not a measurement.
    degraded: EventStreamDegradedSchema.optional(),
  })
  .strict();
export type ChainPrometheusArtifact = z.infer<
  typeof ChainPrometheusArtifactSchema
>;
export const ChainPrometheusResponseSchema = successEnvelopeSchema(
  ChainPrometheusArtifactSchema,
);
export const ChainPrometheusQuerySchema = WindowQuerySchema;
export type ChainPrometheusQuery = z.infer<typeof ChainPrometheusQuerySchema>;

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
        registrations_per_registrant: z.number().min(0).nullable(),
      })
      .strict(),
    intensity_distribution: IntensityDistributionSchema.nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_registrants: z.int().min(0),
          registrations: z.int().min(0),
          registrations_per_registrant: z.number().min(0).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ChainRegistrationsArtifact = z.infer<
  typeof ChainRegistrationsArtifactSchema
>;
export const ChainRegistrationsResponseSchema = successEnvelopeSchema(
  ChainRegistrationsArtifactSchema,
);
export const ChainRegistrationsQuerySchema = WindowQuerySchema;
export type ChainRegistrationsQuery = z.infer<
  typeof ChainRegistrationsQuerySchema
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
        announcements_per_server: z.number().min(0).nullable(),
      })
      .strict(),
    intensity_distribution: IntensityDistributionSchema.nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_servers: z.int().min(0),
          announcements: z.int().min(0),
          announcements_per_server: z.number().min(0).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ChainServingArtifact = z.infer<typeof ChainServingArtifactSchema>;
export const ChainServingResponseSchema = successEnvelopeSchema(
  ChainServingArtifactSchema,
);
export const ChainServingQuerySchema = WindowQuerySchema;
export type ChainServingQuery = z.infer<typeof ChainServingQuerySchema>;

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
        movements_per_mover: z.number().min(0).nullable(),
      })
      .strict(),
    intensity_distribution: IntensityDistributionSchema.nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_movers: z.int().min(0),
          movements: z.int().min(0),
          movements_per_mover: z.number().min(0).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ChainStakeMovesArtifact = z.infer<
  typeof ChainStakeMovesArtifactSchema
>;
export const ChainStakeMovesResponseSchema = successEnvelopeSchema(
  ChainStakeMovesArtifactSchema,
);
export const ChainStakeMovesQuerySchema = WindowQuerySchema;
export type ChainStakeMovesQuery = z.infer<typeof ChainStakeMovesQuerySchema>;

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
        transfers_per_sender: z.number().min(0).nullable(),
      })
      .strict(),
    intensity_distribution: IntensityDistributionSchema.nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_senders: z.int().min(0),
          transfers: z.int().min(0),
          transfers_per_sender: z.number().min(0).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ChainStakeTransfersArtifact = z.infer<
  typeof ChainStakeTransfersArtifactSchema
>;
export const ChainStakeTransfersResponseSchema = successEnvelopeSchema(
  ChainStakeTransfersArtifactSchema,
);
export const ChainStakeTransfersQuerySchema = WindowQuerySchema;
export type ChainStakeTransfersQuery = z.infer<
  typeof ChainStakeTransfersQuerySchema
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
        sets_per_setter: z.number().min(0).nullable(),
      })
      .strict(),
    intensity_distribution: IntensityDistributionSchema.nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          distinct_setters: z.int().min(0),
          weight_sets: z.int().min(0),
          sets_per_setter: z.number().min(0).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type ChainWeightsArtifact = z.infer<typeof ChainWeightsArtifactSchema>;
export const ChainWeightsResponseSchema = successEnvelopeSchema(
  ChainWeightsArtifactSchema,
);
export const ChainWeightsQuerySchema = WindowQuerySchema;
export type ChainWeightsQuery = z.infer<typeof ChainWeightsQuerySchema>;
