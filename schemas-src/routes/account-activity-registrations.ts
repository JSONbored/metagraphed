// GET /api/v1/accounts/{ss58}/axon-removals + .../deregistrations +
// .../registrations + .../weight-setters (types-epic B batch 5, #8059). Live
// account_events-stream data -- no static file. Same per-netuid
// HHI-concentration-scorecard shape family as batch 4's account-activity.ts
// (serving/prometheus/stake-moves/stake-flow), driven by the same
// makeAccountEventHandler() factory in workers/request-handlers/entities.ts.
// Modeled from src/account-axon-removals.ts's buildAccountAxonRemovals(),
// src/account-deregistrations.ts's buildAccountDeregistrations(),
// src/account-registrations.ts's buildAccountRegistrations(), and
// src/account-weight-setters.ts's buildAccountWeightSetters().
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import {
  DeregistrationDerivationSchema,
  EventStreamDegradedSchema,
} from "./event-stream-honesty.ts";

export const WINDOW_ENUM_90D = ["7d", "30d", "90d"] as const;
const WINDOW_ENUM_7_30D = ["7d", "30d"] as const;

export const AccountAxonRemovalsArtifactSchema = z
  .object({
    schema_version: z.int(),
    address: z.string(),
    window: z.enum(WINDOW_ENUM_90D).nullable(),
    total_removals: z.int().min(0),
    subnet_count: z.int().min(0),
    concentration: z.number().nullable(),
    dominant_netuid: z.int().min(0).nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          removals: z.int().min(0),
          first_removed_at: z.string().nullable(),
          last_removed_at: z.string().nullable(),
        })
        .strict()
        .describe(
          "One subnet's slice of an account's axon-removal footprint over the window.",
        ),
    ),
    // #9307: AxonInfoRemoved has never been emitted, so this footprint's zero
    // has never measured this account.
    degraded: EventStreamDegradedSchema.optional(),
  })
  .strict();
export type AccountAxonRemovalsArtifact = z.infer<
  typeof AccountAxonRemovalsArtifactSchema
>;
export const AccountAxonRemovalsResponseSchema = successEnvelopeSchema(
  AccountAxonRemovalsArtifactSchema,
);

export const AccountDeregistrationsArtifactSchema = z
  .object({
    schema_version: z.int(),
    address: z.string(),
    window: z.enum(WINDOW_ENUM_90D).nullable(),
    total_deregistrations: z.int().min(0),
    subnet_count: z.int().min(0),
    concentration: z.number().nullable(),
    dominant_netuid: z.int().min(0).nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          deregistrations: z.int().min(0),
          first_deregistered_at: z.string().nullable(),
          last_deregistered_at: z.string().nullable(),
        })
        .strict()
        .describe(
          "One subnet's slice of an account's deregistration footprint over the window.",
        ),
    ),
    // #9307: the slots where this account was the PREVIOUS holder, derived
    // from UID reuse; `degraded` when nothing derived it.
    derivation: DeregistrationDerivationSchema.optional(),
    degraded: EventStreamDegradedSchema.optional(),
  })
  .strict();
export type AccountDeregistrationsArtifact = z.infer<
  typeof AccountDeregistrationsArtifactSchema
>;
export const AccountDeregistrationsResponseSchema = successEnvelopeSchema(
  AccountDeregistrationsArtifactSchema,
);

export const AccountRegistrationsArtifactSchema = z
  .object({
    schema_version: z.int(),
    address: z.string(),
    window: z.enum(WINDOW_ENUM_90D).nullable(),
    total_registrations: z.int().min(0),
    subnet_count: z.int().min(0),
    concentration: z.number().nullable(),
    dominant_netuid: z.int().min(0).nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          registrations: z.int().min(0),
          first_registered_at: z.string().nullable(),
          last_registered_at: z.string().nullable(),
        })
        .strict()
        .describe(
          "One subnet's slice of an account's registration footprint over the window.",
        ),
    ),
  })
  .strict();
export type AccountRegistrationsArtifact = z.infer<
  typeof AccountRegistrationsArtifactSchema
>;
export const AccountRegistrationsResponseSchema = successEnvelopeSchema(
  AccountRegistrationsArtifactSchema,
);

export const AccountWeightSettersArtifactSchema = z
  .object({
    schema_version: z.int(),
    address: z.string(),
    window: z.enum(WINDOW_ENUM_7_30D).nullable(),
    total_weight_sets: z.int().min(0),
    subnet_count: z.int().min(0),
    concentration: z
      .number()
      .nullable()
      .describe(
        "Herfindahl-Hirschman index of weight-sets across subnets: 1 = all on one subnet, -> 1/n as it spreads evenly; null when the account has no weight-sets.",
      ),
    dominant_netuid: z.int().min(0).nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          weight_sets: z.int().min(0),
          first_set_at: z.string().nullable(),
          last_set_at: z.string().nullable(),
        })
        .strict()
        .describe(
          "One subnet's WeightsSet activity in an account's weight-setting footprint, ranked most-active-first.",
        ),
    ),
  })
  .strict()
  .describe(
    "One account's (validator hotkey's) WeightsSet weight-setting footprint across subnets over a 7d/30d window. Mirrors GET /api/v1/accounts/{ss58}/weight-setters.",
  );
export type AccountWeightSettersArtifact = z.infer<
  typeof AccountWeightSettersArtifactSchema
>;
export const AccountWeightSettersResponseSchema = successEnvelopeSchema(
  AccountWeightSettersArtifactSchema,
);
