// PostgreSQL implementation of the subnet emission store (MET-7365): the
// validity-range writer for state.subnet_emission_splits and
// state.subnet_lifecycle_states (migration 0060), and the reads the emission
// split routes serve. It is handed the `state` source, whose search_path is
// the schema, so its statements name the tables unqualified.
//
// One capture is one transaction: a transaction-scoped advisory lock
// serializes captures, the observation watermark refuses a block the store
// has already passed, and the changes are computed against the current rows
// read under that lock (src/subnet-emission-capture.ts
// `subnetEmissionChanges`). Parts cross as text both ways: they exceed
// JavaScript's safe integers.

import {
  type LifecycleRow,
  type SplitRow,
  type SubnetEmissionSnapshot,
  type SubnetEmissionWriteOutcome,
  subnetEmissionChanges,
} from "./subnet-emission-capture.ts";
import type {
  Ranged,
  SubnetEmissionHistory,
  SubnetEmissionStore,
} from "./subnet-emission-store.ts";

interface Transaction {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<T[]>;
}

export interface SubnetEmissionDatabase {
  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T>;
  read: {
    query<T = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<T[]>;
  };
}

/** The key captures serialize on: any constant the deployment does not
 * already lock with. MET-7365 and migration 0060. */
const CAPTURE_LOCK = 73_650_060;
/** The most history rows a route reads for one subnet and family. */
export const SUBNET_EMISSION_HISTORY_LIMIT = 100;

const FAMILIES = ["subnet_emission_splits", "subnet_lifecycle_states"];

const SPLIT_COLUMNS =
  "netuid, burn_parts::text AS burn_parts, recycle_parts::text AS recycle_parts, " +
  "owner_parts::text AS owner_parts, validator_parts::text AS validator_parts, " +
  "miner_parts::text AS miner_parts, gamma_shares";
const LIFECYCLE_COLUMNS = "netuid, stage, epoch_consensus, created_via_lease";
const RANGE_COLUMNS =
  "valid_from::text AS valid_from, valid_to::text AS valid_to";

async function writeSnapshot(
  tx: Transaction,
  snapshot: SubnetEmissionSnapshot,
  observedAtMs: number,
): Promise<SubnetEmissionWriteOutcome> {
  await tx.query("SELECT pg_advisory_xact_lock(?::bigint)", [CAPTURE_LOCK]);
  const marks = await tx.query<{ block_number: string }>(
    "SELECT block_number::text AS block_number FROM observations WHERE family IN (?, ?)",
    FAMILIES,
  );
  if (marks.some((mark) => Number(mark.block_number) >= snapshot.block))
    return { written: false, opened: 0, closed: 0 };
  const [splits, lifecycle] = [
    await tx.query<SplitRow>(
      `SELECT ${SPLIT_COLUMNS} FROM subnet_emission_splits WHERE valid_to IS NULL`,
    ),
    await tx.query<LifecycleRow>(
      `SELECT ${LIFECYCLE_COLUMNS} FROM subnet_lifecycle_states WHERE valid_to IS NULL`,
    ),
  ];
  const changes = subnetEmissionChanges(snapshot, { splits, lifecycle });
  const close = async (table: string, netuids: number[]) => {
    if (netuids.length === 0) return;
    await tx.query(
      `UPDATE ${table} SET valid_to = ? WHERE valid_to IS NULL AND netuid IN (` +
        "SELECT value::integer FROM jsonb_array_elements_text(?::jsonb))",
      [snapshot.block, JSON.stringify(netuids)],
    );
  };
  // Close before open: the partial unique index holds one current row a
  // subnet, and the rows a capture replaces must stop being current first.
  await close("subnet_emission_splits", changes.closeSplits);
  await close("subnet_lifecycle_states", changes.closeLifecycle);
  if (changes.openSplits.length > 0)
    await tx.query(
      "INSERT INTO subnet_emission_splits (netuid, valid_from, burn_parts, recycle_parts, " +
        "owner_parts, validator_parts, miner_parts, gamma_shares) " +
        "SELECT r.netuid, ?, r.burn_parts, r.recycle_parts, r.owner_parts, " +
        "r.validator_parts, r.miner_parts, r.gamma_shares FROM jsonb_to_recordset(?::jsonb) " +
        "AS r(netuid integer, burn_parts numeric, recycle_parts numeric, owner_parts numeric, " +
        "validator_parts numeric, miner_parts numeric, gamma_shares jsonb)",
      [snapshot.block, JSON.stringify(changes.openSplits)],
    );
  if (changes.openLifecycle.length > 0)
    await tx.query(
      "INSERT INTO subnet_lifecycle_states (netuid, valid_from, stage, epoch_consensus, " +
        "created_via_lease) SELECT r.netuid, ?, r.stage, r.epoch_consensus, " +
        "r.created_via_lease FROM jsonb_to_recordset(?::jsonb) AS r(netuid integer, " +
        "stage text, epoch_consensus text, created_via_lease boolean)",
      [snapshot.block, JSON.stringify(changes.openLifecycle)],
    );
  await tx.query(
    "INSERT INTO observations (family, block_number, observed_at) " +
      "SELECT family, ?, to_timestamp(?::double precision / 1000) " +
      "FROM unnest(ARRAY[?, ?]::text[]) AS family " +
      "ON CONFLICT (family) DO UPDATE SET block_number = EXCLUDED.block_number, " +
      "observed_at = EXCLUDED.observed_at",
    [snapshot.block, observedAtMs, ...FAMILIES],
  );
  return {
    written: true,
    opened: changes.openSplits.length + changes.openLifecycle.length,
    closed: changes.closeSplits.length + changes.closeLifecycle.length,
  };
}

