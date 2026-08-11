// MCP tool `get_subnet_trajectory` (types-epic E batch 2, #8065). No
// "Mirrors" claim in its description and no covered REST route to reuse.
// Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import {
  orderSchema,
  sortSchema,
  McpUnsortedPageFields,
  McpOffsetPageInput,
} from "./shared.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import { netuidSchema } from "./shared.ts";
import { SubnetTrajectoryArtifactSchema } from "../routes/subnet-trajectory.ts";

export const GetSubnetTrajectoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    ...McpOffsetPageInput,
    sort: sortSchema(
      API_QUERY_COLLECTIONS["subnet-trajectory"].sort_fields,
    ).optional(),
    order: orderSchema().optional(),
  })
  .strict();
export type GetSubnetTrajectoryInput = z.infer<
  typeof GetSubnetTrajectoryInputSchema
>;

// The route's own artifact, imported rather than restated (#9797). Both
// `points[]` and `deltas` were bare objects here while the route already
// declared SubnetTrajectoryPointSchema and SubnetTrajectoryDeltaSchema --
// including the note that `deltas` values are DIFFERENCES, not levels, which
// an agent reading only this tool could not have known. `deltas` is a typed
// RECORD keyed by window label, so a new window adds a key rather than
// changing the contract. Verified against production 2026-08-07.
export const GetSubnetTrajectoryOutputSchema =
  SubnetTrajectoryArtifactSchema.extend({
    // The page block the MCP loader adds on top of the route's artifact --
    // undeclared until #10790, when `.strict()` first rejected it.
    ...McpUnsortedPageFields,
  });
export type GetSubnetTrajectoryOutput = z.infer<
  typeof GetSubnetTrajectoryOutputSchema
>;
