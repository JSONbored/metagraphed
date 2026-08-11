// MCP tools `get_subnet_wallets` and `get_subnet_owner_cut` (#10510).
// Mirror GET /api/v1/subnets/{netuid}/wallets and
// GET /api/v1/subnets/{netuid}/owner-cut.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796): each output schema IS the route's
// own ArtifactSchema, so a field rename is a compile error here rather than
// silent production drift.
//
// WHY THESE TWO NEED MORE CARE THAN MOST. An agent that reports "SN X's
// treasury is 5abc…" without the evidence is making an unsourced allegation on
// our behalf, to an audience that cannot check it. So `source_urls` is a
// required field on every attributed wallet, `chain_derived` distinguishes a
// SubnetOwner read from a human attribution, and the disposition's `unresolved`
// bucket serialises distinctly from 0 -- because "we could not determine where
// this went" and "this owner kept nothing" are different claims and only one of
// them is usually true.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import {
  SubnetOwnerCutArtifactSchema,
  SubnetWalletsArtifactSchema,
} from "../routes/subnet-wallets.ts";

export const GetSubnetWalletsInputSchema = z
  .object({ netuid: netuidSchema() })
  .strict();

export const GetSubnetWalletsOutputSchema = SubnetWalletsArtifactSchema;

export const GetSubnetOwnerCutInputSchema = z
  .object({ netuid: netuidSchema() })
  .strict();

export const GetSubnetOwnerCutOutputSchema = SubnetOwnerCutArtifactSchema;
