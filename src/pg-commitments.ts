// PostgreSQL implementation of the commitments store (MET-7365): the
// validity-range writer for state.commitments (migration 0061) and the reads
// the commitment routes serve. It is handed the `state` source, whose
// search_path is the schema, so its statements name the tables unqualified.
//
// One capture is one transaction: a transaction-scoped advisory lock
// serializes captures, the observation watermark refuses a block the store
// has already passed, and the changes are computed against the current rows'
// digests read under that lock (src/commitments-capture.ts
// `commitmentChanges`), so a capture reads 32 bytes a row back and writes
// only the pairs the chain moved. Statements carry at most CHUNK rows: the
// first capture opens every pair the chain holds.

import {
  type CommitmentCurrentRow,
  commitmentChanges,
  type CommitmentsSnapshot,
  type CommitmentsWriteOutcome,
} from "./commitments-capture.ts";
import type {
  CommitmentRow,
  CommitmentsObservation,
  CommitmentsStore,
} from "./commitments-store.ts";
import {
  COMMITMENT_HISTORY_LIMIT,
  SUBNET_COMMITMENTS_LIMIT_MAX,
} from "./route-limits.ts";

interface Query {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<T[]>;
}

export interface CommitmentsDatabase {
  transaction<T>(callback: (tx: Query) => Promise<T>): Promise<T>;
  read: Query;
}

/** The key captures serialize on: MET-7365 and migration 0061. */
const CAPTURE_LOCK = 73_650_061;
const FAMILY = "commitments";
/** Rows a statement carries: about 1 MB of JSON. */
export const COMMITMENTS_WRITE_CHUNK = 2_000;

const ROW_COLUMNS =
  "encode(hotkey, 'hex') AS hotkey, valid_from::text AS valid_from, " +
  "valid_to::text AS valid_to, committed_block::text AS committed_block, " +
  "deposit::text AS deposit, fields, reveals";

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += COMMITMENTS_WRITE_CHUNK)
    out.push(rows.slice(i, i + COMMITMENTS_WRITE_CHUNK));
  return out;
}

async function writeSnapshot(
  tx: Query,
  snapshot: CommitmentsSnapshot,
  observedAtMs: number,
): Promise<CommitmentsWriteOutcome> {
  await tx.query("SELECT pg_advisory_xact_lock(?::bigint)", [CAPTURE_LOCK]);
  const marks = await tx.query<{ block_number: string }>(
    "SELECT block_number::text AS block_number FROM observations WHERE family = ?",
    [FAMILY],
  );
  if (marks.some((mark) => Number(mark.block_number) >= snapshot.block))
    return { written: false, opened: 0, closed: 0 };
  const current = await tx.query<CommitmentCurrentRow>(
    "SELECT netuid, encode(hotkey, 'hex') AS hotkey, encode(digest, 'hex') AS digest " +
      "FROM commitments WHERE valid_to IS NULL",
  );
  const changes = commitmentChanges(snapshot, current);
  // Close before open: the partial unique index holds one current row a
  // pair, and the rows a capture replaces must stop being current first.
  for (const rows of chunks(changes.close))
    await tx.query(
      "UPDATE commitments SET valid_to = ? WHERE valid_to IS NULL AND (netuid, hotkey) IN (" +
        "SELECT r.netuid, decode(r.hotkey, 'hex') FROM jsonb_to_recordset(?::jsonb) " +
        "AS r(netuid integer, hotkey text))",
      [snapshot.block, JSON.stringify(rows)],
    );
  for (const rows of chunks(changes.open))
    await tx.query(
      "INSERT INTO commitments (netuid, hotkey, valid_from, committed_block, deposit, " +
        "fields, reveals, digest) SELECT r.netuid, decode(r.hotkey, 'hex'), ?, " +
        "r.committed_block, r.deposit, r.fields, r.reveals, decode(r.digest, 'hex') " +
        "FROM jsonb_to_recordset(?::jsonb) AS r(netuid integer, hotkey text, " +
        "committed_block bigint, deposit numeric, fields jsonb, reveals jsonb, digest text)",
      [snapshot.block, JSON.stringify(rows)],
    );
  await tx.query(
    "INSERT INTO observations (family, block_number, observed_at) " +
      "VALUES (?, ?, to_timestamp(?::double precision / 1000)) " +
      "ON CONFLICT (family) DO UPDATE SET block_number = EXCLUDED.block_number, " +
      "observed_at = EXCLUDED.observed_at",
    [FAMILY, snapshot.block, observedAtMs],
  );
  return {
    written: true,
    opened: changes.open.length,
    closed: changes.close.length,
  };
}

const OBSERVATION_SQL =
  "SELECT block_number::text AS block_number, " +
  "(extract(epoch FROM observed_at) * 1000)::bigint::text AS observed_at_ms " +
  "FROM observations WHERE family = ?";

async function observation(
  read: Query,
): Promise<CommitmentsObservation | null> {
  const [row] = await read.query<CommitmentsObservation>(OBSERVATION_SQL, [
    FAMILY,
  ]);
  return row ?? null;
}

/** The routes' identity bounds, held here too: a store must not widen a
 * lookup into a scan nothing can have asked for. */
function netuidOf(netuid: number): number {
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
    throw new TypeError("Invalid native commitment identity");
  return netuid;
}

export function createPgCommitmentsStore(
  database: CommitmentsDatabase,
): CommitmentsStore {
  return Object.freeze({
    write: (snapshot: CommitmentsSnapshot, observedAtMs: number) =>
      database.transaction((tx) => writeSnapshot(tx, snapshot, observedAtMs)),
    async subnet(netuid: number, page: { limit: number; offset: number }) {
      const id = netuidOf(netuid);
      const limit = Math.min(
        Math.max(Math.trunc(page.limit), 1),
        SUBNET_COMMITMENTS_LIMIT_MAX,
      );
      const offset = Math.max(Math.trunc(page.offset), 0);
      if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset))
        throw new TypeError("Invalid native commitments page");
      const held = await observation(database.read);
      const [count] = await database.read.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM commitments WHERE netuid = ? AND valid_to IS NULL",
        [id],
      );
      const rows = await database.read.query<CommitmentRow>(
        `SELECT ${ROW_COLUMNS} FROM commitments WHERE netuid = ? AND valid_to IS NULL ` +
          "ORDER BY committed_block DESC NULLS LAST, hotkey LIMIT ? OFFSET ?",
        [id, limit, offset],
      );
      return { observation: held, total: count?.total ?? 0, rows };
    },
    async hotkey(netuid: number, hotkey: string) {
      const id = netuidOf(netuid);
      if (!/^[0-9a-f]{64}$/.test(hotkey))
        throw new TypeError("Invalid native commitment identity");
      const held = await observation(database.read);
      const rows = await database.read.query<CommitmentRow>(
        `SELECT ${ROW_COLUMNS} FROM commitments WHERE netuid = ? AND hotkey = decode(?, 'hex') ` +
          "ORDER BY valid_from DESC LIMIT ?",
        [id, hotkey, COMMITMENT_HISTORY_LIMIT],
      );
      return { observation: held, rows };
    },
  });
}
