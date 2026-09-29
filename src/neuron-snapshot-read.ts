// Full-network directory reads must walk each metric document once (#12197).
// The point-read neurons view intentionally starts with indexed membership,
// but expanding the same large document for every member makes a full snapshot
// quadratic in each shard. CROSS JOIN fixes the document -> entry -> primary
// membership lookup order; an ordinary JOIN lets SQLite reverse it again.
import { selectedD1Store } from "./d1-store.ts";
import type { PgSql } from "./pg-sql.ts";
import { NEURON_COLUMNS } from "./metagraph-neurons.ts";
import { z } from "zod";
import { JsonObjectBodySchema } from "../schemas-src/json-request.ts";
import type { ReadStoreDb, UntypedRowQuerier } from "./read-store.ts";
import { readRevisionedNeuronEconomics } from "./neuron-economics-cache.ts";

const EconomicsValuesSchema = z.array(z.unknown()).length(5);
const EconomicsShardSchema = z.array(
  z.tuple([z.number(), z.string().nullable(), EconomicsValuesSchema]),
);

// stake_tao contains per-UID ALPHA stake despite its historical name (#8945).
export const NEURON_AGGREGATE_QUERY =
  "SELECT netuid, COUNT(*) AS uid_count, " +
  "SUM(CASE WHEN validator_permit THEN 1 ELSE 0 END) AS validator_count, " +
  "SUM(stake_tao) AS total_stake_alpha, MAX(stake_tao) AS max_stake_alpha " +
  "FROM neurons GROUP BY netuid";

// Count accepted memberships separately: a member with absent metrics still
// exists in the public view. Expand each document once for the metric fold,
// excluding orphan entries and memberships pointing at another shard.
export const NEURON_DOCUMENT_AGGREGATE_QUERY = `
  WITH members AS MATERIALIZED (
    SELECT m.netuid,COUNT(*) AS uid_count
    FROM neurons_documents d CROSS JOIN neurons_members m
    WHERE d.day='' AND m.netuid=d.netuid AND m.shard=d.shard
    GROUP BY m.netuid
  ), metrics AS (
    SELECT d.netuid,
      SUM(CASE WHEN json_extract(j.value,'$.validator_permit') THEN 1 ELSE 0 END) AS validator_count,
      SUM(json_extract(j.value,'$.stake_tao')) AS total_stake_alpha,
      MAX(json_extract(j.value,'$.stake_tao')) AS max_stake_alpha
    FROM neurons_documents d CROSS JOIN json_each(d.payload) j
    CROSS JOIN neurons_members m
    WHERE d.day='' AND m.netuid=d.netuid
      AND m.uid=CAST(j.key AS INTEGER) AND j.key=CAST(m.uid AS TEXT)
      AND m.shard=d.shard
    GROUP BY d.netuid
  )
  SELECT m.netuid,m.uid_count,COALESCE(v.validator_count,0) AS validator_count,
    v.total_stake_alpha,v.max_stake_alpha
  FROM members m LEFT JOIN metrics v ON v.netuid=m.netuid`;

export async function readNeuronAggregates(
  db: UntypedRowQuerier,
  env: unknown,
): Promise<Record<string, unknown>[]> {
  const store = selectedD1Store(env, ["neurons"]);
  return store
    ? store.query(NEURON_DOCUMENT_AGGREGATE_QUERY)
    : db.query(NEURON_AGGREGATE_QUERY);
}

export const NEWEST_NEURON_CAPTURE_QUERY = `
  SELECT MAX(json_extract(j.value,'$.captured_at')) AS captured_at
  FROM neurons_documents d CROSS JOIN json_each(d.payload) j
  CROSS JOIN neurons_members m
  WHERE d.day='' AND m.netuid=d.netuid
    AND m.uid=CAST(j.key AS INTEGER) AND j.key=CAST(m.uid AS TEXT)
    AND m.shard=d.shard`;

export async function readNewestNeuronCapture(
  sql: PgSql,
  env: unknown,
): Promise<number> {
  const store = selectedD1Store(env, ["neurons"]);
  const rows = store
    ? await store.query(NEWEST_NEURON_CAPTURE_QUERY)
    : await sql.unsafe<{ captured_at: number | string | null }>(
        "SELECT MAX(captured_at) AS captured_at FROM neurons",
      );
  return Number(rows[0]?.captured_at);
}

