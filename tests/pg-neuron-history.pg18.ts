import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgNeuronHistoryStore } from "../src/pg-neuron-history.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import type { D1StoreBinding } from "../src/d1-store.ts";
import {
  loadAccountPositionHistoryColdTier,
  loadNeuronHistoryColdTier,
} from "../src/neuron-daily-cold-tier.ts";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const runtime = createPgStoreRuntime({
  connectionString,
  maxConnections: 2,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 1000,
  statementTimeoutMillis: 5000,
  onIdleError() {},
});
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const native = createPgNeuronHistoryStore(runtime, decoder);
const source = new DatabaseSync(":memory:");
const objects = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as { type: string; name: string; sql: string }[];
const names = new Set([
  "neuron_daily_documents",
  "neuron_daily_members",
  "neuron_daily",
  "account_position_daily_documents",
  "account_position_daily_members",
  "account_position_daily",
]);
const binding = {
  prepare(text: string) {
    let values: (string | number | null)[] = [];
    return {
      bind(...input: (string | number | null)[]) {
        values = input;
        return this;
      },
      async all() {
        const statement = source.prepare(text);
        statement.setReadBigInts(true);
        return {
          results: statement
            .all(...values)
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([name, value]) => [
                  name,
                  typeof value === "bigint" ? Number(value) : value,
                ]),
              ),
            ),
          success: true,
          meta: {},
        };
      },
    };
  },
  batch() {
    throw new Error("Read fixture does not write");
  },
} as unknown as D1StoreBinding;
const sourceEnv = {
  ...dataApiEnv(),
  D1_STATE: binding as unknown as D1Database,
  D1_STATE_TABLES: objects
    .filter((o) => o.type === "table" || o.type === "view")
    .map((o) => o.name)
    .join(",") as DataApiEnv["D1_STATE_TABLES"],
};
const nativeEnv = { ...dataApiEnv(), NEURON_HISTORY_STORE: native };
const account = "A".repeat(48),
  accountKey = "k" + Buffer.from(account).toString("hex").toUpperCase();
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
let ownApp = false;

describe(
  "native daily history on PostgreSQL 18.6",
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
      await control.query(
        readFileSync(
          new URL(
            "../migrations/postgres/0024_neuron_documents.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      for (const object of objects.filter(
        (o) => o.type === "table" && names.has(o.name),
      ))
        source.exec(object.sql);
      for (const object of objects.filter(
        (o) => o.type === "view" && names.has(o.name),
      ))
        source.exec(object.sql);
      for (const [day, rank] of [
        ["2026-01-01", 0.1],
        ["2026-01-02", 0.2],
        ["2026-01-03", 0.3],
      ] as const) {
        const text = `{"2":{"rank":${rank},"active":1,"validator_permit":true,"captured_at":1767225600000,"take":0.1,"registered_at_block":9007199254740993},"2":{"rank":99},"${accountKey}":{"uid":2,"rank":${rank},"stake_tao":4,"captured_at":1767225600000},"${accountKey}":{"uid":99}}`;
        const payload = source.prepare("SELECT jsonb(?) AS payload").get(text)!
          .payload as Uint8Array;
        for (const table of [
          "neuron_daily_documents",
          "account_position_daily_documents",
        ]) {
          source
            .prepare(`INSERT INTO ${table} VALUES(7,?,0,1767225600000,?)`)
            .run(day, payload);
          await control.query(
            `INSERT INTO app.${table} VALUES(7,$1,0,1767225600000,$2)`,
            [day, payload],
          );
        }
        source
          .prepare(
            "INSERT INTO neuron_daily_members VALUES(7,2,?,'member-key',NULL,0,NULL,0)",
          )
          .run(day);
        await control.query(
          "INSERT INTO app.neuron_daily_members VALUES(7,2,$1,'member-key',NULL,0,NULL,false)",
          [day],
        );
        source
          .prepare("INSERT INTO account_position_daily_members VALUES(?,7,?,0)")
          .run(account, day);
        await control.query(
          "INSERT INTO app.account_position_daily_members VALUES($1,7,$2,0)",
          [account, day],
        );
      }
      // A member pointing at no document is absent from each source SQL view.
      source.exec(
        "INSERT INTO neuron_daily_members VALUES(7,2,'2026-01-04','orphan',NULL,9,NULL,0)",
      );
      await control.query(
        "INSERT INTO app.neuron_daily_members VALUES(7,2,'2026-01-04','orphan',NULL,9,NULL,false)",
      );
    });
    after(async () => {
      await runtime.close();
      decoder.close();
      source.close();
      if (ownApp) await control.query("DROP SCHEMA app CASCADE");
      else
        for (const name of [
          "_audit_neuron_docs_20260922",
          "_audit_neuron_members_20260922",
          "neurons_documents",
          "neurons_members",
          "neuron_daily_documents",
          "neuron_daily_members",
          "account_position_daily_documents",
          "account_position_daily_members",
          "neurons_capture_batches",
          "neurons_passes",
          "neuron_document_projections",
        ])
          await control.query(`DROP TABLE IF EXISTS app.${name} CASCADE`);
      await control.end();
    });

    it("serves byte-identical REST histories using first keys and excludes unmatched shards", async () => {
      for (const path of [
        "subnets/7/neurons/2/history",
        `accounts/${account}/subnets/7/history`,
      ]) {
        const request = new Request(
          `https://example.com/api/v1/${path}?window=all`,
        );
        const expected = await worker.fetch(request.clone(), sourceEnv, ctx);
        const actual = await worker.fetch(request.clone(), nativeEnv, ctx);
        assert.equal(expected.status, 200);
        assert.equal(actual.status, expected.status);
        assert.equal(await actual.text(), await expected.text());
      }
    });

    it("shared history readers preserve the strict seam, inclusive start and limit", async () => {
      const expected = await loadNeuronHistoryColdTier(
        sourceEnv,
        7,
        2,
        "2026-01-02",
        "2026-01-03",
        1,
      );
      const actual = await loadNeuronHistoryColdTier(
        nativeEnv,
        7,
        2,
        "2026-01-02",
        "2026-01-03",
        1,
      );
      assert.deepEqual(actual, expected);
      assert.equal(actual?.[0]?.rank, 0.2);
      assert.deepEqual(
        await loadAccountPositionHistoryColdTier(
          nativeEnv,
          account,
          7,
          null,
          "2026-01-03",
          1,
        ),
        await loadAccountPositionHistoryColdTier(
          sourceEnv,
          account,
          7,
          null,
          "2026-01-03",
          1,
        ),
      );
      assert.deepEqual(
        await native.neuronRows(7, 99, { lo: null, hi: null }, 4),
        [],
      );
      assert.deepEqual(
        await native.accountRows("missing", 7, { lo: null, hi: null }, 4),
        [],
      );
    });
  },
);
