// Native SQLite axon state reads. Expand each document once, then classify
// distinct addresses once; the membership join excludes displaced/stale keys.
// Unary + on the document day prevents propagating its range bound into the
// membership lookup: each member must be a point lookup, not a scan of 30 days.
import {
  UNROUTABLE_AXON_V4_PREFIXES,
  UNROUTABLE_AXON_V6_PREFIXES,
  UNROUTABLE_AXON_V6_EXACT,
} from "./axon-routable.ts";

const address = `CASE WHEN instr(axon,':')=0 THEN axon ELSE
 substr(axon,1,length(axon)-length(json_extract('['||replace(json_quote(axon),':','","')||']','$[#-1]'))-1) END`;
const routable = `address IS NOT NULL AND address<>'' AND
 CASE WHEN instr(address,':')>0 THEN NOT (
 lower(address) IN (${UNROUTABLE_AXON_V6_EXACT.map((value) => `'${value}'`).join(",")}) OR
 ${UNROUTABLE_AXON_V6_PREFIXES.map((prefix) => `lower(address) GLOB '${prefix}*'`).join(" OR ")})
 ELSE NOT (${UNROUTABLE_AXON_V4_PREFIXES.map((prefix) => `address GLOB '${prefix}*'`).join(" OR ")}) END`;

/** extraWhere contains only a fixed predicate and bound placeholders. */
function classified(extraWhere: string): string {
  return `WITH readings AS MATERIALIZED(
 SELECT d.netuid,m.uid,d.day AS snapshot_date,m.hotkey,json_extract(j.value,'$.axon') AS axon
 FROM neuron_daily_documents d CROSS JOIN json_each(d.payload) j
 CROSS JOIN neuron_daily_members m ON m.netuid=d.netuid AND m.snapshot_date=+d.day
 AND m.shard=d.shard AND m.uid=CAST(j.key AS INTEGER)
 WHERE d.day>=? ${extraWhere}
 ), addresses AS MATERIALIZED(SELECT axon,${address} AS address FROM (SELECT DISTINCT axon FROM readings)),
 reachability AS MATERIALIZED(SELECT axon,address,(${routable}) AS routable FROM addresses)
 SELECT r.*,a.address,a.routable FROM readings r LEFT JOIN reachability a ON a.axon IS r.axon`;
}

export function axonSequenceD1Sql(extraWhere = ""): string {
  return `WITH classified AS MATERIALIZED(${classified(extraWhere)})
 SELECT netuid,uid,snapshot_date,hotkey,axon,routable,
 LAG(routable) OVER w AS prev_routable,LAG(hotkey) OVER w AS prev_hotkey,
 LAG(address) OVER w AS prev_address FROM classified
 WINDOW w AS (PARTITION BY netuid,uid ORDER BY snapshot_date)`;
}

export const AXON_DAY_COUNTS_D1_SQL = `WITH classified AS MATERIALIZED(${classified("")})
 SELECT netuid,snapshot_date AS date,COUNT(*) FILTER (WHERE routable) AS with_axon,
 COUNT(*) AS neurons FROM classified GROUP BY netuid,snapshot_date ORDER BY netuid,snapshot_date`;
