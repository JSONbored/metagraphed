// The native (composed-tree) axon transition store (#13019 slice 2).
//
// The sequence, loss predicate and address split stay the ONE definition in
// src/axon-transition.ts / src/axon-routable.ts -- this module only supplies
// the READINGS source over the composed schema, where the D1 shapes differ:
//
//   - indexed: app.neuron_daily_members.axon_index holds the TAGGED SQLite
//     scalar (["class","value"]); the text class unwraps in SQL, and any
//     other class REFUSES by name before the query runs -- the issue's bar is
//     refusal over coercion, and SQLite's cross-class text renderings are
//     exactly the coercions this store must not invent. Real axons are text
//     (chain announcement strings).
//   - unindexed: d.payload is SQLite binary JSON as bytea, unreadable in SQL.
//     The decoder's receipts are the queryable twin: payload_json carries the
//     exact json() text with duplicate keys and order kept, and PG json_each
//     over ::json preserves the duplicate fan-out D1's json_each has. A
//     non-string axon value refuses the same way.
//   - every member read scopes mechid = 0: this is the D1-source plane
//     (0044's contract, #13235).
import { axonSequenceSql } from "./axon-transition.ts";
import { ROUTABLE_AXON_SQL } from "./axon-routable.ts";
import { toPositionalPlaceholders } from "./pg-sql.ts";
import type { NativeSource } from "./native-api-process.ts";

const TAGGED_AXON_TEXT = `CASE WHEN m.axon_index IS NULL THEN NULL
 ELSE (m.axon_index->>1)::json #>> '{}' END`;

const INDEXED_READINGS = `(SELECT m.netuid, m.uid, m.snapshot_date, m.hotkey,
 ${TAGGED_AXON_TEXT} AS axon
 FROM app.neuron_daily_members m WHERE m.mechid = 0) readings`;

const PROJECTED_READINGS = `(SELECT p.netuid, (j.key)::bigint AS uid,
 p.day AS snapshot_date, m.hotkey, j.value->>'axon' AS axon
 FROM app.neuron_document_projections p
 CROSS JOIN LATERAL json_each(p.payload_json::json) j
 JOIN app.neuron_daily_members m ON m.mechid = 0 AND m.netuid = p.netuid
   AND m.snapshot_date = p.day AND m.uid = (j.key)::bigint
 WHERE p.source_table = 'neuron_daily_documents'
   AND p.decode_status = 'complete') readings`;

/** The sequence every native axon-loss reader starts from; same columns and
 * window as the Neon/D1 builders, same `?` placeholder convention. */
export function axonSequencePgSql(extraWhere = "", indexed = true): string {
  return axonSequenceSql(
    extraWhere,
    indexed ? INDEXED_READINGS : PROJECTED_READINGS,
  );
}

export interface PgAxonTransitionStore {
  query<Row>(sql: string, values?: unknown[]): Promise<Row[]>;
  /** True once the axon projection backfill completed (no unindexed member
   * rows on the mechid-0 plane) -- an empty partial-index lookup. */
  projectionReady(): Promise<boolean>;
  /** Refuses by name before any sequence query when a reading exists that the
   * text unwrap cannot represent without coercion. */
  assertReadable(indexed: boolean): Promise<void>;
}

export function createPgAxonTransition(
  source: Pick<NativeSource, "read">,
): PgAxonTransitionStore {
  const query = <Row>(sql: string, values: unknown[] = []) =>
    source.read.query<Row>(toPositionalPlaceholders(sql), values);
  return {
    query,
    async projectionReady() {
      const rows = await query(
        "SELECT 1 FROM app.neuron_daily_members WHERE mechid = 0 AND NOT axon_indexed LIMIT 1",
      );
      return rows.length === 0;
    },
    async assertReadable(indexed) {
      const offending = indexed
        ? await query<{ class: string }>(
            `SELECT DISTINCT m.axon_index->>0 AS class FROM app.neuron_daily_members m
             WHERE m.mechid = 0 AND m.axon_index IS NOT NULL AND m.axon_index->>0 <> 'text' LIMIT 1`,
          )
        : await query<{ class: string }>(
            `SELECT DISTINCT json_typeof(j.value->'axon') AS class
             FROM app.neuron_document_projections p
             CROSS JOIN LATERAL json_each(p.payload_json::json) j
             WHERE p.source_table = 'neuron_daily_documents' AND p.decode_status = 'complete'
               AND j.value->'axon' IS NOT NULL
               AND json_typeof(j.value->'axon') NOT IN ('string', 'null') LIMIT 1`,
          );
      if (offending.length > 0)
        throw new Error(
          `Native axon reading holds a non-text ${indexed ? "scalar" : "value"} (${String(
            offending[0]!.class,
          )}); refusing rather than coercing (#13019)`,
        );
    },
  };
}

/** Per-subnet-day routable/total counts over the native readings -- the same
 * aggregation the watchdog runs over the Neon view, same `?` convention. */
export function axonDayCountsPgSql(indexed = true): string {
  return (
    "SELECT netuid, snapshot_date AS date, " +
    `COUNT(*) FILTER (WHERE ${ROUTABLE_AXON_SQL}) AS with_axon, ` +
    `COUNT(*) AS neurons FROM ${indexed ? INDEXED_READINGS : PROJECTED_READINGS} ` +
    "WHERE snapshot_date >= ? GROUP BY netuid, snapshot_date " +
    "ORDER BY netuid, snapshot_date"
  );
}
