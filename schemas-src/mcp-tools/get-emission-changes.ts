// get_emission_changes (#9615): the emission-gate change log, mirroring
// GET /api/v1/chain/governance/emission-changes.
import { z } from "zod";
import { EMISSION_CHANGES_LIMIT_MAX } from "../../src/route-limits.ts";

export const GetEmissionChangesInputSchema = z
  .object({
    kind: z.enum(["param", "subnet", "flow"]).optional(),
    limit: z.int().min(1).max(EMISSION_CHANGES_LIMIT_MAX).optional(),
  })
  .strict();
export type GetEmissionChangesInput = z.infer<
  typeof GetEmissionChangesInputSchema
>;

export const GetEmissionChangesOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    kind: z.string().nullable(),
    limit: z.int().nullable(),
    change_count: z.int(),
    /** Entries that are a FIRST OBSERVATION rather than a change. Subtract
     * these before counting governance events. */
    predates_capture_count: z.int(),
    latest_change_at: z.string().nullable(),
    changes: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();
export type GetEmissionChangesOutput = z.infer<
  typeof GetEmissionChangesOutputSchema
>;
