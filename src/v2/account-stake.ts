import { z } from "zod";
import {
  V2AccountStakeSchema,
  V2AccountStakeInputSchema,
  isV2AccountStakeEntryAtState,
} from "../../schemas-src/v2/stake.ts";
import {
  isBoundedV2DecodedValue,
  V2HeightSchema,
  V2HashSchema,
  V2NetworkSchema,
  V2SnapshotSchema,
  V2TimestampSchema,
} from "../../schemas-src/v2/contracts.ts";
import {
  accountStakeKey,
  compareAccountStakeKeys,
  decodeAccountStakeCursor,
  encodeAccountStakeCursor,
  type V2AccountStakeCursor,
} from "./account-stake-cursor.ts";
import {
  V2OperationError,
  exactJsonNumbersSql,
  type V2QueryExecutor,
} from "./shared.ts";

// Select at most eleven indexed keys per population before fetching payloads.
// The root coordinate zero is only a seek tie-breaker, never subnet attribution.
const sql = `WITH chosen AS MATERIALIZED (
  SELECT e.*,n.genesis_hash,n.finalized_observed_height,n.finalized_observed_hash,n.finalized_observed_at,
    b.spec_version,b.transaction_version,cp.producer_revision AS execution_revision,
    cp.observed_at AS execution_observed_at,cp.published_at AS execution_published_at
  FROM chain.eligible_stake_publications e JOIN chain.networks n ON n.network_id=e.network_id
  JOIN chain.blocks b ON b.network_id=e.network_id AND b.block_number=e.last_block
    AND b.block_hash=e.state_block_hash AND b.metadata_digest=e.block_metadata_digest
  JOIN ops.publications cp ON cp.publication_id=e.block_publication_id AND cp.network_id=e.network_id
    AND cp.scope='blocks' AND cp.stage='published'
  WHERE e.network_id=$1 AND ($3::text IS NULL OR e.publication_id=$3)
  ORDER BY e.last_block DESC,e.generation DESC LIMIT 1
), position_keys AS MATERIALIZED (
  SELECT 0 AS kind_rank,p.hotkey,p.netuid
  FROM chosen c JOIN chain.published_stake_positions p ON p.publication_id=c.publication_id AND p.network_id=c.network_id
  WHERE p.coldkey=$2 AND ($4::text IS NULL OR (p.hotkey COLLATE "C",0,p.netuid)>($4 COLLATE "C",$5::integer,$6::integer))
  ORDER BY p.hotkey COLLATE "C",p.netuid LIMIT ($7::integer+1)
), root_keys AS MATERIALIZED (
  SELECT 1 AS kind_rank,'0x'||encode(r.hotkey_bytes,'hex') AS hotkey,0 AS netuid
  FROM chosen c JOIN chain.published_root_entitlements r ON r.publication_id=c.publication_id AND r.network_id=c.network_id
  WHERE r.coldkey_bytes=decode(substring($2::text FROM 3),'hex')
    AND ($4::text IS NULL OR (r.hotkey_bytes,1,0)>(decode(substring($4::text FROM 3),'hex'),$5::integer,$6::integer))
  ORDER BY r.hotkey_bytes LIMIT ($7::integer+1)
), keys AS MATERIALIZED (
  SELECT * FROM (SELECT * FROM position_keys UNION ALL SELECT * FROM root_keys) populations
  ORDER BY hotkey COLLATE "C",kind_rank,netuid LIMIT ($7::integer+1)
), page AS MATERIALIZED (
  SELECT k.*,CASE WHEN k.kind_rank=0 THEN
      (SELECT p.position FROM chain.published_stake_positions p WHERE p.publication_id=c.publication_id AND p.network_id=c.network_id
        AND p.coldkey=$2 AND p.hotkey=k.hotkey AND p.netuid=k.netuid)
    ELSE (SELECT r.entitlement FROM chain.published_root_entitlements r WHERE r.publication_id=c.publication_id AND r.network_id=c.network_id
        AND r.coldkey_bytes=decode(substring($2::text FROM 3),'hex') AND r.hotkey_bytes=decode(substring(k.hotkey FROM 3),'hex'))
    END AS payload
  FROM (SELECT * FROM keys ORDER BY hotkey COLLATE "C",kind_rank,netuid LIMIT $7::integer) k CROSS JOIN chosen c
), budget AS (
  SELECT count(*)=LEAST((SELECT count(*) FROM keys),$7::integer)
    AND COALESCE(bool_and(payload IS NOT NULL AND octet_length(payload::text)<=131072 AND ${exactJsonNumbersSql("payload")}),true)
    AND COALESCE(sum(octet_length(payload::text)),0)<=786432 AS within_budget FROM page
)
SELECT jsonb_build_object('id',c.network_id,'genesis_hash',c.genesis_hash) AS network,
  jsonb_build_object('block_number',c.last_block::text,'block_hash',c.state_block_hash,'parent_hash',c.block_parent_hash,
    'metadata_digest',c.block_metadata_digest,'spec_version',c.spec_version,'transaction_version',c.transaction_version,
    'producer_revision',c.execution_revision,'publication_id',c.block_publication_id,'observed_at',c.execution_observed_at,'published_at',c.execution_published_at) AS snapshot,
  jsonb_build_object('publication_id',c.publication_id,'generation',c.generation::text,'source_id',c.source_id,
    'root_candidate_id',c.root_candidate_id,'request_id',c.request_id,'stake_candidate_id',c.stake_candidate_id,'ecosystem_candidate_id',c.ecosystem_candidate_id,
    'block_publication_id',c.block_publication_id,'projection_contract',c.projection_contract,'producer_revision',c.producer_revision,
    'observed_at',c.observed_at,'published_at',c.published_at,'qualification',c.qualification,
    'state_proof_verified',c.state_proof_verified,'runtime_semantics_attested',c.runtime_semantics_attested,
    'census_complete',true,'account_scope','coldkey','member_count',c.member_count::text,'claimant_count',c.claimant_count::text,
    'state',jsonb_build_object('snapshot_id',c.snapshot_id,'block_number',c.last_block::text,'block_hash',c.state_block_hash,
      'metadata_digest',c.state_metadata_digest,'spec_version',c.state_spec_version,'transaction_version',c.state_transaction_version,
      'producer_revision',c.state_producer_revision,'observed_at',c.observed_at)) AS stake,
  c.finalized_observed_height::text,c.finalized_observed_hash,c.finalized_observed_at,
  budget.within_budget,(SELECT count(*) FROM keys)>$7::integer AS has_more,
  CASE WHEN budget.within_budget THEN COALESCE((SELECT jsonb_agg(
    CASE WHEN kind_rank=0 THEN jsonb_build_object('kind','position','position',payload)
      ELSE jsonb_build_object('kind','root_entitlement','entitlement',payload) END
    ORDER BY hotkey COLLATE "C",kind_rank,netuid) FROM page),'[]'::jsonb) ELSE NULL END AS entries
FROM chosen c CROSS JOIN budget`;

