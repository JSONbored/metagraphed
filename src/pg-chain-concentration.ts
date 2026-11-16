import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { createSqliteDocumentDecoder } from "./sqlite-document-decoder.ts";
import { sqliteMetricWireValue } from "./sqlite-metric-value.ts";
import type { ChainConcentrationStore } from "./chain-concentration-store.ts";

interface Part {
  kind: number;
  netuid: string;
  shard: string;
  uid: string | null;
  coldkey: string | null;
  payload: Uint8Array | null;
}

/** Source documents and accepted memberships share one PostgreSQL snapshot.
 * Decode every matching json_each entry, including duplicate and aliased keys. */
export function createPgChainConcentrationStore(
  runtime: Pick<PgStoreRuntime, "read" | "producer">,
  decoder: Pick<
    ReturnType<typeof createSqliteDocumentDecoder>,
    "metricEntries"
  >,
): ChainConcentrationStore {
  return {
    async pendingDays(beforeDay, limit) {
      const rows = await runtime.read.query<{ day: string }>(
        `SELECT d.day FROM app.neuron_daily_documents d
        LEFT JOIN app.chain_concentration_daily c ON c.day=d.day
        WHERE c.day IS NULL AND d.day<$1 AND EXISTS (
          SELECT 1 FROM app.neuron_daily_members m WHERE m.netuid=d.netuid
            AND m.snapshot_date=d.day AND m.shard=d.shard)
        GROUP BY d.day ORDER BY d.day DESC LIMIT $2`,
        [beforeDay, limit],
      );
      return rows.map((row) => row.day);
    },
    async dailyRows(day) {
      const parts = await runtime.read.query<Part>(
        `SELECT 0 AS kind,d.netuid::text,d.shard::text,NULL::text AS uid,
          NULL::text AS coldkey,d.payload
        FROM app.neuron_daily_documents d WHERE d.day=$1
        UNION ALL
        SELECT 1,m.netuid::text,m.shard::text,m.uid::text,m.coldkey,NULL::bytea
        FROM app.neuron_daily_members m JOIN app.neuron_daily_documents d
          ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard
        WHERE d.day=$1`,
        [day],
      );
      const members = new Map<string, Map<string, Part>>();
      const identity = (part: Part) => `${part.netuid}:${part.shard}`;
      for (const part of parts) {
        if (part.kind !== 1) continue;
        const map = members.get(identity(part)) ?? new Map<string, Part>();
        map.set(part.uid!, part);
        members.set(identity(part), map);
      }
      const documents = parts.filter((part) => part.kind === 0);
      const compare = (left: string, right: string) =>
        BigInt(left) < BigInt(right)
          ? -1
          : BigInt(left) > BigInt(right)
            ? 1
            : 0;
      documents.sort(
        (left, right) =>
          compare(left.netuid, right.netuid) ||
          compare(left.shard, right.shard),
      );
      const rows: Record<string, unknown>[] = [];
      for (const document of documents) {
        const accepted = members.get(identity(document));
        if (!accepted?.size) continue;
        if (document.payload === null)
          throw new Error("Missing native concentration document");
        for (const entry of decoder.metricEntries(
          document.payload,
          ["stake_tao", "emission_tao", "validator_permit", "captured_at"],
          [...accepted.keys()],
          false,
          "integer",
        )) {
          if (entry.integerKey === undefined)
            throw new Error("Missing concentration integer key");
          const member = accepted.get(entry.integerKey.toString());
          if (!member) throw new Error("Unmatched concentration member");
          rows.push({
            ...Object.fromEntries(
              Object.entries(entry.values).map(([name, value]) => [
                name,
                sqliteMetricWireValue(value),
              ]),
            ),
            coldkey: member.coldkey,
            netuid: Number(member.netuid),
          });
        }
      }
      return rows;
    },
    async put(record) {
      const result = await runtime.producer.run(
        `INSERT INTO app.chain_concentration_daily
          (day,neuron_count,card,source_captured_at,computed_at,builder_version)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(day) DO UPDATE SET neuron_count=excluded.neuron_count,
          card=excluded.card,source_captured_at=excluded.source_captured_at,
          computed_at=excluded.computed_at,builder_version=excluded.builder_version`,
        [
          record.day,
          record.neuronCount,
          record.card,
          record.capturedAt,
          record.computedAt,
          record.builderVersion,
        ],
      );
      if (result.changes !== 1)
        throw new Error("Native concentration card was not committed");
    },
  };
}
