import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { SqliteDocumentValue } from "./sqlite-document-decoder.ts";
import { createSqliteSum } from "./sqlite-sum.ts";
import type { NeuronAggregateStore } from "./neuron-aggregate-store.ts";
import {
  compareSqliteMetric,
  sqliteMetricWireValue,
} from "./sqlite-metric-value.ts";

interface Decoder {
  metricEntries(
    payload: Uint8Array,
    names: readonly string[],
    keys?: readonly string[],
    includeTextBytes?: boolean,
  ): {
    key: string;
    values: Record<string, SqliteDocumentValue>;
    textBytes?: Record<string, Uint8Array>;
  }[];
  numericAffinity(value: SqliteDocumentValue): bigint | number | null;
}
interface Part {
  kind: number;
  netuid: string;
  shard: string;
  uid: string | null;
  payload: Uint8Array | null;
}
type JsonScalar = Exclude<SqliteDocumentValue, Uint8Array>;

function compareNumeric(left: bigint | number, right: bigint | number): number {
  // Relational BigInt/Number comparison is exact; converting the integer to a
  // Number first would change ordering above JavaScript's safe integer range.
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Count accepted members separately from duplicate metric entries, as the
 * original aggregate query does. Both source families share one PG snapshot. */
export function createPgNeuronAggregateStore(
  runtime: Pick<PgStoreRuntime, "read">,
  decoder: Decoder,
): NeuronAggregateStore {
  return {
    async aggregateRows() {
      const parts = await runtime.read
        .query<Part>(`SELECT 0 AS kind,d.netuid::text,d.shard::text,NULL::text AS uid,d.payload
        FROM app.neurons_documents d WHERE d.day=''
        UNION ALL
        SELECT 1,m.netuid::text,m.shard::text,m.uid::text,NULL::bytea
        FROM app.neurons_members m JOIN app.neurons_documents d
          ON d.netuid=m.netuid AND d.day='' AND d.shard=m.shard`);
      const members = new Map<string, string[]>();
      const groups = new Map<
        string,
        {
          count: number;
          validators: number;
          sum: ReturnType<typeof createSqliteSum>;
          max: JsonScalar;
          maxBytes?: Uint8Array;
        }
      >();
      const key = (part: Part) => `${part.netuid}:${part.shard}`;
      for (const part of parts) {
        if (part.kind !== 1) continue;
        const keys = members.get(key(part)) ?? [];
        keys.push(part.uid!);
        members.set(key(part), keys);
        const group = groups.get(part.netuid) ?? {
          count: 0,
          validators: 0,
          sum: createSqliteSum(),
          max: null,
        };
        group.count++;
        groups.set(part.netuid, group);
      }
      const documents = parts.filter((part) => part.kind === 0);
      documents.sort(
        (left, right) =>
          compareNumeric(BigInt(left.netuid), BigInt(right.netuid)) ||
          compareNumeric(BigInt(left.shard), BigInt(right.shard)),
      );
      for (const document of documents) {
        const keys = members.get(key(document));
        if (!keys) continue;
        if (document.payload === null)
          throw new Error("Missing native aggregate document");
        const group = groups.get(document.netuid)!;
        for (const { values, textBytes } of decoder.metricEntries(
          document.payload,
          ["validator_permit", "stake_tao"],
          keys,
          true,
        )) {
          const original = values.stake_tao;
          if (original instanceof Uint8Array)
            throw new TypeError("JSON aggregate metric cannot be a BLOB");
          if (
            typeof original === "string" &&
            textBytes?.stake_tao === undefined
          )
            throw new Error("Missing native aggregate text bytes");
          const permit = decoder.numericAffinity(values.validator_permit);
          if (permit !== null && permit !== 0n && permit !== 0)
            group.validators++;
          const stake = decoder.numericAffinity(values.stake_tao);
          group.sum.add(
            stake === null
              ? null
              : typeof stake === "bigint"
                ? { kind: "integer", value: stake }
                : { kind: "real", value: stake },
          );
          if (
            compareSqliteMetric(
              original,
              textBytes?.stake_tao,
              group.max,
              group.maxBytes,
            ) > 0
          ) {
            group.max = original;
            group.maxBytes = textBytes?.stake_tao;
          }
        }
      }
      return [...groups]
        .sort(([left], [right]) => compareNumeric(BigInt(left), BigInt(right)))
        .map(([netuid, group]) => ({
          netuid: Number(netuid),
          uid_count: group.count,
          validator_count: group.validators,
          total_stake_alpha: sqliteMetricWireValue(
            group.sum.value()?.value ?? null,
          ),
          max_stake_alpha: sqliteMetricWireValue(group.max),
        }));
    },
  };
}
