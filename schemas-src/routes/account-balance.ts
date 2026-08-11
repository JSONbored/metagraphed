// GET /api/v1/accounts/{ss58}/balance (types-epic B batch 4, #8058). Live
// finney RPC (System::Account chain-state scan), 60s KV-cached -- no static
// file. Modeled from src/account-balance.ts's loadAccountBalance() /
// AccountBalanceResult, cross-checked against the hand-edited
// AccountBalanceArtifact component it replaces, and against real (mocked-
// RPC) loadAccountBalance() output -- see tests/account-balance-loader.test.ts
// for the same fetch-mock pattern this batch's ground-truth test reuses.
//
// Bucket (c): `queried_at` drops format:date-time in favor of plain
// z.string().nullable(), matching this epic's established convention.
import { z } from "zod";
import { FieldSourcesSchema } from "../shared.ts";

export const AccountBalanceArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    balance_tao: z.number().nullable().optional(),
    queried_at: z.string().nullable().optional(),
    // #9108. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .strict()
  .describe(
    "Live free+reserved balance in TAO for one Finney ss58 account, read directly from chain via RPC (KV-cached). balance_tao is null on RPC failure (schema-stable, never a GraphQL error). Mirrors GET /api/v1/accounts/{ss58}/balance.",
  );
export type AccountBalanceArtifact = z.infer<
  typeof AccountBalanceArtifactSchema
>;
