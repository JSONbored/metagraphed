import { createHash } from "node:crypto";
import { captureUpsertStatements } from "./capture-family-d1.ts";
import { NOMINATOR_POSITION_INSERT_COLUMNS } from "./account-nominator-positions.ts";
import { NOMINATOR_POSITIONS_CONFLICT } from "./nominator-positions-neon-write.ts";
import type { ProducerStatement, ProducerStore } from "./producer-store.ts";

export interface SelfStakeSnapshot {
  captured_at: number;
  scanned_pairs: number;
  total_rows: number;
  total_chunks: number;
  index: number;
}

/** Full-scan metadata is optional for legacy callers. A producer sends it only
 * after every pinned source read succeeds; partial owners keep the old path. */
export function parseSelfStakeSnapshot(
  value: unknown,
  rows: readonly Record<string, unknown>[],
): SelfStakeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid self-stake snapshot metadata");
  const keys = [
    "captured_at",
    "scanned_pairs",
    "total_rows",
    "total_chunks",
    "index",
  ] as const;
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new TypeError("Invalid self-stake snapshot metadata fields");
  const fields = value as SelfStakeSnapshot;
  if (!keys.every((key) => Number.isSafeInteger(fields[key])))
    throw new TypeError("Self-stake snapshot fields must be safe integers");
  if (
    fields.captured_at <= 0 ||
    fields.scanned_pairs <= 0 ||
    fields.scanned_pairs > 10_000_000 ||
    fields.total_rows < 0 ||
    fields.total_rows > fields.scanned_pairs ||
    fields.total_chunks < 1 ||
    fields.total_chunks > 1000 ||
    fields.index < 0 ||
    fields.index >= fields.total_chunks ||
    rows.length > 25_000 ||
    rows.length > fields.total_rows ||
    fields.total_rows > fields.total_chunks * 25_000
  )
    throw new RangeError("Self-stake snapshot exceeds its declared bounds");
  if (
    fields.total_rows === 0
      ? fields.total_chunks !== 1
      : rows.length === 0 || fields.total_chunks > fields.total_rows
  )
    throw new TypeError("Self-stake snapshot has an impossible chunk census");
  if (fields.total_chunks === 1 && fields.total_rows !== rows.length)
    throw new TypeError("Self-stake snapshot row census differs");
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.captured_at !== fields.captured_at)
      throw new TypeError("Self-stake snapshot mixes capture timestamps");
    const key = JSON.stringify([row.coldkey, row.hotkey, row.netuid]);
    if (seen.has(key))
      throw new TypeError("Self-stake snapshot repeats a position");
    seen.add(key);
  }
  return { ...fields };
}

/** Exact receipts, latest rows, source-scoped prune and completion commit in
 * one native transaction. A replay cannot recount a chunk or resurrect rows
 * removed by a newer complete snapshot. Owner ranges make chunk membership
 * disjoint without retaining another copy of every position. */
