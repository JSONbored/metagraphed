// GET /api/v1/chain/gamma (#13164; #13161, epic #13142). The chain-wide
// Gamma state: the global switch (SubtensorModule.GammaEnabled) beside every
// subnet's newest captured Gamma state, served live from app.chain_gamma and
// app.subnet_gamma (migration 0047) through the native store seam. The
// writers land with the engine, so until a store is bound and filled this
// route serves the schema-stable decline below, never a fabricated
// Gamma-less chain.
import { z } from "zod";
import { SubnetGammaStateSchema } from "./subnet-gamma.ts";

export const ChainGammaSubnetSchema = SubnetGammaStateSchema.extend({
  netuid: z.int().min(0).max(65535),
})
  .strict()
  .describe("One subnet's newest captured Gamma state, keyed by its netuid.");

export const ChainGammaArtifactSchema = z
  .object({
    schema_version: z.int(),
    /**
     * NULL IS THE DECLINE. The global flag is a real chain value; an unbound
     * or unfilled store must not report it as false (a measured off-switch)
     * or true.
     */
    enabled: z
      .boolean()
      .nullable()
      .describe(
        "Whether Gamma is enabled globally (SubtensorModule.GammaEnabled). NULL when the store holds no capture (store unbound, or the Gamma capture has not run) -- never coalesced to false, which would claim a measured off-switch.",
      ),
    enabled_captured_at: z
      .string()
      .nullable()
      .describe("When the global flag was captured. Null with a null flag."),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible: an empty
     * subnet list is what an unfilled per-subnet capture looks like, not a
     * measured chain without Gamma subnets.
     */
    subnet_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many subnets carry a captured Gamma state here -- `subnets.length`. NULL when the per-subnet series holds no rows (store unbound, or the capture has not run): a zero count is never a measurement and is not published.",
      ),
    captured_at: z.string().nullable(),
    subnets: z
      .array(ChainGammaSubnetSchema)
      .describe(
        "Every subnet's newest captured Gamma state, ordered by netuid.",
      ),
  })
  .strict()
  .describe(
    "The chain-wide Gamma state (#13164). Null `enabled` and an empty subnet list with a null subnet_count until the engine's Gamma capture lands. Mirrors GET /api/v1/chain/gamma.",
  );
