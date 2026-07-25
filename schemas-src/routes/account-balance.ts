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
import { successEnvelopeSchema } from "../envelope.ts";

export const AccountBalanceArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    balance_tao: z.number().nullable().optional(),
    queried_at: z.string().nullable().optional(),
  })
  .passthrough();
export type AccountBalanceArtifact = z.infer<
  typeof AccountBalanceArtifactSchema
>;
export const AccountBalanceResponseSchema = successEnvelopeSchema(
  AccountBalanceArtifactSchema,
);
export const AccountBalanceQuerySchema = z.object({}).strict();
export type AccountBalanceQuery = z.infer<typeof AccountBalanceQuerySchema>;
