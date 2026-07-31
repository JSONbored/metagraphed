// GET /api/v1/accounts/{ss58} + .../subnets (types-epic B batch 4, #8058).
// Live account_events + neurons D1-tier data -- no static file. Modeled from
// src/account-events.ts's buildAccountSummary()/buildAccountSubnets()/
// formatRegistration()/formatAccountEvent()/formatAccountActivity(), cross-
// checked against the hand-edited AccountSummaryArtifact/AccountSubnetsArtifact
// components they replace.
//
// Real finding (bucket b): the hand-edited AccountRegistration component
// only required `netuid`; formatRegistration() (account-events.ts) always
// returns all 5 keys (netuid/uid/stake_tao/validator_permit/active) --
// uid/stake_tao possibly null, but never omitted -- confirmed by reading the
// formatter. Fixed to required-but-nullable for uid/stake_tao, matching
// reality. Same reasoning applies to AccountActivity: the hand-edited
// component only required modules_called/tx_count, but
// formatAccountActivity() always returns all 5 keys; this file's
// AccountActivitySchema already modeled all 5 as required, so no change was
// needed there.
//
// Bucket (c): timestamp fields (first_seen_at/last_seen_at/last_tx_at) drop
// format:date-time in favor of plain z.string().nullable(), matching this
// epic's established convention; labels[].category is modeled as a nullable
// enum via Zod's `.nullable()` rather than the hand-edited schema's
// null-in-enum-array encoding -- same effective type, different JSON Schema
// representation.
//
// AccountRegistration is intentionally NOT registered as a shared component --
// AccountSummaryArtifact and AccountSubnetsArtifact are its only two referrers
// anywhere in schemas/components/*.schema.json (verified via repo-wide $ref
// grep), and both convert together in this same batch, so the hand-edited
// AccountRegistration component key becomes fully orphaned. AccountEventKindCount
// and AccountActivity are likewise orphaned (AccountSummaryArtifact is each
// one's only referrer).
//
// AccountEventSchema is REUSED from subnet-events.ts (types-epic B batch 1,
// #8055) rather than redefined here -- it's already a registered Zod component,
// and workers/request-handlers/entities.ts's handleAccount adds a `labels`
// field on top of buildAccountSummary()'s own output (joined from the
// entities.json artifact), which the hand-edited component's optional
// `labels` array already models.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { AccountEventSchema } from "./subnet-events.ts";

const AccountRegistrationSchema = z
  .object({
    netuid: z.int().min(0),
    uid: z.int().nullable(),
    stake_tao: z.number().nullable(),
    validator_permit: z.boolean(),
    active: z.boolean(),
  })
  .strict();

const AccountEventKindCountSchema = z
  .object({
    kind: z.string(),
    count: z.int().min(0),
  })
  .strict();

const AccountActivitySchema = z
  .object({
    tx_count: z.int().min(0),
    last_tx_block: z.int().nullable(),
    last_tx_at: z.string().nullable(),
    total_fee_tao: z.number().nullable(),
    modules_called: z.array(
      z
        .object({
          call_module: z.string().nullable(),
          count: z.int().min(0),
        })
        .strict(),
    ),
    modules_called_capped: z.boolean(),
  })
  .strict();

// EntityLabel is reused inline (not imported) -- it's still a shared component
// referenced by the not-yet-converted AccountEntitiesArtifact (GET /api/v1/
// accounts/{coldkey}/entities, outside this batch's 15 routes), so its
// hand-edited component key must stay registered rather than orphaned; this
// batch only needs its shape, not a new local export.
const EntityLabelSchema = z
  .object({
    name: z.string().nullable().optional(),
    // #8372: widened to match schemas/entity.schema.json's category enum
    // (bridge/pool/infra/project added; exchange/foundation/operator/other
    // retained so an existing entry stays valid). Keep both in sync.
    category: z
      .enum([
        "exchange",
        "bridge",
        "foundation",
        "pool",
        "infra",
        "project",
        "operator",
        "other",
      ])
      .nullable()
      .optional(),
    notes: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    source_urls: z.array(z.string()).optional(),
  })
  .passthrough();

export const AccountSummaryArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    event_count: z.int().min(0),
    subnet_count: z.int().min(0).optional(),
    first_block: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
    first_seen_at: z.string().nullable().optional(),
    last_seen_at: z.string().nullable().optional(),
    event_scan_capped: z.boolean().optional(),
    event_kinds: z.array(AccountEventKindCountSchema).optional(),
    registrations: z.array(AccountRegistrationSchema),
    recent_events: z.array(AccountEventSchema).optional(),
    activity: AccountActivitySchema.optional(),
    labels: z.array(EntityLabelSchema).optional(),
  })
  .passthrough();
export type AccountSummaryArtifact = z.infer<
  typeof AccountSummaryArtifactSchema
>;
export const AccountSummaryResponseSchema = successEnvelopeSchema(
  AccountSummaryArtifactSchema,
);
export const AccountSummaryQuerySchema = z.object({}).strict();
export type AccountSummaryQuery = z.infer<typeof AccountSummaryQuerySchema>;

export const AccountSubnetsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    subnet_count: z.int().min(0),
    subnets: z.array(AccountRegistrationSchema),
  })
  .passthrough();
export type AccountSubnetsArtifact = z.infer<
  typeof AccountSubnetsArtifactSchema
>;
export const AccountSubnetsResponseSchema = successEnvelopeSchema(
  AccountSubnetsArtifactSchema,
);
export const AccountSubnetsQuerySchema = z.object({}).strict();
export type AccountSubnetsQuery = z.infer<typeof AccountSubnetsQuerySchema>;
