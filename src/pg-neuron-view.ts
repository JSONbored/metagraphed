import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type {
  createSqliteDocumentDecoder,
  SqliteDocumentValue,
} from "./sqlite-document-decoder.ts";
import { NEURON_COLUMNS } from "./metagraph-neurons.ts";
import type { NeuronViewStore } from "./neuron-view-store.ts";
import {
  compareSqliteMetric,
  sqliteMetricWireValue,
  type SqliteMetricScalar,
} from "./sqlite-metric-value.ts";

interface Part {
  kind: number;
  netuid: string;
  shard: string;
  uid: string | null;
  hotkey: string | null;
  coldkey: string | null;
  payload: Uint8Array | null;
}
const identities = new Set(["netuid", "uid", "hotkey", "coldkey"]);
const allowed = new Set(["netuid", ...NEURON_COLUMNS.split(", ")]);
function scalar(value: SqliteDocumentValue): SqliteMetricScalar {
  if (value instanceof Uint8Array)
    throw new TypeError("JSON view metric cannot be a BLOB");
  return value;
}

/** The SQL view does one first-key path lookup per accepted member. Missing,
 * scalar and array metrics remain null; they are not json_each projections. */
export function createPgNeuronViewStore(
  runtime: Pick<PgStoreRuntime, "read">,
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
): NeuronViewStore {
  return {
    async rows(query) {
      const order = query.order ?? [{ column: "netuid" }, { column: "uid" }];
      if (
        (query.validatorsOnly !== undefined &&
          typeof query.validatorsOnly !== "boolean") ||
        (query.excludeRoot !== undefined &&
          typeof query.excludeRoot !== "boolean") ||
        !query.columns.length ||
        new Set(query.columns).size !== query.columns.length ||
        query.columns.some((name) => !allowed.has(name)) ||
        order.some(
          ({ column, descending }) =>
            !allowed.has(column) ||
            (descending !== undefined && typeof descending !== "boolean"),
        ) ||
        new Set(order.map(({ column }) => column)).size !== order.length ||
        (query.limit !== undefined &&
          (!Number.isSafeInteger(query.limit) || query.limit < 1))
      )
        throw new TypeError("Invalid native neuron view projection");
      const values: unknown[] = [];
      const predicates = ["d.day=''"];
      for (const name of ["netuid", "uid"] as const) {
        const value = query[name];
        if (value === undefined) continue;
        if (!Number.isInteger(value) || !Number.isFinite(value))
          throw new TypeError("Invalid native neuron view identity");
        if (BigInt(value) < -(1n << 63n) || BigInt(value) >= 1n << 63n)
          return [];
        values.push(BigInt(value).toString());
        predicates.push(`m.${name}=$${values.length}::bigint`);
      }
      if (query.hotkey !== undefined) {
        if (typeof query.hotkey !== "string")
          throw new TypeError("Invalid native neuron view hotkey");
        values.push(Buffer.from(query.hotkey));
        predicates.push(`convert_to(m.hotkey,'UTF8')=$${values.length}::bytea`);
      }
      if (query.excludeRoot) predicates.push("m.netuid<>0");
      const parts = await runtime.read.query<Part>(
        `WITH selected AS MATERIALIZED (
        SELECT m.* FROM app.neurons_members m JOIN app.neurons_documents d ON d.netuid=m.netuid AND d.shard=m.shard
        WHERE ${predicates.join(" AND ")}
      ), documents AS (
        SELECT d.* FROM app.neurons_documents d JOIN (SELECT DISTINCT netuid,shard FROM selected) s
          ON d.netuid=s.netuid AND d.shard=s.shard WHERE d.day=''
      ) SELECT 0 AS kind,d.netuid::text,d.shard::text,NULL::text AS uid,NULL::text AS hotkey,NULL::text AS coldkey,d.payload FROM documents d
      UNION ALL SELECT 1,m.netuid::text,m.shard::text,m.uid::text,m.hotkey,m.coldkey,NULL::bytea FROM selected m`,
        values,
      );
      const key = (part: Part) => `${part.netuid}:${part.shard}`;
      const groups = new Map<string, Part[]>();
      for (const part of parts) {
        if (part.kind !== 1) continue;
        const group = groups.get(key(part)) ?? [];
        group.push(part);
        groups.set(key(part), group);
      }
      const names = [
        ...new Set([
          ...query.columns,
          ...order.map(({ column }) => column),
          ...(query.validatorsOnly ? ["validator_permit"] : []),
        ]),
      ];
      const metrics = names.filter((name) => !identities.has(name));
      const rows: {
        values: Record<string, SqliteMetricScalar>;
        bytes: Record<string, Uint8Array>;
      }[] = [];
      for (const part of parts) {
        if (part.kind !== 0) continue;
        if (part.payload === null)
          throw new Error("Missing native neuron view document");
        const members = groups.get(key(part)) ?? [];
        const byUid = new Map(members.map((member) => [member.uid!, member]));
        for (const entry of decoder.memberMetrics(
          part.payload,
          metrics,
          members.map((member) => member.uid!),
        )) {
          const member = byUid.get(entry.key)!;
          if (
            query.validatorsOnly &&
            entry.values.validator_permit !== 1n &&
            entry.values.validator_permit !== 1
          )
            continue;
          const fields: Record<string, SqliteMetricScalar> = {
            netuid: BigInt(member.netuid),
            uid: BigInt(member.uid!),
            hotkey: member.hotkey,
            coldkey: member.coldkey,
          };
          const bytes: Record<string, Uint8Array> = {};
          for (const name of names) {
            if (!identities.has(name))
              fields[name] = scalar(entry.values[name]);
            if (typeof fields[name] === "string") {
              const raw = identities.has(name)
                ? Buffer.from(fields[name])
                : entry.textBytes?.[name];
              if (raw === undefined)
                throw new Error("Missing native neuron view text bytes");
              bytes[name] = raw;
            }
          }
          rows.push({ values: fields, bytes });
        }
      }
      rows.sort((left, right) => {
        for (const { column, descending } of order) {
          const compared = compareSqliteMetric(
            left.values[column],
            left.bytes[column],
            right.values[column],
            right.bytes[column],
          );
          if (compared) return descending ? -compared : compared;
        }
        return (
          compareSqliteMetric(
            left.values.netuid,
            undefined,
            right.values.netuid,
            undefined,
          ) ||
          compareSqliteMetric(
            left.values.uid,
            undefined,
            right.values.uid,
            undefined,
          )
        );
      });
      return (
        query.limit === undefined ? rows : rows.slice(0, query.limit)
      ).map((row) =>
        Object.fromEntries(
          query.columns.map((name) => [
            name,
            sqliteMetricWireValue(row.values[name]),
          ]),
        ),
      );
    },
  };
}
