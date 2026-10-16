import { z } from "zod";
import { ALPHA_GENESIS, ALPHA_RUNTIMES } from "./alpha-runtime-identity.ts";
import { ALPHA_RECEIVER_OWNER_TABLES } from "./alpha-capture-reader.ts";
import { selectedD1Store } from "./d1-store.ts";
import type { ProducerStore, ProducerStatement } from "./producer-store.ts";

const count = (max = Number.MAX_SAFE_INTEGER) =>
  z.number().int().min(0).max(max);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
export const alphaCountAnchorSchema = z
  .strictObject({
    captured_at: count().positive(),
    block_number: count(0xffffffff),
    block_hash: hash,
    genesis_hash: z.literal(ALPHA_GENESIS),
    spec_version: z.union([z.literal(454), z.literal(478), z.literal(479)]),
    code_hash: hash,
    metadata_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    scanned_legacy: count(1_000_000),
    scanned_v2: count(1_000_000),
    distinct_members: count(2_000_000),
    excluded_root_members: count(2_000_000),
  })
  .refine((s) => {
    const runtime = ALPHA_RUNTIMES[s.spec_version];
    return (
      s.code_hash === runtime.code &&
      s.metadata_sha256 === runtime.metadata &&
      s.distinct_members >= Math.max(s.scanned_legacy, s.scanned_v2) &&
      s.distinct_members <= s.scanned_legacy + s.scanned_v2 &&
      s.excluded_root_members <= s.distinct_members &&
      (s.spec_version !== 479 ||
        (s.scanned_legacy === 0 && s.distinct_members === s.scanned_v2))
    );
  });
export type AlphaCountAnchor = z.infer<typeof alphaCountAnchorSchema>;

export function alphaCountPassTotal(anchor: AlphaCountAnchor, value: unknown) {
  const total = count(5_000_000).parse(value);
  if (
    total > anchor.distinct_members ||
    (total === 0) !== (anchor.distinct_members === 0)
  )
    throw new TypeError("Alpha count total contradicts the raw member census");
  return total;
}

export function alphaCountsOwnerStore(env: unknown) {
  return selectedD1Store(env, [
    ...ALPHA_RECEIVER_OWNER_TABLES,
    "validator_nominator_counts",
    "validator_nominator_counts_passes",
  ]);
}

/** Old schema compatibility ends when the first canonical Alpha pass exists. */
export async function alphaCountsNeedAnchor(env: unknown) {
  const store =
    selectedD1Store(env, ["nominator_positions"]) ??
    selectedD1Store(env, ["validator_nominator_counts"]);
  if (!store) return false;
  const schema = await store.first(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='alpha_snapshot_passes'",
  );
  if (!schema) return false;
  return Boolean(
    await store.first(
      "SELECT 1 FROM alpha_snapshot_passes WHERE selected=1 LIMIT 1",
    ),
  );
}

export const CURRENT_ALPHA_CAPTURE_SQL =
  "SELECT * FROM alpha_snapshot_passes WHERE selected=1 " +
  "ORDER BY block_number DESC,captured_at DESC LIMIT 1";

/** Compare every field in the immutable capture, including its raw census. */
function anchorPredicate(anchor: AlphaCountAnchor) {
  const entries = Object.entries(anchor);
  return {
    text: entries.map(([key]) => `p.${key}=?`).join(" AND "),
    values: entries.map(([, value]) => value),
  };
}

function assertion(text: string, values: unknown[]): ProducerStatement {
  // A failed assertion aborts the entire native batch, including its receipt.
  return {
    text: `SELECT CASE WHEN (${text}) THEN 1 ELSE json('Alpha count fence failed') END`,
    values,
  };
}

/** Keep every native binding within the ledger's 512 KiB budget. The three
 * validated scalar fields bound each individual row; unrelated input fields
 * never enter SQLite. All pieces still commit in one transaction. */
