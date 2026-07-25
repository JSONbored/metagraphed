// GET /api/v1/subnets/{netuid}/{axon-removals,deregistrations,registrations,
// serving} (types-epic B batch 1, #8055). Four live account_events-window
// scorecards sharing one shape (netuid/window/observed_at + a distinct-actor
// count/event count/per-actor ratio, field names varying by kind) -- no
// static file. Modeled from src/subnet-axon-removals.ts, subnet-
// deregistrations.ts, subnet-registrations.ts, subnet-serving.ts's
// buildSubnet*() functions (byte-identical structure across all four,
// verified by reading all four source files), cross-checked against the
// four hand-edited Subnet*Artifact components they replace.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ACTIVITY_WINDOWS = ["7d", "30d"] as const;

// Every buildSubnet*() always sets window (arg ?? null), so null is a real,
// reachable value (an un-labeled call), not just defensive typing -- kept
// nullable to match the hand-edited originals exactly.
const ActivityWindowSchema = z.enum(ACTIVITY_WINDOWS).nullable();

export const SubnetAxonRemovalsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: ActivityWindowSchema,
    observed_at: z.iso.datetime().nullable(),
    distinct_removers: z.int().min(0),
    removals: z.int().min(0),
    removals_per_remover: z.number().min(0).nullable(),
  })
  .strict();
export type SubnetAxonRemovalsArtifact = z.infer<
  typeof SubnetAxonRemovalsArtifactSchema
>;
export const SubnetAxonRemovalsResponseSchema = successEnvelopeSchema(
  SubnetAxonRemovalsArtifactSchema,
);

export const SubnetDeregistrationsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: ActivityWindowSchema,
    observed_at: z.iso.datetime().nullable(),
    distinct_deregistered_hotkeys: z.int().min(0),
    deregistrations: z.int().min(0),
    deregistrations_per_hotkey: z.number().min(0).nullable(),
  })
  .strict();
export type SubnetDeregistrationsArtifact = z.infer<
  typeof SubnetDeregistrationsArtifactSchema
>;
export const SubnetDeregistrationsResponseSchema = successEnvelopeSchema(
  SubnetDeregistrationsArtifactSchema,
);

export const SubnetRegistrationsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: ActivityWindowSchema,
    observed_at: z.iso.datetime().nullable(),
    distinct_registrants: z.int().min(0),
    registrations: z.int().min(0),
    registrations_per_registrant: z.number().min(0).nullable(),
  })
  .strict();
export type SubnetRegistrationsArtifact = z.infer<
  typeof SubnetRegistrationsArtifactSchema
>;
export const SubnetRegistrationsResponseSchema = successEnvelopeSchema(
  SubnetRegistrationsArtifactSchema,
);

export const SubnetServingArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: ActivityWindowSchema,
    observed_at: z.iso.datetime().nullable(),
    distinct_servers: z.int().min(0),
    announcements: z.int().min(0),
    announcements_per_server: z.number().min(0).nullable(),
  })
  .strict();
export type SubnetServingArtifact = z.infer<typeof SubnetServingArtifactSchema>;
export const SubnetServingResponseSchema = successEnvelopeSchema(
  SubnetServingArtifactSchema,
);

// All four routes take the same single ?window=7d|30d param (src/contracts.ts's
// route() query-param arrays for subnet-axon-removals/deregistrations/
// registrations/serving are identical).
export const SubnetActivityQuerySchema = z
  .object({
    window: z.enum(ACTIVITY_WINDOWS).optional(),
  })
  .strict();
export type SubnetActivityQuery = z.infer<typeof SubnetActivityQuerySchema>;
