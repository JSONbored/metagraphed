// The runtime-upgrade timeline, read from the Iceberg lakehouse.
//
// /api/v1/runtime, `get_runtime` and GraphQL's `runtime` all ran the same
// `tryPostgresTier(METAGRAPH_BLOCKS_SOURCE) ?? buildRuntimeVersionHistory([])`
// fallback, and with the Postgres tier gone every one of them published the
// empty history: `transitions: []`, `transition_count: 0`,
// `current_spec_version: null` — beside a `current` block that reported spec
// 440 from a live chain read. The data never went anywhere; only its reader
// did. `chain.blocks` carries the same `spec_version` column the retired D1
// tier did.
//
// It carries it far better, and that is worth stating precisely, because the
// module docstring on runtime-versions.ts describes a coverage disaster that
// no longer applies. That caveat is about the RETIRED tier: `spec_version`
// arrived there via a nullable ALTER (migration 0017) that was never
// back-filled, so readings clustered at the two ends of the chain and the
// endpoint served 23 transitions against roughly 200 real ones. The lakehouse
// was written by the full genesis→head backfill instead. Measured against it
// on 2026-08-03:
//
//   total blocks   8,763,321
//   with spec_version  8,763,321   (zero nulls)
//   transitions          147       (spec 101 → 440, from block 0)
//
// So the interior holes the gap detector exists to expose are, for this tier,
// genuinely absent — and `coverage_complete` finally means what it says
// instead of being true only because an empty timeline has no gaps in it.
import { r2SqlQuery } from "./r2-sql.ts";
import { buildRuntimeVersionHistory } from "./runtime-versions.ts";

// One row per distinct spec_version: the earliest block that carried that
// reading, sorted into a single ascending timeline. Identical in shape to the
// SQL the D1 tier ran (RUNTIME_TRANSITIONS_SQL) — GROUP BY, MIN() and ORDER BY
// all behave the same here, so this is a change of tier, not of question.
//
// No interpolation: the query takes no caller input at all, so unlike the
// event rollups there is no identifier to validate. /api/v1/runtime accepts
// only `format`, which never reaches SQL.
const TRANSITIONS_SQL =
  "SELECT spec_version, MIN(block_number) AS block_number," +
  " MIN(observed_at) AS observed_at" +
  " FROM chain.blocks WHERE spec_version IS NOT NULL" +
  " GROUP BY spec_version ORDER BY block_number ASC";

// The truly-latest block, queried separately rather than read off the last
// transition. The GROUP BY above collapses every occurrence of a spec_version
// into its EARLIEST block, so after a runtime rollback — a version reappearing
// once a newer one had already been seen — the final transition entry would be
// the superseded version. `current_spec_version` has to come from the head of
// the chain. Same reason the D1 tier queried it separately.
const LATEST_SQL =
  "SELECT spec_version, block_number FROM chain.blocks" +
  " WHERE spec_version IS NOT NULL ORDER BY block_number DESC LIMIT 1";

/**
 * The runtime-upgrade history from the lakehouse, already built into the
 * response shape — or null when the lakehouse cannot answer.
 *
 * Declining rather than returning the empty history is the point: every caller
 * already has its own zeroed fallback, and a built-but-empty timeline coming
 * back from here would be indistinguishable from "this chain has never
 * upgraded". A `transitions: []` that reads as measured fact is the exact
 * failure this route was already shipping.
 */
export async function loadRuntimeVersionHistoryColdTier(
  env: Parameters<typeof r2SqlQuery>[0],
  { query = r2SqlQuery }: { query?: typeof r2SqlQuery } = {},
): Promise<ReturnType<typeof buildRuntimeVersionHistory> | null> {
  const [rows, latestRows] = await Promise.all([
    query(env, TRANSITIONS_SQL),
    query(env, LATEST_SQL),
  ]);
  if (!rows || !latestRows) return null;
  if (rows.length === 0) return null;
  // A missing head row is not fatal on its own: the timeline is still the
  // truth, and the builder already publishes a null current_spec_version. It
  // is passed as null rather than defaulted to the last transition, which
  // would reintroduce the rollback bug the separate query exists to avoid.
  return buildRuntimeVersionHistory(rows, latestRows[0] ?? null);
}