const timestamp = z
  .union([z.date(), V2TimestampSchema])
  .transform((value) => new Date(value).toISOString());
const rowSchema = z.object({
  network: V2NetworkSchema,
  snapshot: V2SnapshotSchema,
  stake: V2AccountStakeSchema.shape.stake,
  finalized_observed_height: V2HeightSchema.nullable(),
  finalized_observed_hash: V2HashSchema.nullable(),
  finalized_observed_at: timestamp.nullable(),
  within_budget: z.literal(true),
  has_more: z.boolean(),
  entries: z.array(z.unknown()).max(10),
});
function unavailable(message: string): never {
  throw new V2OperationError("data_unavailable", message);
}

export function createV2AccountStakeOperation(
  executor: V2QueryExecutor,
  now: () => Date,
) {
  return async function list_account_stake(input: unknown) {
    const parsed = V2AccountStakeInputSchema.safeParse(input);
    if (!parsed.success)
      throw new V2OperationError(
        "invalid_input",
        "Invalid account stake selection",
      );
    const selected = parsed.data;
    let cursor: V2AccountStakeCursor | undefined;
    if (selected.cursor !== undefined) {
      try {
        cursor = decodeAccountStakeCursor(selected.cursor);
      } catch {
        throw new V2OperationError(
          "invalid_input",
          "Invalid account stake cursor",
        );
      }
      if (
        cursor.network !== selected.network ||
        cursor.account_id !== selected.account_id ||
        (selected.publication_id !== undefined &&
          selected.publication_id !== cursor.publication_id)
      )
        throw new V2OperationError(
          "invalid_input",
          "Account stake cursor does not match this request",
        );
    }
    let rows: unknown[];
    try {
      ({ rows } = await executor.query(sql, [
        selected.network,
        selected.account_id,
        cursor?.publication_id ?? selected.publication_id ?? null,
        cursor?.hotkey ?? null,
        cursor === undefined ? null : cursor.kind === "position" ? 0 : 1,
        cursor?.netuid ?? 0,
        selected.limit,
      ]));
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        ["42P01", "42703"].includes(String(error.code))
      )
        unavailable("The stake read contract is unavailable");
      throw error;
    }
    if (rows.length !== 1)
      unavailable("No complete eligible stake census is available");
    const parsedRow = rowSchema.safeParse(rows[0]);
    if (!parsedRow.success)
      unavailable("Published stake evidence is incomplete or invalid");
    const row = parsedRow.data;
    if (
      row.network.id !== selected.network ||
      (cursor !== undefined &&
        row.network.genesis_hash !== cursor.genesis_hash) ||
      ((cursor?.publication_id ?? selected.publication_id) !== undefined &&
        row.stake.publication_id !==
          (cursor?.publication_id ?? selected.publication_id)) ||
      row.entries.length > selected.limit ||
      (row.has_more && row.entries.length !== selected.limit)
    )
      unavailable("Stake publication or page identity differs");
    for (const entry of row.entries)
      if (!isBoundedV2DecodedValue(entry))
        unavailable("Published stake body exceeds admission");
    const entries = V2AccountStakeSchema.shape.entries.safeParse(row.entries);
    if (!entries.success) unavailable("Published stake body is invalid");
    let previous =
      cursor === undefined
        ? undefined
        : { kind: cursor.kind, hotkey: cursor.hotkey, netuid: cursor.netuid };
    for (const entry of entries.data) {
      const key = accountStakeKey(entry);
      if (previous !== undefined && compareAccountStakeKeys(previous, key) >= 0)
        unavailable("Stake page order or continuation differs");
      previous = key;
      if (
        !isV2AccountStakeEntryAtState(
          entry,
          selected.account_id,
          row.network.genesis_hash,
          row.stake.state,
        )
      )
        unavailable("Stake entry belongs to another account, network or state");
    }
    const observedNow = now().getTime();
    const age = observedNow - Date.parse(row.stake.observed_at);
    const observationAge =
      row.finalized_observed_at === null
        ? null
        : observedNow - Date.parse(row.finalized_observed_at);
    if (
      !Number.isFinite(observedNow) ||
      !Number.isFinite(age) ||
      age < -5000 ||
      [
        row.stake.published_at,
        row.snapshot.observed_at,
        row.snapshot.published_at,
      ].some((value) => Date.parse(value) > observedNow + 5000) ||
      (observationAge !== null && observationAge < -5000)
    )
      unavailable("Invalid stake observation clock");
    const completeObservation =
      row.finalized_observed_height !== null &&
      row.finalized_observed_hash !== null &&
      observationAge !== null;
    if (
      !completeObservation &&
      [
        row.finalized_observed_height,
        row.finalized_observed_hash,
        row.finalized_observed_at,
      ].some((value) => value !== null)
    )
      unavailable("Finalized observation is incomplete");
    if (
      completeObservation &&
      BigInt(row.finalized_observed_height!) <
        BigInt(row.stake.state.block_number)
    )
      unavailable("Finalized observation precedes stake state");
    if (
      completeObservation &&
      row.finalized_observed_height === row.stake.state.block_number &&
      row.finalized_observed_hash !== row.stake.state.block_hash
    )
      unavailable("Finalized observation conflicts with stake state");
    const last = entries.data.at(-1);
    const output = V2AccountStakeSchema.safeParse({
      api_version: "2",
      network: row.network,
      snapshot: row.snapshot,
      stake: row.stake,
      account_id: selected.account_id,
      freshness: {
        status: !completeObservation
          ? "unknown"
          : age <= 3600000 && observationAge! <= 30000
            ? "current"
            : "stale",
        age_seconds: Math.max(0, age / 1000),
        finalized_lag_blocks: !completeObservation
          ? null
          : (
              BigInt(row.finalized_observed_height!) -
              BigInt(row.stake.state.block_number)
            ).toString(),
        target_seconds: 3600,
        target_blocks: null,
      },
      entries: entries.data,
      next_cursor:
        row.has_more && last !== undefined
          ? encodeAccountStakeCursor({
              version: 1,
              network: selected.network,
              genesis_hash: row.network.genesis_hash,
              account_id: selected.account_id,
              publication_id: row.stake.publication_id,
              ...accountStakeKey(last),
            })
          : null,
    });
    if (!output.success)
      unavailable("Execution and stake publication evidence differ");
    return output.data;
  };
}
