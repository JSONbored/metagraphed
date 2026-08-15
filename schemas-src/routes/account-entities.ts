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
import { EntityCategorySchema } from "../shared.ts";

/**
 * ONE entity-label vocabulary (#10790).
 *
 * This and `account-summary.ts` each declared it, and both comments said "keep
 * both in sync" -- which is what a vocabulary with no owner sounds like. The
 * two were still identical field-for-field, so this collapse changes nothing
 * published; it removes the second place a future field could fail to land.
 */
export const EntityLabelSchema = z
  .object({
    name: z.string().nullable().optional(),
    // #8372: widened to match schemas/entity.schema.json's category enum
    // (bridge/pool/infra/project added; exchange/foundation/operator/other
    // retained so an existing entry stays valid).
    category: EntityCategorySchema.nullable().optional(),
    notes: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    source_urls: z.array(z.string()).optional(),
  })
  .strict()
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
          role: z.enum(["owns", "gained_ownership", "lost_ownership"]),
          block_number: z.int().nullable().optional(),
          observed_at: z.string().nullable().optional(),
        })
        .strict()
        .describe(
          "One tie between this `coldkey` and a subnet. `owns` is CURRENT ownership read from the economics tier's `owner_coldkey` (measured from SubtensorModule.SubnetOwner) and carries a NULL `block_number`, because it is a state rather than an event -- these come first, by netuid. `gained_ownership`/`lost_ownership` are SubnetOwnerChanged transfers, newest first, and there is exactly ONE such event in all of chain history: ownership is established at registration and only ever moved by conviction contest, which is why reading the transfer stream alone reported no ties for coldkeys that plainly own a subnet (#9313).",
        ),
    ),
    owners_observed_at: z
      .string()
      .nullable()
      .describe(
        'When the CURRENT-ownership half was captured, or null when no owner snapshot could be read. Null is load-bearing: it distinguishes "we could not read who owns what" from "this address owns nothing", which are the same empty list without it. An `owns` tie is never fresher than this stamp.',
      ),
  })
  .strict()
  .describe(
    "One `coldkey`'s community-contributed entity labels plus its subnet-ownership ties (#6740). Mirrors GET /api/v1/accounts/{ss58}/entities.",
  );
/** The read-tolerant twin -- see SubnetEventsReadSchema for the reasoning. */
export const AccountEntitiesReadSchema = AccountEntitiesArtifactSchema.extend({
  labels: z.array(EntityLabelSchema.partial().catchall(z.unknown())),
  ownership_ties: z.array(z.looseObject({})),
})
  .partial()
  .catchall(z.unknown());
export type AccountEntitiesRead = z.infer<typeof AccountEntitiesReadSchema>;

export type AccountEntitiesArtifact = z.infer<
  typeof AccountEntitiesArtifactSchema
>;
