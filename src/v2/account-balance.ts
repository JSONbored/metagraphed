import { z } from "zod";
import {
  V2AccountBalanceInputSchema,
  V2AccountBalanceSchema,
} from "../../schemas-src/v2/balance.ts";
import {
  V2HashSchema,
  V2HeightSchema,
  V2NetworkSchema,
  V2SnapshotSchema,
  V2TimestampSchema,
} from "../../schemas-src/v2/primitives.ts";
import {
  V2OperationError,
  v2FinalizedFreshness,
  type V2QueryExecutor,
} from "./shared.ts";

// Point observations have independent membership. Filter this exact account
// before choosing its newest publication, never a network-wide generation.
const sql = `WITH chosen AS MATERIALIZED (
  SELECT e.*,n.finalized_observed_height,n.finalized_observed_hash,n.finalized_observed_at,
    b.spec_version,b.transaction_version,cp.producer_revision AS execution_revision,
    cp.observed_at AS execution_observed_at,cp.published_at AS execution_published_at
  FROM chain.eligible_account_balance_observations e
  JOIN chain.networks n ON n.network_id=e.network_id
  JOIN chain.blocks b ON b.network_id=e.network_id AND b.block_number=e.block_number
    AND b.block_hash=e.state_block_hash AND b.parent_hash=e.block_parent_hash AND b.metadata_digest=e.block_metadata_digest
  JOIN chain.block_publications v ON v.publication_id=e.block_publication_id AND v.network_id=e.network_id AND v.block_number=e.block_number
  JOIN ops.publications cp ON cp.publication_id=v.publication_id AND cp.network_id=v.network_id AND cp.scope='blocks' AND cp.stage='published'
  WHERE e.network_id=$1 AND e.account_id=$2 AND ($3::text IS NULL OR e.publication_id=$3)
  ORDER BY e.block_number DESC,e.generation DESC,e.publication_id COLLATE "C" LIMIT 1
)
SELECT jsonb_build_object('id',c.network_id,'genesis_hash',c.genesis_hash) AS network,
  jsonb_build_object('block_number',c.block_number::text,'block_hash',c.state_block_hash,'parent_hash',c.block_parent_hash,
    'metadata_digest',c.block_metadata_digest,'spec_version',c.spec_version,'transaction_version',c.transaction_version,
    'producer_revision',c.execution_revision,'publication_id',c.block_publication_id,'observed_at',c.execution_observed_at,'published_at',c.execution_published_at) AS snapshot,
  jsonb_build_object('publication_id',c.publication_id,'generation',c.generation::text,'request_id',c.request_id,'observation_id',c.observation_id,
    'projection_contract',c.projection_contract,'decoder_revision',c.decoder_revision,'profile_revision',c.profile_revision,'upstream_revision',c.upstream_revision,
    'block_publication_id',c.block_publication_id,'observed_at',c.observed_at,'published_at',c.published_at,'lookup_scope',c.lookup_scope,'unit',c.unit,
    'qualification',c.qualification,'state_proof_verified',c.state_proof_verified,'runtime_semantics_attested',c.runtime_semantics_attested,
    'state',jsonb_build_object('snapshot_id',c.snapshot_id,'block_number',c.block_number::text,'block_hash',c.state_block_hash,
      'metadata_digest',c.state_metadata_digest,'spec_version',c.state_spec_version,'transaction_version',c.state_transaction_version,
      'producer_revision',c.state_producer_revision,'observed_at',c.observed_at)) AS balance,
  CASE c.status WHEN 'stored' THEN jsonb_build_object('status',c.status,'account',c.account_info)
    WHEN 'not_stored' THEN jsonb_build_object('status',c.status,'runtime_default',c.account_info) ELSE NULL END AS result,
  c.finalized_observed_height::text,c.finalized_observed_hash,c.finalized_observed_at
FROM chosen c`;

const timestamp = z
  .union([z.date(), V2TimestampSchema])
  .transform((value) => new Date(value).toISOString());
const rowSchema = z.object({
  network: V2NetworkSchema,
  snapshot: V2SnapshotSchema,
  balance: V2AccountBalanceSchema.shape.balance,
  result: V2AccountBalanceSchema.shape.result,
  finalized_observed_height: V2HeightSchema.nullable(),
  finalized_observed_hash: V2HashSchema.nullable(),
  finalized_observed_at: timestamp.nullable(),
});
function unavailable(message: string): never {
  throw new V2OperationError("data_unavailable", message);
}

export function createV2AccountBalanceOperation(
  executor: V2QueryExecutor,
  now: () => Date,
) {
  return async function get_account_balance(input: unknown) {
    const parsed = V2AccountBalanceInputSchema.safeParse(input);
    if (!parsed.success)
      throw new V2OperationError(
        "invalid_input",
        "Invalid account balance selection",
      );
    const selected = parsed.data;
    let rows: unknown[];
    try {
      ({ rows } = await executor.query(sql, [
        selected.network,
        selected.account_id,
        selected.publication_id ?? null,
      ]));
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        ["42P01", "42703"].includes(String(error.code))
      )
        unavailable("The account balance read contract is unavailable");
      throw error;
    }
    if (rows.length !== 1)
      unavailable("No eligible exact account observation is available");
    const parsedRow = rowSchema.safeParse(rows[0]);
    if (!parsedRow.success)
      unavailable("Published account balance evidence is invalid");
    const row = parsedRow.data;
    const account =
      row.result.status === "stored"
        ? row.result.account
        : row.result.runtime_default;
    if (
      row.network.id !== selected.network ||
      account.account_id !== selected.account_id ||
      (selected.publication_id !== undefined &&
        row.balance.publication_id !== selected.publication_id)
    )
      unavailable("Account balance publication or account identity differs");
    const observedNow = now();
    if (
      [
        row.balance.published_at,
        row.snapshot.observed_at,
        row.snapshot.published_at,
      ].some((value) => Date.parse(value) > observedNow.getTime() + 5000)
    )
      unavailable("Invalid account balance publication clock");
    const output = V2AccountBalanceSchema.safeParse({
      api_version: "2",
      network: row.network,
      snapshot: row.snapshot,
      account_id: selected.account_id,
      balance: row.balance,
      result: row.result,
      freshness: v2FinalizedFreshness(
        { ...row.balance.state, ...row },
        observedNow,
      ),
    });
    if (!output.success)
      unavailable(
        "Account balance state and captured execution evidence differ",
      );
    return output.data;
  };
}
