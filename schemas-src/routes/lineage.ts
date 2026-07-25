// GET /api/v1/lineage (types-epic B batch 8, #8062). No-input,
// baked-artifact passthrough route (mirrors the get_lineage MCP tool,
// types-epic E batch 11, #8074's meta-artifacts-1.ts). Modeled from the
// hand-edited LineageArtifact component it replaces.
import { z } from "zod";
import { ArtifactBaseSchema, successEnvelopeSchema } from "../envelope.ts";

export const LineageArtifactSchema = ArtifactBaseSchema.extend({
  published_at: z.string().nullable().optional(),
  source_network: z.string(),
  target_network: z.string(),
  link_count: z.int().min(0),
  graduated_subnet_count: z.int().min(0).optional(),
  matched_by_counts: z.record(z.string(), z.int().min(0)).optional(),
  testnet_only_count: z.int().min(0).optional(),
  broken_link_count: z.int().min(0).optional(),
  broken_links: z
    .array(
      z
        .object({
          source_netuid: z.int().min(0).nullable(),
          target_netuid: z.int().min(0).nullable(),
          reason: z.enum([
            "invalid-approval",
            "source-netuid-missing",
            "target-netuid-missing",
            "target-netuid-conflict",
          ]),
          conflicts_with_source_netuid: z.int().min(0).nullable().optional(),
        })
        .strict(),
    )
    .optional(),
  links: z.array(
    z
      .object({
        mainnet_netuid: z.int().min(0),
        mainnet_name: z.string().nullable().optional(),
        mainnet_slug: z.string().nullable().optional(),
        testnet_netuid: z.int().min(0),
        testnet_name: z.string().nullable().optional(),
        matched_by: z.enum(["github_repo", "chain_name"]),
      })
      .passthrough(),
  ),
}).passthrough();
export type LineageArtifact = z.infer<typeof LineageArtifactSchema>;
export const LineageResponseSchema = successEnvelopeSchema(
  LineageArtifactSchema,
);
