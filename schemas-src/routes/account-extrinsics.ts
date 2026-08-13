// GET /api/v1/accounts/{ss58}/extrinsics (types-epic B batch 5, #8059). Live
// extrinsics store-tier data -- no static file. Modeled from src/extrinsics.ts's
// buildAccountExtrinsics()/formatExtrinsic(), cross-checked against the
// hand-edited AccountExtrinsicsArtifact component it replaces.
//
// ExtrinsicSchema below is a LOCAL, UNREGISTERED copy of the hand-edited
// `Extrinsic` component's shape -- Extrinsic itself is NOT converted or
// deleted in this batch: it has 4 referrers across schemas/components/
// *.schema.json (verified via repo-wide $ref grep) -- AccountExtrinsicsArtifact
// plus 3 block/extrinsic-detail routes that are out of scope for this batch
// (types-epic B batch 7 covers blocks/extrinsics/validators). The hand-edited
// `Extrinsic` component key stays in schemas/components/*.schema.json,
// untouched, for those other routes to keep resolving. This route's own
// `extrinsics[]` is a local inline copy (cosmetic $ref-vs-inline difference
// vs the hand-edited AccountExtrinsicsArtifact, same pattern as batch 4's
// AccountPortfolioArtifact.stake_concentration).
//
// Real finding (bucket a): `limit`/`offset` were initially modeled
// `.nullable()` (matching buildAccountExtrinsics()'s own `limit ?? null` TS
// signature), but handleAccountExtrinsics resolves them via
// workers/request-params.ts's parsePagination(), which always returns real
// numbers -- same finding as account-events-feed.ts's 3 routes. Fixed to
// required non-nullable integers.
import { z } from "zod";
import { ExtrinsicSchema } from "./extrinsics.ts";

// The extrinsic-feed route's OWN row (#10790). One producer writes both --
// `formatExtrinsic` in src/extrinsics.ts, which sets every field with `?? null`
// -- so a row is always PRESENT and sometimes null, never absent. This copy
// said `.optional()` on nine of the twelve and typed `call_args` as
// `z.unknown()` where the shared row states the record/positional-tuple duality
// `decodeChainEventArgs` produces.

export const AccountExtrinsicsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    extrinsic_count: z.int().min(0),
    // NULLABLE, and this is not defensive (#9796). The REST layer defaults
    // `limit`/`offset` before the loader runs, so a live route response always
    // carries integers -- which is why validate:api never saw this. The same
    // loader also serves the MCP tool, which passes the caller's arguments
    // straight through, and an omitted limit reaches it as undefined:
    // `limit: limit ?? null` then emits null. The contract said that was
    // impossible.
    limit: z.int().nullable(),
    offset: z.int().nullable(),
    next_cursor: z.string().nullable().optional(),
    extrinsics: z.array(ExtrinsicSchema),
  })
  .strict()
  .describe(
    "One account's signed-extrinsic feed (newest first), backing account_extrinsics. Matched by the extrinsic signer only. extrinsic_count is the page count, matching the REST feed convention. Each item is a full Extrinsic (block/index/hash/call/success/fee/tip).",
  );
export type AccountExtrinsicsArtifact = z.infer<
  typeof AccountExtrinsicsArtifactSchema
>;
