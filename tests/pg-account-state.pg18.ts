import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgAccountIdentitySql } from "../src/account-identity-pg.ts";
import { createPgAccountUsage } from "../src/account-usage-pg.ts";
import { createPgAccountUsageReaders } from "../src/account-usage-read-pg.ts";
import { createD1Store } from "../src/d1-store.ts";
import {
  writeUsageRollupD1,
  type UsageRollupBucket,
} from "../src/usage-rollup-d1.ts";
import { sqliteNumberDecimal } from "../src/sqlite-number.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { createPgAccountBlocks } from "../src/account-block-pg.ts";
import { createPgKv } from "../src/pg-kv.ts";
import { applyTieredRateLimit } from "../workers/tiered-rate-limit.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const source = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  d1Databases: ["DB"],
  compatibilityDate: "2026-06-06",
});
const tables = [
  "rpc_accounts",
  "github_accounts",
  "api_key_blocks",
  "api_key_usage_daily",
  "api_usage_rollup",
  "api_usage_rollup_batches",
];
let db: D1Database, runtime: PgStoreRuntime;
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
const sourceNumeric = (row: {
  kind: string;
  value: number | null;
  exact: string;
}) => {
  if (row.kind === "integer") return row.exact;
  assert.equal(row.kind, "real");
  if (row.value === null)
    return row.exact.startsWith("-") ? "-Infinity" : "Infinity";
  const decimal = sqliteNumberDecimal(row.value);
  return decimal.includes(".") ? decimal : `${decimal}.0`;
};

