// MCP tool `get_subnet_trajectory` (types-epic E batch 2, #8065). No
// "Mirrors" claim in its description and no covered REST route to reuse.
// Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { MAX_LIMIT } from "../../workers/request-params.ts";
import { MCP_LIST_LIMIT_DEFAULT } from "../../src/route-limits.ts";
import {
  offsetSchema,
  limitSchema,
  orderSchema,
  sortSchema,
} from "./shared.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import { netuidSchema } from "./shared.ts";
import { SubnetTrajectoryArtifactSchema } from "../routes/subnet-trajectory.ts";

export const GetSubnetTrajectoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    // The page (#10605). Both numbers come from the constants that actually
    // decide them: MAX_LIMIT is the ceiling listQuerySchema gives every list
    // route, and MCP_LIST_LIMIT_DEFAULT is the default applyMcpQueryFilters
    // really applies -- published rather than hidden, because #10101 found 83
    // tools whose schema left a caller unable to tell what an omitted
    // limit returns. Publishing the ceiling while hiding the default would
    // recreate exactly that gap.
    limit: limitSchema(MAX_LIMIT, MCP_LIST_LIMIT_DEFAULT).optional(),
    // An integer OFFSET, which is what these routes publish
    // (`{minimum: 0, type: integer}`) -- not the keyset cursor. Conflating the
    // two is the mistake query-params.ts calls out by name.
    cursor: offsetSchema().optional(),
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
export const GetSubnetTrajectoryOutputSchema = SubnetTrajectoryArtifactSchema;
export type GetSubnetTrajectoryOutput = z.infer<
  typeof GetSubnetTrajectoryOutputSchema
>;
