// GET /api/v1/economics (types-epic A pilot route #5 of 5, #7859) —
// live-KV-tier envelope variant: workers/api.ts's handleApiRequest prefers
// the live `economics:current` KV blob (resolveLiveEconomics), falling back
// to the committed R2 economics.json artifact when KV is cold/stale/invalid
// (unlike health, this keeps a real static fallback so the route never
// 404s). Data shape derived from public/metagraph/openapi.json's
// EconomicsArtifact component (built from src/contracts.ts), cross-checked
// against real handler output — see tests/zod-schemas.test.ts.
import { z } from "zod";
import { ArtifactBaseSchema, successEnvelopeSchema } from "../envelope.ts";
import {
  ChainStateSchema,
  FieldSourcesSchema,
  SubnetEconomicsSchema,
} from "../shared.ts";

// TAO amounts here are lossless fixed 9-decimal (rao-precision) strings, not
// numbers -- a JSON number is only exact to 2^53-1 (~9,007,199 TAO at rao
// precision), and the network-wide totals already exceed that (#2924). Parse
// as an arbitrary-precision decimal, not Number(), if exact-rao fidelity
// matters.
const RaoPrecisionTaoStringSchema = z.string().regex(/^\d+\.\d{9}$/);

/**
 * The NETWORK-WIDE aggregate carried on every economics answer.
 *
 * Named and exported (#9927 follow-up) because two MCP tools serve this exact
 * object and both published it as a bare `{"type":"object"}` -- get_economics
 * once, and get_subnet_economics once PER SUBNET, which is why that tool grew
 * an `include_summary: false` (#9874).
 *
 * The TAO totals are rao-precision decimal STRINGS, not numbers: nine decimal
 * places, exactly. A caller that reads them as floats loses rao, and a schema
 * saying `object` told them nothing about which fields those even are.
 */
export const EconomicsSummarySchema = z
  .object({
    registration_open_count: z.int().min(0),
    subnet_count: z.int().min(0),
    total_alpha_value_tao: RaoPrecisionTaoStringSchema,
    total_miners: z.int().min(0),
    total_network_value_tao: RaoPrecisionTaoStringSchema,
    total_root_value_tao: RaoPrecisionTaoStringSchema,
    total_stake_alpha: RaoPrecisionTaoStringSchema,
    total_validators: z.int().min(0),
    with_economics_count: z.int().min(0),
  })
  .strict();

export const EconomicsArtifactSchema = ArtifactBaseSchema.extend({
  captured_at: z.string().nullable(),
  network: z.string().nullable(),
  // Optional, never null: absent means this refresh pinned no block (#8744).
  chain_state: ChainStateSchema.optional(),
  subnets: z.array(SubnetEconomicsSchema),
  // #9106: per-field provenance for the SUBNET ROW shape above. Attached at
  // serve time (workers/api.ts), so it is optional here -- the committed R2
  // artifact and the KV blob do not carry it.
  field_sources: FieldSourcesSchema.optional(),
  summary: EconomicsSummarySchema,
});
export type EconomicsArtifact = z.infer<typeof EconomicsArtifactSchema>;

export const EconomicsResponseSchema = successEnvelopeSchema(
  EconomicsArtifactSchema,
);
