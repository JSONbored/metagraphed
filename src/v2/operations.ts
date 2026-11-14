import { z } from "zod";
import { createV2AccountStakeOperation } from "./account-stake.ts";
import {
  decodeAccountEventCursor,
  encodeAccountEventCursor,
  type V2AccountEventCursor,
} from "./account-event-cursor.ts";
import {
  createV2RegistryOperations,
  V2_SUBNET_PROJECTION_SQL,
} from "./registry.ts";
import {
  V2InvocationError,
  type createV2InvocationEngine,
  type V2InvocationCaller,
} from "./invocation.ts";
import {
  isBoundedV2DecodedValue,
  V2BlockSchema,
  V2AccountEventsSchema,
  V2BlockListSchema,
  V2HeadSchema,
  V2HeightSchema,
  V2NetworkSchema,
  V2EcosystemNetuidSchema,
  V2EcosystemSchema,
  V2EcosystemEnvelopeSchema,
  V2SnapshotSchema,
  V2SubnetListSchema,
  V2SubnetResultSchema,
  V2_OPERATION_SCHEMAS,
  type V2Freshness,
  type V2OperationName,
} from "../../schemas-src/v2/contracts.ts";

import {
  V2OperationError,
  exactJsonNumbersSql,
  type V2QueryExecutor,
} from "./shared.ts";
export { V2OperationError, type V2QueryExecutor } from "./shared.ts";

export interface V2OperationContext {
  caller: V2InvocationCaller;
  signal?: AbortSignal;
  invocation?: V2InvocationEngine;
  approveInvocation?: (
    intent: unknown,
    expiresAt: string,
  ) => Promise<{ approval_id: string; expires_at: string }>;
}
export type V2InvocationEngine = ReturnType<typeof createV2InvocationEngine>;

const DbTimestampSchema = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((value) => new Date(value).toISOString());

const PublishedRowSchema = z.object({
  network_id: V2NetworkSchema.shape.id,
  genesis_hash: V2NetworkSchema.shape.genesis_hash,
  block_number: V2HeightSchema,
  block_hash: V2SnapshotSchema.shape.block_hash,
  parent_hash: V2SnapshotSchema.shape.parent_hash,
  metadata_digest: V2SnapshotSchema.shape.metadata_digest,
  spec_version: V2SnapshotSchema.shape.spec_version,
  transaction_version: V2SnapshotSchema.shape.transaction_version,
  producer_revision: V2SnapshotSchema.shape.producer_revision,
  publication_id: V2SnapshotSchema.shape.publication_id,
  observed_at: DbTimestampSchema,
  published_at: DbTimestampSchema,
  finalized_observed_height: V2HeightSchema.nullable(),
  finalized_observed_hash: V2SnapshotSchema.shape.block_hash.nullable(),
  finalized_observed_at: DbTimestampSchema.nullable(),
  integrity_verified: z.literal(true),
  stage: z.literal("published"),
});

const sourceRow = PublishedRowSchema.extend({
  raw_digest: V2SnapshotSchema.shape.metadata_digest,
  event_count: z.int().min(0).max(65536),
  extrinsic_count: z.int().min(0).max(65536),
});

const HeadRowSchema = PublishedRowSchema.extend({
  complete_from: V2HeightSchema,
  complete_through: V2HeightSchema,
  checkpoint_hash: V2SnapshotSchema.shape.block_hash,
  checkpoint_publication_id: V2SnapshotSchema.shape.publication_id,
  has_gap: z.literal(false),
});

const RegistryRowSchema = PublishedRowSchema.extend({
  registry_complete: z.literal(true),
  registry_expected_netuids: z.array(V2EcosystemNetuidSchema).min(1).max(4096),
  actual_netuids: z.array(V2EcosystemNetuidSchema).min(1).max(4096),
  actual_operational_netuids: z.array(V2EcosystemNetuidSchema).min(1).max(4096),
  actual_mechanisms_complete: z.boolean(),
  ecosystem: V2EcosystemSchema,
});

const columns = `n.network_id, n.genesis_hash,
  b.block_number::text, b.block_hash, b.parent_hash, b.metadata_digest,
  p.producer_revision, p.observed_at, p.publication_id, p.published_at,
  b.spec_version::float8 AS spec_version, b.transaction_version::float8 AS transaction_version,
  p.stage, r.integrity_verified,
  n.finalized_observed_height::text, n.finalized_observed_hash,
  n.finalized_observed_at`;

const headSql = `SELECT ${columns},
  c.complete_from::text, c.complete_through::text,
  c.block_hash AS checkpoint_hash, c.publication_id AS checkpoint_publication_id,
  EXISTS (SELECT 1 FROM ops.gaps g WHERE g.network_id=n.network_id
    AND g.family='blocks' AND g.resolved_at IS NULL
    AND g.start_block <= c.complete_through AND g.end_block >= c.complete_from) AS has_gap
FROM chain.networks n
JOIN ops.checkpoints c ON c.network_id=n.network_id AND c.family='blocks'
JOIN chain.blocks b ON b.network_id=c.network_id AND b.block_number=c.complete_through
JOIN ops.publications p ON p.publication_id=b.publication_id AND p.network_id=b.network_id
LEFT JOIN chain.raw_eligibility r ON r.digest=b.raw_digest
  AND (r.kind='opaque' OR r.metadata_digest=b.metadata_digest)
WHERE n.network_id=$1`;

const blockSource = `SELECT ${columns},b.raw_digest,b.event_count,b.extrinsic_count
FROM chain.blocks b JOIN chain.networks n ON n.network_id=b.network_id
JOIN ops.publications p ON p.publication_id=b.publication_id AND p.network_id=b.network_id
LEFT JOIN chain.raw_eligibility r ON r.digest=b.raw_digest
  AND (r.kind='opaque' OR r.metadata_digest=b.metadata_digest)`;

