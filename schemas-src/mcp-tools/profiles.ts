// MCP tools `list_profiles`, `get_subnet_profile` (types-epic E batch 4,
// #8067). Mirror GET /api/v1/profiles and GET /api/v1/subnets/{netuid}/profile,
// neither of which is one of schemas-src/routes/'s covered pilot routes --
// no existing Zod schema to reuse (SubnetProfile from schemas-src/routes/
// subnet-profile.ts, #8055, is NOT reused: the hand-written LIST_PROFILES_
// OUTPUT_SCHEMA/GET_SUBNET_PROFILE_OUTPUT_SCHEMA this replaces already left
// `profiles`/`subnet`/`profile` as bare objects, not SubnetProfile-shaped --
// reusing the deep schema now would tighten what these two tools' own
// existing contract accepts, the same "look-but-don't-reuse" finding
// pilot batch's get-network-health.ts/get-economics.ts documented). Modeled
// fresh, shallow, from the hand-written literals src/profiles-mcp.ts
// replaces. Enum values hardcoded from src/contracts.ts's QUERY_ENUMS.{
// subnetType,curationLevel,profileLevel} and the "profiles" query
// collection's sort_fields at the time of writing.
import { z } from "zod";
import { SubnetProfileArtifactSchema } from "../routes/subnet-profiles.ts";
import {
  fieldsStringSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  querySchema,
  sortSchema,
} from "./shared.ts";
import { CURATION_LEVEL_VALUES } from "../shared.ts";
import { SubnetProfileSchema } from "../routes/subnet-profile.ts";

const SUBNET_TYPE = ["root", "application"] as const;
const CURATION_LEVEL = CURATION_LEVEL_VALUES;
const PROFILE_LEVEL = [
  "directory-only",
  "identity-partial",
  "identity-complete",
  "operational",
  "adapter-backed",
] as const;
const PROFILES_SORT_FIELDS = [
  "candidate_count",
  "completeness_score",
  "curation_level",
  "interface_count",
  "missing_critical_count",
  "name",
  "netuid",
  "operational_interface_count",
  "profile_level",
  "review_state",
] as const;

export const ListProfilesInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    subnet_type: z
      .enum(SUBNET_TYPE)
      .optional()
      .describe("Root subnet or an application subnet.")
      .meta({ examples: [SUBNET_TYPE[0]] }),
    curation_level: z
      .enum(CURATION_LEVEL)
      .optional()
      .describe(
        "How the record entered the registry — native chain data, discovered candidate, community submission, or machine-derived.",
      )
      .meta({ examples: [CURATION_LEVEL[0]] }),
    review_state: z
      .string()
      .optional()
      .describe("Where the item sits in maintainer review.")
      .meta({ examples: ["pending"] }),
    confidence: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("How confident the machine assessment is.")
      .meta({ examples: ["low"] }),
    profile_level: z
      .enum(PROFILE_LEVEL)
      .optional()
      .describe(
        "How complete the subnet's profile is, from directory-only upward.",
      )
      .meta({ examples: [PROFILE_LEVEL[0]] }),
    q: querySchema().optional(),
    sort: sortSchema(PROFILES_SORT_FIELDS).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(1000).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListProfilesInput = z.infer<typeof ListProfilesInputSchema>;

export const GetSubnetProfileInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetProfileInput = z.infer<typeof GetSubnetProfileInputSchema>;

export const ListProfilesOutputSchema = z
  .object({
    captured_at: z.string().nullable().optional(),
    // Typed from the route's own SubnetProfileSchema (#9797), PARTIAL
    // because this tool advertises `fields` (#9884). Verified against
    // production 2026-08-07.
    profiles: z.array(SubnetProfileSchema.partial()),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListProfilesOutput = z.infer<typeof ListProfilesOutputSchema>;

// DERIVED, NOT COPIED (#9796). The copy published subnet, profile,
// surfaces[], endpoints[] and candidate_surfaces[] as bare open shapes, so a
// profile lookup -- the tool whose entire job is describing a subnet -- told
// an agent nothing about the profile. SubnetProfileArtifactSchema models all
// of it: 35 fields on `profile` alone, 44 on `subnet`.
//
// Verified against production before the switch, because deriving is a
// tightening.
export const GetSubnetProfileOutputSchema = SubnetProfileArtifactSchema;
export type GetSubnetProfileOutput = z.infer<
  typeof GetSubnetProfileOutputSchema
>;