export async function writeSelfStakeSnapshotD1(
  store: ProducerStore,
  incoming: Record<string, unknown>[],
  supplied: SelfStakeSnapshot,
  nowMs: number,
) {
  const snapshot = parseSelfStakeSnapshot(supplied, incoming);
  const {
    captured_at: at,
    scanned_pairs: scanned,
    total_rows: total,
    total_chunks: chunks,
    index,
  } = snapshot;
  if (!Number.isSafeInteger(nowMs) || nowMs < at)
    throw new TypeError("Self-stake completion precedes its capture timestamp");
  const columns = [...NOMINATOR_POSITION_INSERT_COLUMNS, "source"];
  const rows: Record<string, unknown>[] = incoming.map((row) => ({
    ...row,
    source: "self-stake",
  }));
  const key = (row: Record<string, unknown>) =>
    JSON.stringify([row.coldkey, row.hotkey, row.netuid]);
  const ordered = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        [at, scanned, total, chunks, index],
        ordered.map((row) => columns.map((column) => row[column] ?? null)),
      ]),
    )
    .digest("hex");
  const owners = [...new Set(rows.map((row) => String(row.coldkey)))].sort();
  const first = owners[0] ?? null,
    last = owners.at(-1) ?? null;
  const pending = `EXISTS (SELECT 1 FROM self_stake_snapshot_chunks c JOIN self_stake_snapshot_passes p USING(captured_at)
    WHERE c.captured_at=${at} AND c.batch_index=${index} AND c.sha256='${digest}' AND c.applied=0 AND p.completed_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM self_stake_snapshot_passes WHERE captured_at>${at} AND completed_at IS NOT NULL)`;
  const data = rows.length
    ? captureUpsertStatements(
        {
          table: "nominator_positions",
          columns,
          conflict: NOMINATOR_POSITIONS_CONFLICT,
        },
        rows,
        "nominator_positions.captured_at < excluded.captured_at",
        pending,
      )
    : [];
  const statements: ProducerStatement[] = [
    {
      text: `INSERT INTO self_stake_snapshot_passes(captured_at,scanned_pairs,expected_rows,expected_chunks) VALUES (?,?,?,?)
        ON CONFLICT(captured_at) DO UPDATE SET expected_rows=CASE
        WHEN self_stake_snapshot_passes.scanned_pairs=excluded.scanned_pairs AND self_stake_snapshot_passes.expected_rows=excluded.expected_rows
          AND self_stake_snapshot_passes.expected_chunks=excluded.expected_chunks THEN excluded.expected_rows ELSE NULL END`,
      values: [at, scanned, total, chunks],
    },
    {
      text: `INSERT INTO self_stake_snapshot_chunks(captured_at,batch_index,sha256,row_count,first_owner,last_owner)
        SELECT ?,?,CASE WHEN NOT EXISTS (SELECT 1 FROM self_stake_snapshot_chunks
          WHERE captured_at=? AND batch_index<>? AND first_owner<=? AND last_owner>=?) THEN ? ELSE NULL END,?,?,?
        ON CONFLICT(captured_at,batch_index) DO UPDATE SET sha256=CASE
          WHEN self_stake_snapshot_chunks.sha256=excluded.sha256 THEN excluded.sha256 ELSE NULL END`,
      values: [
        at,
        index,
        at,
        index,
        last,
        first,
        digest,
        rows.length,
        first,
        last,
      ],
    },
    ...data,
    {
      text: `DELETE FROM nominator_positions WHERE source='self-stake' AND ${pending}
        AND coldkey IN (SELECT value FROM json_each(?)) AND captured_at<?`,
      values: [JSON.stringify(owners), at],
    },
    {
      text: `UPDATE self_stake_snapshot_passes SET received_rows=received_rows+?,received_chunks=received_chunks+1
        WHERE captured_at=? AND EXISTS (SELECT 1 FROM self_stake_snapshot_chunks WHERE captured_at=? AND batch_index=? AND sha256=? AND applied=0)`,
      values: [rows.length, at, at, index, digest],
    },
    {
      text: "UPDATE self_stake_snapshot_chunks SET applied=1 WHERE captured_at=? AND batch_index=? AND sha256=?",
      values: [at, index, digest],
    },
    {
      text: `DELETE FROM nominator_positions WHERE source='self-stake' AND captured_at<? AND EXISTS (
        SELECT 1 FROM self_stake_snapshot_passes WHERE captured_at=? AND completed_at IS NULL AND received_rows=expected_rows AND received_chunks=expected_chunks)`,
      values: [at, at],
    },
    {
      text: `UPDATE self_stake_snapshot_passes SET completed_at=? WHERE captured_at=? AND completed_at IS NULL
        AND received_rows=expected_rows AND received_chunks=expected_chunks`,
      values: [nowMs, at],
    },
  ];
  if (statements.length > 900)
    throw new RangeError("Self-stake snapshot exceeds atomic statement budget");
  const applied = await store.transaction(statements);
  const receipt = await store.first<{
    sha256: string;
    applied: number;
    received_rows: number;
    received_chunks: number;
    completed_at: number | null;
  }>(
    `SELECT c.sha256,c.applied,p.received_rows,p.received_chunks,p.completed_at
      FROM self_stake_snapshot_chunks c JOIN self_stake_snapshot_passes p USING(captured_at) WHERE c.captured_at=? AND c.batch_index=?`,
    [at, index],
  );
  if (!receipt || receipt.sha256 !== digest || receipt.applied !== 1)
    throw new Error("Self-stake snapshot chunk was not durably acknowledged");
  return {
    attempted: true,
    write: { ok: true, rows: incoming.length, statements: data.length },
    prune: { ok: true, rows: owners.length, statements: 1 },
    snapshot: {
      ok: true,
      rows: 1,
      statements: statements.length - data.length,
      ...snapshot,
      sha256: digest,
      received_rows: receipt.received_rows,
      received_chunks: receipt.received_chunks,
      completed_at: receipt.completed_at,
      complete: receipt.completed_at !== null,
      positions_retired: applied.at(-2)!.changes,
    },
  };
}