/** The watermark both families share: the older of the two, so a reader is
 * never told the state is newer than the family that lags. */
const OBSERVATION_SQL =
  "SELECT min(block_number)::text AS block_number, " +
  "(extract(epoch FROM min(observed_at)) * 1000)::bigint::text AS observed_at_ms, " +
  "count(*)::integer AS families FROM observations";

type ObservationRow = {
  block_number: string | null;
  observed_at_ms: string | null;
  families: number;
};

function observationOf(rows: readonly ObservationRow[]) {
  const row = rows[0];
  // Both families or neither: one alone is a store mid-migration.
  if (!row || row.families !== FAMILIES.length || row.block_number === null)
    return null;
  return {
    block_number: row.block_number,
    observed_at_ms: row.observed_at_ms,
  };
}

export function createPgSubnetEmissionStore(
  database: SubnetEmissionDatabase,
): SubnetEmissionStore {
  return Object.freeze({
    write: (snapshot: SubnetEmissionSnapshot, observedAtMs: number) =>
      database.transaction((tx) => writeSnapshot(tx, snapshot, observedAtMs)),
    async current() {
      const [observation, splits, lifecycle] = [
        observationOf(
          await database.read.query<ObservationRow>(OBSERVATION_SQL),
        ),
        await database.read.query<Ranged<SplitRow>>(
          `SELECT ${SPLIT_COLUMNS}, ${RANGE_COLUMNS} FROM subnet_emission_splits ` +
            "WHERE valid_to IS NULL ORDER BY netuid",
        ),
        await database.read.query<Ranged<LifecycleRow>>(
          `SELECT ${LIFECYCLE_COLUMNS}, ${RANGE_COLUMNS} FROM subnet_lifecycle_states ` +
            "WHERE valid_to IS NULL ORDER BY netuid",
        ),
      ];
      return { observation, splits, lifecycle };
    },
    async subnet(netuid: number): Promise<SubnetEmissionHistory> {
      // Same identity bound the routes enforce: a netuid is a u16, and a store
      // must not widen a lookup into a scan nothing can have asked for.
      if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
        throw new TypeError("Invalid native subnet emission identity");
      const [observation, splits, lifecycle] = [
        observationOf(
          await database.read.query<ObservationRow>(OBSERVATION_SQL),
        ),
        await database.read.query<Ranged<SplitRow>>(
          `SELECT ${SPLIT_COLUMNS}, ${RANGE_COLUMNS} FROM subnet_emission_splits ` +
            "WHERE netuid = ? ORDER BY valid_from DESC LIMIT ?",
          [netuid, SUBNET_EMISSION_HISTORY_LIMIT],
        ),
        await database.read.query<Ranged<LifecycleRow>>(
          `SELECT ${LIFECYCLE_COLUMNS}, ${RANGE_COLUMNS} FROM subnet_lifecycle_states ` +
            "WHERE netuid = ? ORDER BY valid_from DESC LIMIT ?",
          [netuid, SUBNET_EMISSION_HISTORY_LIMIT],
        ),
      ];
      return { observation, splits, lifecycle };
    },
  });
}
