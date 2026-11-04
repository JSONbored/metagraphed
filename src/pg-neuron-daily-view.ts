import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type {
  createSqliteDocumentDecoder,
  SqliteDocumentValue,
} from "./sqlite-document-decoder.ts";
import type { NeuronDailyViewStore } from "./neuron-daily-view-store.ts";
import { NEURON_DAILY_COLUMNS } from "../generated/lakehouse/types.ts";
import { shiftIsoDate } from "./iso-date-window.ts";
import { sqliteMetricWireValue } from "./sqlite-metric-value.ts";

interface Part {
  kind: number;
  netuid: string;
  snapshot_date: string;
  shard: string;
  uid: string | null;
  hotkey: string | null;
  coldkey: string | null;
  payload: Uint8Array | null;
}
const identities = new Set([
  "netuid",
  "snapshot_date",
  "uid",
  "hotkey",
  "coldkey",
]);
const columns = new Set<string>(NEURON_DAILY_COLUMNS);
function network(value: number | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value))
    throw new TypeError("Invalid native daily view netuid");
  const integer = BigInt(value);
  return integer < -(1n << 63n) || integer >= 1n << 63n
    ? null
    : integer.toString();
}
function wire(value: SqliteDocumentValue): unknown {
  if (value instanceof Uint8Array)
    throw new TypeError("Canonical daily JSON metric cannot be a BLOB");
  return sqliteMetricWireValue(value);
}
const key = (part: Part) =>
  `${part.netuid}:${part.snapshot_date}:${part.shard}`;

/** Bounded canonical view reads. The source view does one first-key lookup per
 * accepted member; it does not retain json_each duplicate multiplicity. */
export function createPgNeuronDailyViewStore(
  runtime: Pick<PgStoreRuntime, "read">,
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
): NeuronDailyViewStore {
  return {
    async rows(query) {
      if (
        !Number.isSafeInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > 1000000 ||
        !query.columns.length ||
        new Set(query.columns).size !== query.columns.length ||
        query.columns.some((name) => !columns.has(name)) ||
        (query.oldestFirst !== undefined &&
          typeof query.oldestFirst !== "boolean") ||
        [query.fromDay, query.beforeDay].some(
          (day) => day != null && typeof day !== "string",
        ) ||
        (query.days !== undefined &&
          (!Array.isArray(query.days) ||
            query.days.length > 16 ||
            query.days.some((day) => typeof day !== "string")))
      )
        throw new TypeError("Invalid bounded native daily view query");
      const netuid = network(query.netuid);
      if (netuid === null || query.days?.length === 0) return [];
      const values: unknown[] = [];
      const predicates: string[] = [];
      if (netuid !== undefined) {
        values.push(netuid);
        predicates.push(`m.netuid=$${values.length}::bigint`);
      }
      for (const [day, operator] of [
        [query.fromDay, ">="],
        [query.beforeDay, "<"],
      ] as const) {
        if (day == null) continue;
        values.push(day);
        predicates.push(
          `m.snapshot_date ${operator} $${values.length}::text COLLATE "C"`,
        );
      }
      if (query.days !== undefined) {
        const slots = query.days.map((day) => {
          values.push(day);
          return `$${values.length}::text`;
        });
        predicates.push(`m.snapshot_date IN (${slots.join(",")})`);
      }
      values.push(query.limit);
      const direction = query.oldestFirst ? "ASC" : "DESC";
      const parts = await runtime.read.query<Part>(
        `WITH selected AS MATERIALIZED (
        SELECT m.* FROM app.neuron_daily_members m JOIN app.neuron_daily_documents d
          ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard
        ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
        ORDER BY m.snapshot_date ${direction},m.netuid,m.uid LIMIT $${values.length}
      ), documents AS (
        SELECT d.* FROM app.neuron_daily_documents d JOIN (
          SELECT DISTINCT netuid,snapshot_date,shard FROM selected
        ) s ON d.netuid=s.netuid AND d.day=s.snapshot_date AND d.shard=s.shard
      ) SELECT 0 AS kind,d.netuid::text,d.day AS snapshot_date,d.shard::text,
          NULL::text AS uid,NULL::text AS hotkey,NULL::text AS coldkey,d.payload FROM documents d
      UNION ALL SELECT 1,m.netuid::text,m.snapshot_date,m.shard::text,m.uid::text,m.hotkey,m.coldkey,NULL::bytea FROM selected m`,
        values,
      );
      const members = parts.filter((part) => part.kind === 1);
      const groups = new Map<string, string[]>();
      for (const member of members) {
        const group = groups.get(key(member)) ?? [];
        group.push(member.uid!);
        groups.set(key(member), group);
      }
      const metrics = query.columns.filter((name) => !identities.has(name));
      const projections = new Map<
        string,
        Map<string, Record<string, SqliteDocumentValue>>
      >();
      for (const document of parts) {
        if (document.kind !== 0) continue;
        if (document.payload === null)
          throw new Error("Missing canonical daily document");
        projections.set(
          key(document),
          new Map(
            decoder
              .memberMetrics(
                document.payload,
                metrics,
                groups.get(key(document)) ?? [],
              )
              .map((entry) => [entry.key, entry.values]),
          ),
        );
      }
      members.sort((left, right) => {
        const date = Buffer.compare(
          Buffer.from(left.snapshot_date),
          Buffer.from(right.snapshot_date),
        );
        if (date) return query.oldestFirst ? date : -date;
        const netuid = BigInt(left.netuid) - BigInt(right.netuid);
        if (netuid) return netuid < 0n ? -1 : 1;
        const uid = BigInt(left.uid!) - BigInt(right.uid!);
        return uid < 0n ? -1 : uid > 0n ? 1 : 0;
      });
      return members.map((member) => {
        const values = projections.get(key(member))?.get(member.uid!);
        if (!values)
          throw new Error("Missing canonical daily member projection");
        const row: Record<string, SqliteDocumentValue> = {
          ...values,
          netuid: BigInt(member.netuid),
          uid: BigInt(member.uid!),
          snapshot_date: member.snapshot_date,
          hotkey: member.hotkey,
          coldkey: member.coldkey,
        };
        return Object.fromEntries(
          query.columns.map((name) => [name, wire(row[name])]),
        );
      });
    },
    async window(days, requestedNetuid) {
      if (
        days !== null &&
        (!Number.isSafeInteger(days) || days < 0 || days > 36500)
      )
        throw new TypeError("Invalid native daily window");
      const netuid = network(requestedNetuid);
      if (netuid === null) return { startDate: null, endDate: null };
      const values: unknown[] = netuid === undefined ? [] : [netuid];
      const source = `FROM app.neuron_daily_documents d WHERE ${netuid === undefined ? "" : "d.netuid=$1::bigint AND "}
        EXISTS(SELECT 1 FROM app.neuron_daily_members m WHERE m.netuid=d.netuid AND m.snapshot_date=d.day AND m.shard=d.shard)`;
      const end = await runtime.read.query<{ value: string | null }>(
        `SELECT MAX(d.day COLLATE "C") AS value ${source}`,
        values,
      );
      const endDate = end[0]?.value ?? null;
      if (endDate === null) return { startDate: null, endDate: null };
      const cutoff = days === null ? null : shiftIsoDate(endDate, -days);
      if (cutoff !== null) values.push(cutoff);
      const start = await runtime.read.query<{ value: string | null }>(
        `SELECT MIN(d.day COLLATE "C") AS value ${source}
        ${cutoff === null ? "" : `AND d.day >= $${values.length}::text COLLATE "C"`}`,
        values,
      );
      return { startDate: start[0]?.value ?? null, endDate };
    },
  };
}
