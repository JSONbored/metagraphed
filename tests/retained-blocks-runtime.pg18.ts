import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import type { PgTransaction } from "../src/pg-pool.ts";
import { createPgRetainedBlocks } from "../src/retained-blocks-pg.ts";
import {
  handleRetainedBlocksSync,
  retainedBlockDigest,
} from "../src/retained-blocks-sync.ts";
import {
  readRetainedBlockCensus,
  readRetainedBlockObservedAt,
  readRetainedBlockRows,
} from "../src/retained-blocks-d1.ts";
import { fetchBlockRowsFromR2Sql } from "../src/r2-sql-blocks.ts";
import { encodeCursor } from "../src/cursor.ts";
import { RetainedHistoryUnavailableError } from "../src/retained-history-store.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  statement_timeout: 5000,
  query_timeout: 5000,
  connectionTimeoutMillis: 2000,
});
const now = Date.now();
const identity = "a".repeat(64),
  other = "b".repeat(64);
const author = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const descriptor = {
  network: "mainnet",
  table: "blocks",
  bucket: "fixture",
  key: "blocks.parquet",
  etag: "fixture",
  bytes: 100,
  rows: 3,
};
const row = [11, "0xabc", "0xdef", author, 3, 7, 240, 100];
const tail = [10, null, null, null, null, 11, 241, 200];
let runtime: PgStoreRuntime;
let ownsSchemas = false;
const idleErrors: Error[] = [];
const env = () => ({
  RETAINED_BLOCKS_STORE: createPgRetainedBlocks(runtime),
  RETAINED_BLOCKS_NETWORKS: "mainnet,testnet",
  RETAINED_BLOCKS_SYNC_SECRET: "fixture-secret",
});
const inputRequest = (
  input: unknown,
  token = "fixture-secret",
  method = "POST",
) =>
  new Request("https://example.com/api/v1/internal/retained-blocks-sync", {
    method,
    headers: { "x-retained-blocks-sync-token": token },
    ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
const call = (input: unknown) =>
  handleRetainedBlocksSync(inputRequest(input), env(), now);
async function ok(input: unknown) {
  const result = await call(input);
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(result.headers.get("cache-control"), "no-store");
  return result.json() as Promise<Record<string, unknown>>;
}
const publication = (extra: Record<string, unknown> = {}) => ({
  kind: "publish",
  network: "mainnet",
  table_uuid: "019fc234-642e-7f82-b656-ddb8529315ab",
  snapshot: "9223372036854775806",
  sequence: 10,
  generated_at: now,
  source_rows: 3,
  sources: [identity],
  coverage: null,
  ...extra,
});
async function complete(rows = [row, row, tail], id = identity) {
  await ok({
    kind: "begin",
    identity: id,
    source: { ...descriptor, rows: rows.length },
  });
  await ok({ kind: "chunk", identity: id, start: 0, rows });
}

describe(
  "retained handlers and readers on PostgreSQL 18.6",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await control.query("BEGIN");
      try {
        for (const name of [
          "0000_source_metadata.sql",
          "0001_retained_blocks.sql",
          "0002_retained_sequences.sql",
          "0003_retained_feed_order.sql",
        ]) {
          await control.query(
            readFileSync(
              new URL(`../migrations/postgres/${name}`, import.meta.url),
              "utf8",
            ),
          );
        }
        await control.query("COMMIT");
        ownsSchemas = true;
      } catch (error) {
        await control.query("ROLLBACK");
        throw error;
      }
      runtime = createPgStoreRuntime({
        connectionString,
        maxConnections: 4,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError: (error) => idleErrors.push(error),
      });
    });
    beforeEach(async () => {
      await control.query(
        "TRUNCATE retained.history_blocks,retained.history_block_sources,retained.history_block_authors," +
          "retained.history_block_chunks,retained.history_block_source_counts,retained.history_block_counts," +
          "retained.history_block_state RESTART IDENTITY",
      );
    });
    after(async () => {
      try {
        await runtime?.close();
        if (ownsSchemas)
          await control.query(
            "DROP SCHEMA retained CASCADE; DROP SCHEMA source_meta CASCADE",
          );
        assert.deepEqual(idleErrors, []);
      } finally {
        await control.end();
      }
    });

    it("keeps the normal provision/auth/method/body refusal envelopes", async () => {
      assert.equal(
        (await handleRetainedBlocksSync(inputRequest({}), {})).status,
        503,
      );
      assert.equal(
        (await handleRetainedBlocksSync(inputRequest({}, "wrong"), env()))
          .status,
        401,
      );
      assert.equal(
        (
          await handleRetainedBlocksSync(
            inputRequest({}, "fixture-secret", "GET"),
            env(),
          )
        ).status,
        405,
      );
      assert.equal((await call({})).status, 400);
      assert.deepEqual(await ok({ kind: "status", network: "mainnet" }), {
        state: null,
        sources: [],
        next_cursor: null,
      });
    });

    it("preserves begin identity, chunk receipts and exact replay under concurrency", async () => {
      await ok({ kind: "begin", identity, source: descriptor });
      assert.equal(
        (
          await call({
            kind: "begin",
            identity,
            source: { ...descriptor, etag: "different" },
          })
        ).status,
        409,
      );
      assert.equal(
        (await call({ kind: "chunk", identity: other, start: 0, rows: [row] }))
          .status,
        404,
      );
      assert.equal(
        (await call({ kind: "chunk", identity, start: 1, rows: [row] })).status,
        409,
      );
      const chunk = { kind: "chunk", identity, start: 0, rows: [row, row] };
      const responses = await Promise.all([call(chunk), call(chunk)]);
      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200],
      );
      assert.equal((await call({ ...chunk, rows: [tail, tail] })).status, 409);
      await ok({ kind: "chunk", identity, start: 2, rows: [tail] });
      assert.equal(
        (await call({ kind: "chunk", identity, start: 3, rows: [row] })).status,
        409,
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*) AS n FROM retained.history_blocks",
          )
        ).rows[0].n,
        3,
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT start_row,rows FROM retained.history_block_chunks ORDER BY start_row",
          )
        ).rows,
        [
          { start_row: 0, rows: 2 },
          { start_row: 2, rows: 1 },
        ],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT value,rows FROM retained.history_block_source_counts WHERE kind='events' ORDER BY value",
          )
        ).rows,
        [
          { value: 7, rows: 2 },
          { value: 11, rows: 1 },
        ],
      );
    });

    it("serializes changed chunks and first publications without a partial winner", async () => {
      await ok({ kind: "begin", identity, source: { ...descriptor, rows: 1 } });
      const responses = await Promise.all([
        call({ kind: "chunk", identity, start: 0, rows: [row] }),
        call({ kind: "chunk", identity, start: 0, rows: [tail] }),
      ]);
      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [200, 409],
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*) AS n FROM retained.history_blocks",
          )
        ).rows[0].n,
        1,
      );
      const lower = publication({ source_rows: 1, sequence: 9 });
      const higher = publication({ source_rows: 1, sequence: 10 });
      const publishResponses = await Promise.all([call(lower), call(higher)]);
      assert.equal(publishResponses[1].status, 200);
      assert.ok([200, 409].includes(publishResponses[0].status));
      assert.deepEqual(
        (
          await control.query(
            "SELECT sequence,generation FROM retained.history_block_state",
          )
        ).rows,
        [{ sequence: 10, generation: retainedBlockDigest(higher) }],
      );
    });

    it("validates publication census, freshness, table identity and generation-bound status", async () => {
      await complete();
      assert.equal(
        (await call(publication({ sources: [identity, identity] }))).status,
        400,
      );
      assert.equal(
        (await call(publication({ generated_at: now + 1 }))).status,
        400,
      );
      assert.equal((await call(publication({ source_rows: 4 }))).status, 409);
      assert.equal((await call(publication({ sources: [other] }))).status, 409);
      const published = await ok(publication());
      assert.equal(published.generation, retainedBlockDigest(publication()));
      assert.equal((await call(publication({ sequence: 9 }))).status, 409);
      assert.equal(
        (await call(publication({ snapshot: "other" }))).status,
        400,
      );
      assert.equal((await call(publication({ snapshot: "123" }))).status, 409);
      assert.equal(
        (
          await call(
            publication({ table_uuid: "019fc234-642e-7f82-b656-ddb8529315ac" }),
          )
        ).status,
        409,
      );
      assert.equal(
        (await call({ kind: "status", network: "mainnet", generation: other }))
          .status,
        409,
      );
      const status = await ok({
        kind: "status",
        network: "mainnet",
        generation: published.generation,
      });
      assert.equal((status.sources as unknown[]).length, 1);
      assert.equal(status.next_cursor, null);
    });

    it("feeds existing census, observed-through and cursor entry points with duplicate rows", async () => {
      const rows = [
        row,
        row,
        tail,
        [12, null, null, null, 0, 0, null, null],
        [null, null, null, null, null, null, null, 100],
      ];
      await complete(rows);
      await ok(publication({ source_rows: rows.length }));
      assert.deepEqual(await readRetainedBlockCensus(env(), "mainnet", now), {
        lo: 10,
        hi: 12,
        n: 5,
      });
      assert.equal(
        await readRetainedBlockObservedAt(env(), 11, "mainnet", now),
        new Date(100).toISOString(),
      );
      assert.equal(
        await readRetainedBlockObservedAt(env(), 12, "mainnet", now),
        null,
      );
      let cursor: string | null = null;
      const seen: (number | null)[] = [];
      for (let page = 0; page < 4; page += 1) {
        const result = await fetchBlockRowsFromR2Sql(
          env(),
          { limit: 2, offset: 0, cursor },
          "mainnet",
        );
        assert.ok(result);
        seen.push(
          ...result.rows.map((row) => row.block_number as number | null),
        );
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      assert.deepEqual(seen, [12, 11, 11, 10, null]);
      const filtered = await fetchBlockRowsFromR2Sql(
        env(),
        { limit: 10, offset: 0, author, minEvents: 7 },
        "mainnet",
      );
      assert.equal(filtered?.rows.length, 2);
      assert.deepEqual(
        (
          await fetchBlockRowsFromR2Sql(
            env(),
            { limit: 10, offset: 0, minEvents: 999 },
            "mainnet",
          )
        )?.rows,
        [],
      );
      const observed = await fetchBlockRowsFromR2Sql(
        env(),
        { limit: 10, offset: 0, cursor: encodeCursor([200, 10]) },
        "mainnet",
      );
      assert.ok(observed);
      assert.deepEqual(
        observed.rows.map((row) => row.block_number),
        [null, 11, 11],
      );
    });

    it("paginates status within one generation and refuses an old page after publication changes", async () => {
      await control.query(
        "INSERT INTO retained.history_block_sources(identity,network,source,expected_rows,received_rows,active) " +
          "SELECT lpad(i::text,64,'0'),0,'{}',1,1,1 FROM generate_series(1,201) AS i",
      );
      await control.query(
        "INSERT INTO retained.history_block_state VALUES (0,$1,$2,'1',1,$3,201,201,NULL)",
        [identity, "019fc234-642e-7f82-b656-ddb8529315ab", now],
      );
      const first = await ok({
        kind: "status",
        network: "mainnet",
        generation: identity,
      });
      assert.equal((first.sources as unknown[]).length, 200);
      assert.equal(first.next_cursor, 200);
      const next = await ok({
        kind: "status",
        network: "mainnet",
        generation: identity,
        after: first.next_cursor,
      });
      assert.equal((next.sources as unknown[]).length, 1);
      assert.equal(next.next_cursor, null);
      await control.query(
        "UPDATE retained.history_block_state SET generation=$1",
        [other],
      );
      assert.equal(
        (
          await call({
            kind: "status",
            network: "mainnet",
            generation: identity,
            after: first.next_cursor,
          })
        ).status,
        409,
      );
    });

    it("keeps unavailable retained data distinct from an empty page", async () => {
      await complete();
      await ok(publication());
      await control.query(
        "UPDATE retained.history_block_state SET generated_at=$1",
        [now - 7200001],
      );
      assert.equal(await readRetainedBlockCensus(env(), "mainnet", now), null);
      await assert.rejects(
        fetchBlockRowsFromR2Sql(env(), { limit: 2, offset: 0 }, "mainnet"),
        RetainedHistoryUnavailableError,
      );
      assert.equal(
        await readRetainedBlockRows(env(), [], 2, "testnet", now),
        null,
      );
      assert.equal(
        await readRetainedBlockRows(
          { ...env(), RETAINED_BLOCKS_NETWORKS: "" },
          [],
          2,
          "mainnet",
          now,
        ),
        undefined,
      );
    });

    it("drains issued callback work, rejects an escaped scope and rolls back a swallowed failure", async () => {
      let escaped!: PgTransaction;
      const result = await runtime.transaction(async (tx) => {
        escaped = tx;
        void tx.run(
          "INSERT INTO retained.history_block_authors(address) VALUES (?)",
          ["callback"],
        );
        return 42;
      });
      assert.equal(result, 42);
      assert.equal(
        (
          await control.query(
            "SELECT count(*) AS n FROM retained.history_block_authors",
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(escaped.query("SELECT 1"), /scope is closed/);
      await assert.rejects(
        runtime.transaction(async (tx) => {
          await tx.run(
            "INSERT INTO retained.history_block_authors(address) VALUES (?)",
            ["rolled-back"],
          );
          await tx
            .run(
              "INSERT INTO retained.history_block_authors(address) VALUES (?)",
              ["callback"],
            )
            .catch(() => undefined);
        }),
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT address FROM retained.history_block_authors",
          )
        ).rows,
        [{ address: "callback" }],
      );
    });

    it("holds one repeatable-read snapshot across callback reads", async () => {
      await runtime.transaction(
        async (tx) => {
          assert.deepEqual(
            await tx.first(
              "SELECT COUNT(*) AS n FROM retained.history_block_authors",
            ),
            { n: 0 },
          );
          await control.query(
            "INSERT INTO retained.history_block_authors(address) VALUES ('concurrent')",
          );
          assert.deepEqual(
            await tx.first(
              "SELECT COUNT(*) AS n FROM retained.history_block_authors",
            ),
            { n: 0 },
          );
        },
        { isolation: "repeatable read" },
      );
      assert.equal(
        (
          await control.query(
            "SELECT COUNT(*) AS n FROM retained.history_block_authors",
          )
        ).rows[0].n,
        1,
      );
    });

    it("supports the complete native height-cursor order directly from its index", async () => {
      interface Plan {
        "Node Type": string;
        "Index Name"?: string;
        Plans?: Plan[];
      }
      const nodes = (plan: Plan): Plan[] => [
        plan,
        ...(plan.Plans ?? []).flatMap(nodes),
      ];
      await control.query("BEGIN");
      try {
        // This establishes index ordering support on a tiny fixture. Production
        // latency and the planner's choice over full history require measurements.
        await control.query("SET LOCAL enable_seqscan=off");
        await control.query("SET LOCAL enable_bitmapscan=off");
        const result = await control.query(
          "EXPLAIN (FORMAT JSON, COSTS FALSE) SELECT block_number,observed_at,source_id,ordinal " +
            "FROM retained.history_blocks WHERE network=0 " +
            "ORDER BY block_number DESC NULLS LAST,observed_at ASC NULLS FIRST,source_id DESC,ordinal DESC LIMIT 10",
        );
        const plan = nodes(result.rows[0]["QUERY PLAN"][0].Plan as Plan);
        assert.ok(
          plan.some((node) => node["Index Name"] === "history_blocks_height"),
        );
        assert.equal(
          plan.some((node) => node["Node Type"].includes("Sort")),
          false,
        );
      } finally {
        await control.query("ROLLBACK");
      }
    });
  },
);