// A multi-path extraction returns JSON, while individual SQLite columns turn
// booleans into integers and structured values into JSON text. Restore those
// same column values when unpacking the compact response.
function sqliteJsonColumn(value: unknown): unknown {
  if (typeof value === "boolean") return Number(value);
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

/** Economic rankings need miners and validators, including null hotkeys.
 * Expand each bounded document once instead of re-reading its JSON per UID.
 * stake_tao already includes the weighted root leg; pass it through unchanged. */
export async function readNeuronEconomicsRows(
  db: UntypedRowQuerier,
  env: unknown,
  netuid?: number,
): Promise<Record<string, unknown>[]> {
  const metrics = [
    "stake_tao",
    "validator_permit",
    "dividends",
    "active",
    "take",
  ];
  const scoped = netuid !== undefined;
  const params = scoped ? [netuid] : [];
  const store = selectedD1Store(env, ["neurons"]);
  if (store) {
    const read = async () => {
      // Transport one array per bounded document shard, rather than tens of
      // thousands of row objects and separately encoded metrics strings. Keep
      // identities from accepted memberships and parse each metric object once.
      const shards = await store.query<{
        netuid: number;
        shard: number;
        rows_payload: string;
      }>(
        `SELECT d.netuid,d.shard,
        json_group_array(json_array(m.uid,m.hotkey,
          json_extract(j.value,${metrics.map((column) => `'$.${column}'`).join(",")}))) AS rows_payload
       FROM neurons_documents d CROSS JOIN json_each(d.payload) j
       CROSS JOIN neurons_members m
       WHERE d.day='' AND ${scoped ? "d.netuid=?" : "d.netuid!=0"}
         AND m.netuid=d.netuid AND m.uid=CAST(j.key AS INTEGER) AND m.shard=d.shard
       GROUP BY d.netuid,d.shard`,
        params,
      );
      // SQL aggregation does not promise member or shard order. Restore the
      // public view's exact ordering after unpacking, including scoped reads.
      return shards
        .flatMap(({ netuid, rows_payload }) =>
          EconomicsShardSchema.parse(JSON.parse(rows_payload)).map(
            (row) => [netuid, ...row] as const,
          ),
        )
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        .map(([netuid, uid, hotkey, values]) => ({
          ...(!scoped ? { netuid } : {}),
          uid,
          hotkey,
          ...Object.fromEntries(
            metrics.map((column, index) => [
              column,
              sqliteJsonColumn(values[index]),
            ]),
          ),
        }));
    };
    // Scoped reads are already small. Reuse only the full network read and
    // only where the owned producer has atomic revision tracking enabled.
    const owned = env as { D1_STATE: object; D1_EXPORT_REVISIONS?: string };
    return !scoped && owned.D1_EXPORT_REVISIONS === "enabled"
      ? readRevisionedNeuronEconomics(store, owned.D1_STATE, read)
      : read();
  }
  return db.query(
    `SELECT ${scoped ? "" : "netuid, "}uid, hotkey, ${metrics.join(", ")} FROM neurons WHERE ${scoped ? "netuid = ?" : "netuid != 0"} ORDER BY ${scoped ? "uid" : "netuid, uid"}`,
    params,
  );
}

interface SubnetSnapshotPart {
  shard: number;
  payload: string | null;
  uid: number | null;
  hotkey: string | null;
  coldkey: string | null;
}

/** One statement binds documents and accepted memberships to the same snapshot. */
export async function readSubnetNeuronRows(
  sql: PgSql,
  env: unknown,
  netuid: number,
  validatorsOnly = false,
): Promise<Record<string, unknown>[]> {
  const store = selectedD1Store(env, ["neurons"]);
  if (!store)
    return sql.unsafe(
      `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ?
       ${validatorsOnly ? "AND validator_permit = TRUE" : ""} ORDER BY uid`,
      [netuid],
    );
  // Expanding json_each in SQL bills a read for every virtual row as well as
  // each membership. Read the bounded shards once and expand them in memory.
  // UNION ALL keeps both halves atomic without adding a transaction or index.
  const parts = await store.query<SubnetSnapshotPart>(
    `SELECT shard,json(payload) AS payload,NULL AS uid,NULL AS hotkey,NULL AS coldkey
     FROM neurons_documents WHERE netuid=? AND day=''
     UNION ALL
     SELECT shard,NULL AS payload,uid,hotkey,coldkey
     FROM neurons_members WHERE netuid=?`,
    [netuid, netuid],
  );
  const documents = new Map<number, Record<string, unknown>>();
  for (const part of parts)
    if (part.payload !== null)
      documents.set(
        part.shard,
        JsonObjectBodySchema.parse(JSON.parse(part.payload)),
      );
  const rows: Record<string, unknown>[] = [];
  for (const member of parts) {
    if (member.uid === null) continue;
    const document = documents.get(member.shard);
    if (!document) continue;
    const metrics = JsonObjectBodySchema.parse(
      document[String(member.uid)] ?? {},
    );
    if (validatorsOnly && metrics.validator_permit !== 1) continue;
    rows.push({
      ...Object.fromEntries(
        NEURON_COLUMNS.split(", ").map((column) => [
          column,
          metrics[column] ?? null,
        ]),
      ),
      uid: member.uid,
      hotkey: member.hotkey,
      coldkey: member.coldkey,
    });
  }
  return rows.sort((left, right) => Number(left.uid) - Number(right.uid));
}

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

/** Boundary snapshots expand each stored document once, as directory reads do. */
export async function readNeuronDailyValidators(
  sql: PgSql,
  env: unknown,
  startDate: string,
  endDate: string,
): Promise<Record<string, unknown>[]> {
  const store = selectedD1Store(env, ["neuron_daily"]);
  if (store)
    return store.query(
      `SELECT m.snapshot_date,m.netuid,m.hotkey,
        json_extract(j.value,'$.validator_permit') AS validator_permit
       FROM neuron_daily_documents d CROSS JOIN json_each(d.payload) j
       CROSS JOIN neuron_daily_members m
       WHERE d.day IN (?,?) AND m.netuid=d.netuid AND m.snapshot_date=d.day
         AND m.uid=CAST(j.key AS INTEGER) AND m.shard=d.shard
         AND json_extract(j.value,'$.validator_permit')=TRUE`,
      [startDate, endDate],
    );
  return sql`SELECT snapshot_date,netuid,hotkey,validator_permit
    FROM neuron_daily WHERE validator_permit=TRUE
      AND snapshot_date IN (${startDate},${endDate})`;
}

interface NeuronDailyRollup extends Record<string, unknown> {
  snapshot_date: string;
  neuron_count: string | number;
  validator_count: string | number;
  total_stake_tao: string | number | null;
  total_emission_tao: string | number | null;
}

/** Bound the accepted membership first, then expand each selected shard once.
 * Missing metric entries remain null rows, just as in the membership view. */
export async function readNeuronDailyMetricRows<Row>(
  db: Pick<ReadStoreDb, "query">,
  env: unknown,
  netuid: number,
  cutoff: string,
  columns: string,
  limit: number,
): Promise<Row[]> {
  const names = columns.split(",").map((column) => column.trim());
  const allowed = new Set(["snapshot_date", ...NEURON_COLUMNS.split(", ")]);
  if (
    names.some((name) => !allowed.has(name)) ||
    new Set(names).size !== names.length ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  )
    throw new Error("Invalid bounded neuron history projection");
  const store = selectedD1Store(env, ["neuron_daily"]);
  if (!store)
    return db.query<Row>(
      `SELECT ${names.join(", ")} FROM neuron_daily
       WHERE netuid = ? AND snapshot_date >= ?
       ORDER BY snapshot_date DESC, uid LIMIT ?`,
      [netuid, cutoff, limit],
    );
  const identities = new Set(["snapshot_date", "uid", "hotkey", "coldkey"]);
  const projection = names
    .map((name) =>
      identities.has(name)
        ? `s.${name} AS ${name}`
        : `json_extract(v.value,'$.${name}') AS ${name}`,
    )
    .join(",");
  return store.query<Row>(
    `WITH selected AS MATERIALIZED (
       SELECT m.snapshot_date,m.uid,m.hotkey,m.coldkey,m.shard
       FROM neuron_daily_members m JOIN neuron_daily_documents d
         ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard
       WHERE m.netuid=? AND m.snapshot_date>=?
       ORDER BY m.snapshot_date DESC,m.uid LIMIT ?
     ), metric_rows AS MATERIALIZED (
       SELECT d.day,d.shard,j.key,j.value
       FROM (SELECT DISTINCT snapshot_date,shard FROM selected) shards
       CROSS JOIN neuron_daily_documents d CROSS JOIN json_each(d.payload) j
       WHERE d.netuid=? AND d.day=shards.snapshot_date AND d.shard=shards.shard
     )
     SELECT ${projection} FROM selected s LEFT JOIN metric_rows v
       ON v.day=s.snapshot_date AND v.shard=s.shard AND v.key=CAST(s.uid AS TEXT)
     ORDER BY s.snapshot_date DESC,s.uid`,
    [netuid, cutoff, limit, netuid],
  );
}

const DAILY_DOCUMENT_TOTALS = `COUNT(*) AS neuron_count,
  SUM(CASE WHEN json_extract(j.value,'$.validator_permit') THEN 1 ELSE 0 END) AS validator_count,
  SUM(json_extract(j.value,'$.stake_tao')) AS total_stake_tao,
  SUM(json_extract(j.value,'$.emission_tao')) AS total_emission_tao`;
const DAILY_DOCUMENT_MEMBERS = `FROM neuron_daily_documents d
  CROSS JOIN json_each(d.payload) j CROSS JOIN neuron_daily_members m`;
const DAILY_DOCUMENT_MATCH = `m.netuid=d.netuid AND m.snapshot_date=d.day
  AND m.uid=CAST(j.key AS INTEGER) AND m.shard=d.shard`;

/** Expand each boundary document once before grouping its accepted members. */
export async function readNeuronDailyTotals(
  sql: PgSql,
  env: unknown,
  startDate: string,
  endDate: string,
): Promise<NeuronDailyRollup[]> {
  const store = selectedD1Store(env, ["neuron_daily"]);
  if (store)
    return store.query<NeuronDailyRollup>(
      `SELECT m.netuid,m.snapshot_date,${DAILY_DOCUMENT_TOTALS}
     ${DAILY_DOCUMENT_MEMBERS}
     WHERE d.day IN (?,?) AND ${DAILY_DOCUMENT_MATCH}
     GROUP BY m.netuid,m.snapshot_date`,
      [startDate, endDate],
    );
  return sql<NeuronDailyRollup>`SELECT netuid,snapshot_date,COUNT(*) AS neuron_count,
    SUM(CASE WHEN validator_permit THEN 1 ELSE 0 END) AS validator_count,
    SUM(stake_tao) AS total_stake_tao,SUM(emission_tao) AS total_emission_tao
    FROM neuron_daily WHERE snapshot_date IN (${startDate},${endDate})
    GROUP BY netuid,snapshot_date`;
}

export async function readSubnetDailyHistory(
  sql: PgSql,
  env: unknown,
  netuid: number,
  cutoff: string | null,
  limit: number,
  before: string | null = null,
): Promise<NeuronDailyRollup[]> {
  const store = selectedD1Store(env, ["neuron_daily"]);
  if (store)
    return store.query<NeuronDailyRollup>(
      `SELECT m.snapshot_date,${DAILY_DOCUMENT_TOTALS}
     ${DAILY_DOCUMENT_MEMBERS}
     WHERE d.netuid=? ${cutoff ? "AND d.day>=?" : ""} ${before ? "AND d.day<?" : ""} AND ${DAILY_DOCUMENT_MATCH}
     GROUP BY m.snapshot_date ORDER BY m.snapshot_date DESC LIMIT ?`,
      [netuid, ...(cutoff ? [cutoff] : []), ...(before ? [before] : []), limit],
    );
  if (before) throw new Error("Daily history ceiling requires its D1 owner");
  return cutoff
    ? sql<NeuronDailyRollup>`SELECT snapshot_date,COUNT(*) AS neuron_count,
        SUM(CASE WHEN validator_permit THEN 1 ELSE 0 END) AS validator_count,
        SUM(stake_tao) AS total_stake_tao,SUM(emission_tao) AS total_emission_tao
        FROM neuron_daily WHERE netuid=${netuid} AND snapshot_date>=${cutoff}
        GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ${limit}`
    : sql<NeuronDailyRollup>`SELECT snapshot_date,COUNT(*) AS neuron_count,
        SUM(CASE WHEN validator_permit THEN 1 ELSE 0 END) AS validator_count,
        SUM(stake_tao) AS total_stake_tao,SUM(emission_tao) AS total_emission_tao
        FROM neuron_daily WHERE netuid=${netuid}
        GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ${limit}`;
}