describe(
  "native account identities and usage on PostgreSQL18",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await control.query(migration("0010_account_state.sql"));
      await control.query(migration("0033_account_numeric.sql"));
      await control.query(migration("0035_usage_row_identity.sql"));
      await control.query(migration("0036_usage_row_identity_activate.sql"));
      await control.query(migration("0009_auth_kv.sql"));
      runtime = createPgStoreRuntime({
        connectionString,
        maxConnections: 8,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError() {},
      });
      db = await source.getD1Database("DB");
      const objects = JSON.parse(
        readFileSync(
          new URL("../generated/db/d1-schema.json", import.meta.url),
          "utf8",
        ),
      ) as { type: string; name: string; sql: string }[];
      for (const table of objects.filter(
        (entry) => entry.type === "table" && tables.includes(entry.name),
      ))
        await db.prepare(table.sql).run();
      for (const index of objects.filter(
        (entry) =>
          entry.type === "index" &&
          tables.some(
            (name) =>
              entry.sql.includes(`ON ${name} `) ||
              entry.sql.includes(`ON ${name}\n`),
          ),
      ))
        await db.prepare(index.sql).run();
    });
    beforeEach(async () => {
      await control.query(
        `TRUNCATE ${tables.map((name) => `app.${name}`).join(",")} RESTART IDENTITY`,
      );
      await control.query("TRUNCATE auth.kv_entries");
      for (const name of tables) await db.exec(`DELETE FROM ${name}`);
    });
    after(async () => {
      await source.dispose();
      await runtime.close();
      await control.query("DROP SCHEMA app CASCADE; DROP SCHEMA auth CASCADE");
      await control.end();
    });

    it("matches identity upsert results and wide numeric lookup behavior", async () => {
      const sql = createPgAccountIdentitySql(runtime);
      const expected = await db
        .prepare(
          "INSERT INTO github_accounts(github_user_id,github_login,created_at,last_login_at) VALUES (?,?,?,?) ON CONFLICT(github_user_id) DO UPDATE SET github_login=excluded.github_login,last_login_at=excluded.last_login_at RETURNING id,github_login,tier",
        )
        .bind(1e30, "fixture", 1, 1)
        .all();
      const actual =
        await sql`INSERT INTO github_accounts(github_user_id,github_login,created_at,last_login_at) VALUES (${1e30},${"fixture"},${1},${1}) ON CONFLICT(github_user_id) DO UPDATE SET github_login=excluded.github_login,last_login_at=excluded.last_login_at RETURNING id,github_login,tier`;
      assert.deepEqual(actual, expected.results);
      assert.equal(
        (
          await control.query(
            "SELECT github_user_id::text AS value FROM app.github_accounts",
          )
        ).rows[0].value,
        sqliteNumberDecimal(1e30),
      );
      assert.deepEqual(
        await sql`SELECT tier FROM github_accounts WHERE id=${1e30}`,
        (
          await db
            .prepare("SELECT tier FROM github_accounts WHERE id=?")
            .bind(1e30)
            .all()
        ).results,
      );
      assert.deepEqual(
        await sql`SELECT tier FROM github_accounts WHERE id=${0.5}`,
        [],
      );
    });

    it("serializes concurrent account-kind counters and retains source overflow values", async () => {
      const usage = createPgAccountUsage(runtime);
      const input = {
        accountKind: "rpc" as const,
        accountId: 0.1,
        day: "2026-11-04",
        route: "/fixture",
        rejected: false,
      };
      await Promise.all(
        Array.from({ length: 6 }, () => usage.increment(input)),
      );
      await usage.increment({
        ...input,
        accountKind: "github",
        rejected: true,
      });
      assert.deepEqual(
        (
          await control.query(
            "SELECT account_kind,account_id::text AS account_id,request_count::text AS requests,rejected_count::text AS rejected FROM app.api_key_usage_daily ORDER BY account_kind",
          )
        ).rows,
        [
          {
            account_kind: "github",
            account_id: sqliteNumberDecimal(0.1),
            requests: "0",
            rejected: "1",
          },
          {
            account_kind: "rpc",
            account_id: sqliteNumberDecimal(0.1),
            requests: "6",
            rejected: "0",
          },
        ],
      );
      await control.query(
        "UPDATE app.api_key_usage_daily SET request_count=9223372036854775807 WHERE account_kind='rpc'",
      );
      await db
        .prepare(
          "INSERT INTO api_key_usage_daily(account_kind,account_id,day,route,request_count) VALUES ('rpc',?,?,?,9223372036854775807)",
        )
        .bind(input.accountId, input.day, input.route)
        .run();
      await db
        .prepare(
          "INSERT INTO api_key_usage_daily(account_kind,account_id,day,route,request_count,rejected_count) VALUES ('rpc',?,?,?,?,?) ON CONFLICT(account_kind,account_id,day,route) DO UPDATE SET request_count=api_key_usage_daily.request_count+excluded.request_count,rejected_count=api_key_usage_daily.rejected_count+excluded.rejected_count",
        )
        .bind(input.accountId, input.day, input.route, 1, 0)
        .run();
      await usage.increment(input);
      const expected = await db
        .prepare(
          "SELECT typeof(request_count) AS kind,request_count AS value,quote(request_count) AS exact FROM api_key_usage_daily WHERE account_kind='rpc'",
        )
        .first<{ kind: string; value: number | null; exact: string }>();
      assert.equal(
        (
          await control.query(
            "SELECT request_count::text AS value FROM app.api_key_usage_daily WHERE account_kind='rpc'",
          )
        ).rows[0].value,
        sourceNumeric(expected!),
      );
    });

    it("matches source JSON aggregation, stored scalar kinds and receipt replay", async () => {
      const usage = createPgAccountUsage(runtime);
      const store = createD1Store(db);
      const rows = [
        {
          day: "2026-11-04",
          family: "fraction",
          cost_shape: "edge",
          request_count: 0.1,
          keyed_count: 1e20,
        },
        {
          day: "2026-11-04",
          family: "fraction",
          cost_shape: "edge",
          request_count: 0.2,
          keyed_count: 1,
        },
        {
          day: "2026-11-04",
          family: "fraction",
          cost_shape: "edge",
          request_count: 1,
          keyed_count: -1e20,
        },
        {
          day: "2026-11-04",
          family: "wide",
          cost_shape: "edge",
          request_count: 1e18 + 128,
          keyed_count: 0,
        },
        {
          day: "2026-11-04",
          family: "infinite",
          cost_shape: "edge",
          request_count: Number.MAX_VALUE,
          keyed_count: 0,
        },
        {
          day: "2026-11-04",
          family: "infinite",
          cost_shape: "edge",
          request_count: Number.MAX_VALUE,
          keyed_count: 0,
        },
      ] satisfies UsageRollupBucket[];
      const options = { batchId: "replay-fixture" };
      await writeUsageRollupD1(store, rows, options);
      await usage.writeRollup(rows, options);
      const expected = (
        await db
          .prepare(
            "SELECT route_family,typeof(request_count) AS requests_kind,request_count AS requests,quote(request_count) AS requests_exact,typeof(keyed_count) AS keyed_kind,keyed_count AS keyed,quote(keyed_count) AS keyed_exact FROM api_usage_rollup ORDER BY route_family",
          )
          .all<{
            route_family: string;
            requests_kind: string;
            requests: number | null;
            requests_exact: string;
            keyed_kind: string;
            keyed: number | null;
            keyed_exact: string;
          }>()
      ).results.map((row) => ({
        family: row.route_family,
        requests: sourceNumeric({
          kind: row.requests_kind,
          value: row.requests,
          exact: row.requests_exact,
        }),
        keyed: sourceNumeric({
          kind: row.keyed_kind,
          value: row.keyed,
          exact: row.keyed_exact,
        }),
      }));
      const current = async () =>
        (
          await control.query(
            "SELECT route_family AS family,request_count::text AS requests,keyed_count::text AS keyed FROM app.api_usage_rollup ORDER BY route_family",
          )
        ).rows;
      assert.deepEqual(await current(), expected);
      await writeUsageRollupD1(store, rows, options);
      await usage.writeRollup(rows, options);
      assert.deepEqual(await current(), expected);
      await assert.rejects(
        writeUsageRollupD1(store, [{ ...rows[0], request_count: 2 }], options),
        /acknowledged/,
      );
      await assert.rejects(
        usage.writeRollup([{ ...rows[0], request_count: 2 }], options),
        /acknowledged/,
      );
      assert.deepEqual(await current(), expected);
    });

    it("rolls back every group and receipt when a later group fails", async () => {
      await control.query(
        "CREATE FUNCTION app.fail_usage_group() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.route_family='z' THEN RAISE EXCEPTION 'fixture rejected group'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_usage_group BEFORE INSERT ON app.api_usage_rollup FOR EACH ROW EXECUTE FUNCTION app.fail_usage_group()",
      );
      try {
        await assert.rejects(
          createPgAccountUsage(runtime).writeRollup(
            [
              {
                day: "2026-11-04",
                family: "a",
                cost_shape: "edge",
                request_count: 1,
                keyed_count: 1,
              },
              {
                day: "2026-11-04",
                family: "z",
                cost_shape: "edge",
                request_count: 1,
                keyed_count: 1,
              },
            ],
            { batchId: "rollback-fixture" },
          ),
          /fixture rejected group/,
        );
        assert.equal(
          (
            await control.query(
              "SELECT count(*)::int AS n FROM app.api_usage_rollup",
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await control.query(
              "SELECT count(*)::int AS n FROM app.api_usage_rollup_batches",
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await control.query(
          "DROP TRIGGER fail_usage_group ON app.api_usage_rollup; DROP FUNCTION app.fail_usage_group()",
        );
      }
    });

    it("retains rowid tie order and SQLite SUM ordering at the read boundary", async () => {
      const readers = createPgAccountUsageReaders(runtime);
      let rowId = 0;
      for (const [route, count] of [
        ["z", 1e16],
        ["a", 1],
        ["m", -1e16],
      ] as const) {
        rowId += 1;
        await db
          .prepare(
            "INSERT INTO api_key_usage_daily(account_id,day,route,request_count) VALUES(42,'2026-11-04',?,?)",
          )
          .bind(route, count)
          .run();
        await control.query(
          "INSERT INTO app.api_key_usage_daily(account_id,day,route,request_count,source_row_id) VALUES(42,'2026-11-04',$1,$2::numeric,$3)",
          [route, sqliteNumberDecimal(count), rowId],
        );
      }
      await db
        .prepare(
          "INSERT INTO api_key_usage_daily(account_id,day,route,request_count) VALUES(42,'2026-11-04','infinite',9e999)",
        )
        .run();
      await control.query(
        "INSERT INTO app.api_key_usage_daily(account_id,day,route,request_count,source_row_id) VALUES(42,'2026-11-04','infinite','Infinity',4)",
      );
      assert.deepEqual(
        await readers.accountRows(42, "2026-11-01"),
        (
          await db
            .prepare(
              "SELECT day,route,request_count,rejected_count FROM api_key_usage_daily WHERE account_id=42 AND day>='2026-11-01' ORDER BY day DESC",
            )
            .all()
        ).results,
      );
      assert.deepEqual(
        await readers.anomalyRows("2026-11-01"),
        (
          await db
            .prepare(
              "SELECT account_id,day,route,request_count FROM api_key_usage_daily WHERE day>='2026-11-01' ORDER BY account_id,day",
            )
            .all()
        ).results,
      );
      const values = [
        {
          family: "z",
          shape: "same",
          requests: "1",
          keyed: "10000000000000000",
          keyedPg: "10000000000000000",
        },
        {
          family: "a",
          shape: "same",
          requests: "1",
          keyed: "0.1",
          keyedPg: sqliteNumberDecimal(0.1),
        },
        {
          family: "m",
          shape: "same",
          requests: "1",
          keyed: "-10000000000000000",
          keyedPg: "-10000000000000000",
        },
        {
          family: "smaller",
          shape: "wide",
          requests: "9007199254740992",
          keyed: "0",
          keyedPg: "0",
        },
        {
          family: "greater",
          shape: "wide",
          requests: "9007199254740993",
          keyed: "0",
          keyedPg: "0",
        },
        {
          family: "positive",
          shape: "indeterminate",
          requests: "1",
          keyed: "9e999",
          keyedPg: "Infinity",
        },
        {
          family: "negative",
          shape: "indeterminate",
          requests: "1",
          keyed: "-9e999",
          keyedPg: "-Infinity",
        },
      ];
      rowId = 0;
      for (const value of values) {
        rowId += 1;
        await db
          .prepare(
            `INSERT INTO api_usage_rollup(day,route_family,cost_shape,request_count,keyed_count) VALUES('2026-11-04',?,?,${value.requests},${value.keyed})`,
          )
          .bind(value.family, value.shape)
          .run();
        await control.query(
          "INSERT INTO app.api_usage_rollup(day,route_family,cost_shape,request_count,keyed_count,source_row_id) VALUES('2026-11-04',$1,$2,$3::numeric,$4::numeric,$5)",
          [value.family, value.shape, value.requests, value.keyedPg, rowId],
        );
      }
      for (const groupBy of ["family", "shape"] as const) {
        const columns =
          groupBy === "shape" ? "cost_shape" : "route_family,cost_shape";
        const expected = (
          await db
            .prepare(
              `SELECT ${columns},SUM(request_count) AS request_count,SUM(keyed_count) AS keyed_count FROM api_usage_rollup WHERE day>='2026-11-01' GROUP BY ${columns} ORDER BY SUM(request_count) DESC${groupBy === "family" ? " LIMIT 500" : ""}`,
            )
            .all()
        ).results;
        assert.deepEqual(
          await readers.rollupRows("2026-11-01", groupBy),
          expected,
        );
      }
    });

    it("replays an uncertain committed batch once without duplicating usage", async () => {
      let calls = 0;
      const uncertain: Pick<PgStoreRuntime, "transaction"> = {
        async transaction(callback, options) {
          const value = await runtime.transaction(callback, options);
          calls += 1;
          if (calls === 1)
            throw Object.assign(new Error("fixture lost commit reply"), {
              code: "08006",
            });
          return value;
        },
      };
      await createPgAccountUsage(uncertain).writeRollup(
        [
          {
            day: "2026-11-04",
            family: "a",
            cost_shape: "edge",
            request_count: 3,
            keyed_count: 2,
          },
        ],
        { batchId: "uncertain-fixture" },
      );
      assert.equal(calls, 2);
      assert.deepEqual(
        (
          await control.query(
            "SELECT request_count::text AS requests,keyed_count::text AS keyed FROM app.api_usage_rollup",
          )
        ).rows,
        [{ requests: "3", keyed: "2" }],
      );
      assert.equal(
        (
          await control.query(
            "SELECT applied FROM app.api_usage_rollup_batches WHERE batch_id='uncertain-fixture'",
          )
        ).rows[0].applied,
        true,
      );
    });

    it("refuses expired batches and pool saturation without a partial write", async () => {
      const rows = [
        {
          day: "2026-11-04",
          family: "a",
          cost_shape: "edge",
          request_count: 3,
          keyed_count: 2,
        },
      ];
      await assert.rejects(
        createPgAccountUsage(runtime).writeRollup(rows, {
          batchId: "expired-fixture",
          now: () => 0,
        }),
        /acknowledged/,
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::int AS n FROM app.api_usage_rollup_batches",
          )
        ).rows[0].n,
        0,
      );
      const limited = createPgStoreRuntime({
        connectionString,
        maxConnections: 1,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError() {},
      });
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = limited.transaction(async () => {
        entered();
        await gate;
      });
      try {
        await ready;
        await assert.rejects(
          createPgAccountUsage(limited).writeRollup(rows),
          /at capacity/,
        );
        assert.equal(
          (
            await control.query(
              "SELECT count(*)::int AS n FROM app.api_usage_rollup",
            )
          ).rows[0].n,
          0,
        );
      } finally {
        release();
        await held;
        await limited.close();
      }
    });

    it("retains durable blocks after cache expiry and never turns authority failure into a grant", async () => {
      await control.query(
        "INSERT INTO app.api_key_blocks(account_kind,account_id,reason_code,blocked_at) VALUES ('github',42,'abuse_manual',0),('rpc',9007199254740993,'abuse_manual',0)",
      );
      const authority = createPgAccountBlocks(runtime);
      assert.equal(
        (await authority.read(9007199254740992, "rpc")).blocked,
        true,
      );
      assert.equal((await authority.read(0, "rpc")).blocked, false);
      let clock = Date.now(),
        draws = 0;
      const kv = createPgKv(runtime, "control", { now: () => clock });
      await kv.put(
        "api-key-blocklist",
        JSON.stringify({
          blocks: [
            {
              accountKind: "github",
              accountId: 42,
              reasonCode: "abuse_manual",
            },
          ],
        }),
        { expirationTtl: 60 },
      );
      const env = {
        CONTROL_KV_STORE: kv,
        ACCOUNT_BLOCK_STORE: authority,
        KEYED: {
          limit: async () => {
            draws += 1;
            return { success: true };
          },
        },
      } as unknown as Env;
      const config = {
        anonymous: { envVar: "ANON", limit: 10, windowSeconds: 60 },
        keyed: { envVar: "KEYED", limit: 100, windowSeconds: 60 },
        keyPrefix: "fixture",
      };
      const request = () =>
        new Request("https://api.example.com/api/v1/fixture");
      const gate = (selected = env) =>
        applyTieredRateLimit(request(), selected, config, {
          oauthIdentity: { accountId: 42, tier: "paid" },
        });
      assert.equal((await gate()).allowed, false);
      clock += 61000;
      assert.equal(await kv.get("api-key-blocklist"), null);
      assert.equal((await gate()).allowed, false);
      await kv.put("api-key-blocklist", JSON.stringify({ blocks: [{}] }), {
        expirationTtl: 60,
      });
      assert.equal((await gate()).allowed, false);
      await assert.rejects(
        gate({
          ...env,
          ACCOUNT_BLOCK_STORE: {
            read: async () => {
              throw new Error("authority unavailable");
            },
          },
        } as unknown as Env),
        /authority unavailable/,
      );
      assert.equal(draws, 0);
      await control.query(
        "UPDATE app.api_key_blocks SET unblocked_at=1 WHERE account_kind='github'",
      );
      await kv.delete("api-key-blocklist");
      assert.equal((await gate()).allowed, true);
      assert.equal(draws, 1);
    });
  },
);
