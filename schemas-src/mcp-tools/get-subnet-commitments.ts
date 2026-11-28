// MCP tools `get_subnet_commitments`, `get_subnet_hotkey_commitment`.
// Mirror GET /api/v1/subnets/{netuid}/commitments and GET
// /api/v1/subnets/{netuid}/commitments/{hotkey} (MET-7365).
//
// DERIVED FROM THE ROUTE, NOT COPIED: the page inputs are the route's own
// ROUTE_QUERY_SCHEMAS entry, and each output schema IS the route's
// ArtifactSchema, so a field rename is a compile error here rather than
// silent drift between the two surfaces.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { accountKeySchema, netuidSchema } from "./shared.ts";
import {
  HotkeyCommitmentArtifactSchema,
  SubnetCommitmentsArtifactSchema,
} from "../routes/subnet-commitments.ts";

const RouteQuery_subnets_netuid_commitments =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/commitments"];

export const GetSubnetCommitmentsInputSchema = z
  .object({
    netuid: netuidSchema(),
    limit: RouteQuery_subnets_netuid_commitments.shape.limit,
    offset: RouteQuery_subnets_netuid_commitments.shape.offset,
  })
  .strict();

export const GetSubnetCommitmentsOutputSchema = SubnetCommitmentsArtifactSchema;

export const GetSubnetHotkeyCommitmentInputSchema = z
  .object({
    netuid: netuidSchema(),
    hotkey: accountKeySchema("hotkey"),
  })
  .strict();

export const GetSubnetHotkeyCommitmentOutputSchema =
  HotkeyCommitmentArtifactSchema;
