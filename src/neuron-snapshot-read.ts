// Full-network directory reads must walk each metric document once (#12197).
// The point-read neurons view intentionally starts with indexed membership,
// but expanding the same large document for every member makes a full snapshot
// quadratic in each shard. CROSS JOIN fixes the document -> entry -> primary
// membership lookup order; an ordinary JOIN lets SQLite reverse it again.
import { selectedD1Store } from "./d1-store.ts";
import type { PgSql } from "./pg-sql.ts";

interface NeuronDirectoryRow extends Record<string, unknown> {
  // Both statements exclude NULL hotkeys before returning rows.
  hotkey: string;
}

export async function readNeuronDirectoryRows(
  sql: PgSql,
  env: unknown,
  validatorsOnly = false,
): Promise<NeuronDirectoryRow[]> {
  const metrics = validatorsOnly
    ? [
        "validator_trust",
        "emission_tao",
        "stake_tao",
        "block_number",
        "captured_at",
        "take",
      ]
    : [
        "validator_permit",
        "emission_tao",
        "stake_tao",
        "block_number",
        "captured_at",
      ];
  const store = selectedD1Store(env, ["neurons"]);
  if (store) {
    return store.query(`SELECT m.netuid, m.uid, m.hotkey, m.coldkey,
      ${metrics.map((column) => `json_extract(j.value,'$.${column}') AS ${column}`).join(", ")}
      FROM neurons_documents d
      CROSS JOIN json_each(d.payload) j
      CROSS JOIN neurons_members m
      WHERE d.day = '' AND m.netuid = d.netuid
        AND m.uid = CAST(j.key AS INTEGER) AND m.shard = d.shard
        AND m.hotkey IS NOT NULL
        ${validatorsOnly ? "AND json_extract(j.value,'$.validator_permit') = TRUE" : ""}
      ORDER BY m.hotkey ASC, stake_tao DESC, m.netuid ASC, m.uid ASC`);
  }
  return sql.unsafe(`SELECT netuid, uid, hotkey, coldkey, ${metrics.join(", ")}
    FROM neurons WHERE ${validatorsOnly ? "validator_permit = TRUE AND " : ""}hotkey IS NOT NULL
    ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC`);
}

interface DirectoryNominatorRow extends Record<string, unknown> {
  hotkey: string;
  nominator_count: number | null;
  scan_at: number | null;
}

// A partial pass can still exceed the lifecycle lane's netuid coverage floor.
// Delivery counters may include retries, so require both a completed receipt
// and exactly its expected number of distinct current memberships. Never use
// an older complete receipt to certify a newer, incomplete snapshot.
export async function readCompleteNeuronRows(
  env: unknown,
): Promise<Record<string, unknown>[] | null> {
  const store = selectedD1Store(env, ["neurons", "neurons_passes"]);
  if (!store) return null;
  return store.query(`WITH current AS MATERIALIZED (
    SELECT m.netuid, json_extract(j.value,'$.captured_at') AS captured_at,
      json_extract(j.value,'$.block_number') AS block_number
    FROM neurons_documents d
    CROSS JOIN json_each(d.payload) j
    CROSS JOIN neurons_members m
    WHERE d.day='' AND m.netuid=d.netuid
      AND m.uid=CAST(j.key AS INTEGER) AND m.shard=d.shard
  ), complete AS (
    SELECT n.captured_at FROM current n
    JOIN neurons_passes p ON p.captured_at=n.captured_at
    WHERE n.captured_at=(SELECT MAX(captured_at) FROM current)
    GROUP BY n.captured_at
    HAVING COUNT(*)=MAX(p.expected_rows)
      AND MAX(p.received_rows)>=MAX(p.expected_rows)
      AND MAX(p.completed_at) IS NOT NULL
  )
  SELECT n.netuid,MAX(n.block_number) AS block_number
  FROM current n JOIN complete p ON p.captured_at=n.captured_at
  GROUP BY n.netuid ORDER BY n.netuid`);
}

// The D1 caller has already read the permitted validator memberships. Bind
// their keys as one JSON value instead of scanning the neurons view again.
// LEFT JOIN and the whole-table scan stamp preserve confirmed-zero semantics.
export async function readDirectoryNominatorCounts(
  sql: PgSql,
  env: unknown,
  hotkeys: readonly string[],
): Promise<DirectoryNominatorRow[]> {
  const store = selectedD1Store(env, ["neurons", "validator_nominator_counts"]);
  if (store) {
    return store.query(
      `SELECT k.value AS hotkey, c.nominator_count AS nominator_count,
        (SELECT MAX(captured_at) FROM validator_nominator_counts) AS scan_at
       FROM json_each(?) k
       LEFT JOIN validator_nominator_counts c ON c.hotkey = k.value`,
      [JSON.stringify([...new Set(hotkeys)])],
    );
  }
  return sql<DirectoryNominatorRow>`
    SELECT n.hotkey AS hotkey,
           c.nominator_count AS nominator_count,
           (SELECT MAX(captured_at) FROM validator_nominator_counts) AS scan_at
    FROM (
      SELECT DISTINCT hotkey FROM neurons
      WHERE validator_permit = TRUE AND hotkey IS NOT NULL
    ) n
    LEFT JOIN validator_nominator_counts c ON c.hotkey = n.hotkey`;
}
