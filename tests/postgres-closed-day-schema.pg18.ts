import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const sourceObjects = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}[];
const names = ["subnet_snapshots", "archive_export_revisions"];
const source = new DatabaseSync(":memory:");
const control = new Client({
  connectionString: pg18FixtureUrl().toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
let ownApp = false;

function exactNumeric(value: number | bigint): string {
  if (typeof value === "bigint") return String(value);
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  const packed = bytes.getBigUint64(0);
  const exponent = Number((packed >> 52n) & 2047n);
  assert.notEqual(exponent, 2047);
  const significand =
    (packed & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
  const power = exponent ? exponent - 1075 : -1074;
  const sign = packed >> 63n ? "-" : "";
  if (power >= 0) return sign + String(significand << BigInt(power));
  const places = -power;
  const digits = String(significand * 5n ** BigInt(places)).padStart(
    places + 1,
    "0",
  );
  return sign + digits.slice(0, -places) + "." + digits.slice(-places);
}

async function applyActivation() {
  await control.query("BEGIN");
  try {
    await control.query(migration("0023_closed_day_revisions_activate.sql"));
    await control.query("COMMIT");
  } catch (error) {
    await control.query("ROLLBACK");
    throw error;
  }
}

async function attachSnapshotFixture() {
  await control.query(
    "CREATE TRIGGER fixture_snapshot_lock BEFORE INSERT OR UPDATE OR DELETE ON app.subnet_snapshots FOR EACH STATEMENT EXECUTE FUNCTION app.archive_export_revision_lock()",
  );
  await control.query(
    "CREATE TRIGGER fixture_snapshot_closed AFTER INSERT OR UPDATE OR DELETE ON app.subnet_snapshots FOR EACH ROW EXECUTE FUNCTION app.archive_export_closed_day('subnet_snapshots','snapshot_date')",
  );
}

async function compareRevisions() {
  const expected = source
    .prepare(
      "SELECT table_name,revision FROM archive_export_revisions ORDER BY table_name",
    )
    .all()
    .map((row) => ({ ...row }));
  const observed = (
    await control.query(
      "SELECT table_name,revision::double precision AS revision FROM app.archive_export_revisions ORDER BY table_name",
    )
  ).rows;
  assert.deepEqual(observed, expected);
}

describe(
  "closed-day revision schema and arithmetic",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      ownApp =
        (
          await control.query(
            "SELECT oid FROM pg_namespace WHERE nspname='app'",
          )
        ).rowCount === 0;
      await control.query(migration("0022_closed_day_revisions.sql"));
      for (const object of sourceObjects.filter(
        (item) => item.type === "table" && names.includes(item.name),
      ))
        source.exec(object.sql);
      for (const object of sourceObjects.filter(
        (item) => item.type !== "table" && names.includes(item.tbl_name),
      ))
        source.exec(object.sql);
    });
    beforeEach(async () => {
      await control.query(
        "DROP TRIGGER IF EXISTS fixture_snapshot_closed ON app.subnet_snapshots; DROP TRIGGER IF EXISTS fixture_snapshot_lock ON app.subnet_snapshots",
      );
      await control.query(
        "TRUNCATE app.subnet_snapshots,app.archive_export_revisions",
      );
      source.exec(
        "DELETE FROM subnet_snapshots; DELETE FROM archive_export_revisions",
      );
    });
    after(async () => {
      try {
        await control.query(
          "DROP TABLE app.subnet_snapshots; DROP TABLE app.archive_export_revisions",
        );
        await control.query(
          "DROP FUNCTION app.archive_export_closed_day(); DROP FUNCTION app.archive_export_revision_lock(); DROP FUNCTION app.archive_revision_increment(numeric)",
        );
        if (ownApp) await control.query("DROP SCHEMA app");
      } finally {
        source.close();
        await control.end();
      }
    });

    it("preserves snapshot columns and the source index with explicit numeric revision storage", async () => {
      for (const name of names) {
        const expected = source
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((column) => ({
            name: column.name,
            type:
              column.name === "revision"
                ? "numeric"
                : ["emission_enabled", "subtoken_enabled"].includes(
                      String(column.name),
                    )
                  ? "boolean"
                  : (
                      {
                        INTEGER: "bigint",
                        REAL: "double precision",
                        TEXT: "text",
                      } as Record<string, string>
                    )[String(column.type)],
            nullable: !(column.notnull || column.pk),
          }));
        assert.deepEqual(
          (
            await control.query(
              "SELECT column_name AS name,data_type AS type,is_nullable='YES' AS nullable FROM information_schema.columns WHERE table_schema='app' AND table_name=$1 ORDER BY ordinal_position",
              [name],
            )
          ).rows,
          expected,
        );
      }
      assert.deepEqual(
        (
          await control.query(
            "SELECT indexname FROM pg_indexes WHERE schemaname='app' AND tablename='subnet_snapshots' AND indexname NOT LIKE '%_pkey' ORDER BY indexname",
          )
        ).rows,
        [{ indexname: "idx_subnet_snapshots_date_netuid" }],
      );
    });

    it("matches SQLite integer affinity and exact binary64 increment results", async () => {
      const read = source.prepare(
        "SELECT revision FROM archive_export_revisions WHERE table_name='probe'",
      );
      read.setReadBigInts(true);
      for (const initial of [
        0n,
        9223372036854775806n,
        9223372036854775807n,
        0.1,
        1.5,
        1e20,
        Number.MIN_VALUE,
        Number.MAX_VALUE,
      ]) {
        source
          .prepare(
            "INSERT OR REPLACE INTO archive_export_revisions VALUES ('probe',?)",
          )
          .run(initial);
        for (let step = 0; step < 3; step++) {
          const previous = read.get()!.revision as number | bigint;
          source.exec(
            "UPDATE archive_export_revisions SET revision=revision+1 WHERE table_name='probe'",
          );
          const expected = read.get()!.revision as number | bigint;
          const matches = await control.query(
            "SELECT app.archive_revision_increment($1::numeric) = $2::numeric AS equal",
            [exactNumeric(previous), exactNumeric(expected)],
          );
          assert.equal(matches.rows[0].equal, true, `${initial} step ${step}`);
        }
      }
    });

    it("requires real document dependencies before full activation and preserves imported revisions", async () => {
      await control.query(
        "INSERT INTO app.archive_export_revisions VALUES ('subnet_snapshots/2001-01-01',0.1)",
      );
      await assert.rejects(applyActivation(), { code: "42P01" });
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM pg_trigger WHERE tgrelid='app.subnet_snapshots'::regclass AND NOT tgisinternal",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await control.query(
            "SELECT revision FROM app.archive_export_revisions",
          )
        ).rows[0].revision,
        "0.1",
      );
    });

    it("matches snapshot old/new-day effects using statement UTC and rolls back increments", async () => {
      await attachSnapshotFixture();
      await control.query("SET TIME ZONE 'Pacific/Honolulu'");
      const today = source.prepare("SELECT date('now') AS day").get()!
        .day as string;
      for (const [id, day] of [
        [1, "2001-01-01"],
        [2, today],
        [3, "2999-01-01"],
      ] as const) {
        source
          .prepare(
            "INSERT INTO subnet_snapshots(netuid,snapshot_date) VALUES (?,?)",
          )
          .run(id, day);
        await control.query(
          "INSERT INTO app.subnet_snapshots(netuid,snapshot_date) VALUES ($1,$2)",
          [id, day],
        );
      }
      await compareRevisions();
      for (const day of ["2001-01-01", "2001-01-02", today, "2001-01-01"]) {
        source
          .prepare("UPDATE subnet_snapshots SET snapshot_date=? WHERE netuid=1")
          .run(day);
        await control.query(
          "UPDATE app.subnet_snapshots SET snapshot_date=$1 WHERE netuid=1",
          [day],
        );
        await compareRevisions();
      }
      await control.query("BEGIN");
      await control.query("DELETE FROM app.subnet_snapshots WHERE netuid=1");
      await control.query("ROLLBACK");
      await compareRevisions();
      source.exec("DELETE FROM subnet_snapshots WHERE netuid=1");
      await control.query("DELETE FROM app.subnet_snapshots WHERE netuid=1");
      await compareRevisions();
    });
  },
);