const listBlocksSql = `WITH live_head AS MATERIALIZED (${headSql})
SELECT to_jsonb(h) AS head,to_jsonb(a) AS anchor,
  (SELECT to_jsonb(previous) FROM (${blockSource} WHERE b.network_id=$1 AND b.block_number=$3::bigint) previous) AS boundary,
  COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.block_number::bigint DESC)
    FROM (${blockSource} WHERE b.network_id=$1
      AND b.block_number >= COALESCE($5::bigint,h.complete_from::bigint)
      AND b.block_number <= a.block_number::bigint
      AND ($3::bigint IS NULL OR b.block_number < $3::bigint)
      ORDER BY b.block_number DESC LIMIT $4) page),'[]'::jsonb) AS blocks
FROM live_head h LEFT JOIN LATERAL (${blockSource}
  WHERE b.network_id=$1 AND b.block_number=COALESCE($2::bigint,h.block_number::bigint)) a ON true`;

// Count and size the bounded pages before constructing their JSON. In
// particular, the CASE branches contain the aggregation subqueries: putting
// CASE around an aggregate alone would still evaluate its arguments eagerly.
const blockSql = `WITH selected AS MATERIALIZED (${blockSource} WHERE b.network_id=$1 AND b.block_number=$2::bigint),
event_totals AS (SELECT count(*)::integer AS actual_event_count,min(event_index) AS first_event_index,max(event_index) AS last_event_index
  FROM chain.events e JOIN selected b ON (e.network_id,e.block_number,e.publication_id)=(b.network_id,b.block_number::bigint,b.publication_id)),
extrinsic_totals AS (SELECT count(*)::integer AS actual_extrinsic_count,min(extrinsic_index) AS first_extrinsic_index,max(extrinsic_index) AS last_extrinsic_index
  FROM chain.extrinsics e JOIN selected b ON (e.network_id,e.block_number,e.publication_id)=(b.network_id,b.block_number::bigint,b.publication_id)),
event_page AS MATERIALIZED (SELECT e.*,octet_length(e.fields::text) AS field_bytes,
  cardinality(e.topics) AS topic_count, COALESCE((SELECT sum(octet_length(topic)) FROM unnest(e.topics) topic),0) AS topic_bytes,(SELECT count(*) FROM chain.event_participants a
    WHERE (a.publication_id,a.network_id,a.block_number,a.event_index)=(e.publication_id,e.network_id,e.block_number,e.event_index)) AS participant_count
  FROM chain.events e JOIN selected b ON (e.network_id,e.block_number,e.publication_id)=(b.network_id,b.block_number::bigint,b.publication_id)
  WHERE e.event_index>$3 ORDER BY e.event_index LIMIT $4),
extrinsic_page AS MATERIALIZED (SELECT e.*,octet_length(e.fields::text) AS field_bytes,
  COALESCE(octet_length(e.signer::text),0) AS signer_bytes
  FROM chain.extrinsics e JOIN selected b ON (e.network_id,e.block_number,e.publication_id)=(b.network_id,b.block_number::bigint,b.publication_id)
  WHERE e.extrinsic_index>$5 ORDER BY e.extrinsic_index LIMIT $6),
budget AS (SELECT
  COALESCE((SELECT bool_and(field_bytes<=262144 AND participant_count<=256 AND topic_count<=256 AND topic_bytes<=16896
    AND length(pallet) BETWEEN 1 AND 128 AND length(variant) BETWEEN 1 AND 128
    AND CASE WHEN field_bytes<=262144 THEN ${exactJsonNumbersSql("fields")} ELSE false END) FROM event_page),true)
  AND COALESCE((SELECT bool_and(field_bytes<=262144 AND signer_bytes<=262144
    AND length(pallet) BETWEEN 1 AND 128 AND length(call) BETWEEN 1 AND 128
    AND CASE WHEN field_bytes<=262144 AND signer_bytes<=262144 THEN ${exactJsonNumbersSql("fields")} AND ${exactJsonNumbersSql("signer")} ELSE false END) FROM extrinsic_page),true)
  AND COALESCE((SELECT sum(field_bytes+participant_count*192+topic_bytes+topic_count*4+2048) FROM event_page),0)
    +COALESCE((SELECT sum(field_bytes+signer_bytes+2048) FROM extrinsic_page),0)<=786432 AS within_budget)
SELECT b.*,events.*,extrinsics.*,budget.within_budget,
  CASE WHEN budget.within_budget THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'event_index',e.event_index,'pallet',e.pallet,'variant',e.variant,'fields',e.fields,
    'phase',e.phase,'extrinsic_index',e.extrinsic_index,'topics',e.topics,
    'participants',COALESCE((SELECT jsonb_agg(jsonb_build_object('participant_index',a.participant_index,
      'account_id',a.account_id,'role',a.role) ORDER BY a.participant_index) FROM chain.event_participants a
      WHERE (a.publication_id,a.network_id,a.block_number,a.event_index)=(e.publication_id,e.network_id,e.block_number,e.event_index)), '[]'::jsonb)
  ) ORDER BY e.event_index) FROM event_page e),'[]'::jsonb) ELSE NULL END AS events,
  CASE WHEN budget.within_budget THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'extrinsic_index',e.extrinsic_index,'extrinsic_hash',e.extrinsic_hash,'pallet',e.pallet,'call',e.call,
    'fields',e.fields,'is_signed',e.is_signed,'signer',e.signer
  ) ORDER BY e.extrinsic_index) FROM extrinsic_page e),'[]'::jsonb) ELSE NULL END AS extrinsics
FROM selected b CROSS JOIN event_totals events CROSS JOIN extrinsic_totals extrinsics CROSS JOIN budget`;

