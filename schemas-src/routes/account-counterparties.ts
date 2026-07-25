// GET /api/v1/accounts/{ss58}/counterparties (types-epic B batch 5, #8059).
// Live account_events Transfer-stream data -- no static file. Modeled from
// src/counterparties.ts's buildCounterparties()/buildCounterpartyRelationship(),
// cross-checked against the hand-edited AccountCounterpartiesArtifact
// component it replaces. Dual-mode: list mode (default) returns
// `counterparties[]`; passing ?counterparty=<ss58> additionally attaches a
// `relationship` drilldown object (workers/request-handlers/entities.ts's
// handleAccountCounterparties) -- both modes share this one artifact schema,
// with `relationship` optional.
//
// Real finding (bucket b): the hand-edited component only required
// schema_version/ss58/counterparty_count/counterparties -- but
// CounterpartiesResult's own TS interface (src/counterparties.ts) always
// returns transfers_scanned/scan_capped/total_sent_tao/total_received_tao
// unconditionally alongside those. Modeled as required here, matching
// buildCounterparties()'s real always-present output. Same story one level
// down: each `counterparties[]` entry's sent_tao/received_tao/net_tao/
// transfer_count/last_block are hand-edited-optional but buildCounterparties()
// always sets all 6 Counterparty fields -- modeled as required. And
// `relationship.transfers[].amount_tao` is hand-edited-nullable, but
// buildCounterpartyRelationship() SKIPS any row whose amount_tao is null
// (`if (amount == null) continue`) before ever pushing it -- every row that
// makes it into transfers[] always has a real non-null amount_tao -- modeled
// as required non-nullable.
//
// Bucket (c): the hand-edited schema constrains ss58/address/from/to fields
// with an SS58 regex (`^[1-9A-HJ-NP-Za-km-z]{47,48}$`) that no runtime code
// actually validates against (the route's own path pattern is the only
// shape check) -- dropped in favor of plain z.string(), matching how every
// other account route in this epic models ss58-shaped fields.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const CounterpartySchema = z
  .object({
    address: z.string(),
    sent_tao: z.number(),
    received_tao: z.number(),
    net_tao: z.number(),
    transfer_count: z.int().min(0),
    last_block: z.int().nullable(),
  })
  .strict();

const CounterpartyTransferSchema = z
  .object({
    block_number: z.int().nullable(),
    event_index: z.int().nullable(),
    netuid: z.int().nullable(),
    from: z.string(),
    to: z.string(),
    amount_tao: z.number(),
    direction: z.enum(["sent", "received"]),
    observed_at: z.string().nullable(),
  })
  .strict();

const CounterpartyRelationshipSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    counterparty: z.string(),
    transfer_count: z.int().min(0),
    transfers_scanned: z.int().min(0),
    scan_capped: z.boolean(),
    total_sent_tao: z.number(),
    total_received_tao: z.number(),
    net_tao: z.number(),
    first_block: z.int().nullable(),
    last_block: z.int().nullable(),
    first_seen_at: z.string().nullable(),
    last_seen_at: z.string().nullable(),
    limit: z.int().min(1).max(100),
    transfers: z.array(CounterpartyTransferSchema),
  })
  .strict();

export const AccountCounterpartiesArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    counterparty_count: z.int().min(0),
    transfers_scanned: z.int().min(0),
    scan_capped: z.boolean(),
    total_sent_tao: z.number(),
    total_received_tao: z.number(),
    counterparties: z.array(CounterpartySchema),
    relationship: CounterpartyRelationshipSchema.optional(),
  })
  .passthrough();
export type AccountCounterpartiesArtifact = z.infer<
  typeof AccountCounterpartiesArtifactSchema
>;
export const AccountCounterpartiesResponseSchema = successEnvelopeSchema(
  AccountCounterpartiesArtifactSchema,
);
export const AccountCounterpartiesQuerySchema = z
  .object({
    counterparty: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type AccountCounterpartiesQuery = z.infer<
  typeof AccountCounterpartiesQuerySchema
>;
