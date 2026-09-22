// Native SQLite observation writes; selected only for the whole family.
import { latencyStatColumns, OK_LATENCY } from "./health-sql.ts";
import type { ObservationWrite } from "./observations-neon.ts";
import type { ProducerStore, ProducerStatement } from "./producer-store.ts";
type Row = Record<string, unknown>;
type Day = { date: string; start: number; end: number };
async function execute(
  store: ProducerStore,
  statements: ProducerStatement[],
): Promise<ObservationWrite> {
  try {
    if (statements.length > 900)
      throw new RangeError(
        "Observation capture exceeds atomic statement budget",
      );
    await store.transaction(statements);
    return { ok: true };
  } catch (error) {
    console.error("[observations-d1]", String(error));
    return { ok: false, reason: String(error) };
  }
}
const CHECK_COLUMNS = [
  "surface_id",
  "surface_key",
  "netuid",
  "kind",
  "status",
  "classification",
  "latency_ms",
  "status_code",
  "ok",
  "checked_at",
];
const STATUS_COLUMNS = [
  "surface_id",
  "surface_key",
  "netuid",
  "kind",
  "url",
  "provider",
  "status",
  "classification",
  "latency_ms",
  "status_code",
  "last_checked",
  "last_ok",
  "consecutive_failures",
  "updated_at",
];
export function persistProbesD1(
  store: ProducerStore,
  rows: Row[],
  runAt: number,
): Promise<ObservationWrite> {
  const checks = rows.map((r) => [
    r.surface_id,
    r.surface_key ?? null,
    r.netuid ?? null,
    r.kind ?? null,
    r.status ?? null,
    r.classification ?? null,
    r.latency_ms ?? null,
    r.status_code ?? null,
    Number(r.status === "ok"),
    r.checked_at_ms,
  ]);
  const statements: ProducerStatement[] = [
    {
      text: `INSERT INTO surface_checks(${CHECK_COLUMNS.join(",")}) SELECT ${CHECK_COLUMNS.map((_, i) => `json_extract(value,'$[${i}]')`).join(",")} FROM json_each(?) WHERE true ON CONFLICT(surface_id,checked_at) DO NOTHING`,
      values: [JSON.stringify(checks)],
    },
  ];
  for (const r of rows) {
    const keyed = Boolean(r.surface_key);
    statements.push({
      text: `INSERT INTO surface_status(${STATUS_COLUMNS.join(",")}) VALUES(${STATUS_COLUMNS.map(() => "?").join(",")})
 ON CONFLICT ${keyed ? "(surface_key) WHERE surface_key IS NOT NULL" : "(surface_id)"} DO UPDATE SET
 surface_id=excluded.surface_id,surface_key=COALESCE(excluded.surface_key,surface_status.surface_key),
 ${STATUS_COLUMNS.filter(
   (c) => !["surface_id", "surface_key", "last_ok"].includes(c),
 )
   .map((c) => `${c}=excluded.${c}`)
   .join(",")},
 last_ok=CASE WHEN excluded.last_ok IS NULL THEN surface_status.last_ok WHEN surface_status.last_ok IS NULL THEN excluded.last_ok ELSE MAX(excluded.last_ok,surface_status.last_ok) END
 WHERE surface_status.last_checked IS NULL OR surface_status.last_checked<=excluded.last_checked`,
      values: [
        r.surface_id,
        r.surface_key ?? null,
        r.netuid ?? null,
        r.kind ?? null,
        r.url ?? null,
        r.provider ?? null,
        r.status ?? null,
        r.classification ?? null,
        r.latency_ms ?? null,
        r.status_code ?? null,
        r.checked_at_ms,
        r.last_ok_ms ?? null,
        r.consecutive_failures ?? 0,
        runAt,
      ],
    });
  }
  return execute(store, statements);
}
function ranked(): string {
  return `WITH windowed AS(
 SELECT surface_id,COALESCE(surface_key,surface_id) AS surface_key,netuid,ok,latency_ms,checked_at FROM surface_checks WHERE checked_at>=? AND checked_at<?
 ), latest_candidates AS(
 SELECT c.surface_key,c.netuid,COALESCE(s.surface_id,c.surface_id) AS alias,s.surface_id IS NOT NULL AS current_alias,c.checked_at,
 ROW_NUMBER() OVER(PARTITION BY c.surface_key ORDER BY c.checked_at DESC,c.surface_id DESC) AS latest_rank
 FROM windowed c LEFT JOIN surface_status s ON s.surface_key=c.surface_key
 ), identities AS(
 SELECT surface_key,netuid,CASE WHEN ROW_NUMBER() OVER(PARTITION BY alias ORDER BY current_alias DESC,checked_at DESC,surface_key)=1 THEN alias ELSE 'history:'||surface_key END AS surface_id
 FROM latest_candidates WHERE latest_rank=1
 ), ranked AS(
 SELECT i.surface_id,c.surface_key,i.netuid,ok,latency_ms,
 CASE WHEN ${OK_LATENCY} THEN ROW_NUMBER() OVER(PARTITION BY c.surface_key,CASE WHEN ${OK_LATENCY} THEN 0 ELSE 1 END ORDER BY latency_ms) END AS rn,
 COUNT(*) FILTER(WHERE ${OK_LATENCY}) OVER(PARTITION BY c.surface_key) AS lat_cnt
 FROM windowed c JOIN identities i ON i.surface_key=c.surface_key
 )`;
}
export function rollupUptimeD1(
  store: ProducerStore,
  days: Day[],
  runAt: number,
): Promise<ObservationWrite> {
  return execute(
    store,
    days.flatMap(({ date, start, end }) => [
      { text: "DELETE FROM surface_uptime_daily WHERE day=?", values: [date] },
      {
        text: `${ranked()} INSERT INTO surface_uptime_daily(surface_id,surface_key,netuid,day,samples,ok_count,uptime_ratio,latency_samples,avg_latency_ms,p50_latency_ms,p95_latency_ms,p99_latency_ms,status,updated_at)
 SELECT MAX(surface_id),surface_key,netuid,?,COUNT(*),COUNT(*) FILTER(WHERE ok),
 CASE WHEN COUNT(*) FILTER(WHERE ok)=COUNT(*) THEN 1.0
 WHEN ROUND(CAST(COUNT(*) FILTER(WHERE ok) AS REAL)/COUNT(*),4)>=1.0 THEN 0.9999
 ELSE ROUND(CAST(COUNT(*) FILTER(WHERE ok) AS REAL)/COUNT(*),4) END,
 ${latencyStatColumns({ roundedAvg: true, includeMinMax: false })},
 CASE WHEN COUNT(*) FILTER(WHERE ok)=COUNT(*) THEN 'ok' WHEN COUNT(*) FILTER(WHERE ok)=0 THEN 'failed' ELSE 'degraded' END,?
 FROM ranked GROUP BY surface_key,netuid`,
        values: [start, end, date, runAt],
      },
    ]),
  );
}
export function rollupFailuresD1(
  store: ProducerStore,
  days: Day[],
  runAt: number,
): Promise<ObservationWrite> {
  return execute(
    store,
    days.map(({ date, start, end }) => ({
      text: `INSERT INTO surface_failure_daily(day,netuid,kind,classification,checks,updated_at)
 SELECT ?,netuid,kind,classification,COUNT(*),? FROM surface_checks WHERE checked_at>=? AND checked_at<? AND kind IS NOT NULL AND classification IS NOT NULL
 GROUP BY netuid,kind,classification ON CONFLICT DO UPDATE SET checks=excluded.checks,updated_at=excluded.updated_at`,
      values: [date, runAt, start, end],
    })),
  );
}
export function pruneChecksD1(
  store: ProducerStore,
  cutoff: number,
): Promise<ObservationWrite> {
  return execute(store, [
    { text: "DELETE FROM surface_checks WHERE checked_at<?", values: [cutoff] },
  ]);
}
const SNAPSHOT_COLUMNS = [
  "netuid",
  "snapshot_date",
  "completeness_score",
  "surface_count",
  "endpoint_count",
  "monitored_count",
  "candidate_count",
  "captured_at",
  "validator_count",
  "miner_count",
  "total_stake_tao",
  "alpha_price_tao",
  "emission_share",
  "tao_in_pool_tao",
  "alpha_in_pool",
  "alpha_out_pool",
  "subnet_volume_tao",
  "tao_in_emission_tao",
  "excess_tao",
  "alpha_in_emission",
  "alpha_out_emission",
  "miner_burned_fraction",
  "emission_enabled",
  "subtoken_enabled",
  "first_emission_block",
  "pipeline_block",
  "pipeline_block_hash",
];
export function upsertSnapshotsD1(
  store: ProducerStore,
  rows: Row[],
): Promise<ObservationWrite> {
  return execute(
    store,
    rows.map((row) => ({
      text: `INSERT INTO subnet_snapshots(${SNAPSHOT_COLUMNS.join(",")}) VALUES(${SNAPSHOT_COLUMNS.map(() => "?").join(",")}) ON CONFLICT(netuid,snapshot_date) DO UPDATE SET ${SNAPSHOT_COLUMNS.slice(
        2,
      )
        .map((c) => `${c}=excluded.${c}`)
        .join(",")}`,
      values: SNAPSHOT_COLUMNS.map((c) =>
        row[c] == null
          ? null
          : ["emission_enabled", "subtoken_enabled"].includes(c)
            ? Number(Boolean(row[c]))
            : row[c],
      ),
    })),
  );
}