// Coverage, replay fencing and the event page share one statement snapshot.
// Interval proof scans only block identities and event counts; decoded payloads
// are admitted separately after selecting distinct events, never appearances.
const accountEventsSql = `WITH live_head AS MATERIALIZED (${headSql}),
anchor AS MATERIALIZED (SELECT a.* FROM live_head h JOIN LATERAL (
  ${blockSource} WHERE b.network_id=$1
    AND b.block_number=COALESCE($4::bigint,h.block_number::bigint)) a ON true),
bounds AS MATERIALIZED (SELECT COALESCE($3::bigint,h.complete_from::bigint) AS from_block,
  a.block_number::bigint AS through_block FROM live_head h CROSS JOIN anchor a),
interval_blocks AS MATERIALIZED (SELECT b.network_id,b.block_number,b.publication_id,
  b.block_hash,b.parent_hash,lag(b.block_hash) OVER (ORDER BY b.block_number) AS previous_hash,
  COALESCE(r.integrity_verified,false) AND COALESCE(p.scope='blocks' AND p.stage='published'
    AND p.first_block<=b.block_number AND p.last_block>=b.block_number,false) AS eligible,
  b.event_count,b.extrinsic_count,body.actual_count,body.first_index,body.last_index
  FROM chain.blocks b CROSS JOIN bounds x
  LEFT JOIN ops.publications p ON p.publication_id=b.publication_id AND p.network_id=b.network_id
  LEFT JOIN chain.raw_eligibility r ON r.digest=b.raw_digest
    AND (r.kind='opaque' OR r.metadata_digest=b.metadata_digest)
  CROSS JOIN LATERAL (SELECT count(*) AS actual_count,min(e.event_index) AS first_index,
    max(e.event_index) AS last_index FROM chain.events e
    WHERE (e.publication_id,e.network_id,e.block_number)=(b.publication_id,b.network_id,b.block_number)) body
  WHERE b.network_id=$1 AND b.block_number BETWEEN x.from_block AND x.through_block),
coverage AS (SELECT count(*)::text AS block_count,min(block_number)::text AS first_block,
  max(block_number)::text AS last_block,
  COALESCE(bool_and(eligible AND (previous_hash IS NULL OR parent_hash=previous_hash)
    AND event_count BETWEEN 0 AND 65536 AND extrinsic_count BETWEEN 0 AND 65536
    AND actual_count=event_count AND CASE WHEN event_count=0
      THEN first_index IS NULL AND last_index IS NULL
      ELSE first_index=0 AND last_index=event_count-1 END),false) AS valid
  FROM interval_blocks),
gap AS (SELECT EXISTS(SELECT FROM ops.gaps g CROSS JOIN bounds x WHERE g.network_id=$1
  AND g.family='blocks' AND g.resolved_at IS NULL
  AND g.start_block<=x.through_block AND g.end_block>=x.from_block) AS present),
revision AS MATERIALIZED (SELECT p.generation::text,p.publication_id
  FROM ops.publications p CROSS JOIN bounds x WHERE p.network_id=$1
    AND p.scope='blocks' AND p.stage='published'
    AND p.first_block<=x.through_block AND p.last_block>=x.from_block
    AND EXISTS(SELECT FROM chain.block_publications v WHERE v.publication_id=p.publication_id
      AND v.network_id=p.network_id AND v.block_number BETWEEN x.from_block AND x.through_block)
  ORDER BY p.generation DESC,p.publication_id DESC LIMIT 1),
event_keys AS MATERIALIZED (SELECT e.publication_id,e.network_id,e.block_number,e.event_index
  FROM chain.events e JOIN interval_blocks b
    ON (e.publication_id,e.network_id,e.block_number)=(b.publication_id,b.network_id,b.block_number)
  WHERE ($5::bigint IS NULL OR (e.block_number,e.event_index)<($5::bigint,$6::integer))
    AND EXISTS(SELECT FROM chain.event_participants a
      WHERE (a.publication_id,a.network_id,a.block_number,a.event_index)
        =(e.publication_id,e.network_id,e.block_number,e.event_index) AND a.account_id=$2)
  ORDER BY e.block_number DESC,e.event_index DESC LIMIT ($7::integer+1)),
event_page AS MATERIALIZED (SELECT e.*,octet_length(e.fields::text) AS field_bytes,
  cardinality(e.topics) AS topic_count,
  COALESCE((SELECT sum(octet_length(topic)) FROM unnest(e.topics) topic),0) AS topic_bytes,
  (SELECT count(*) FROM chain.event_participants a
    WHERE (a.publication_id,a.network_id,a.block_number,a.event_index)
      =(e.publication_id,e.network_id,e.block_number,e.event_index)) AS participant_count
  FROM event_keys k JOIN chain.events e USING(publication_id,network_id,block_number,event_index)
  ORDER BY e.block_number DESC,e.event_index DESC LIMIT $7),
budget AS (SELECT COALESCE(bool_and(field_bytes<=262144 AND participant_count BETWEEN 1 AND 256
    AND topic_count<=256 AND topic_bytes<=16896
    AND length(pallet) BETWEEN 1 AND 128 AND length(variant) BETWEEN 1 AND 128
    AND CASE WHEN field_bytes<=262144 THEN ${exactJsonNumbersSql("fields")} ELSE false END),true)
    AND COALESCE(sum(field_bytes+participant_count*400+topic_bytes+topic_count*4+4096),0)<=786432
    AS within_budget FROM event_page)
SELECT to_jsonb(h)||jsonb_build_object('has_gap',gap.present) AS head,to_jsonb(a) AS anchor,
  to_jsonb(coverage) AS coverage,to_jsonb(revision) AS revision,budget.within_budget,
  (SELECT count(*)>$7::integer FROM event_keys) AS has_more,
  CASE WHEN coverage.valid AND NOT gap.present AND budget.within_budget THEN
    COALESCE((SELECT jsonb_agg(jsonb_build_object('source',to_jsonb(source),
      'event',jsonb_build_object('event_index',e.event_index,'pallet',e.pallet,'variant',e.variant,
        'fields',e.fields,'phase',e.phase,'extrinsic_index',e.extrinsic_index,'topics',e.topics,
        'participants',participants.all_rows),'matching_participants',participants.matches)
      ORDER BY e.block_number DESC,e.event_index DESC)
      FROM event_page e JOIN LATERAL (${blockSource}
        WHERE b.network_id=e.network_id AND b.block_number=e.block_number) source ON true
      CROSS JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('participant_index',p.participant_index,
        'account_id',p.account_id,'role',p.role) ORDER BY p.participant_index) AS all_rows,
        jsonb_agg(jsonb_build_object('participant_index',p.participant_index,
          'account_id',p.account_id,'role',p.role) ORDER BY p.participant_index)
          FILTER (WHERE p.account_id=$2) AS matches
        FROM chain.event_participants p WHERE (p.publication_id,p.network_id,p.block_number,p.event_index)
          =(e.publication_id,e.network_id,e.block_number,e.event_index)) participants),'[]'::jsonb)
    ELSE NULL END AS events
FROM live_head h LEFT JOIN anchor a ON true CROSS JOIN coverage CROSS JOIN gap
CROSS JOIN budget LEFT JOIN revision ON true`;

