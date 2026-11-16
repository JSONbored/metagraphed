import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type {
  createSqliteDocumentDecoder,
  SqliteDocumentValue,
} from "./sqlite-document-decoder.ts";
import type { ValidatorHistoryStore } from "./validator-history-store.ts";
import { createSqliteSum } from "./sqlite-sum.ts";
import { sqliteMetricWireValue } from "./sqlite-metric-value.ts";

export interface ValidatorHistoryLimits {
  maxSourceRows?: number;
  maxPageBytes?: number;
  pageRows?: number;
  maxDurationMillis?: number;
}
const fields = [
  "stake_tao",
  "emission_tao",
  "validator_permit",
  "validator_trust",
  "consensus",
  "dividends",
  "take",
] as const;
interface Part {
  kind: number;
  netuid: string;
  day: string | null;
  shard: string | null;
  uid: string | null;
  payload: Uint8Array | null;
  overflow: boolean;
  total_stake_tao: number | null;
  tao_in_pool_tao: number | null;
  alpha_in_pool: number | null;
}
const identity = (part: Part) =>
  JSON.stringify([part.netuid, part.day, part.shard]);
function wire(value: SqliteDocumentValue): unknown {
  if (value instanceof Uint8Array)
    throw new TypeError("Validator JSON metric cannot be a BLOB");
  return sqliteMetricWireValue(value);
}
function add(
  sum: ReturnType<typeof createSqliteSum>,
  value: bigint | number | null,
) {
  sum.add(
    value === null
      ? null
      : typeof value === "bigint"
        ? { kind: "integer", value }
        : { kind: "real", value },
  );
}
const memberOrder = (left: Part, right: Part) =>
  Buffer.compare(Buffer.from(right.day!), Buffer.from(left.day!)) ||
  Number(BigInt(left.netuid) - BigInt(right.netuid)) ||
  Number(BigInt(left.uid!) - BigInt(right.uid!));

/** Preserve canonical SQLite values through arithmetic. Keyset pages keep a
 * dense validator history from loading all of its document payloads at once. */
