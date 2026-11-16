import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const fixtureUrl = pg18FixtureUrl();
const control = new Client({
  connectionString: fixtureUrl.toString(),
  connectionTimeoutMillis: 2_000,
  statement_timeout: 5_000,
  query_timeout: 5_000,
});
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
let ownsSchemas = false;
let store: PgStoreRuntime;
const idleErrors: Error[] = [];

async function source(id: number, network = 0, active = 1, rows = 1) {
  await store.producer.run(
    "INSERT INTO retained.history_block_sources " +
      "(id,identity,network,source,expected_rows,received_rows,active) VALUES (?,?,?,?,?,?,?)",
    [id, `source-${id}`, network, `descriptor-${id}`, rows, rows, active],
  );
}

async function block(
  sourceId: number,
  ordinal: number,
  height: number | null,
  observed: number | null,
  network = 0,
  author: number | null = null,
) {
  await store.producer.run(
    "INSERT INTO retained.history_blocks " +
      "(network,source_id,ordinal,block_number,block_hash,author_id,observed_at) VALUES (?,?,?,?,?,?,?)",
    [
      network,
      sourceId,
      ordinal,
      height,
      height === null ? null : `hash-${height}`,
      author,
      observed,
    ],
  );
}

describe(
  "complete retained-block PostgreSQL schema",
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
        await control.query(migration("0000_source_metadata.sql"));
        await control.query(migration("0001_retained_blocks.sql"));
        await control.query("COMMIT");
        ownsSchemas = true;
      } catch (error) {
        await control.query("ROLLBACK");
        throw error;
      }
      store = createPgStoreRuntime({
        connectionString: fixtureUrl.toString(),
        maxConnections: 2,
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 1_000,
        statementTimeoutMillis: 5_000,
        onIdleError: (error) => idleErrors.push(error),
      });
    });

    beforeEach(async () => {
      await control.query(
        "TRUNCATE retained.history_blocks,retained.history_block_sources,retained.history_block_authors," +
          "retained.history_block_chunks,retained.history_block_source_counts,retained.history_block_counts," +
          "retained.history_block_state,source_meta.state_d1_migrations,source_meta.retained_d1_migrations," +
          "source_meta.state_sqlite_sequence,source_meta.retained_sqlite_sequence RESTART IDENTITY",
      );
    });

    after(async () => {
      try {
        await store?.close();
        if (ownsSchemas) {
          await control.query(
            "DROP SCHEMA retained CASCADE; DROP SCHEMA source_meta CASCADE",
          );
        }
        assert.deepEqual(idleErrors, []);
      } finally {
        await control.end();
      }
    });

    it("creates all seven physical tables, their indexes and the actual filtered view", async () => {
      const tables = await control.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='retained' " +
          "AND table_type='BASE TABLE' ORDER BY table_name",
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        [
          "history_block_authors",
          "history_block_chunks",
          "history_block_counts",
          "history_block_source_counts",
          "history_block_sources",
          "history_block_state",
          "history_blocks",
        ],
      );
      const indexes = await control.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname='retained' AND tablename='history_blocks' ORDER BY indexname",
      );
      assert.deepEqual(
        indexes.rows.map((row) => row.indexname),
        [
          "history_blocks_author",
          "history_blocks_author_spec",
          "history_blocks_events",
          "history_blocks_extrinsics",
          "history_blocks_height",
          "history_blocks_order",
          "history_blocks_pkey",
          "history_blocks_spec",
        ],
      );
      const view = await control.query(
        "SELECT * FROM retained.history_block_rows",
      );
      assert.deepEqual(
        view.fields.map((field) => field.name),
        [
          "network",
          "block_number",
          "block_hash",
          "parent_hash",
          "author",
          "extrinsic_count",
          "event_count",
          "spec_version",
          "observed_at",
        ],
      );
      assert.deepEqual(view.rows, []);
      assert.equal(
        (
          await control.query(
            "SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid " +
              "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='retained' AND NOT t.tgisinternal",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*) AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace " +
              "WHERE n.nspname='retained' AND c.contype='f'",
          )
        ).rows[0].n,
        0,
      );
    });

    it("preserves source metadata rows and reconciles identities above every retained high-water mark", async () => {
      await source(500);
      await store.producer.run(
        "INSERT INTO retained.history_block_authors(id,address) VALUES (?,?)",
        [1000, "author"],
      );
      await control.query(
        "INSERT INTO source_meta.state_d1_migrations VALUES (42,'state.sql','2026-11-04 00:00:00')",
      );
      await control.query(
        "INSERT INTO source_meta.retained_d1_migrations VALUES (42,'retained.sql','2026-11-04 00:00:01')",
      );
      await control.query(
        "INSERT INTO source_meta.retained_sqlite_sequence VALUES " +
          "('history_block_sources',700),('history_block_sources',700),('history_block_authors',10),(NULL,NULL)",
      );
      await control.query("BEGIN");
      try {
        await control.query(migration("0002_retained_sequences.sql"));
        await control.query("COMMIT");
      } catch (error) {
        await control.query("ROLLBACK");
        throw error;
      }
      assert.deepEqual(
        (await control.query("SELECT * FROM source_meta.state_d1_migrations"))
          .rows,
        [{ id: 42, name: "state.sql", applied_at: "2026-11-04 00:00:00" }],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT * FROM source_meta.retained_d1_migrations",
          )
        ).rows,
        [{ id: 42, name: "retained.sql", applied_at: "2026-11-04 00:00:01" }],
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*) AS n FROM source_meta.retained_sqlite_sequence",
          )
        ).rows[0].n,
        4,
      );
      assert.equal(
        (
          await control.query(
            "INSERT INTO retained.history_block_sources(identity,network,source,expected_rows) " +
              "VALUES ('after-import',0,'new',0) RETURNING id",
          )
        ).rows[0].id,
        701,
      );
      assert.equal(
        (
          await control.query(
            "INSERT INTO retained.history_block_authors(address) VALUES ('next') RETURNING id",
          )
        ).rows[0].id,
        1001,
      );
      // A consumed sequence value can exceed max(id), even after a transaction abort.
      await control.query(
        "SELECT nextval(pg_get_serial_sequence('retained.history_block_sources','id'))",
      );
      await control.query("BEGIN");
      await control.query(migration("0002_retained_sequences.sql"));
      await control.query("COMMIT");
      assert.equal(
        (
          await control.query(
            "INSERT INTO retained.history_block_sources(identity,network,source,expected_rows) " +
              "VALUES ('after-repeat',0,'new',0) RETURNING id",
          )
        ).rows[0].id,
        703,
      );
    });

    it("keeps duplicate block observations and filters inactive or cross-network sources", async () => {
      await source(1);
      await source(2);
      await source(3, 1);
      await source(4, 0, 0);
      await store.producer.run(
        "INSERT INTO retained.history_block_authors(id,address) VALUES (?,?)",
        [1, "known"],
      );
      await block(1, 0, 10, 100, 0, 1);
      await block(2, 0, 10, 100, 0, 999);
      await block(3, 0, 10, 100, 0);
      await block(4, 0, 10, 100, 0);
      await block(3, 1, null, null, 1);
      const rows = await store.read.query(
        "SELECT network,block_number,author,observed_at " +
          "FROM retained.history_block_rows ORDER BY network,author NULLS LAST",
      );
      assert.deepEqual(rows, [
        { network: 0, block_number: 10, author: "known", observed_at: 100 },
        { network: 0, block_number: 10, author: null, observed_at: 100 },
        { network: 1, block_number: null, author: null, observed_at: null },
      ]);
      assert.equal(
        (
          await control.query(
            "SELECT count(*) AS n FROM retained.history_blocks",
          )
        ).rows[0].n,
        5,
      );
    });

    it("refuses sequence activation when an original high-water mark is exhausted", async () => {
      await control.query(
        "INSERT INTO source_meta.retained_sqlite_sequence VALUES " +
          "('history_block_sources',9223372036854775807)",
      );
      await control.query("BEGIN");
      try {
        await assert.rejects(
          control.query(migration("0002_retained_sequences.sql")),
          (error: unknown) => {
            assert.equal((error as { code?: string }).code, "22003");
            return true;
          },
        );
      } finally {
        await control.query("ROLLBACK");
      }
      assert.equal(
        (
          await control.query(
            "SELECT last_value FROM pg_sequences WHERE schemaname='retained' AND sequencename='history_block_sources_id_seq'",
          )
        ).rows[0].last_value,
        null,
      );
    });

    it("enforces the source range, uniqueness and positive-count constraints", async () => {
      await source(1);
      const invalid = [
        "INSERT INTO retained.history_block_sources(identity,network,source,expected_rows) VALUES ('bad',2,'x',0)",
        "UPDATE retained.history_block_sources SET expected_rows=-1 WHERE id=1",
        "UPDATE retained.history_block_sources SET received_rows=2 WHERE id=1",
        "INSERT INTO retained.history_blocks(network,source_id,ordinal) VALUES (0,1,-1)",
        "INSERT INTO retained.history_block_chunks VALUES (1,0,0,'x')",
        "INSERT INTO retained.history_block_source_counts VALUES (1,'invalid',3,1)",
        "INSERT INTO retained.history_block_counts VALUES (0,'events',3,0)",
        "INSERT INTO retained.history_block_state VALUES (2,'g','t','s',1,1,1,1,NULL)",
      ];
      for (const statement of invalid) {
        await assert.rejects(control.query(statement), (error: unknown) => {
          assert.equal((error as { code?: string }).code, "23514");
          return true;
        });
      }
      await block(1, 0, 1, 1);
      await assert.rejects(block(1, 0, 2, 2), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "23505");
        return true;
      });
    });

    it("publishes active membership, summary counts and the snapshot receipt atomically", async () => {
      await source(1, 0, 0, 2);
      await source(2, 0, 0, 1);
      await store.producer.run(
        "INSERT INTO retained.history_block_source_counts VALUES (1,'events',3,2),(2,'events',3,1)",
      );
      const publish = [
        {
          text: "UPDATE retained.history_block_sources SET active=1 WHERE network=0",
        },
        { text: "DELETE FROM retained.history_block_counts WHERE network=0" },
        {
          text:
            "INSERT INTO retained.history_block_counts " +
            "SELECT 0,c.kind,c.value,SUM(c.rows) FROM retained.history_block_source_counts c " +
            "JOIN retained.history_block_sources s ON s.id=c.source_id " +
            "WHERE s.network=0 AND s.active=1 GROUP BY c.kind,c.value",
        },
        {
          text: "INSERT INTO retained.history_block_state VALUES (?,?,?,?,?,?,?,?,?)",
          values: [
            0,
            "a".repeat(64),
            "00000000-0000-4000-8000-000000000001",
            "9223372036854775806",
            1,
            1000,
            3,
            2,
            null,
          ],
        },
      ];
      await assert.rejects(
        store.producer.transaction([
          ...publish.slice(0, 3),
          { ...publish[3], values: [2, ...publish[3].values!.slice(1)] },
        ]),
      );
      assert.deepEqual(
        await store.read.query(
          "SELECT active FROM retained.history_block_sources ORDER BY id",
        ),
        [{ active: 0 }, { active: 0 }],
      );
      assert.deepEqual(
        await store.read.query("SELECT * FROM retained.history_block_counts"),
        [],
      );
      await store.producer.transaction(publish);
      assert.deepEqual(
        await store.read.query("SELECT * FROM retained.history_block_counts"),
        [{ network: 0, kind: "events", value: 3, rows: 3 }],
      );
      assert.deepEqual(
        await store.read.first(
          "SELECT source_rows,source_files,snapshot,coverage FROM retained.history_block_state WHERE network=0",
        ),
        {
          source_rows: 3,
          source_files: 2,
          snapshot: "9223372036854775806",
          coverage: null,
        },
      );
    });

    it("uses explicit PostgreSQL null ordering and physical tie keys for retained feeds", async () => {
      await source(1, 0, 1, 6);
      await source(2);
      await block(1, 0, 10, 100);
      await block(1, 1, 9, 200);
      await block(1, 2, 8, 200);
      await block(2, 0, 8, 200);
      await block(1, 3, 11, 50);
      await block(1, 4, 12, null);
      await block(1, 5, null, 100);
      const from =
        " FROM retained.history_blocks b JOIN retained.history_block_sources s " +
        "ON s.id=b.source_id AND s.network=b.network AND s.active=1 WHERE b.network=0";
      const heightOrder = await store.read.query<{
        block_number: number | null;
      }>(
        "SELECT block_number" +
          from +
          " ORDER BY block_number DESC NULLS LAST,observed_at ASC NULLS FIRST,source_id DESC,ordinal DESC",
      );
      assert.deepEqual(
        heightOrder.map((row) => row.block_number),
        [12, 11, 10, 9, 8, 8, null],
      );
      const observationOrder = await store.read.query<{
        block_number: number | null;
      }>(
        "SELECT block_number" +
          from +
          " ORDER BY observed_at DESC NULLS FIRST,block_number DESC NULLS FIRST",
      );
      assert.deepEqual(
        observationOrder.map((row) => row.block_number),
        [12, 9, 8, 8, null, 10, 11],
      );
      const afterDuplicate = await store.read.query<{
        source_id: number;
        ordinal: number;
      }>(
        "SELECT source_id,ordinal" +
          from +
          " AND block_number=? AND observed_at IS NOT DISTINCT FROM ? " +
          "AND (source_id,ordinal)<(?,?) ORDER BY source_id DESC,ordinal DESC",
        [8, 200, 2, 0],
      );
      assert.deepEqual(afterDuplicate, [{ source_id: 1, ordinal: 2 }]);
    });
  },
);
