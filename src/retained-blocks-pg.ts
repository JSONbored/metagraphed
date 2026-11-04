import { z } from "zod";
import { BLOCKS_COLUMNS } from "../generated/lakehouse/types.ts";
import { BlocksRowSchema } from "../schemas-src/lakehouse.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgTransaction } from "./pg-pool.ts";
import { checkedRetainedBlockState } from "./retained-blocks-d1.ts";
import {
  retainedBlockDigest,
  type RetainedBlocksSyncInput,
} from "./retained-blocks-sync.ts";
import type { RetainedBlocksStore } from "./retained-blocks-store.ts";
import { internalJson } from "./internal-json.ts";

const integer = z.number().int().nonnegative().safe();
const sourceSchema = z.object({
  id: integer,
  network: z.union([z.literal(0), z.literal(1)]),
  source: z.string(),
  expected_rows: integer,
  received_rows: integer,
});
const fail = (status: number, error: string) => internalJson({ error }, status);
const netId = (network: string) => (network === "mainnet" ? 0 : 1);

async function begin(
  tx: PgTransaction,
  input: Extract<RetainedBlocksSyncInput, { kind: "begin" }>,
) {
  const descriptor = JSON.stringify(input.source);
  await tx.run(
    "INSERT INTO retained.history_block_sources(identity,network,source,expected_rows) " +
      "VALUES (?,?,?,?) ON CONFLICT(identity) DO NOTHING",
    [
      input.identity,
      netId(input.source.network),
      descriptor,
      input.source.rows,
    ],
  );
  const source = sourceSchema.parse(
    await tx.first(
      "SELECT * FROM retained.history_block_sources WHERE identity=?",
      [input.identity],
    ),
  );
  if (source.source !== descriptor)
    return fail(409, "source identity conflict");
  return internalJson({
    received_rows: source.received_rows,
    expected_rows: source.expected_rows,
  });
}

async function chunk(
  tx: PgTransaction,
  input: Extract<RetainedBlocksSyncInput, { kind: "chunk" }>,
) {
  const found = await tx.first(
    "SELECT * FROM retained.history_block_sources WHERE identity=? FOR UPDATE",
    [input.identity],
  );
  if (!found) return fail(404, "source is not registered");
  const source = sourceSchema.parse(found);
  const end = input.start + input.rows.length;
  if (end > source.expected_rows || input.start > source.received_rows) {
    return fail(409, "chunk exceeds source or skips rows");
  }
  const digest = retainedBlockDigest(input.rows);
  if (input.start < source.received_rows) {
    const prior = await tx.first<{ rows: number; digest: string }>(
      "SELECT rows,digest FROM retained.history_block_chunks WHERE source_id=? AND start_row=?",
      [source.id, input.start],
    );
    return prior?.digest === digest && prior.rows === input.rows.length
      ? internalJson({ received_rows: source.received_rows })
      : fail(409, "chunk identity conflict");
  }
  const json = JSON.stringify(input.rows);
  // A consistent author order avoids opposite unique-index lock ordering when
  // two independently locked sources introduce overlapping authors.
  await tx.run(
    "INSERT INTO retained.history_block_authors(address) " +
      'SELECT DISTINCT (value->>3) COLLATE "C" FROM jsonb_array_elements(?::jsonb) ' +
      "WHERE value->>3 IS NOT NULL ORDER BY 1 ON CONFLICT(address) DO NOTHING",
    [json],
  );
  for (const [kind, column] of [
    ["events", 5],
    ["extrinsics", 4],
  ] as const) {
    await tx.run(
      "INSERT INTO retained.history_block_source_counts(source_id,kind,value,rows) " +
        `SELECT ?,?,(value->>${column})::bigint,COUNT(*) FROM jsonb_array_elements(?::jsonb) ` +
        `WHERE value->>${column} IS NOT NULL GROUP BY value->>${column} ` +
        "ON CONFLICT(source_id,kind,value) DO UPDATE SET rows=history_block_source_counts.rows+excluded.rows",
      [source.id, kind, json],
    );
  }
  await tx.run(
    "INSERT INTO retained.history_blocks " +
      "SELECT ?,?,?+ordinality-1,(value->>0)::bigint,value->>1,value->>2," +
      "(SELECT id FROM retained.history_block_authors WHERE address=value->>3)," +
      "(value->>4)::bigint,(value->>5)::bigint,(value->>6)::bigint,(value->>7)::bigint " +
      "FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS input(value,ordinality)",
    [source.network, source.id, input.start, json],
  );
  await tx.run("INSERT INTO retained.history_block_chunks VALUES (?,?,?,?)", [
    source.id,
    input.start,
    input.rows.length,
    digest,
  ]);
  await tx.run(
    "UPDATE retained.history_block_sources SET received_rows=? WHERE id=?",
    [end, source.id],
  );
  return internalJson({ received_rows: end });
}

