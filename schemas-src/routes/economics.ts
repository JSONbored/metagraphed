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
import { SubnetEconomicsSchema } from "../shared.ts";

// TAO amounts here are lossless fixed 9-decimal (rao-precision) strings, not
// numbers -- a JSON number is only exact to 2^53-1 (~9,007,199 TAO at rao
// precision), and the network-wide totals already exceed that (#2924). Parse
// as an arbitrary-precision decimal, not Number(), if exact-rao fidelity
// matters.
const RaoPrecisionTaoStringSchema = z.string().regex(/^\d+\.\d{9}$/);

export const EconomicsArtifactSchema = ArtifactBaseSchema.extend({
  captured_at: z.string().nullable(),
  network: z.string().nullable(),
  subnets: z.array(SubnetEconomicsSchema),
  summary: z
    .object({
      registration_open_count: z.int().min(0),
      subnet_count: z.int().min(0),
      total_alpha_value_tao: RaoPrecisionTaoStringSchema,
      total_miners: z.int().min(0),
      total_network_value_tao: RaoPrecisionTaoStringSchema,
      total_root_value_tao: RaoPrecisionTaoStringSchema,
      total_stake_tao: RaoPrecisionTaoStringSchema,
      total_validators: z.int().min(0),
      with_economics_count: z.int().min(0),
    })
    .strict(),
});
export type EconomicsArtifact = z.infer<typeof EconomicsArtifactSchema>;

export const EconomicsResponseSchema = successEnvelopeSchema(
  EconomicsArtifactSchema,
);

export const EconomicsQuerySchema = z
  .object({
    netuid: z.int().min(0).optional(),
    registration_allowed: z.enum(["true", "false"]).optional(),
    q: z.string().max(200).optional(),
    fields: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*)*$/)
      .optional(),
    limit: z.int().min(1).max(1000).optional(),
    cursor: z.int().min(0).optional(),
    sort: z
      .enum([
        "alpha_fdv_tao",
        "alpha_market_cap_tao",
        "alpha_price_change_1d",
        "alpha_price_change_1h",
        "alpha_price_change_1m",
        "alpha_price_change_7d",
        "alpha_price_tao",
        "block",
        "emission_share",
        "max_stake_tao",
        "max_uids",
        "max_validators",
        "miner_count",
        "miner_readiness",
        "name",
        "netuid",
        "open_slots",
        "registration_cost_tao",
        "subnet_volume_tao",
        "total_stake_tao",
        "validator_count",
      ])
      .optional(),
    order: z.enum(["asc", "desc"]).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type EconomicsQuery = z.infer<typeof EconomicsQuerySchema>;
