// GET /api/v1/subnets/{netuid}/volume (types-epic B batch 1, #8055). Live
// account_events aggregate -- no static file. Modeled from
// src/alpha-volume.ts's buildAlphaVolume() AlphaVolumeResult interface
// (every field always present, none omitted), cross-checked against the
// hand-edited SubnetAlphaVolumeArtifact component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const SubnetAlphaVolumeArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z.enum(["24h"]),
    buy_volume_alpha: z.number(),
    sell_volume_alpha: z.number(),
    total_volume_alpha: z.number(),
    buy_volume_tao: z.number(),
    sell_volume_tao: z.number(),
    total_volume_tao: z.number(),
    buy_count: z.int().min(0),
    sell_count: z.int().min(0),
    net_volume_alpha: z.number(),
    sentiment_ratio: z.number().nullable(),
    sentiment: z.enum(["bullish", "bearish", "neutral"]),
    vol_mcap_ratio: z.number().nullable(),
  })
  .strict();
export type SubnetAlphaVolumeArtifact = z.infer<
  typeof SubnetAlphaVolumeArtifactSchema
>;

export const SubnetAlphaVolumeResponseSchema = successEnvelopeSchema(
  SubnetAlphaVolumeArtifactSchema,
);

// No query params (validateQueryParams(url, []) in handleSubnetAlphaVolume).
export const SubnetAlphaVolumeQuerySchema = z.object({}).strict();
export type SubnetAlphaVolumeQuery = z.infer<
  typeof SubnetAlphaVolumeQuerySchema
>;