const registrySql = `SELECT n.network_id,n.genesis_hash,
  b.block_number::text,b.block_hash,b.parent_hash,b.metadata_digest,
  b.spec_version::float8 AS spec_version,b.transaction_version::float8 AS transaction_version,
  bp.producer_revision,bp.observed_at,bp.publication_id,bp.published_at,bp.stage,r.integrity_verified,
  n.finalized_observed_height::text,n.finalized_observed_hash,n.finalized_observed_at,
  e.registry_complete,e.registry_expected_netuids,
  ARRAY(SELECT s.netuid FROM registry.subnets s WHERE s.publication_id=e.publication_id AND s.network_id=e.network_id ORDER BY s.netuid) AS actual_netuids,
  ARRAY(SELECT s.netuid FROM registry.subnets s WHERE s.publication_id=e.publication_id AND s.network_id=e.network_id AND s.operational ORDER BY s.netuid) AS actual_operational_netuids,
  NOT EXISTS(SELECT FROM registry.subnets s WHERE s.publication_id=e.publication_id AND s.network_id=e.network_id AND s.mechanism_availability<>'current') AS actual_mechanisms_complete,
  jsonb_build_object('publication_id',e.publication_id,'generation',e.generation::text,
    'source_id',e.source_id,'candidate_id',e.candidate_id,'block_publication_id',e.block_publication_id,
    'projection_contract',e.projection_contract,'producer_revision',e.producer_revision,
    'profile_revision',e.profile_revision,'upstream_revision',e.upstream_revision,
    'observed_at',to_char(e.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'published_at',to_char(e.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'qualification',e.qualification,'state_proof_verified',e.state_proof_verified,
    'runtime_semantics_attested',e.runtime_semantics_attested,'enumeration_complete',e.enumeration_complete,
    'reportable_mechanisms_complete',e.reportable_mechanisms_complete,
    'operational_netuids',e.operational_netuids,'residual_storage_netuids',e.residual_storage_netuids,
    'state',jsonb_build_object('snapshot_id',e.snapshot_id,'block_number',e.last_block::text,
      'block_hash',e.state_block_hash,'metadata_digest',e.state_metadata_digest,
      'spec_version',e.state_spec_version,'transaction_version',e.state_transaction_version,
      'producer_revision',e.state_producer_revision,
      'observed_at',to_char(e.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) AS ecosystem
FROM registry.eligible_ecosystem_publications e
JOIN chain.networks n ON n.network_id=e.network_id
JOIN chain.blocks b ON b.network_id=e.network_id AND b.block_number=e.last_block
JOIN chain.block_publications version ON version.publication_id=e.block_publication_id
  AND version.network_id=b.network_id AND version.block_number=b.block_number
JOIN ops.publications bp ON bp.publication_id=version.publication_id AND bp.network_id=e.network_id
  AND bp.scope='blocks' AND bp.stage='published'
JOIN chain.raw_eligibility r ON r.digest=b.raw_digest
  AND (r.kind='opaque' OR r.metadata_digest=b.metadata_digest)
WHERE e.network_id=$1 AND r.integrity_verified=true`;

function parseInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new V2OperationError("invalid_input", "Invalid operation input");
  return parsed.data;
}

function freshness(
  row: z.output<typeof PublishedRowSchema>,
  now: Date,
): V2Freshness {
  const age = now.getTime() - Date.parse(row.observed_at);
  if (!Number.isFinite(age) || age < -5000)
    throw new V2OperationError("data_unavailable", "Invalid publication clock");
  const observed = row.finalized_observed_height;
  if (observed === null) {
    if (
      row.finalized_observed_hash !== null ||
      row.finalized_observed_at !== null
    )
      throw new V2OperationError(
        "data_unavailable",
        "Incomplete finalized observation",
      );
    return {
      status: "unknown",
      age_seconds: Math.max(0, age / 1000),
      finalized_lag_blocks: null,
      target_seconds: 30,
      target_blocks: 2,
    };
  }
  if (
    row.finalized_observed_hash === null ||
    row.finalized_observed_at === null ||
    BigInt(observed) < BigInt(row.block_number) ||
    (observed === row.block_number &&
      row.finalized_observed_hash !== row.block_hash)
  )
    throw new V2OperationError(
      "data_unavailable",
      "Invalid finalized observation",
    );
  const observationAge = now.getTime() - Date.parse(row.finalized_observed_at);
  if (observationAge < -5000)
    throw new V2OperationError("data_unavailable", "Invalid observation clock");
  const lag = BigInt(observed) - BigInt(row.block_number);
  return {
    status:
      age <= 30000 && observationAge <= 30000 && lag <= 2n
        ? "current"
        : "stale",
    age_seconds: Math.max(0, age / 1000),
    finalized_lag_blocks: lag.toString(),
    target_seconds: 30,
    target_blocks: 2,
  };
}

function envelope(row: z.output<typeof PublishedRowSchema>, now: Date) {
  return {
    api_version: "2" as const,
    network: { id: row.network_id, genesis_hash: row.genesis_hash },
    snapshot: {
      block_number: row.block_number,
      block_hash: row.block_hash,
      parent_hash: row.parent_hash,
      metadata_digest: row.metadata_digest,
      spec_version: row.spec_version,
      transaction_version: row.transaction_version,
      producer_revision: row.producer_revision,
      publication_id: row.publication_id,
      observed_at: row.observed_at,
      published_at: row.published_at,
    },
    freshness: freshness(row, now),
  };
}

function requireOne(rows: unknown[], message: string) {
  if (rows.length === 0)
    throw new V2OperationError("data_unavailable", message);
  if (rows.length !== 1) throw new Error("Ambiguous publication");
  return rows[0];
}

function parseBlockEvidence<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new V2OperationError(
      "data_unavailable",
      "Published block evidence is incomplete or invalid",
    );
  return parsed.data;
}

function unavailableBlockEvidence(message: string): never {
  throw new V2OperationError("data_unavailable", message);
}