async function publish(
  tx: PgTransaction,
  input: Extract<RetainedBlocksSyncInput, { kind: "publish" }>,
  now: number,
) {
  if (
    new Set(input.sources).size !== input.sources.length ||
    input.generated_at > now ||
    now - input.generated_at > 7200000
  ) {
    return fail(400, "snapshot identity or freshness invalid");
  }
  const net = netId(input.network);
  // The namespace/network lock also serializes publishers before any state row
  // exists. A row lock alone cannot cover that first-publication race.
  await tx.query("SELECT pg_advisory_xact_lock(1297303,?::integer)", [net]);
  const counts = z
    .object({ files: integer, rows: integer })
    .parse(
      await tx.first(
        "SELECT COUNT(*) AS files,COALESCE(SUM(expected_rows),0)::bigint AS rows " +
          "FROM retained.history_block_sources WHERE network=? AND identity=ANY(?::text[]) " +
          "AND received_rows=expected_rows",
        [net, input.sources],
      ),
    );
  if (
    counts.files !== input.sources.length ||
    counts.rows !== input.source_rows
  ) {
    return fail(409, "snapshot source census incomplete");
  }
  const prior = await tx.first<{
    sequence: number;
    generated_at: number;
    table_uuid: string;
    snapshot: string;
  }>("SELECT * FROM retained.history_block_state WHERE network=? FOR UPDATE", [
    net,
  ]);
  if (
    prior &&
    (prior.sequence > input.sequence ||
      prior.generated_at > input.generated_at ||
      prior.table_uuid !== input.table_uuid ||
      (prior.sequence === input.sequence && prior.snapshot !== input.snapshot))
  ) {
    return fail(409, "snapshot cannot regress or replace its table identity");
  }
  await tx.run(
    "UPDATE retained.history_block_sources SET active=CASE WHEN identity=ANY(?::text[]) THEN 1 ELSE 0 END WHERE network=?",
    [input.sources, net],
  );
  await tx.run("DELETE FROM retained.history_block_counts WHERE network=?", [
    net,
  ]);
  await tx.run(
    "INSERT INTO retained.history_block_counts " +
      "SELECT ?,c.kind,c.value,SUM(c.rows) FROM retained.history_block_source_counts c " +
      "JOIN retained.history_block_sources s ON s.id=c.source_id WHERE s.network=? AND s.active=1 GROUP BY c.kind,c.value",
    [net, net],
  );
  const generation = retainedBlockDigest(input);
  await tx.run(
    "INSERT INTO retained.history_block_state VALUES (?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(network) DO UPDATE SET generation=excluded.generation,table_uuid=excluded.table_uuid," +
      "snapshot=excluded.snapshot,sequence=excluded.sequence,generated_at=excluded.generated_at," +
      "source_rows=excluded.source_rows,source_files=excluded.source_files,coverage=excluded.coverage",
    [
      net,
      generation,
      input.table_uuid,
      input.snapshot,
      input.sequence,
      input.generated_at,
      input.source_rows,
      input.sources.length,
      input.coverage,
    ],
  );
  return internalJson({
    generation,
    source_rows: input.source_rows,
    source_files: input.sources.length,
  });
}

