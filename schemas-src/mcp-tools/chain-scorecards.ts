// MCP tools `get_chain_idle_stake`, `get_chain_yield`.
// Mirror GET /api/v1/chain/idle-stake, GET /api/v1/chain/yield.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_chain_yield: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { ChainConcentrationArtifactSchema } from "../routes/chain-concentration.ts";
import { ChainConcentrationSubnetsArtifactSchema } from "../routes/chain-concentration-subnets.ts";
import { ChainPerformanceArtifactSchema } from "../routes/chain-performance.ts";
import { limitSchema, orderSchema, sortSchema } from "./shared.ts";
import {
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT,
  CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { ChainIdleStakeArtifactSchema } from "../routes/chain-idle-stake.ts";
import { ChainYieldArtifactSchema } from "../routes/chain-yield.ts";
import {
  CONCENTRATION_LENSES,
  CONCENTRATION_RANKING_SORTS,
} from "../routes/chain-concentration-subnets.ts";

// --- get_chain_concentration_subnets (#9717) ---------------------------------
// The cross-subnet RANKING, as opposed to get_chain_concentration's single
// network aggregate over the same read.

export const GetChainConcentrationSubnetsInputSchema = z
  .object({
    lens: z
      .enum(CONCENTRATION_LENSES)
      .optional()
      .describe(
        "Which distribution to rank subnets by. `emission` (the default) is " +
          "the reward question — who actually receives emissions. `stake` is " +
          "who holds the alpha. The `entity_` variants collapse an operator's " +
          "hotkeys into one holder, so a Sybil running twenty UIDs counts once.",
      )
      .meta({ examples: ["emission"] }),
    sort: sortSchema(CONCENTRATION_RANKING_SORTS).optional(),
    order: orderSchema().optional(),
    limit: limitSchema(
      CHAIN_CONCENTRATION_SUBNETS_LIMIT_MAX,
      CHAIN_CONCENTRATION_SUBNETS_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetChainConcentrationSubnetsInput = z.infer<
  typeof GetChainConcentrationSubnetsInputSchema
>;

// DERIVED, NOT COPIED (#9796). The copy published `network` as a bare open
// object and `subnets` as a bare open ARRAY -- the ranked list this tool exists
// to return, with nothing said about a row.
export const GetChainConcentrationSubnetsOutputSchema =
  ChainConcentrationSubnetsArtifactSchema;
export type GetChainConcentrationSubnetsOutput = z.infer<
  typeof GetChainConcentrationSubnetsOutputSchema
>;

export const GetChainConcentrationInputSchema = z.object({}).strict();
export type GetChainConcentrationInput = z.infer<
  typeof GetChainConcentrationInputSchema
>;

// DERIVED, NOT COPIED (#9796). Five bare open objects -- stake, emission,
// entity_stake, entity_emission, validator_stake -- on a tool whose entire
// purpose is those five distributions. The network-wide twin of
// get_subnet_concentration, fixed the same way in the same batch.
export const GetChainConcentrationOutputSchema =
  ChainConcentrationArtifactSchema;
export type GetChainConcentrationOutput = z.infer<
  typeof GetChainConcentrationOutputSchema
>;

export const GetChainPerformanceInputSchema = z.object({}).strict();
export type GetChainPerformanceInput = z.infer<
  typeof GetChainPerformanceInputSchema
>;

// DERIVED, NOT COPIED (#9796). Same five-bare-objects shape as its
// concentration sibling above: incentive, dividends, trust, consensus and
// validator_trust were each {"type":"object"} and nothing more.
export const GetChainPerformanceOutputSchema = ChainPerformanceArtifactSchema;
export type GetChainPerformanceOutput = z.infer<
  typeof GetChainPerformanceOutputSchema
>;

export const GetChainIdleStakeInputSchema = z.object({}).strict();
export type GetChainIdleStakeInput = z.infer<
  typeof GetChainIdleStakeInputSchema
>;

export const GetChainIdleStakeOutputSchema = ChainIdleStakeArtifactSchema;
export type GetChainIdleStakeOutput = z.infer<
  typeof GetChainIdleStakeOutputSchema
>;

export const GetChainYieldInputSchema = z.object({}).strict();
export type GetChainYieldInput = z.infer<typeof GetChainYieldInputSchema>;

export const GetChainYieldOutputSchema = ChainYieldArtifactSchema;
export type GetChainYieldOutput = z.infer<typeof GetChainYieldOutputSchema>;
