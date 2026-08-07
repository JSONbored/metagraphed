// MCP tools `list_crowdloans`, `get_crowdloan`.
// Mirror GET /api/v1/crowdloans, GET /api/v1/crowdloans/{crowdloan_id}.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift.
//
// These two routes were the only published pair with no tool at all (#9968) --
// every other entry in mcp-route-map.ts's AGENT_UNREACHABLE is a decision, and
// this one was an omission. Agents could not read crowdloan data by any path.
import { z } from "zod";
import { McpNetworkSchema } from "../shared.ts";
import {
  CrowdloanDetailArtifactSchema,
  CrowdloansArtifactSchema,
} from "../routes/crowdloans.ts";

export const ListCrowdloansInputSchema = z
  .object({
    // #8700: which chain to read. Both routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names -- identical on
    // every chain running the same runtime -- so the endpoint is the only
    // thing that varies. Absent means finney.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type ListCrowdloansInput = z.infer<typeof ListCrowdloansInputSchema>;

export const ListCrowdloansOutputSchema = CrowdloansArtifactSchema;
export type ListCrowdloansOutput = z.infer<typeof ListCrowdloansOutputSchema>;

export const GetCrowdloanInputSchema = z
  .object({
    // u32 on-chain, not the u16 a netuid is -- NextCrowdloanId counts every
    // crowdloan ever created, including dissolved ones.
    crowdloan_id: z
      .int()
      .min(0)
      .max(4294967295)
      .meta({
        description:
          "The crowdloan id, as reported by list_crowdloans. u32 range " +
          "0..4294967295. An id can be legitimately absent: `dissolve` removes " +
          "the record while NextCrowdloanId keeps counting.",
        examples: [0],
      }),
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetCrowdloanInput = z.infer<typeof GetCrowdloanInputSchema>;

export const GetCrowdloanOutputSchema = CrowdloanDetailArtifactSchema;
export type GetCrowdloanOutput = z.infer<typeof GetCrowdloanOutputSchema>;