function countJsonPieces(rows: Record<string, unknown>[]): string[] {
  const encoder = new TextEncoder();
  const pieces: string[] = [];
  let batch: string[] = [];
  let bytes = 2;
  let total = 2;
  for (const [index, row] of rows.entries()) {
    const encoded = JSON.stringify({
      hotkey: row.hotkey,
      nominator_count: row.nominator_count,
      captured_at: row.captured_at,
    });
    const size = encoder.encode(encoded).byteLength;
    total += size + (index ? 1 : 0);
    if (total > 8_000_000)
      throw new RangeError("Alpha count rows exceed the request byte budget");
    if (batch.length && bytes + size + 1 > 512 * 1024) {
      pieces.push(`[${batch.join(",")}]`);
      batch = [];
      bytes = 2;
    }
    bytes += size + (batch.length ? 1 : 0);
    batch.push(encoded);
  }
  if (batch.length) pieces.push(`[${batch.join(",")}]`);
  return pieces;
}

/** A transport ACK is admission only. This receipt observes actual native rows. */
export async function readAlphaCountStatusD1(
  store: ProducerStore,
  input: AlphaCountAnchor,
  expectedRows?: number,
) {
  const anchor = alphaCountAnchorSchema.parse(input);
  if (expectedRows !== undefined) alphaCountPassTotal(anchor, expectedRows);
  const predicate = anchorPredicate(anchor);
  const identity = JSON.stringify(anchor);
  const row = await store.first<{
    current: number;
    pass_total: number | null;
    applied_count: number;
    completed_at: number | null;
    complete: number;
  }>(
    `WITH current AS (${CURRENT_ALPHA_CAPTURE_SQL}), receipt AS
      (SELECT * FROM validator_nominator_counts_passes WHERE captured_at=? AND alpha_snapshot=?),
    totals AS MATERIALIZED (SELECT COUNT(*) AS applied_count,
      COALESCE(SUM(nominator_count),0) AS member_pairs
      FROM validator_nominator_counts WHERE captured_at=?)
    SELECT EXISTS(SELECT 1 FROM current p WHERE ${predicate.text}) AS current,
      (SELECT expected_rows FROM receipt) AS pass_total,
      (SELECT applied_count FROM totals) AS applied_count,
      (SELECT completed_at FROM receipt) AS completed_at,
      EXISTS(SELECT 1 FROM receipt WHERE completed_at>0 AND received_rows=expected_rows
        AND expected_rows=(SELECT applied_count FROM totals)
        AND (SELECT member_pairs FROM totals) BETWEEN ? AND ?) AS complete`,
    [
      anchor.captured_at,
      identity,
      anchor.captured_at,
      ...predicate.values,
      anchor.excluded_root_members,
      anchor.distinct_members,
    ],
  );
  if (
    !row ||
    (expectedRows !== undefined &&
      row.pass_total !== null &&
      row.pass_total !== expectedRows)
  )
    throw new TypeError("Alpha count receipt declaration differs");
  return {
    ok: true,
    stores: ["d1"],
    alpha_snapshot: anchor,
    pass_total: row.pass_total ?? expectedRows ?? null,
    applied_count: row.applied_count,
    completed_at: row.completed_at,
    complete: row.complete === 1,
    current: row.current === 1,
  };
}

/** Counts and their terminal receipt share the canonical capture's native owner.
 * Counting actual unique hotkeys makes HTTP and queue retries idempotent. */
