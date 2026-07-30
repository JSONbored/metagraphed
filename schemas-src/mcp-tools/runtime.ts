// MCP tool `get_runtime` (types-epic E batch 8, #8071). Mirrors
// GET /api/v1/runtime, which is not one of schemas-src/routes/'s covered
// pilot routes -- no existing Zod schema to reuse. Modeled fresh, matching
// the hand-written literal it replaces field-for-field.
import { z } from "zod";

export const GetRuntimeInputSchema = z.object({}).strict();
export type GetRuntimeInput = z.infer<typeof GetRuntimeInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch) -- but unlike most
// other item shapes in this epic, spec_version/block_number are plain
// (non-nullable) integers when present: the hand-written original wraps
// them in bare `{type:"integer"}`, not NULLABLE_INT.
const RuntimeTransitionSchema = z
  .object({
    spec_version: z.int().optional(),
    block_number: z.int().optional(),
    observed_at: z.string().nullable().optional(),
  })
  .passthrough();

// #8702 upgrade radar. Every field is independently nullable because each
// comes from its own upstream: a testnet RPC outage blanks the testnet reading
// and nothing else. `pending_upgrade` carries "unknown" as a real value rather
// than degrading to "none" -- "no upgrade pending" and "we could not tell" are
// opposite answers, and a consumer must be able to tell them apart.
//
// There is deliberately no ETA/expected-date field anywhere in this shape: the
// foundation publishes no deploy schedule, so any predicted date would be a
// guess presented as data. See src/upgrade-radar.ts.
const ChainReadingSchema = z
  .object({
    network: z.string(),
    spec_version: z.int().nullable(),
    observed_at: z.string().nullable(),
  })
  .passthrough();

const ReleaseRecordSchema = z
  .object({
    tag: z.string(),
    spec_version: z.int(),
    published_at: z.string().nullable(),
    url: z.string().nullable(),
    name: z.string().nullable(),
    prerelease: z.boolean(),
  })
  .passthrough();

const UpgradeRadarSchema = z
  .object({
    mainnet: ChainReadingSchema,
    testnet: ChainReadingSchema,
    latest_release: ReleaseRecordSchema.nullable(),
    pending_upgrade: z.enum([
      "none",
      "testnet_soaking",
      "released_undeployed",
      "unknown",
    ]),
    versions_behind: z.int().nullable(),
  })
  .passthrough();

export const GetRuntimeOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    transition_count: z.int(),
    current_spec_version: z.int().nullable().optional(),
    coverage_from_block: z.int().nullable().optional(),
    coverage_from_at: z.string().nullable().optional(),
    transitions: z.array(RuntimeTransitionSchema),
    current: UpgradeRadarSchema.optional(),
  })
  .passthrough();
export type GetRuntimeOutput = z.infer<typeof GetRuntimeOutputSchema>;
