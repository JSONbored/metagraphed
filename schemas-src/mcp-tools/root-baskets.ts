import { z } from "zod";
import { McpNetworkSchema } from "../shared.ts";
import { ss58Schema } from "../query-params.ts";
import {
  RootBasketsArtifactSchema,
  RootBasketsQuerySchema,
  AccountRootBasketsQuerySchema,
} from "../routes/root-baskets.ts";

export const GetRootBasketsInputSchema = RootBasketsQuerySchema.extend({
  network: McpNetworkSchema.optional(),
}).strict();
export const GetAccountRootBasketsInputSchema =
  AccountRootBasketsQuerySchema.extend({
    ss58: ss58Schema(),
    network: McpNetworkSchema.optional(),
  }).strict();
export const GetRootBasketsOutputSchema = RootBasketsArtifactSchema;
