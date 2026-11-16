import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type {
  createSqliteDocumentDecoder,
  SqliteDocumentValue,
} from "./sqlite-document-decoder.ts";
import {
  NEURON_ECONOMICS_FIELDS,
  type NeuronLiveStore,
  type NeuronDirectoryRow,
} from "./neuron-live-store.ts";
import {
  EconomicsValuesSchema,
  sqliteJsonColumn,
} from "./neuron-snapshot-read.ts";
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

function integerOrder(left: string, right: string): number {
  const a = BigInt(left),
    b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function metric(value: SqliteDocumentValue, bytes: Uint8Array | undefined) {
  if (value instanceof Uint8Array)
    throw new TypeError("JSON live metric cannot be a BLOB");
  if (typeof value === "string" && bytes === undefined)
    throw new Error("Missing native live metric text bytes");
  return value;
}

/** Read each bounded document once with its accepted memberships in the same
 * statement. The codec retains duplicate keys and each source query's join. */
export function createPgNeuronLiveStore(
  runtime: Pick<PgStoreRuntime, "read">,
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
): NeuronLiveStore {
  async function parts(netuid?: number) {
    if (
      netuid !== undefined &&
      (!Number.isInteger(netuid) || !Number.isFinite(netuid))
    )
      throw new TypeError("Invalid native neuron live identity");
    if (
      netuid !== undefined &&
      (BigInt(netuid) < -(1n << 63n) || BigInt(netuid) >= 1n << 63n)
    )
      return [];
    const filter = netuid === undefined ? "" : " AND d.netuid=$1::bigint";
    const rows = await runtime.read.query<Part>(
      `SELECT 0 AS kind,d.netuid::text,d.shard::text,
      NULL::text AS uid,NULL::text AS hotkey,NULL::text AS coldkey,d.payload
      FROM app.neurons_documents d WHERE d.day=''${filter}
      UNION ALL
      SELECT 1,m.netuid::text,m.shard::text,m.uid::text,m.hotkey,m.coldkey,NULL::bytea
      FROM app.neurons_members m JOIN app.neurons_documents d
        ON d.netuid=m.netuid AND d.day='' AND d.shard=m.shard${filter}`,
      netuid === undefined ? [] : [BigInt(netuid).toString()],
    );
    const key = (part: Part) => `${part.netuid}:${part.shard}`;
    const members = new Map<string, Map<string, Part>>();
    for (const row of rows) {
      if (row.kind !== 1) continue;
      const shard = members.get(key(row)) ?? new Map<string, Part>();
      shard.set(row.uid!, row);
      members.set(key(row), shard);
    }
    return rows
      .filter((row) => row.kind === 0)
      .sort(
        (a, b) =>
          integerOrder(a.netuid, b.netuid) || integerOrder(a.shard, b.shard),
      )
      .flatMap((row) => {
        const accepted = members.get(key(row)) ?? new Map<string, Part>();
        if (row.payload === null)
          throw new Error("Missing native live document");
        return [{ ...row, payload: row.payload, members: accepted }];
      });
  }
  return {
    async newestCapture() {
      let maximum: SqliteMetricScalar = null;
      let maximumBytes: Uint8Array | undefined;
      for (const part of await parts()) {
        for (const entry of decoder.metricEntries(
          part.payload,
          ["captured_at"],
          [...part.members.keys()],
          true,
        )) {
          const value = metric(
            entry.values.captured_at,
            entry.textBytes?.captured_at,
          );
          if (
            compareSqliteMetric(
              value,
              entry.textBytes?.captured_at,
              maximum,
              maximumBytes,
            ) > 0
          ) {
            maximum = value;
            maximumBytes = entry.textBytes?.captured_at;
          }
        }
      }
      return Number(sqliteMetricWireValue(maximum));
    },
    async economicsRows(netuid) {
      const result: {
        network: string;
        uid: string;
        row: Record<string, unknown>;
      }[] = [];
      for (const part of await parts(netuid)) {
        if (netuid === undefined && BigInt(part.netuid) === 0n) continue;
        for (const entry of decoder.metricTuples(
          part.payload,
          NEURON_ECONOMICS_FIELDS,
          [...part.members.keys()],
          "integer",
        )) {
          const member = part.members.get(entry.integerKey!.toString())!;
          const values = EconomicsValuesSchema.parse(
            JSON.parse(entry.json ?? "null"),
          );
          result.push({
            network: part.netuid,
            uid: member.uid!,
            row: {
              ...(netuid === undefined ? { netuid: Number(part.netuid) } : {}),
              uid: Number(member.uid),
              hotkey: member.hotkey,
              ...Object.fromEntries(
                NEURON_ECONOMICS_FIELDS.map((name, index) => [
                  name,
                  sqliteJsonColumn(values[index]),
                ]),
              ),
            },
          });
        }
      }
      return result
        .sort(
          (a, b) =>
            Number(a.network) - Number(b.network) ||
            Number(a.uid) - Number(b.uid),
        )
        .map(({ row }) => row);
    },
    async directoryRows(validatorsOnly = false) {
      const fields = validatorsOnly
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
      const projection = validatorsOnly
        ? [...fields, "validator_permit"]
        : fields;
      const result: {
        network: string;
        uid: string;
        stake: SqliteMetricScalar;
        stakeBytes?: Uint8Array;
        row: NeuronDirectoryRow;
      }[] = [];
      for (const part of await parts()) {
        if (validatorsOnly)
          decoder.validateMetricEntries(part.payload, "validator_permit");
        const keys = [...part.members]
          .filter(([, member]) => member.hotkey !== null)
          .map(([uid]) => uid);
        for (const entry of decoder.metricEntries(
          part.payload,
          projection,
          keys,
          true,
          "integer",
        )) {
          if (
            validatorsOnly &&
            entry.values.validator_permit !== 1n &&
            entry.values.validator_permit !== 1
          )
            continue;
          const member = part.members.get(entry.integerKey!.toString())!;
          const stake = metric(
            entry.values.stake_tao,
            entry.textBytes?.stake_tao,
          );
          result.push({
            network: part.netuid,
            uid: member.uid!,
            stake,
            stakeBytes: entry.textBytes?.stake_tao,
            row: {
              netuid: Number(part.netuid),
              uid: Number(member.uid),
              hotkey: member.hotkey!,
              coldkey: member.coldkey,
              ...Object.fromEntries(
                fields.map((name) => [
                  name,
                  sqliteMetricWireValue(entry.values[name]),
                ]),
              ),
            },
          });
        }
      }
      return result
        .sort(
          (a, b) =>
            Buffer.compare(
              Buffer.from(a.row.hotkey),
              Buffer.from(b.row.hotkey),
            ) ||
            compareSqliteMetric(b.stake, b.stakeBytes, a.stake, a.stakeBytes) ||
            integerOrder(a.network, b.network) ||
            integerOrder(a.uid, b.uid),
        )
        .map(({ row }) => row);
    },
  };
}
