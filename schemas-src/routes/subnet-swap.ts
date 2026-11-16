// GET /api/v1/subnets/{netuid}/swap (#13165; #13161, epic #13142). One
// subnet's v490 balancer-based Swap state, served live from app.swap_balancer
// (migration 0049) through the native store seam. The table's writers -- the
// engine's Swap.BalancerTaoReservoir / Swap.BalancerAlphaReservoir /
// Swap.FeeRate decode -- land separately, so until a store is bound and
// filled this route serves the schema-stable decline below, never a
// fabricated empty pool.
import { z } from "zod";

export const SubnetSwapStateSchema = z
  .object({
    tao_reservoir: z
      .string()
      .nullable()
      .describe(
        "The subnet pool's TAO reservoir (Swap.BalancerTaoReservoir) -- u64 atomic units (rao) as a decimal string. Null when not captured, never fabricated as 0.",
      ),
    alpha_reservoir: z
      .string()
      .nullable()
      .describe(
        "The subnet pool's alpha reservoir (Swap.BalancerAlphaReservoir) -- u64 alpha atomic units as a decimal string. Null when not captured, never fabricated as 0.",
      ),
    fee_rate: z
      .int()
      .min(0)
      .max(65535)
      .nullable()
      .describe(
        "The pool's swap fee rate (Swap.FeeRate) -- the chain's raw u16 as stored, served verbatim because the engine's decode owns the scaling. Null when the capture did not carry it -- never coalesced to 0, which would claim a measured fee-free pool.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One captured balancer state of a subnet's Swap pool: the TAO and alpha reservoirs and the raw fee rate with their capture stamp.",
  );

export const SubnetSwapArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    /**
     * NULL IS THE DECLINE. An absent state is never a measured empty pool --
     * it is what an unbound or unfilled store looks like (the engine
     * dependency #13165 defers), and publishing a zeroed state would be the
     * confident-zero failure the sibling subnet surfaces' own comments are
     * about.
     */
    swap: SubnetSwapStateSchema.nullable().describe(
      "The subnet's newest captured balancer state. NULL when the store holds no capture for this subnet (store unbound, or the balancer capture has not run): an absent state is never served as a zeroed one.",
    ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One subnet's current balancer-based Swap state (#13165). Null `swap` until the engine's balancer capture lands. Mirrors GET /api/v1/subnets/{netuid}/swap.",
  );
