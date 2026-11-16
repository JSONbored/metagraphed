// GET /api/v1/subnets/{netuid}/alpha-assets (#13165; #13161, epic #13142).
// One subnet's AlphaAssets accounting, served live from app.alpha_assets
// (migration 0049) through the native store seam. The table's writers -- the
// engine's AlphaAssets.TotalAlphaIssuance / AlphaAssets.AlphaBurned /
// AlphaAssets.AlphaRecycled decode -- land separately, so until a store is
// bound and filled this route serves the schema-stable decline below, never
// a fabricated zero-issuance subnet.
import { z } from "zod";

export const SubnetAlphaAssetsStateSchema = z
  .object({
    total_issuance: z
      .string()
      .nullable()
      .describe(
        "The subnet's total alpha issuance (AlphaAssets.TotalAlphaIssuance) -- u64 alpha atomic units as a decimal string. Null when not captured, never fabricated as 0.",
      ),
    burned: z
      .string()
      .nullable()
      .describe(
        "Alpha burned on this subnet (AlphaAssets.AlphaBurned) -- u64 alpha atomic units as a decimal string. Null when not captured.",
      ),
    recycled: z
      .string()
      .nullable()
      .describe(
        "Alpha recycled on this subnet (AlphaAssets.AlphaRecycled) -- u64 alpha atomic units as a decimal string. Null when not captured.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One captured alpha-asset accounting state of a subnet: total issuance and its burn/recycle sinks with their capture stamp.",
  );

export const SubnetAlphaAssetsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    /**
     * NULL IS THE DECLINE. An absent state is never a measured zero issuance
     * -- it is what an unbound or unfilled store looks like (the engine
     * dependency #13165 defers), and publishing a zeroed state would be the
     * confident-zero failure the sibling subnet surfaces' own comments are
     * about.
     */
    alpha_assets: SubnetAlphaAssetsStateSchema.nullable().describe(
      "The subnet's newest captured alpha-asset accounting. NULL when the store holds no capture for this subnet (store unbound, or the alpha-assets capture has not run): an absent state is never served as a zeroed one.",
    ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One subnet's current AlphaAssets accounting (#13165). Null `alpha_assets` until the engine's alpha-assets capture lands. Mirrors GET /api/v1/subnets/{netuid}/alpha-assets.",
  );
