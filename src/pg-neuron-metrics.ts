import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type {
  createSqliteDocumentDecoder,
  SqliteDocumentValue,
} from "./sqlite-document-decoder.ts";
import type { NeuronMetricStore } from "./neuron-metric-store.ts";
import { CHAIN_PERFORMANCE_READ_COLUMNS } from "./chain-performance.ts";
import { NEURON_COLUMNS } from "./metagraph-neurons.ts";

interface Part {
  kind: number;
  netuid: string;
  shard: string;
  snapshot_date: string;
  uid: string | null;
  hotkey: string | null;
  coldkey: string | null;
  payload: Uint8Array | null;
}

const identities = new Set(["snapshot_date", "uid", "hotkey", "coldkey"]);
const dailyFields = new Set(["snapshot_date", ...NEURON_COLUMNS.split(", ")]);
const performanceFields = CHAIN_PERFORMANCE_READ_COLUMNS.split(", ");

function numberAtBoundary(value: SqliteDocumentValue): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function projectParts(
  parts: Part[],
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
  names: readonly string[],
  daily: boolean,
): Record<string, unknown>[] {
  const metrics = names.filter(
    (name) => !identities.has(name) && name !== "netuid",
  );
  const documents = new Map<
    string,
    Map<string, Record<string, SqliteDocumentValue>[]>
  >();
  const key = (part: Part) =>
    `${part.netuid}:${part.snapshot_date}:${part.shard}`;
  const members = parts.filter((part) => part.kind === 1);
  const memberKeys = new Map<string, string[]>();
  for (const member of members) {
    const keys = memberKeys.get(key(member)) ?? [];
    keys.push(member.uid!);
    memberKeys.set(key(member), keys);
  }
  for (const part of parts) {
    if (part.kind !== 0) continue;
    if (part.payload === null)
      throw new Error("Missing native metric document");
    const values = new Map<string, Record<string, SqliteDocumentValue>[]>();
    for (const entry of decoder.metricEntries(
      part.payload,
      metrics,
      memberKeys.get(key(part)) ?? [],
    )) {
      const matches = values.get(entry.key) ?? [];
      matches.push(entry.values);
      values.set(entry.key, matches);
    }
    documents.set(key(part), values);
  }
  members.sort((left, right) => {
    if (daily && left.snapshot_date !== right.snapshot_date)
      return Buffer.compare(
        Buffer.from(right.snapshot_date),
        Buffer.from(left.snapshot_date),
      );
    const networkOrder = BigInt(left.netuid) - BigInt(right.netuid);
    if (!daily && networkOrder !== 0n) return networkOrder < 0n ? -1 : 1;
    const uidOrder = BigInt(left.uid!) - BigInt(right.uid!);
    return uidOrder < 0n ? -1 : uidOrder > 0n ? 1 : 0;
  });
  return members.flatMap((part) => {
    const document = documents.get(key(part));
    if (!document) throw new Error("Missing native member document");
    const entries = document.get(part.uid!) ?? [null];
    return entries.map((entry) =>
      Object.fromEntries(
        names.map((name) => {
          const value =
            name === "netuid"
              ? BigInt(part.netuid)
              : name === "uid"
                ? BigInt(part.uid!)
                : name === "snapshot_date"
                  ? part.snapshot_date
                  : name === "hotkey"
                    ? part.hotkey
                    : name === "coldkey"
                      ? part.coldkey
                      : (entry?.[name] ?? null);
          return [name, numberAtBoundary(value)];
        }),
      ),
    );
  });
}

/** These readers preserve the optimized source's entry multiplicity and exact
 * string-key join. Their semantics intentionally differ from JSON.parse and
 * from the point-history SQL view's first-key extraction. */
export function createPgNeuronMetricStore(
  runtime: Pick<PgStoreRuntime, "read">,
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
): NeuronMetricStore {
  return {
    async performanceRows() {
      const parts = await runtime.read
        .query<Part>(`SELECT 0 AS kind,d.netuid::text,d.shard::text,''::text AS snapshot_date,
        NULL::text AS uid,NULL::text AS hotkey,NULL::text AS coldkey,d.payload
        FROM app.neurons_documents d WHERE d.day=''
        UNION ALL
        SELECT 1,m.netuid::text,m.shard::text,''::text,m.uid::text,m.hotkey,m.coldkey,NULL::bytea
        FROM app.neurons_members m JOIN app.neurons_documents d
          ON d.netuid=m.netuid AND d.day='' AND d.shard=m.shard`);
      return projectParts(parts, decoder, performanceFields, false);
    },
    async dailyRows<Row>(
      netuid: number,
      cutoff: string | null,
      columns: readonly string[],
      limit: number,
    ) {
      if (!Number.isInteger(netuid) || !Number.isFinite(netuid))
        throw new TypeError("Invalid native neuron metric identity");
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        columns.length === 0 ||
        new Set(columns).size !== columns.length ||
        columns.some((name) => !dailyFields.has(name))
      )
        throw new TypeError("Invalid bounded native neuron metric projection");
      const network = BigInt(netuid);
      if (network < -(1n << 63n) || network >= 1n << 63n) return [];
      const parts = await runtime.read.query<Part>(
        `WITH selected AS MATERIALIZED (
        SELECT m.* FROM app.neuron_daily_members m JOIN app.neuron_daily_documents d
          ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard
        WHERE m.netuid=$1::bigint AND m.snapshot_date >= $2::text COLLATE "C"
        ORDER BY m.snapshot_date DESC,m.uid LIMIT $3
      ), documents AS (
        SELECT d.* FROM app.neuron_daily_documents d JOIN (
          SELECT DISTINCT snapshot_date,shard FROM selected
        ) s ON d.netuid=$1::bigint AND d.day=s.snapshot_date AND d.shard=s.shard
      )
      SELECT 0 AS kind,d.netuid::text,d.shard::text,d.day AS snapshot_date,
        NULL::text AS uid,NULL::text AS hotkey,NULL::text AS coldkey,d.payload FROM documents d
      UNION ALL
      SELECT 1,m.netuid::text,m.shard::text,m.snapshot_date,m.uid::text,m.hotkey,m.coldkey,NULL::bytea FROM selected m`,
        [network.toString(), cutoff, limit],
      );
      return projectParts(parts, decoder, columns, true) as Row[];
    },
  };
}