export function createV2Operations(
  executor: V2QueryExecutor,
  options: { now?: () => Date; invocation?: V2InvocationEngine } = {},
) {
  const now = options.now ?? (() => new Date());
  const registry = async (network: string, publicationId?: string) => {
    let result;
    try {
      result = await executor.query(
        `${registrySql}${publicationId === undefined ? "" : " AND e.publication_id=$2"}
ORDER BY e.last_block DESC,e.generation DESC LIMIT 1`,
        publicationId === undefined ? [network] : [network, publicationId],
      );
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        ["42P01", "42703"].includes(String(error.code))
      )
        throw new V2OperationError(
          "data_unavailable",
          "The ecosystem read contract is unavailable",
        );
      throw error;
    }
    const row = parseBlockEvidence(
      RegistryRowSchema,
      requireOne(result.rows, "No complete ecosystem publication is available"),
    );
    const expected = row.registry_expected_netuids;
    if (
      row.network_id !== network ||
      (publicationId !== undefined &&
        row.ecosystem.publication_id !== publicationId) ||
      expected[0] !== 0 ||
      expected.some((id, index) => index > 0 && id <= expected[index - 1]) ||
      expected.length !== row.actual_netuids.length ||
      expected.some((id, index) => id !== row.actual_netuids[index]) ||
      JSON.stringify(row.ecosystem.operational_netuids) !==
        JSON.stringify(row.actual_operational_netuids) ||
      row.ecosystem.operational_netuids.some((id) => !expected.includes(id)) ||
      row.ecosystem.residual_storage_netuids.some((id) =>
        expected.includes(id),
      ) ||
      row.ecosystem.reportable_mechanisms_complete !==
        row.actual_mechanisms_complete
    )
      throw new V2OperationError(
        "data_unavailable",
        "Ecosystem publication coverage mismatch",
      );
    return row;
  };
  const ecosystemEnvelope = (row: z.output<typeof RegistryRowSchema>) => {
    const observedNow = now();
    const block = envelope(row, observedNow);
    const age = observedNow.getTime() - Date.parse(row.ecosystem.observed_at);
    if (
      !Number.isFinite(age) ||
      age < -5000 ||
      Date.parse(row.ecosystem.published_at) > observedNow.getTime() + 5000
    )
      throw new V2OperationError(
        "data_unavailable",
        "Invalid ecosystem observation clock",
      );
    const observationAge =
      row.finalized_observed_at === null
        ? null
        : observedNow.getTime() - Date.parse(row.finalized_observed_at);
    return V2EcosystemEnvelopeSchema.parse({
      ...block,
      ecosystem: row.ecosystem,
      freshness: {
        status:
          observationAge === null
            ? "unknown"
            : age <= 900000 && observationAge <= 30000
              ? "current"
              : "stale",
        age_seconds: Math.max(0, age / 1000),
        finalized_lag_blocks: block.freshness.finalized_lag_blocks,
        target_seconds: 900,
        target_blocks: null,
      },
    });
  };

  const chain = {
    async get_chain_head(input: unknown) {
      const { network } = parseInput(
        V2_OPERATION_SCHEMAS.get_chain_head.input,
        input,
      );
      const result = await executor.query(headSql, [network]);
      const row = parseBlockEvidence(
        HeadRowSchema,
        requireOne(result.rows, "No contiguous publication is available"),
      );
      if (
        row.network_id !== network ||
        row.complete_through !== row.block_number ||
        row.checkpoint_hash !== row.block_hash ||
        row.checkpoint_publication_id !== row.publication_id
      )
        unavailableBlockEvidence(
          "Checkpoint identity does not match its published block",
        );
      return V2HeadSchema.parse({
        ...envelope(row, now()),
        coverage: {
          from_block: row.complete_from,
          through_block: row.complete_through,
          contiguous: true,
        },
        observed_finalized:
          row.finalized_observed_height === null
            ? null
            : {
                block_number: row.finalized_observed_height,
                block_hash: row.finalized_observed_hash,
                observed_at: row.finalized_observed_at,
              },
      });
    },
    async list_blocks(input: unknown) {
      const selected = parseInput(
        V2_OPERATION_SCHEMAS.list_blocks.input,
        input,
      );
      const {
        network,
        limit,
        before,
        from_block,
        anchor_height,
        anchor_hash,
        anchor_publication_id,
      } = selected;
      const result = await executor.query(listBlocksSql, [
        network,
        anchor_height ?? null,
        before ?? null,
        limit + 1,
        from_block ?? null,
      ]);
      if (result.rows.length !== 1)
        unavailableBlockEvidence(
          "No unambiguous contiguous publication is available",
        );
      const read = parseBlockEvidence(
        z.object({
          head: z.unknown(),
          anchor: z.unknown(),
          boundary: z.unknown(),
          blocks: z.array(z.unknown()),
        }),
        result.rows[0],
      );
      const head = parseBlockEvidence(HeadRowSchema, read.head);
      if (
        head.network_id !== network ||
        head.block_number !== head.complete_through ||
        head.checkpoint_hash !== head.block_hash ||
        head.checkpoint_publication_id !== head.publication_id
      )
        unavailableBlockEvidence("Checkpoint identity mismatch");
      const anchor = parseBlockEvidence(sourceRow, read.anchor);
      const from = from_block ?? head.complete_from;
      if (
        anchor.network_id !== network ||
        BigInt(anchor.block_number) > BigInt(head.complete_through) ||
        BigInt(from) < BigInt(head.complete_from) ||
        BigInt(from) > BigInt(anchor.block_number) ||
        (anchor_height !== undefined &&
          anchor.block_number !== anchor_height) ||
        (anchor_hash !== undefined && anchor.block_hash !== anchor_hash) ||
        (anchor_publication_id !== undefined &&
          anchor.publication_id !== anchor_publication_id)
      )
        throw new V2OperationError(
          "data_unavailable",
          "The pinned block source changed; restart this read",
        );
      const top =
        before === undefined
          ? BigInt(anchor.block_number)
          : BigInt(before) - 1n;
      const available = top - BigInt(from) + 1n;
      const expected = Number(
        available < BigInt(limit + 1) ? available : BigInt(limit + 1),
      );
      const rows = parseBlockEvidence(z.array(sourceRow), read.blocks);
      if (
        rows.length !== expected ||
        rows.some(
          (row, index) =>
            row.network_id !== network ||
            BigInt(row.block_number) !== top - BigInt(index) ||
            (index > 0 && rows[index - 1].parent_hash !== row.block_hash),
        )
      )
        unavailableBlockEvidence("Block page coverage mismatch");
      if (before !== undefined) {
        const boundary = parseBlockEvidence(sourceRow, read.boundary);
        if (
          boundary.network_id !== network ||
          boundary.block_number !== before ||
          (rows.length > 0 && boundary.parent_hash !== rows[0].block_hash)
        )
          unavailableBlockEvidence("Block continuation boundary mismatch");
      } else if (
        rows[0] &&
        (rows[0].block_hash !== anchor.block_hash ||
          rows[0].publication_id !== anchor.publication_id)
      )
        unavailableBlockEvidence("Block anchor mismatch");
      const page = rows.slice(0, limit);
      return V2BlockListSchema.parse({
        ...envelope(anchor, now()),
        coverage: {
          from_block: from,
          through_block: anchor.block_number,
          contiguous: true,
        },
        blocks: page.map((row) => ({
          snapshot: envelope(row, now()).snapshot,
          source_capture_digest: row.raw_digest,
          event_count: row.event_count,
          extrinsic_count: row.extrinsic_count,
        })),
        next_before: rows.length > limit ? page.at(-1)!.block_number : null,
      });
    },
    async list_account_events(input: unknown) {
      const selected = parseInput(
        V2_OPERATION_SCHEMAS.list_account_events.input,
        input,
      );
      const { network, account_id, limit } = selected;
      let cursor: V2AccountEventCursor | undefined;
      if (selected.cursor !== undefined) {
        try {
          cursor = decodeAccountEventCursor(selected.cursor);
        } catch {
          throw new V2OperationError(
            "invalid_input",
            "Invalid account event cursor",
          );
        }
        if (cursor.network !== network || cursor.account_id !== account_id)
          throw new V2OperationError(
            "invalid_input",
            "Account event cursor does not match this request",
          );
      }
      const result = await executor.query(accountEventsSql, [
        network,
        account_id,
        cursor?.from_block ?? selected.from_block ?? null,
        cursor?.anchor_height ?? null,
        cursor?.before_block ?? null,
        cursor?.before_event_index ?? null,
        limit,
      ]);
      const read = parseBlockEvidence(
        z.object({
          head: z.unknown(),
          anchor: z.unknown(),
          coverage: z.object({
            block_count: z
              .string()
              .regex(/^(0|[1-9][0-9]*)$/)
              .max(20),
            first_block: V2HeightSchema.nullable(),
            last_block: V2HeightSchema.nullable(),
            valid: z.literal(true),
          }),
          revision: V2AccountEventsSchema.shape.revision,
          within_budget: z.literal(true),
          has_more: z.boolean(),
          events: z.array(z.unknown()).max(100),
        }),
        requireOne(result.rows, "No account event publication is available"),
      );
      const head = parseBlockEvidence(HeadRowSchema, read.head);
      const anchor = parseBlockEvidence(sourceRow, read.anchor);
      const from =
        cursor?.from_block ?? selected.from_block ?? head.complete_from;
      if (
        head.network_id !== network ||
        head.complete_through !== head.block_number ||
        head.checkpoint_hash !== head.block_hash ||
        head.checkpoint_publication_id !== head.publication_id ||
        anchor.network_id !== network ||
        anchor.genesis_hash !== head.genesis_hash ||
        BigInt(anchor.block_number) > BigInt(head.complete_through) ||
        BigInt(from) < BigInt(head.complete_from) ||
        BigInt(from) > BigInt(anchor.block_number) ||
        read.coverage.first_block !== from ||
        read.coverage.last_block !== anchor.block_number ||
        BigInt(read.coverage.block_count) !==
          BigInt(anchor.block_number) - BigInt(from) + 1n
      )
        unavailableBlockEvidence("Account event interval coverage mismatch");
      if (
        cursor &&
        (cursor.genesis_hash !== anchor.genesis_hash ||
          cursor.anchor_height !== anchor.block_number ||
          cursor.anchor_hash !== anchor.block_hash ||
          cursor.anchor_publication_id !== anchor.publication_id ||
          cursor.revision_generation !== read.revision.generation ||
          cursor.revision_publication_id !== read.revision.publication_id)
      )
        unavailableBlockEvidence(
          "The pinned account event interval changed; restart this read",
        );
      if (
        read.events.length > limit ||
        (read.has_more && read.events.length !== limit)
      )
        unavailableBlockEvidence("Account event page length mismatch");
      // Do not enter the recursive decoded-field schema before bounding its input.
      for (const value of read.events) {
        if (
          value === null ||
          typeof value !== "object" ||
          !("event" in value) ||
          value.event === null ||
          typeof value.event !== "object" ||
          !("fields" in value.event) ||
          !("participants" in value.event) ||
          !Array.isArray(value.event.participants) ||
          value.event.participants.length > 256 ||
          !("topics" in value.event) ||
          !Array.isArray(value.event.topics) ||
          value.event.topics.length > 256 ||
          !("matching_participants" in value) ||
          !Array.isArray(value.matching_participants) ||
          value.matching_participants.length > 256 ||
          !isBoundedV2DecodedValue(value.event.fields)
        )
          unavailableBlockEvidence(
            "Account event payload exceeds the supported response budget",
          );
      }
      const rows = parseBlockEvidence(
        z.array(
          z
            .object({
              source: sourceRow,
              event: V2AccountEventsSchema.shape.events.element.shape.event,
              matching_participants:
                V2AccountEventsSchema.shape.events.element.shape
                  .matching_participants,
            })
            .strict(),
        ),
        read.events,
      );
      let previous = cursor
        ? {
            height: BigInt(cursor.before_block),
            index: cursor.before_event_index,
          }
        : undefined;
      let priorSource: string | undefined;
      for (const row of rows) {
        const { source, event, matching_participants } = row;
        const height = BigInt(source.block_number);
        const matches = event.participants.filter(
          (participant) => participant.account_id === account_id,
        );
        const identity = JSON.stringify(source);
        if (
          source.network_id !== network ||
          source.genesis_hash !== anchor.genesis_hash ||
          height < BigInt(from) ||
          height > BigInt(anchor.block_number) ||
          event.event_index >= source.event_count ||
          (event.phase === "ApplyExtrinsic") !==
            (event.extrinsic_index !== null) ||
          (event.extrinsic_index !== null &&
            event.extrinsic_index >= source.extrinsic_count) ||
          event.participants.some(
            (participant, index) => participant.participant_index !== index,
          ) ||
          JSON.stringify(matches) !== JSON.stringify(matching_participants) ||
          (height === BigInt(anchor.block_number) &&
            identity !== JSON.stringify(anchor)) ||
          (previous &&
            (height > previous.height ||
              (height === previous.height &&
                event.event_index >= previous.index))) ||
          (previous &&
            height === previous.height &&
            priorSource !== undefined &&
            identity !== priorSource)
        )
          unavailableBlockEvidence("Account event page evidence mismatch");
        previous = { height, index: event.event_index };
        priorSource = identity;
      }
      const observedNow = now();
      const last = rows.at(-1);
      const output = V2AccountEventsSchema.parse({
        ...envelope(anchor, observedNow),
        account_id,
        coverage: {
          from_block: from,
          through_block: anchor.block_number,
          contiguous: true,
        },
        revision: read.revision,
        events: rows.map(({ source, event, matching_participants }) => ({
          snapshot: envelope(source, observedNow).snapshot,
          source_capture_digest: source.raw_digest,
          event_count: source.event_count,
          extrinsic_count: source.extrinsic_count,
          event,
          matching_participants,
        })),
        next_cursor:
          read.has_more && last
            ? encodeAccountEventCursor({
                version: 1,
                network,
                genesis_hash: anchor.genesis_hash,
                account_id,
                from_block: from,
                anchor_height: anchor.block_number,
                anchor_hash: anchor.block_hash,
                anchor_publication_id: anchor.publication_id,
                revision_generation: read.revision.generation,
                revision_publication_id: read.revision.publication_id,
                before_block: last.source.block_number,
                before_event_index: last.event.event_index,
              })
            : null,
      });
      if (Buffer.byteLength(JSON.stringify(output)) > 1048576)
        unavailableBlockEvidence(
          "Account event response exceeds the supported byte budget",
        );
      return output;
    },
    async get_block(input: unknown) {
      const selected = parseInput(V2_OPERATION_SCHEMAS.get_block.input, input);
      const {
        network,
        height,
        after_event_index,
        after_extrinsic_index,
        limit,
        extrinsic_limit,
      } = selected;
      const result = await executor.query(blockSql, [
        network,
        height,
        after_event_index ?? -1,
        limit + 1,
        after_extrinsic_index ?? -1,
        extrinsic_limit + 1,
      ]);
      if (result.rows.length === 0)
        throw new V2OperationError("not_found", "Published block not found");
      if (result.rows.length !== 1)
        unavailableBlockEvidence("Published block identity is ambiguous");
      const row = parseBlockEvidence(
        sourceRow.extend({
          actual_event_count: z.int().nonnegative(),
          first_event_index: z.int().nonnegative().nullable(),
          last_event_index: z.int().nonnegative().nullable(),
          actual_extrinsic_count: z.int().nonnegative(),
          first_extrinsic_index: z.int().nonnegative().nullable(),
          last_extrinsic_index: z.int().nonnegative().nullable(),
          within_budget: z.boolean(),
          events: z.unknown(),
          extrinsics: z.unknown(),
        }),
        result.rows[0],
      );
      if (row.network_id !== network || row.block_number !== height)
        unavailableBlockEvidence("Block identity mismatch");
      if (
        (selected.publication_id !== undefined &&
          row.publication_id !== selected.publication_id) ||
        (selected.block_hash !== undefined &&
          row.block_hash !== selected.block_hash)
      )
        throw new V2OperationError(
          "data_unavailable",
          "The pinned block source changed; restart this read",
        );
      for (const [count, actual, first, last] of [
        [
          row.event_count,
          row.actual_event_count,
          row.first_event_index,
          row.last_event_index,
        ],
        [
          row.extrinsic_count,
          row.actual_extrinsic_count,
          row.first_extrinsic_index,
          row.last_extrinsic_index,
        ],
      ] as const)
        if (
          actual !== count ||
          (count === 0
            ? first !== null || last !== null
            : first !== 0 || last !== count - 1)
        )
          unavailableBlockEvidence("Block body coverage mismatch");
      if (!row.within_budget)
        throw new V2OperationError(
          "data_unavailable",
          "Block payload exceeds the supported response budget",
        );
      for (const body of [row.events, row.extrinsics]) {
        if (
          !Array.isArray(body) ||
          body.some(
            (item) =>
              item === null ||
              typeof item !== "object" ||
              !isBoundedV2DecodedValue(item.fields) ||
              ("signer" in item && !isBoundedV2DecodedValue(item.signer)),
          )
        )
          throw new V2OperationError(
            "data_unavailable",
            "Block payload exceeds the supported response budget",
          );
      }
      const events = parseBlockEvidence(
        z.array(V2BlockSchema.shape.events.element),
        row.events,
      );
      const extrinsics = parseBlockEvidence(
        z.array(V2BlockSchema.shape.extrinsics.element),
        row.extrinsics,
      );
      const checkPage = (
        rows: { index: number }[],
        count: number,
        after: number | undefined,
        limit: number,
      ) => {
        const start = (after ?? -1) + 1;
        if (
          rows.length !== Math.min(Math.max(0, count - start), limit + 1) ||
          rows.some((row, index) => row.index !== start + index)
        )
          unavailableBlockEvidence("Block body page coverage mismatch");
      };
      checkPage(
        events.map((event) => ({ index: event.event_index })),
        row.event_count,
        after_event_index,
        limit,
      );
      checkPage(
        extrinsics.map((extrinsic) => ({ index: extrinsic.extrinsic_index })),
        row.extrinsic_count,
        after_extrinsic_index,
        extrinsic_limit,
      );
      if (
        events.some(
          (event) =>
            !isBoundedV2DecodedValue(event.fields) ||
            (event.extrinsic_index !== null &&
              event.extrinsic_index >= row.extrinsic_count) ||
            event.participants.some(
              (participant, index) => participant.participant_index !== index,
            ),
        ) ||
        extrinsics.some(
          (extrinsic) =>
            !isBoundedV2DecodedValue(extrinsic.fields) ||
            !isBoundedV2DecodedValue(extrinsic.signer),
        )
      )
        unavailableBlockEvidence("Block body payload mismatch");
      const page = events.slice(0, limit);
      const extrinsicPage = extrinsics.slice(0, extrinsic_limit);
      const output = V2BlockSchema.parse({
        ...envelope(row, now()),
        source_capture_digest: row.raw_digest,
        event_count: row.event_count,
        extrinsic_count: row.extrinsic_count,
        events: page,
        extrinsics: extrinsicPage,
        next_event_index:
          events.length > limit ? page.at(-1)!.event_index : null,
        next_extrinsic_index:
          extrinsics.length > extrinsic_limit
            ? extrinsicPage.at(-1)!.extrinsic_index
            : null,
      });
      if (Buffer.byteLength(JSON.stringify(output)) > 1048576)
        throw new V2OperationError(
          "data_unavailable",
          "Block response exceeds the supported byte budget",
        );
      return output;
    },
    async list_subnets(input: unknown) {
      const { network, publication_id, after, limit } = parseInput(
        V2_OPERATION_SCHEMAS.list_subnets.input,
        input,
      );
      const row = await registry(network, publication_id);
      const result = await executor.query(
        `SELECT ${V2_SUBNET_PROJECTION_SQL} AS subnet
         FROM registry.subnets s WHERE s.network_id=$1 AND s.publication_id=$2
           AND ($3::integer IS NULL OR s.netuid > $3::integer)
         ORDER BY s.netuid LIMIT $4`,
        [network, row.ecosystem.publication_id, after ?? null, limit + 1],
      );
      const expected = row.registry_expected_netuids
        .filter((netuid) => after === undefined || netuid > after)
        .slice(0, limit + 1);
      const parsedRows = parseBlockEvidence(
        z.array(z.object({ subnet: V2SubnetListSchema.shape.subnets.element })),
        result.rows,
      ).map((entry) => entry.subnet);
      if (
        parsedRows.length !== expected.length ||
        parsedRows.some(
          (subnet, index) => subnet.generation.netuid !== expected[index],
        )
      )
        throw new V2OperationError(
          "data_unavailable",
          "Registry page coverage mismatch",
        );
      const subnets = parsedRows.slice(0, limit);
      const output = V2SubnetListSchema.parse({
        ...ecosystemEnvelope(row),
        coverage: {
          registry_complete: true,
          reportable_subnets: row.registry_expected_netuids.length,
          operational_subnets: row.ecosystem.operational_netuids.length,
        },
        subnets,
        next_after: null,
      });
      if (result.rows.length > limit) {
        output.next_after = output.subnets.at(-1)!.generation.netuid;
      }
      return output;
    },
    async get_subnet(input: unknown) {
      const { network, netuid, publication_id } = parseInput(
        V2_OPERATION_SCHEMAS.get_subnet.input,
        input,
      );
      const row = await registry(network, publication_id);
      if (!row.registry_expected_netuids.includes(netuid))
        throw new V2OperationError(
          "not_found",
          "Subnet is absent from the selected registry",
        );
      const result = await executor.query(
        `SELECT ${V2_SUBNET_PROJECTION_SQL} AS subnet
         FROM registry.subnets s WHERE s.network_id=$1 AND s.publication_id=$2 AND s.netuid=$3`,
        [network, row.ecosystem.publication_id, netuid],
      );
      const { subnet } = parseBlockEvidence(
        z.object({ subnet: V2SubnetResultSchema.shape.subnet }),
        requireOne(result.rows, "Subnet publication is incomplete"),
      );
      if (subnet.generation.netuid !== netuid)
        throw new V2OperationError(
          "data_unavailable",
          "Subnet identity mismatch",
        );
      return V2SubnetResultSchema.parse({
        ...ecosystemEnvelope(row),
        subnet,
      });
    },
  };
  async function prepareInvocation(
    input: unknown,
    context?: V2OperationContext,
  ) {
    if (!context)
      throw new V2OperationError(
        "authorization_required",
        "Authentication is required",
      );
    const invocation = context.invocation ?? options.invocation;
    if (!invocation)
      throw new V2OperationError(
        "data_unavailable",
        "Service invocation is unavailable",
      );
    try {
      return await invocation.prepare(input, context.caller, context.signal);
    } catch (error) {
      if (error instanceof V2InvocationError)
        throw new V2OperationError(
          [
            "catalog_unavailable",
            "catalog_changed",
            "cancelled",
            "deadline_exceeded",
          ].includes(error.code)
            ? "data_unavailable"
            : "invalid_input",
          error.message,
        );
      throw error;
    }
  }
  return {
    ...chain,
    list_account_stake: createV2AccountStakeOperation(executor, now),
    ...createV2RegistryOperations(executor, chain, options),
    prepare_service_invocation: prepareInvocation,
    async approve_service_invocation(
      input: unknown,
      context?: V2OperationContext,
    ) {
      if (!context?.approveInvocation)
        throw new V2OperationError(
          "authorization_required",
          "Authentication is required",
        );
      const parsed =
        V2_OPERATION_SCHEMAS.approve_service_invocation.input.parse(input);
      const intent = await prepareInvocation(parsed.invocation, context);
      if (context.signal?.aborted)
        throw new V2OperationError(
          "data_unavailable",
          "Service approval was cancelled",
        );
      return V2_OPERATION_SCHEMAS.approve_service_invocation.output.parse(
        await context.approveInvocation(intent, parsed.expires_at),
      );
    },
    async invoke_service(input: unknown, context?: V2OperationContext) {
      if (!context)
        throw new V2OperationError(
          "authorization_required",
          "Authentication is required",
        );
      const invocation = context.invocation ?? options.invocation;
      if (!invocation)
        throw new V2OperationError(
          "data_unavailable",
          "Service invocation is unavailable",
        );
      return invocation.invoke(input, context.caller, context.signal);
    },
  };
}

export type V2Operations = ReturnType<typeof createV2Operations>;

export async function executeV2Operation(
  operations: V2Operations,
  name: V2OperationName,
  input: unknown,
  context?: V2OperationContext,
) {
  if (
    name === "invoke_service" ||
    name === "prepare_service_invocation" ||
    name === "approve_service_invocation"
  )
    return operations[name](input, context);
  return operations[name](input);
}
