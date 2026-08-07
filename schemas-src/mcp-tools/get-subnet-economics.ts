// MCP tool `get_subnet_economics` (types-epic E batch 2, #8065). No REST
// mirror named in its description; the handler calls loadSubnetEconomics()
// directly and returns its own compact shape, distinct from schemas-src's
// SubnetEconomicsSchema (schemas-src/shared.ts) or EconomicsArtifactSchema.
// Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import { EconomicsSummarySchema } from "../routes/economics.ts";
import { SubnetEconomicsSchema } from "../shared.ts";

export const GetSubnetEconomicsInputSchema = z
  .object({
    netuid: netuidSchema(),
    // #9874: the summary block is network-wide, so a per-subnet sweep receives
    // the identical object once per subnet. Defaulted to `true` rather than to
    // the reporter's suggested `false`: dropping a field every existing caller
    // currently receives is a breaking change, and this parameter is worth
    // having on its own before that is worth arguing about.
    include_summary: z
      .boolean()
      .optional()
      .describe(
        "Include the network-wide `summary` block (default `true`). PASS " +
          "`false` WHEN SWEEPING MORE THAN ONE SUBNET: the block is identical " +
          "on every call, so 129 subnets means receiving the same aggregate " +
          "129 times — about 19% of the response, measured on 2026-08-07. " +
          "With `false` the key is `null` rather than absent, so a caller " +
          "reading it does not have to branch on presence.",
      )
      .meta({ examples: [false] }),
  })
  .strict();
export type GetSubnetEconomicsInput = z.infer<
  typeof GetSubnetEconomicsInputSchema
>;

export const GetSubnetEconomicsOutputSchema = z
  .object({
    netuid: netuidSchema(),
    source: z.string().nullable().optional(),
    captured_at: z.string().nullable().optional(),
    // Typed from the route's own schemas (#9797). Nullable rather than
    // omitted when the caller passes `include_summary: false` (#9874), and
    // this tool advertises no `fields`, so neither is partial.
    summary: EconomicsSummarySchema.nullable().optional(),
    economics: SubnetEconomicsSchema.nullable(),
  })
  .passthrough();
export type GetSubnetEconomicsOutput = z.infer<
  typeof GetSubnetEconomicsOutputSchema
>;
