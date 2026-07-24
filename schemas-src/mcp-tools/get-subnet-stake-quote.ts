// MCP tool `get_subnet_stake_quote` (types-epic E pilot batch, #7863). The
// handler calls the SAME computeStakeQuote() the REST `subnet-stake-quote`
// route uses (workers/request-handlers/entities.ts's handleSubnetStakeQuote)
// and returns the exact same `{schema_version, ...result.quote}` shape --
// unlike get-network-health.ts/get-economics.ts, the hand-written output
// schema this replaces (TOOL_OUTPUT_SCHEMAS.get_subnet_stake_quote,
// src/mcp-server.ts) was ALREADY `additionalProperties:false` with the exact
// same 12-field set as schemas-src/routes/stake-quote.ts's
// SubnetStakeQuoteArtifactSchema -- a genuine full-fidelity mirror, so it's
// reused directly rather than re-declared.
//
// One deliberate tightening: `amount` gains SubnetStakeQuoteArtifactSchema's
// `.gt(0)` (the hand-written output schema had bare `{type:"number"}`, no
// bound). This mirrors the INPUT schema's own `exclusiveMinimum:0` on the
// same field, and the value is always an echo of an already-validated
// input, so no real request can surface the difference -- noted as a
// bucket-(a)-equivalent improvement in the PR body, not silently dropped.
import { SubnetStakeQuoteArtifactSchema } from "../routes/stake-quote.ts";
import { z } from "zod";

const STAKE_QUOTE_DIRECTIONS = ["stake", "unstake"] as const;

export const GetSubnetStakeQuoteInputSchema = z
  .object({
    netuid: z.int().min(0),
    amount: z.number().gt(0),
    direction: z.enum(STAKE_QUOTE_DIRECTIONS).optional(),
  })
  .strict();
export type GetSubnetStakeQuoteInput = z.infer<
  typeof GetSubnetStakeQuoteInputSchema
>;

export const GetSubnetStakeQuoteOutputSchema = SubnetStakeQuoteArtifactSchema;