/** Share the process pool while keeping the retained family in one transaction. */
export function createPgRetainedBlocks(
  runtime: Pick<PgStoreRuntime, "transaction">,
): RetainedBlocksStore {
  const state = async (tx: PgTransaction, net: number, now: number) =>
    checkedRetainedBlockState(
      await tx.first(
        "SELECT * FROM retained.history_block_state WHERE network=?",
        [net],
      ),
      net,
      now,
    );
  const from =
    " FROM retained.history_blocks b " +
    "JOIN retained.history_block_sources s ON s.id=b.source_id AND s.network=b.network AND s.active=1 " +
    "LEFT JOIN retained.history_block_authors a ON a.id=b.author_id ";
  return {
    sync(input, now) {
      return runtime.transaction(
        async (tx) => {
          if (input.kind === "begin") return begin(tx, input);
          if (input.kind === "chunk") return chunk(tx, input);
          if (input.kind === "publish") return publish(tx, input, now);
          const net = netId(input.network);
          const selected = await tx.first<{ generation: string }>(
            "SELECT * FROM retained.history_block_state WHERE network=?",
            [net],
          );
          if (
            input.generation !== undefined &&
            input.generation !== selected?.generation
          ) {
            return fail(409, "snapshot changed during status pagination");
          }
          const rows = await tx.query<{ id: number }>(
            "SELECT id,identity,source,expected_rows,received_rows FROM retained.history_block_sources " +
              "WHERE network=? AND active=1 AND id>? ORDER BY id LIMIT 201",
            [net, input.after],
          );
          const sources = rows.slice(0, 200);
          return internalJson({
            state: selected ?? null,
            sources,
            next_cursor: rows.length > 200 ? sources[199]!.id : null,
          });
        },
        input.kind === "status" ? { isolation: "repeatable read" } : undefined,
      );
    },
    census(network, now) {
      return runtime.transaction(
        async (tx) => {
          const net = netId(network);
          const selected = await state(tx, net, now);
          const counts = z
            .object({ files: integer, rows: integer, pending: integer })
            .parse(
              await tx.first(
                "SELECT COUNT(*) AS files,COALESCE(SUM(received_rows),0)::bigint AS rows," +
                  "COALESCE(SUM(expected_rows-received_rows),0)::bigint AS pending " +
                  "FROM retained.history_block_sources WHERE network=? AND active=1",
                [net],
              ),
            );
          const boundary = (direction: "ASC" | "DESC") =>
            tx.first<{ block_number: number }>(
              "SELECT b.block_number" +
                from +
                "WHERE b.network=? AND b.block_number IS NOT NULL " +
                `ORDER BY b.block_number ${direction} LIMIT 1`,
              [net],
            );
          const lo = await boundary("ASC"),
            hi = await boundary("DESC");
          const bounds = z
            .object({
              lo: z.number().int().safe().nullable(),
              hi: z.number().int().safe().nullable(),
            })
            .parse({
              lo: lo?.block_number ?? null,
              hi: hi?.block_number ?? null,
            });
          if (
            counts.pending !== 0 ||
            counts.files !== selected.source_files ||
            counts.rows !== selected.source_rows
          )
            return null;
          if (counts.rows === 0)
            return bounds.lo === null && bounds.hi === null
              ? { ...bounds, n: 0 }
              : null;
          if (bounds.lo === null || bounds.hi === null || bounds.lo > bounds.hi)
            return null;
          return { ...bounds, n: counts.rows };
        },
        { isolation: "repeatable read" },
      );
    },
    observedAt(height, network, now) {
      return runtime.transaction(
        async (tx) => {
          const net = netId(network);
          await state(tx, net, now);
          const row = z
            .object({ observed_at: integer.positive() })
            .parse(
              await tx.first(
                "SELECT b.observed_at" +
                  from +
                  "WHERE b.network=? AND b.block_number=? " +
                  "ORDER BY b.observed_at DESC NULLS LAST LIMIT 1",
                [net, height],
              ),
            );
          return new Date(row.observed_at).toISOString();
        },
        { isolation: "repeatable read" },
      );
    },
    rows(where, count, network, now, options) {
      return runtime.transaction(
        async (tx) => {
          const net = netId(network);
          await state(tx, net, now);
          for (const [kind, minimum] of [
            ["events", options.minEvents],
            ["extrinsics", options.minExtrinsics],
          ] as const) {
            if (minimum == null) continue;
            const census = z
              .object({ matches: integer })
              .parse(
                await tx.first(
                  "SELECT COALESCE(SUM(rows),0)::bigint AS matches FROM retained.history_block_counts " +
                    "WHERE network=? AND kind=? AND value>=?",
                  [net, kind, minimum],
                ),
              );
            if (census.matches === 0) return [];
          }
          // These predicates are produced by the existing block-feed guards and
          // cursor codec. Their SQL subset is shared; no SQLite SQL is rewritten.
          const projection = "SELECT b.*,a.address AS author" + from;
          const selected = options.heightOrder
            ? "b.source_id AS _source_id,b.ordinal AS _ordinal,"
            : "";
          const order = options.heightOrder
            ? "b.block_number DESC NULLS LAST,b.observed_at ASC NULLS FIRST,b.source_id DESC,b.ordinal DESC"
            : "b.observed_at DESC NULLS FIRST,b.block_number DESC NULLS FIRST";
          const values: unknown[] = [net];
          const conditions = [
            "b.network=?",
            ...where.map((clause) => `(${clause})`),
          ];
          if (options.heightOrder && options.heightUpper !== undefined) {
            conditions.push("(b.block_number IS NULL OR b.block_number<=?)");
            values.push(options.heightUpper);
          }
          values.push(count);
          const rows = await tx.query(
            `SELECT ${selected}${BLOCKS_COLUMNS.map((column) => `b.${column}`).join(",")}` +
              ` FROM (${projection}) b WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ?`,
            values,
          );
          return (
            options.heightOrder
              ? BlocksRowSchema.required().extend({
                  _source_id: integer,
                  _ordinal: integer,
                })
              : BlocksRowSchema.required()
          )
            .array()
            .parse(rows);
        },
        { isolation: "repeatable read" },
      );
    },
  };
}
