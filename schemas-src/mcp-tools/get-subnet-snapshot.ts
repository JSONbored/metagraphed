// MCP tool `get_subnet_snapshot`. Fans out to 5 of a subnet's live views in
// one round trip: hyperparameters, concentration, performance, top_validators
// and recent_events.
//
// COMPOSED FROM THE FIVE ROUTES IT CALLS (#9797). This file's header used to
// say there was "no single REST route or schemas-src schema to reuse", and
// modelled the result "fresh, shallow" -- five bare `{"type":"object"}` sites,
// on the tool whose entire purpose is those five views. There is no SINGLE
// route to derive from, but there are five, and the handler calls them by
// path: /hyperparameters, /concentration, /performance, /validators and
// /events, each falling back to that route's own builder. So the answer was
// never a fresh model; it was a composition nobody had written down.
//
// Verified against production before the switch, slice by slice: the live
// tool's five sections each validate against the route artifact schema they
// now publish.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import { SubnetConcentrationArtifactSchema } from "../routes/subnet-concentration.ts";
import { SubnetEventsArtifactSchema } from "../routes/subnet-events.ts";
import { SubnetHyperparametersArtifactSchema } from "../routes/subnet-hyperparameters.ts";
import { SubnetValidatorsArtifactSchema } from "../routes/subnet-metagraph.ts";
import { SubnetPerformanceArtifactSchema } from "../routes/subnet-performance.ts";

export const GetSubnetSnapshotInputSchema = z
  .object({
    netuid: netuidSchema(),
    top_validators_limit: z
      .int()
      .min(1)
      .optional()
      .describe(
        "How many top validators to include in the embedded validator list.",
      )
      .meta({ examples: [10] }),
    recent_events_limit: z
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "How many recent events to embed. Clamped to the tool's ceiling rather than rejected.",
      )
      .meta({ examples: [10] }),
  })
  .strict();
export type GetSubnetSnapshotInput = z.infer<
  typeof GetSubnetSnapshotInputSchema
>;

export const GetSubnetSnapshotOutputSchema = z
  .object({
    netuid: netuidSchema(),
    hyperparameters: SubnetHyperparametersArtifactSchema,
    concentration: SubnetConcentrationArtifactSchema,
    performance: SubnetPerformanceArtifactSchema,
    // The validators artifact re-sliced to `top_validators_limit`, so
    // `validator_count` counts the returned page rather than the subnet --
    // the handler recomputes it after the slice.
    top_validators: SubnetValidatorsArtifactSchema,
    recent_events: SubnetEventsArtifactSchema,
  })
  .strict();
export type GetSubnetSnapshotOutput = z.infer<
  typeof GetSubnetSnapshotOutputSchema
>;
