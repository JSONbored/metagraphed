// MCP tools `get_subnet_registrations`, `get_subnet_stake_moves`,
// `get_subnet_stake_transfers`, `get_subnet_axon_removals`,
// `get_subnet_serving`, `get_subnet_prometheus`, `get_subnet_deregistrations`
// (types-epic E batch 3, #8066). Seven live account_events-window
// scorecards sharing one shape (netuid/window/observed_at + a distinct-actor
// count/event count/per-actor ratio, field names varying by kind) -- each
// mirrors a GET /api/v1/subnets/{netuid}/<kind> route not covered by
// schemas-src/routes/. Modeled fresh, shallow, from the hand-written
// literals they replace (byte-identical structure across all seven, mirrors
// the REST batch-1 precedent in schemas-src/routes/subnet-activity.ts,
// #8055). Window enum hardcoded {"7d","30d"} from each tool's own
// src/subnet-*.ts WINDOWS constant at the time of writing (all seven
// verified identical).
import { z } from "zod";
import { netuidSchema } from "./shared.ts";

const ACTIVITY_WINDOWS = ["7d", "30d"] as const;
const ActivityWindowSchema = z.enum(ACTIVITY_WINDOWS).optional();

const ActivityInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: ActivityWindowSchema.describe(
      "Trailing time window to aggregate over, ending at the latest data point rather than a calendar boundary. Options are per-tool; see this parameter's enum.",
    ),
  })
  .strict();

export const GetSubnetRegistrationsInputSchema = ActivityInputSchema;
export type GetSubnetRegistrationsInput = z.infer<
  typeof GetSubnetRegistrationsInputSchema
>;
export const GetSubnetRegistrationsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    distinct_registrants: z.int(),
    registrations: z.int(),
    registrations_per_registrant: z.number().nullable().optional(),
  })
  .passthrough();
export type GetSubnetRegistrationsOutput = z.infer<
  typeof GetSubnetRegistrationsOutputSchema
>;

export const GetSubnetStakeMovesInputSchema = ActivityInputSchema;
export type GetSubnetStakeMovesInput = z.infer<
  typeof GetSubnetStakeMovesInputSchema
>;
export const GetSubnetStakeMovesOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    distinct_movers: z.int(),
    movements: z.int(),
    movements_per_mover: z.number().nullable().optional(),
  })
  .passthrough();
export type GetSubnetStakeMovesOutput = z.infer<
  typeof GetSubnetStakeMovesOutputSchema
>;

export const GetSubnetStakeTransfersInputSchema = ActivityInputSchema;
export type GetSubnetStakeTransfersInput = z.infer<
  typeof GetSubnetStakeTransfersInputSchema
>;
export const GetSubnetStakeTransfersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    distinct_senders: z.int(),
    transfers: z.int(),
    transfers_per_sender: z.number().nullable().optional(),
  })
  .passthrough();
export type GetSubnetStakeTransfersOutput = z.infer<
  typeof GetSubnetStakeTransfersOutputSchema
>;

export const GetSubnetAxonRemovalsInputSchema = ActivityInputSchema;
export type GetSubnetAxonRemovalsInput = z.infer<
  typeof GetSubnetAxonRemovalsInputSchema
>;
export const GetSubnetAxonRemovalsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    distinct_removers: z.int(),
    removals: z.int(),
    removals_per_remover: z.number().nullable(),
  })
  .passthrough();
export type GetSubnetAxonRemovalsOutput = z.infer<
  typeof GetSubnetAxonRemovalsOutputSchema
>;

export const GetSubnetServingInputSchema = ActivityInputSchema;
export type GetSubnetServingInput = z.infer<typeof GetSubnetServingInputSchema>;
export const GetSubnetServingOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    distinct_servers: z.int(),
    announcements: z.int(),
    announcements_per_server: z.number().nullable(),
  })
  .passthrough();
export type GetSubnetServingOutput = z.infer<
  typeof GetSubnetServingOutputSchema
>;

export const GetSubnetPrometheusInputSchema = ActivityInputSchema;
export type GetSubnetPrometheusInput = z.infer<
  typeof GetSubnetPrometheusInputSchema
>;
export const GetSubnetPrometheusOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    distinct_exporters: z.int(),
    announcements: z.int(),
    announcements_per_exporter: z.number().nullable(),
  })
  .passthrough();
export type GetSubnetPrometheusOutput = z.infer<
  typeof GetSubnetPrometheusOutputSchema
>;

export const GetSubnetDeregistrationsInputSchema = ActivityInputSchema;
export type GetSubnetDeregistrationsInput = z.infer<
  typeof GetSubnetDeregistrationsInputSchema
>;
export const GetSubnetDeregistrationsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    distinct_deregistered_hotkeys: z.int(),
    deregistrations: z.int(),
    deregistrations_per_hotkey: z.number().nullable(),
  })
  .passthrough();
export type GetSubnetDeregistrationsOutput = z.infer<
  typeof GetSubnetDeregistrationsOutputSchema
>;