export function createPgValidatorHistoryStore(
  runtime: Pick<PgStoreRuntime, "transaction">,
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
  limits: ValidatorHistoryLimits = {},
): ValidatorHistoryStore {
  const maxSourceRows = limits.maxSourceRows ?? 200000,
    maxPageBytes = limits.maxPageBytes ?? 32 * 1024 * 1024,
    pageRows = limits.pageRows ?? 512,
    maxDurationMillis = limits.maxDurationMillis ?? 20000;
  if (
    !Number.isSafeInteger(maxSourceRows) ||
    maxSourceRows < 1 ||
    maxSourceRows > 200000 ||
    !Number.isSafeInteger(maxPageBytes) ||
    maxPageBytes < 1 ||
    maxPageBytes > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(pageRows) ||
    pageRows < 1 ||
    pageRows > 512 ||
    !Number.isSafeInteger(maxDurationMillis) ||
    maxDurationMillis < 1 ||
    maxDurationMillis > 60000
  )
    throw new RangeError("Invalid native validator history resource bounds");
  return {
    async rows(hotkey, cutoff, limit, netuid) {
      if (
        typeof hotkey !== "string" ||
        (cutoff !== null && typeof cutoff !== "string") ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 10000
      )
        throw new TypeError("Invalid bounded native validator history query");
      let network: string | undefined;
      if (netuid !== undefined) {
        if (!Number.isFinite(netuid) || !Number.isInteger(netuid))
          throw new TypeError("Invalid native validator history netuid");
        const integer = BigInt(netuid);
        if (integer < -(1n << 63n) || integer >= 1n << 63n) return [];
        network = integer.toString();
      }
      return runtime.transaction(
        async (scope) => {
          const exceptional = /\0|[\uD800-\uDFFF]/u.test(hotkey);
          const baseValues: unknown[] = [
            exceptional ? Buffer.from(hotkey) : hotkey,
          ];
          const basePredicates = [
            exceptional
              ? "convert_to(m.hotkey,'UTF8')=$1::bytea"
              : "m.hotkey=$1::text",
          ];
          if (cutoff !== null) {
            baseValues.push(cutoff);
            basePredicates.push(
              `m.snapshot_date >= $${baseValues.length}::text COLLATE "C"`,
            );
          }
          if (network !== undefined) {
            baseValues.push(network);
            basePredicates.push(`m.netuid=$${baseValues.length}::bigint`);
          }
          let cursor: Part | undefined,
            capacity = pageRows,
            sourceRows = 0,
            done = false;
          const deadline = performance.now() + maxDurationMillis;
          const scoped: Record<string, unknown>[] = [];
          const grouped = new Map<
            string,
            {
              networks: Set<string>;
              stake: ReturnType<typeof createSqliteSum>;
              emission: ReturnType<typeof createSqliteSum>;
            }
          >();
          let lastDay: string | undefined;
          while (!done) {
            if (performance.now() >= deadline)
              throw new RangeError(
                "Validator history exceeded its work deadline",
              );
            const values = [...baseValues],
              predicates = [...basePredicates];
            if (cursor) {
              const day = values.push(cursor.day),
                net = values.push(cursor.netuid),
                uid = values.push(cursor.uid);
              predicates.push(
                `(m.snapshot_date<$${day}::text COLLATE "C" OR (m.snapshot_date=$${day}::text COLLATE "C" AND (m.netuid>$${net}::bigint OR (m.netuid=$${net}::bigint AND m.uid>$${uid}::bigint))))`,
              );
            }
            const parts = await scope.query<Part>(
              `WITH selected AS MATERIALIZED (
            SELECT m.netuid,m.uid,m.snapshot_date,m.shard FROM app.neuron_daily_members m JOIN app.neuron_daily_documents d
              ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard
            WHERE ${predicates.join(" AND ")} ORDER BY m.snapshot_date COLLATE "C" DESC,m.netuid,m.uid LIMIT ${capacity + 1}
          ), page_members AS MATERIALIZED (
            SELECT * FROM selected ORDER BY snapshot_date COLLATE "C" DESC,netuid,uid LIMIT ${capacity}
          ), documents AS MATERIALIZED (
            SELECT d.* FROM app.neuron_daily_documents d JOIN (SELECT DISTINCT netuid,snapshot_date,shard FROM page_members) s
            ON d.netuid=s.netuid AND d.day=s.snapshot_date AND d.shard=s.shard
          ), budget AS (SELECT COALESCE(SUM(octet_length(payload)),0) AS bytes FROM documents)
          SELECT 0 AS kind,d.netuid::text,CASE WHEN octet_length(d.day)<=128 THEN d.day END AS day,d.shard::text,NULL::text AS uid,
            CASE WHEN budget.bytes<=${maxPageBytes} THEN d.payload END AS payload,
            budget.bytes>${maxPageBytes} OR octet_length(d.day)>128 AS overflow,
            NULL::double precision AS total_stake_tao,NULL::double precision AS tao_in_pool_tao,NULL::double precision AS alpha_in_pool
            FROM documents d CROSS JOIN budget
          UNION ALL SELECT 1,m.netuid::text,CASE WHEN octet_length(m.snapshot_date)<=128 THEN m.snapshot_date END,m.shard::text,m.uid::text,NULL::bytea,
            octet_length(m.snapshot_date)>128,NULL::double precision,NULL::double precision,NULL::double precision FROM selected m
          UNION ALL SELECT 2,s.netuid::text,CASE WHEN octet_length(s.snapshot_date)<=128 THEN s.snapshot_date END,NULL::text,NULL::text,NULL::bytea,
            octet_length(s.snapshot_date)>128,s.total_stake_tao,s.tao_in_pool_tao,s.alpha_in_pool FROM app.subnet_snapshots s
            JOIN (SELECT DISTINCT netuid,snapshot_date FROM page_members) m ON m.netuid=s.netuid AND m.snapshot_date=s.snapshot_date`,
              values,
            );
            if (parts.some((part) => part.day === null))
              throw new RangeError(
                "Validator history source day exceeds its budget",
              );
            if (parts.some((part) => part.overflow)) {
              if (capacity === 1)
                throw new RangeError(
                  "Validator history document exceeds its page budget",
                );
              capacity = Math.max(1, Math.floor(capacity / 2));
              continue;
            }
            const allMembers = parts
              .filter((part) => part.kind === 1)
              .sort(memberOrder);
            if (allMembers.length > capacity + 1)
              throw new RangeError(
                "Validator history page exceeds its source budget",
              );
            const members = allMembers.slice(0, capacity);
            if (!members.length) break;
            const byDocument = new Map<string, string[]>();
            for (const part of members) {
              const key = identity(part);
              const group = byDocument.get(key) ?? [];
              group.push(part.uid!);
              byDocument.set(key, group);
            }
            const projections = new Map<
              string,
              Map<string, Record<string, SqliteDocumentValue>>
            >();
            const snapshots = new Map(
              parts
                .filter((part) => part.kind === 2)
                .map((part) => [JSON.stringify([part.netuid, part.day]), part]),
            );
            for (const part of parts) {
              if (part.kind !== 0 || !byDocument.has(identity(part))) continue;
              if (part.payload === null)
                throw new Error("Missing native validator daily document");
              projections.set(
                identity(part),
                new Map(
                  decoder
                    .memberMetrics(
                      part.payload,
                      fields,
                      byDocument.get(identity(part))!,
                    )
                    .map((entry) => [entry.key, entry.values]),
                ),
              );
            }
            for (const member of members) {
              if (
                network === undefined &&
                grouped.size === limit &&
                member.day !== lastDay
              ) {
                done = true;
                break;
              }
              if (++sourceRows > maxSourceRows)
                throw new RangeError(
                  "Validator history exceeds its complete source budget",
                );
              const projected = projections
                .get(identity(member))
                ?.get(member.uid!);
              if (!projected)
                throw new Error("Missing native validator daily projection");
              if (
                network === undefined &&
                projected.validator_permit !== 1n &&
                projected.validator_permit !== 1
              )
                continue;
              const snapshot = snapshots.get(
                JSON.stringify([member.netuid, member.day]),
              );
              const price =
                member.netuid === "0"
                  ? 1n
                  : decoder.arithmetic(
                      "divide",
                      snapshot?.tao_in_pool_tao ?? null,
                      snapshot?.alpha_in_pool ?? null,
                    );
              const stake = decoder.arithmetic(
                  "multiply",
                  projected.stake_tao,
                  price,
                ),
                emission = decoder.arithmetic(
                  "multiply",
                  projected.emission_tao,
                  price,
                );
              if (network !== undefined) {
                scoped.push({
                  snapshot_date: member.day,
                  subnet_count: 1,
                  netuid: Number(member.netuid),
                  uid: Number(member.uid),
                  stake_alpha: wire(projected.stake_tao),
                  emission_alpha: wire(projected.emission_tao),
                  validator_trust: wire(projected.validator_trust),
                  consensus: wire(projected.consensus),
                  dividends: wire(projected.dividends),
                  take: wire(projected.take),
                  validator_permit: wire(projected.validator_permit),
                  subnet_total_stake: wire(snapshot?.total_stake_tao ?? null),
                  total_stake_tao: wire(stake),
                  total_emission_tao: wire(emission),
                });
                if (scoped.length === limit) {
                  done = true;
                  break;
                }
              } else {
                const group = grouped.get(member.day!) ?? {
                  networks: new Set<string>(),
                  stake: createSqliteSum(),
                  emission: createSqliteSum(),
                };
                group.networks.add(member.netuid);
                add(group.stake, stake);
                add(group.emission, emission);
                grouped.set(member.day!, group);
                lastDay = member.day!;
              }
            }
            cursor = members.at(-1)!;
            if (allMembers.length <= capacity) done = true;
            capacity = pageRows;
          }
          if (performance.now() >= deadline)
            throw new RangeError(
              "Validator history exceeded its work deadline",
            );
          if (network !== undefined) return scoped;
          return [...grouped].map(([day, group]) => ({
            snapshot_date: day,
            subnet_count: group.networks.size,
            total_stake_tao: wire(group.stake.value()?.value ?? null),
            total_emission_tao: wire(group.emission.value()?.value ?? null),
          }));
        },
        { isolation: "repeatable read" },
      );
    },
  };
}
