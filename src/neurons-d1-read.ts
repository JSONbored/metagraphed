// The neurons read tier, against D1 (#9146) — the read half of #9157's write
// path.
//
// #9157 landed the writer and 0007_neurons.sql landed the tables, so the
// neurons family now has a home on Cloudflare. Nothing reads it yet: every
// neurons route still asks the Postgres tier first and, when that misses,
// builds its payload from an empty array. Once the indexer box is wiped that
// miss becomes permanent, so ~26 REST routes plus the MCP and GraphQL surfaces
// over them would serve a schema-stable empty forever. This module is what
// they fall back to instead.
//
// SHAPE, AND WHY IT IS ROWS RATHER THAN PAYLOADS. `tryPostgresTier` returns an
// already-built payload from the DATA_API service binding, but the builders
// that produced it (buildSubnetMetagraph / buildNeuronDetail /
// buildSubnetValidators / buildGlobalValidators, src/metagraph-neurons.ts) are
// pure and already imported by every call site — they are exactly what the
// current `buildSubnetMetagraph([], netuid)` fallback calls. So this module
// returns ROWS and lets each call site run the same builder it already runs.
// That keeps one formatter per payload rather than two implementations that
// have to be kept in step, and it is why a D1-served response is
// indistinguishable from a Postgres-served one.
//
// The column list is `NEURON_INSERT_COLUMNS` — the same list the writer binds
// and the migration declares — so a column added to one without the others
// fails tests/neurons-d1-schema.test.ts rather than silently reading NULLs.
//
// Failure contract is `src/analytics-live.ts`'s, deliberately: a failed read
// degrades to zero rows and bumps a generation counter, so a handler can tell
// "D1 answered with nothing" from "D1 did not answer" and refuse to edge-cache
// the latter as fresh. A transient D1 blip must not pin zeros into the edge.

import { NEURON_INSERT_COLUMNS } from "./metagraph-neurons.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

type Row = Record<string, unknown>;

/** Structural read slice, mirroring analytics-live.ts's ObservationsReadDb so
 * tests can hand in a node:sqlite-backed fake and the real binding both. */
export interface NeuronsReadDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] } | unknown>;
    };
  };
}

let neuronsD1ReadFailureGeneration = 0;

registerModuleStateReset("src/neurons-d1-read.ts", () => {
  neuronsD1ReadFailureGeneration = 0;
});

export function currentNeuronsD1ReadFailureGeneration(): number {
  return neuronsD1ReadFailureGeneration;
}

// Quoted and joined once. Selecting the explicit list rather than `*` keeps
// the read pinned to the writer's contract: a column the migration gained but
// the writer never sends would otherwise silently appear here.
const NEURON_COLUMN_LIST = NEURON_INSERT_COLUMNS.map((c) => `"${c}"`).join(", ");

async function d1All(
  db: NeuronsReadDb | null | undefined,
  sql: string,
  params: unknown[],
): Promise<Row[]> {
  if (!db?.prepare) return [];
  try {
    const outcome = await db
      .prepare(sql)
      .bind(...params)
      .all();
    const rows = Array.isArray(outcome)
      ? outcome
      : (outcome as { results?: unknown[] })?.results;
    return (Array.isArray(rows) ? rows : []) as Row[];
  } catch (error) {
    neuronsD1ReadFailureGeneration += 1;
    console.error("[neurons-d1]", String((error as Error)?.message));
    return [];
  }
}

/**
 * Every live UID on one subnet, ordered by uid.
 *
 * `neurons` is latest-only — the writer upserts on (netuid, uid) and prunes
 * UIDs absent from each snapshot — so there is no per-UID de-duplication to do
 * here and no captured_at filter to apply. Feed straight to
 * buildSubnetMetagraph / buildSubnetValidators.
 */
export async function readSubnetNeurons(
  db: NeuronsReadDb | null | undefined,
  netuid: number,
): Promise<Row[]> {
  return d1All(
    db,
    `SELECT ${NEURON_COLUMN_LIST} FROM neurons WHERE netuid = ? ORDER BY uid ASC`,
    [netuid],
  );
}

/**
 * Only the validator-permitted UIDs on one subnet.
 *
 * A SEPARATE reader rather than a filter over readSubnetNeurons, because
 * `buildSubnetValidators` does NOT filter — it formats whatever rows it is
 * handed. The Postgres tier applied `WHERE validator_permit = true` in SQL, so
 * a D1 leg that reused the unfiltered read would quietly serve every miner as
 * a validator. `validator_permit` is an INTEGER 0/1 with a CHECK
 * (0007_neurons.sql), so `= 1` is exact rather than truthy.
 */
export async function readSubnetValidators(
  db: NeuronsReadDb | null | undefined,
  netuid: number,
): Promise<Row[]> {
  return d1All(
    db,
    `SELECT ${NEURON_COLUMN_LIST} FROM neurons WHERE netuid = ? AND validator_permit = 1 ORDER BY uid ASC`,
    [netuid],
  );
}

/**
 * One UID on one subnet, or null when it does not exist.
 *
 * Returns null rather than an empty row so the caller can pass it straight to
 * buildNeuronDetail, which already distinguishes "no such neuron" from a
 * malformed one.
 */
export async function readNeuron(
  db: NeuronsReadDb | null | undefined,
  netuid: number,
  uid: number,
): Promise<Row | null> {
  const rows = await d1All(
    db,
    `SELECT ${NEURON_COLUMN_LIST} FROM neurons WHERE netuid = ? AND uid = ? LIMIT 1`,
    [netuid, uid],
  );
  return rows[0] ?? null;
}

// NOT INCLUDED: a reader for the cross-subnet leaderboards (/api/v1/validators,
// /api/v1/accounts). Those builders take a `priceByNetuid` map and denominate
// their *_tao columns with it; the empty-payload fallback passes NO_ALPHA_PRICES,
// which is harmless only because it has no rows to price. Handing them real D1
// rows with no price join would publish alpha-denominated numbers under _tao
// field names — precisely the defect #8803 fixed for top-holders and #8945
// tracks for the rest. Those routes need the price join wired first; serving
// them wrong is worse than serving them empty.
