// get_subnet_owner_capture (#10929).
//
// The input is DERIVED from the route's own query schema and the output IS the
// route's artifact schema by identity — never re-modelled. A field renamed on
// the route is a compile error here, which is the only thing that keeps the
// MCP mirror from drifting away from what REST serves.
//
// This tool matters more than most for the same reason /revenue's does: an
// agent asked "is this subnet's team taking most of the emission" will quote
// whatever it receives. The output carries `blind_spots` and an `unresolved`
// verdict on every non-owner coldkey as REQUIRED shape, so there is no
// response in which a caller gets a capture figure without the layers it
// cannot see stated beside it.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { netuidSchema } from "./shared.ts";
import { SubnetOwnerCaptureArtifactSchema } from "../routes/owner-capture.ts";

const RouteQuery_subnets_netuid_owner_capture =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/owner-capture"];

export const GetSubnetOwnerCaptureInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: RouteQuery_subnets_netuid_owner_capture.shape.window,
  })
  .strict();

export const GetSubnetOwnerCaptureOutputSchema =
  SubnetOwnerCaptureArtifactSchema;