export async function writeAlphaCountsD1(
  store: ProducerStore,
  rows: Record<string, unknown>[],
  input: AlphaCountAnchor,
  expectedRows: number,
  nowMs: number,
) {
  const anchor = alphaCountAnchorSchema.parse(input);
  alphaCountPassTotal(anchor, expectedRows);
  if (
    rows.length > 50_000 ||
    rows.length > expectedRows ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0 ||
    rows.some(
      (row) =>
        row.captured_at !== anchor.captured_at ||
        typeof row.hotkey !== "string" ||
        !row.hotkey ||
        new TextEncoder().encode(row.hotkey).byteLength > 128 ||
        !Number.isSafeInteger(row.nominator_count) ||
        Number(row.nominator_count) < 0,
    ) ||
    new Set(rows.map((row) => row.hotkey)).size !== rows.length
  )
    throw new TypeError("Invalid anchored Alpha count rows or declaration");
  const identity = JSON.stringify(anchor);
  const predicate = anchorPredicate(anchor);
  const pieces = countJsonPieces(rows);
  const statements: ProducerStatement[] = [
    assertion(
      `EXISTS(SELECT 1 FROM (${CURRENT_ALPHA_CAPTURE_SQL}) p WHERE ${predicate.text}
        AND p.completed_at IS NOT NULL)
      AND ?>=(SELECT COUNT(DISTINCT hotkey) FROM alpha_snapshot_rows WHERE captured_at=?)
      AND NOT EXISTS(SELECT 1 FROM validator_nominator_counts_passes WHERE captured_at=?
        AND (alpha_snapshot IS NOT ? OR expected_rows<>?))
      AND NOT EXISTS(SELECT 1 FROM validator_nominator_counts WHERE captured_at=?
        AND NOT EXISTS(SELECT 1 FROM validator_nominator_counts_passes WHERE captured_at=?))`,
      [
        ...predicate.values,
        expectedRows,
        anchor.captured_at,
        anchor.captured_at,
        identity,
        expectedRows,
        anchor.captured_at,
        anchor.captured_at,
      ],
    ),
    {
      text: `INSERT INTO validator_nominator_counts_passes
        (captured_at,expected_rows,received_rows,completed_at,alpha_snapshot) VALUES(?,?,0,NULL,?)
        ON CONFLICT(captured_at) DO NOTHING`,
      values: [anchor.captured_at, expectedRows, identity],
    },
  ];
  for (const encoded of pieces) {
    statements.push(
      assertion(
        `NOT EXISTS(SELECT 1 FROM json_each(?) r JOIN validator_nominator_counts c
        ON c.hotkey=json_extract(r.value,'$.hotkey') AND c.captured_at=?
        WHERE c.nominator_count IS NOT json_extract(r.value,'$.nominator_count'))
      AND NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE
        json_extract(r.value,'$.nominator_count') NOT BETWEEN 1 AND ?
        OR json_extract(r.value,'$.nominator_count')<(SELECT COUNT(DISTINCT coldkey)
          FROM alpha_snapshot_rows WHERE captured_at=? AND hotkey=json_extract(r.value,'$.hotkey')))`,
        [
          encoded,
          anchor.captured_at,
          encoded,
          anchor.distinct_members,
          anchor.captured_at,
        ],
      ),
      {
        text: `INSERT INTO validator_nominator_counts(hotkey,nominator_count,captured_at)
        SELECT json_extract(value,'$.hotkey'),json_extract(value,'$.nominator_count'),?
        FROM json_each(?) WHERE true ON CONFLICT(hotkey) DO UPDATE SET
        nominator_count=excluded.nominator_count,captured_at=excluded.captured_at`,
        values: [anchor.captured_at, encoded],
      },
    );
  }
  statements.push(
    assertion(
      `WITH known AS (SELECT hotkey,COUNT(DISTINCT coldkey) AS n FROM alpha_snapshot_rows
        WHERE captured_at=? GROUP BY hotkey), actual AS
        (SELECT * FROM validator_nominator_counts WHERE captured_at=?)
      SELECT COUNT(*)<=? AND COALESCE(SUM(a.nominator_count-COALESCE(k.n,0)),0)<=?
        AND (COUNT(*)<? OR (COALESCE(SUM(a.nominator_count),0)>=?
          AND NOT EXISTS(SELECT 1 FROM known k
            WHERE NOT EXISTS(SELECT 1 FROM actual WHERE hotkey=k.hotkey))))
      FROM actual a LEFT JOIN known k USING(hotkey)`,
      [
        anchor.captured_at,
        anchor.captured_at,
        expectedRows,
        anchor.excluded_root_members,
        expectedRows,
        anchor.excluded_root_members,
      ],
    ),
    {
      text: `UPDATE validator_nominator_counts_passes SET
        received_rows=(SELECT COUNT(*) FROM validator_nominator_counts WHERE captured_at=?),
        completed_at=COALESCE(completed_at,CASE WHEN expected_rows=
          (SELECT COUNT(*) FROM validator_nominator_counts WHERE captured_at=?) THEN ? END)
        WHERE captured_at=? AND alpha_snapshot=?`,
      values: [
        anchor.captured_at,
        anchor.captured_at,
        nowMs,
        anchor.captured_at,
        identity,
      ],
    },
  );
  await store.transaction(statements);
  return readAlphaCountStatusD1(store, anchor, expectedRows);
}
