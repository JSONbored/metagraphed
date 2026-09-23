// Full-network directory reads must walk each metric document once (#12197).
// The point-read neurons view intentionally starts with indexed membership,
// but expanding the same large document for every member makes a full snapshot
// quadratic in each shard. CROSS JOIN fixes the document -> entry -> primary
// membership lookup order; an ordinary JOIN lets SQLite reverse it again.
import { selectedD1Store } from "./d1-store.ts";
import type { PgSql } from "./pg-sql.ts";

export async function readNeuronDirectoryRows(
  sql: PgSql,
  env: unknown,
  validatorsOnly = false,
): Promise<Record<string, unknown>[]> {
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
