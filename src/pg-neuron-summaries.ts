import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type {
  createSqliteDocumentDecoder,
  SqliteMetricEntry,
  SqliteDocumentValue,
} from "./sqlite-document-decoder.ts";
import type {
  NeuronSummaryStore,
  NeuronDailyRollup,
} from "./neuron-summary-store.ts";
import {
  compareSqliteMetric,
  sqliteMetricWireValue,
  type SqliteMetricScalar,
} from "./sqlite-metric-value.ts";
import { createSqliteSum } from "./sqlite-sum.ts";

interface Part {
  kind: number;
  netuid: string;
  shard: string;
  day: string;
  uid: string | null;
  hotkey: string | null;
  payload: Uint8Array | null;
  receipt: {
    captured_at: string;
    expected_rows: string;
    received_rows: string;
    completed_at: string | null;
  } | null;
}
interface Document extends Part {
  payload: Uint8Array;
  members: Map<string, Part>;
}
function numericOrder(left: string, right: string) {
  const a = BigInt(left),
    b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
const textOrder = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
function metric(entry: SqliteMetricEntry, name: string): SqliteMetricScalar {
  const value = entry.values[name];
  if (value instanceof Uint8Array)
    throw new TypeError("JSON summary metric cannot be a BLOB");
  if (typeof value === "string" && !entry.textBytes?.[name])
    throw new Error("Missing native summary text bytes");
  return value;
}

/** One snapshot binds source documents, memberships and optional pass receipts.
 * Raw SQLite documents remain authoritative; PostgreSQL owns persistence. */
export function createPgNeuronSummaryStore(
  runtime: Pick<PgStoreRuntime, "read">,
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
): NeuronSummaryStore {
  async function readParts(
    daily: boolean,
    predicate: string,
    params: unknown[],
    receipts = false,
  ) {
    const documents = daily ? "neuron_daily_documents" : "neurons_documents";
    const members = daily ? "neuron_daily_members" : "neurons_members";
    const day = daily ? "m.snapshot_date" : "''::text";
    const rows = await runtime.read.query<Part>(
      `SELECT 0 AS kind,d.netuid::text,d.shard::text,d.day,
      NULL::text AS uid,NULL::text AS hotkey,d.payload,NULL::jsonb AS receipt
      FROM app.${documents} d WHERE ${predicate}
      UNION ALL
      SELECT 1,m.netuid::text,m.shard::text,${day},m.uid::text,m.hotkey,NULL::bytea,NULL::jsonb
      FROM app.${members} m JOIN app.${documents} d ON d.netuid=m.netuid
        AND d.shard=m.shard AND ${daily ? "d.day=m.snapshot_date" : "d.day=''"}
      WHERE ${predicate}${
        receipts
          ? ` UNION ALL SELECT 2,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::bytea,
      jsonb_build_object('captured_at',p.captured_at::text,'expected_rows',p.expected_rows::text,
      'received_rows',p.received_rows::text,'completed_at',p.completed_at::text) FROM app.neurons_passes p`
          : ""
      }`,
      params,
    );
    const identity = (row: Part) => `${row.netuid}:${row.day}:${row.shard}`;
    const accepted = new Map<string, Map<string, Part>>();
    for (const row of rows) {
      if (row.kind !== 1) continue;
      const map = accepted.get(identity(row)) ?? new Map<string, Part>();
      map.set(row.uid!, row);
      accepted.set(identity(row), map);
    }
    const parts: Document[] = rows
      .filter((row) => row.kind === 0)
      .sort(
        (a, b) =>
          numericOrder(a.netuid, b.netuid) ||
          textOrder(a.day, b.day) ||
          numericOrder(a.shard, b.shard),
      )
      .map((row) => {
        if (row.payload === null)
          throw new Error("Missing native summary document");
        return {
          ...row,
          payload: row.payload,
          members: accepted.get(identity(row)) ?? new Map<string, Part>(),
        };
      });
    return {
      parts,
      receipts: rows.filter((row) => row.kind === 2).map((row) => row.receipt!),
    };
  }
  const entries = (part: Document, names: readonly string[]) =>
    decoder.metricEntries(
      part.payload,
      names,
      [...part.members.keys()],
      true,
      "integer",
    );
  const add = (
    sum: ReturnType<typeof createSqliteSum>,
    value: SqliteDocumentValue,
  ) => {
    const numeric = decoder.numericAffinity(value);
    sum.add(
      numeric === null
        ? null
        : typeof numeric === "bigint"
          ? { kind: "integer", value: numeric }
          : { kind: "real", value: numeric },
    );
  };
  function totals(
    parts: Document[],
    includeNetwork: boolean,
  ): NeuronDailyRollup[] {
    const groups = new Map<
      string,
      {
        netuid: string;
        day: string;
        count: number;
        validators: number;
        stake: ReturnType<typeof createSqliteSum>;
        emission: ReturnType<typeof createSqliteSum>;
      }
    >();
    for (const part of parts) {
      for (const entry of entries(part, [
        "validator_permit",
        "stake_tao",
        "emission_tao",
      ])) {
        const key = `${part.netuid}:${part.day}`;
        const group = groups.get(key) ?? {
          netuid: part.netuid,
          day: part.day,
          count: 0,
          validators: 0,
          stake: createSqliteSum(),
          emission: createSqliteSum(),
        };
        group.count++;
        const permit = decoder.numericAffinity(entry.values.validator_permit);
        if (permit !== null && permit !== 0n && permit !== 0)
          group.validators++;
        add(group.stake, entry.values.stake_tao);
        add(group.emission, entry.values.emission_tao);
        groups.set(key, group);
      }
    }
    return [...groups.values()].map((group) => ({
      ...(includeNetwork ? { netuid: Number(group.netuid) } : {}),
      snapshot_date: group.day,
      neuron_count: group.count,
      validator_count: group.validators,
      total_stake_tao: sqliteMetricWireValue(
        group.stake.value()?.value ?? null,
      ) as number | null,
      total_emission_tao: sqliteMetricWireValue(
        group.emission.value()?.value ?? null,
      ) as number | null,
    }));
  }
  return {
    async dailyValidators(startDate, endDate) {
      const { parts } = await readParts(true, "d.day IN ($1::text,$2::text)", [
        startDate,
        endDate,
      ]);
      return parts.flatMap((part) => {
        decoder.validateMetricEntries(part.payload, "validator_permit");
        return entries(part, ["validator_permit"])
          .filter(
            (entry) =>
              entry.values.validator_permit === 1n ||
              entry.values.validator_permit === 1,
          )
          .map((entry) => ({
            snapshot_date: part.day,
            netuid: Number(part.netuid),
            hotkey: part.members.get(entry.integerKey!.toString())!.hotkey,
            validator_permit: 1,
          }));
      });
    },
    async dailyTotals(startDate, endDate) {
      return totals(
        (
          await readParts(true, "d.day IN ($1::text,$2::text)", [
            startDate,
            endDate,
          ])
        ).parts,
        true,
      );
    },
    async subnetHistory(netuid, cutoff, limit, before = null) {
      if (
        !Number.isInteger(netuid) ||
        !Number.isFinite(netuid) ||
        !Number.isSafeInteger(limit) ||
        limit < 1
      )
        throw new TypeError("Invalid native neuron history bounds");
      if (BigInt(netuid) < -(1n << 63n) || BigInt(netuid) >= 1n << 63n)
        return [];
      const params: unknown[] = [BigInt(netuid).toString()];
      const predicates = ["d.netuid=$1::bigint"];
      if (cutoff) {
        params.push(cutoff);
        predicates.push(`d.day >= $${params.length}::text COLLATE "C"`);
      }
      if (before) {
        params.push(before);
        predicates.push(`d.day < $${params.length}::text COLLATE "C"`);
      }
      return totals(
        (await readParts(true, predicates.join(" AND "), params)).parts,
        false,
      )
        .sort((a, b) => textOrder(b.snapshot_date, a.snapshot_date))
        .slice(0, limit);
    },
    async nominatorCounts(hotkeys) {
      const rows = await runtime.read.query<{
        hotkey: string;
        nominator_count: string | null;
        scan_at: string | null;
      }>(
        `SELECT k.hotkey,c.nominator_count::text,
        (SELECT MAX(captured_at)::text FROM app.validator_nominator_counts) AS scan_at
        FROM unnest($1::text[]) WITH ORDINALITY k(hotkey,ordinal)
        LEFT JOIN app.validator_nominator_counts c ON c.hotkey=k.hotkey ORDER BY k.ordinal`,
        [[...new Set(hotkeys)]],
      );
      return rows.map((row) => ({
        hotkey: row.hotkey,
        nominator_count:
          row.nominator_count === null ? null : Number(row.nominator_count),
        scan_at: row.scan_at === null ? null : Number(row.scan_at),
      }));
    },
    async completeRows() {
      const { parts, receipts } = await readParts(false, "d.day=''", [], true);
      const current: {
        netuid: string;
        entry: SqliteMetricEntry;
        capture: SqliteMetricScalar;
      }[] = [];
      let maximum: SqliteMetricScalar = null,
        maximumBytes: Uint8Array | undefined;
      for (const part of parts)
        for (const entry of entries(part, ["captured_at", "block_number"])) {
          const capture = metric(entry, "captured_at");
          current.push({ netuid: part.netuid, entry, capture });
          if (
            compareSqliteMetric(
              capture,
              entry.textBytes?.captured_at,
              maximum,
              maximumBytes,
            ) > 0
          ) {
            maximum = capture;
            maximumBytes = entry.textBytes?.captured_at;
          }
        }
      if (maximum === null) return [];
      const receipt = receipts.find((row) =>
        decoder.matchesInteger(maximum, BigInt(row.captured_at)),
      );
      if (
        !receipt ||
        receipt.completed_at === null ||
        BigInt(receipt.received_rows) < BigInt(receipt.expected_rows)
      )
        return [];
      const selected = current.filter(
        ({ capture, entry }) =>
          compareSqliteMetric(
            capture,
            entry.textBytes?.captured_at,
            maximum,
            maximumBytes,
          ) === 0,
      );
      if (BigInt(selected.length) !== BigInt(receipt.expected_rows)) return [];
      const groups = new Map<
        string,
        { value: SqliteMetricScalar; bytes?: Uint8Array }
      >();
      for (const { netuid, entry } of selected) {
        const value = metric(entry, "block_number"),
          prior = groups.get(netuid);
        if (
          !prior ||
          compareSqliteMetric(
            value,
            entry.textBytes?.block_number,
            prior.value,
            prior.bytes,
          ) > 0
        )
          groups.set(netuid, { value, bytes: entry.textBytes?.block_number });
      }
      return [...groups]
        .sort(([a], [b]) => numericOrder(a, b))
        .map(([netuid, block]) => ({
          netuid: Number(netuid),
          block_number: sqliteMetricWireValue(block.value),
        }));
    },
  };
}
