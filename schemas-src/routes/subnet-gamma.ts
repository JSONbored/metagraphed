// GET /api/v1/subnets/{netuid}/gamma and its /history (#13164; #13161, epic
// #13142). One subnet's Gamma state, served live from app.subnet_gamma
// (migration 0047) through the native store seam. The table's writers -- the
// engine's SubnetGammaEnabled / SubnetGammaPrice / SubnetGammaEmission /
// PendingGammaEmission / UnconvertedGammaEmission /
// SubnetGammaEmissionWhitelisted decode -- land separately, so until a store
// is bound and filled these routes serve the schema-stable decline below,
// never a fabricated Gamma-off subnet.
import { z } from "zod";

export const SubnetGammaStateSchema = z
  .object({
    enabled: z
      .boolean()
      .nullable()
      .describe(
        "Whether Gamma is enabled on this subnet (SubtensorModule.SubnetGammaEnabled). Null when the capture did not carry the flag -- never coalesced to false, which would claim a measured off-switch.",
      ),
    price: z
      .string()
      .nullable()
      .describe(
        "The subnet's Gamma price (SubtensorModule.SubnetGammaPrice) -- the chain's raw price encoding as a canonical decimal string, served verbatim because the engine's decode owns the scaling. Null when not captured.",
      ),
    emission: z
      .string()
      .nullable()
      .describe(
        "The subnet's Gamma emission (SubtensorModule.SubnetGammaEmission) -- u64 atomic units as a decimal string. Null when not captured, never fabricated as 0.",
      ),
    pending_emission: z
      .string()
      .nullable()
      .describe(
        "Gamma emission accrued but not yet minted (SubtensorModule.PendingGammaEmission) -- u64 atomic units as a decimal string. Null when not captured.",
      ),
    unconverted_emission: z
      .string()
      .nullable()
      .describe(
        "Gamma emission minted but not yet converted (SubtensorModule.UnconvertedGammaEmission) -- u64 atomic units as a decimal string. Null when not captured.",
      ),
    whitelisted: z
      .boolean()
      .nullable()
      .describe(
        "Whether the subnet is whitelisted for Gamma emission (SubtensorModule.SubnetGammaEmissionWhitelisted). Null when the capture did not carry the flag.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One captured Gamma state of a subnet: the enablement flags, the raw price, and the emission counters with their capture stamp.",
  );

export const SubnetGammaArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    /**
     * NULL IS THE DECLINE. An absent state is never a measured "Gamma off" --
     * it is what an unbound or unfilled store looks like (the engine
     * dependency #13164 defers), and publishing a zeroed state would be the
     * confident-zero failure the sibling subnet surfaces' own comments are
     * about.
     */
    gamma: SubnetGammaStateSchema.nullable().describe(
      "The subnet's newest captured Gamma state. NULL when the store holds no capture for this subnet (store unbound, or the Gamma capture has not run): an absent state is never served as a zeroed one.",
    ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One subnet's current Gamma state (#13164). Null `gamma` until a Gamma capture is observed. Mirrors GET /api/v1/subnets/{netuid}/gamma.",
  );

export const SubnetGammaHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible. An empty
     * series is never a measured "no history" -- it is what an unbound or
     * unfilled store looks like (the engine dependency #13164 defers).
     */
    point_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many captures this answer carries -- `points.length`. NULL when the series holds no rows for this subnet (store unbound, or the Gamma capture has not run): a zero count is never a measurement and is not published.",
      ),
    captured_at: z.string().nullable(),
    points: z
      .array(SubnetGammaStateSchema)
      .describe("The subnet's captured Gamma states, newest first."),
  })
  .strict()
  .describe(
    "One subnet's Gamma capture series (#13164). Empty with a null point_count until a Gamma capture is observed. Mirrors GET /api/v1/subnets/{netuid}/gamma/history.",
  );
