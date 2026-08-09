// GET /api/v1/accounts/{ss58}/entities (types-epic B batch 5, #8059). Live
// chain_events SubnetOwnerChanged-stream + entities.json artifact data -- no
// static file. Modeled from src/entity-labels.ts's buildAccountEntities(),
// cross-checked against the hand-edited AccountEntitiesArtifact component it
// replaces.
//
// EntityLabelSchema is a LOCAL, UNREGISTERED copy of the hand-edited
// `EntityLabel` component's shape (same approach batch 4's account-summary.ts
// took for AccountSummaryArtifact.labels[]) -- `EntityLabel` itself stays
// hand-edited/registered in schemas/components/*.schema.json, untouched:
// AccountSummaryArtifact (batch 4, #8058, not yet merged when this batch was
// written) and AccountEntitiesArtifact (this route) are its only two
// referrers, and deleting it here would break batch 4's still-hand-edited
// $ref to it. Once batch 4 merges, EntityLabel will have zero remaining
// referrers and become a candidate for a small follow-up cleanup -- out of
// scope for either batch individually to avoid breaking the other's
// in-flight branch.
//
// Bucket (c): `labels[].category` models a nullable enum via Zod's
// `.nullable()` rather than the hand-edited schema's null-in-enum-array
// encoding -- same effective type, different JSON Schema representation
// (same cosmetic finding batch 4's account-summary.ts made for the
// identical field).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { EntityCategorySchema } from "../shared.ts";

const EntityLabelSchema = z
  .object({
    name: z.string().nullable().optional(),
    // #8372: widened to match schemas/entity.schema.json's category enum
    // and account-summary.ts's own copy -- keep all three in sync.
    category: EntityCategorySchema.nullable().optional(),
    notes: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    source_urls: z.array(z.string()).optional(),
  })
  .passthrough()
  .describe(
    "A community-contributed entity label for an address (exchange/foundation/operator/other).",
  );

export const AccountEntitiesArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    labels: z.array(EntityLabelSchema),
    ownership_tie_count: z.int().min(0),
    ownership_ties: z.array(
      z
        .object({
          netuid: z.int().nullable(),
          role: z.enum(["gained_ownership", "lost_ownership"]),
          block_number: z.int().nullable().optional(),
          observed_at: z.string().nullable().optional(),
        })
        .passthrough()
        .describe(
          "One SubnetOwnerChanged transfer tying this `coldkey` to a subnet, either as the gaining or losing side, newest first.",
        ),
    ),
  })
  .passthrough()
  .describe(
    "One `coldkey`'s community-contributed entity labels plus its subnet-ownership ties (#6740). Mirrors GET /api/v1/accounts/{ss58}/entities.",
  );
export type AccountEntitiesArtifact = z.infer<
  typeof AccountEntitiesArtifactSchema
>;
export const AccountEntitiesResponseSchema = successEnvelopeSchema(
  AccountEntitiesArtifactSchema,
);
