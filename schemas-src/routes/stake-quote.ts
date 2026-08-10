// GET /api/v1/subnets/{netuid}/stake-quote (types-epic A pilot route #4 of
// 5, #7859) — computed-payload envelope variant: no artifact read, pure math
// (src/stake-quote.ts's computeStakeQuote) against the live economics-tier
// AMM pool reserves, wired in workers/request-handlers/entities.ts's
// handleSubnetStakeQuote. src/stake-quote.ts already exports its own
// StakeQuote TS interface (the eventual target of types-epic C's Postgres/
// domain-type generation) -- this Zod schema is the wire-boundary
// counterpart, kept independent per this issue's zero-behavior-change scope.
// Cross-checked against real handler output — see tests/zod-schemas.test.ts.
import { z } from "zod";

export const SubnetStakeQuoteArtifactSchema = z
  .object({
    alpha_in_pool: z.number().nullable(),
    amount: z.number().gt(0),
    direction: z
      .enum(["stake", "unstake"])
      .describe(
        "stake (spends TAO for alpha) or unstake (spends alpha for TAO).",
      ),
    effective_price_tao: z.number().min(0),
    expected_out: z.number().min(0),
    expected_out_unit: z.enum(["alpha", "tao"]),
    is_root: z
      .boolean()
      .describe(
        "True for root (netuid 0), which quotes 1:1 with no price impact.",
      ),
    netuid: z.int().min(0),
    price_impact_pct: z.number().min(0),
    schema_version: z.int(),
    spot_price_tao: z.number().min(0),
    tao_in_pool_tao: z.number().nullable(),
  })
  .strict()
  .describe(
    "A read-only hypothetical stake/unstake quote against one subnet's live AMM pool (#6979). Mirrors GET /api/v1/subnets/{netuid}/stake-quote.",
  );
export type SubnetStakeQuoteArtifact = z.infer<
  typeof SubnetStakeQuoteArtifactSchema
>;
