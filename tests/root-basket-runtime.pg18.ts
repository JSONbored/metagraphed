import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgRootBasketStore } from "../src/root-basket-pg.ts";
import { createD1Store, type D1StoreBinding } from "../src/d1-store.ts";
import {
  ROOT_BASKET_D1_TABLES,
  writeRootBasketCaptureD1,
} from "../src/root-basket-capture-d1.ts";
import { handleRootBasketExport } from "../src/root-basket-export.ts";
import { handleRootBasketCaptureSync } from "../src/root-basket-capture-sync.ts";
import { handleD1StateExport } from "../src/d1-state-export.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";
import { syntheticBasketCapture } from "./fixtures/root-basket-capture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  statement_timeout: 5000,
  connectionTimeoutMillis: 2000,
});
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
const definitions = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as { type: string; tbl_name: string; sql: string }[];
let sqlite: DatabaseSync;
let runtime: PgStoreRuntime;
let native: ReturnType<typeof createPgRootBasketStore>;
let d1: D1StoreBinding;
const source = () => createD1Store(d1);
function binding(): D1StoreBinding {
  const prepare = (text: string, values: SQLInputValue[] = []) => ({
    bind: (...params: SQLInputValue[]) => prepare(text, params),
    async all() {
      return { results: sqlite.prepare(text).all(...values), meta: {} };
    },
    async run() {
      return {
        results: [],
        meta: { changes: Number(sqlite.prepare(text).run(...values).changes) },
      };
    },
  });
  return {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1StoreBinding;
}
async function equivalent() {
  for (const table of ROOT_BASKET_D1_TABLES) {
    const columns = sqlite
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name));
    const fields = columns
      .map((name) => `CAST(${name} AS TEXT) AS ${name}`)
      .join(",");
    const order = columns.join(",");
    const expected = sqlite
      .prepare(`SELECT ${fields} FROM ${table} ORDER BY ${order}`)
      .all()
      .map((row) => ({ ...row }));
    const actual = await control.query(
      `SELECT ${fields} FROM app.${table} ORDER BY ${order}`,
    );
    assert.deepEqual(actual.rows, expected, table);
  }
}
async function both(input = syntheticBasketCapture(), now = 3000) {
  const expected = await writeRootBasketCaptureD1(source(), input, now);
  assert.deepEqual(await native.write(input, now), expected);
  await equivalent();
  return expected;
}
const scope = () => {
  const value = syntheticBasketCapture();
  return {
    kind: "basket",
    network: value.network,
    network_genesis_hash: value.network_genesis_hash,
    decoder_version: value.decoder_version,
  };
};
const nativeEnv = () => ({
  ROOT_BASKET_STORE: native,
  ROOT_BASKET_CAPTURE_SYNC_SECRET: "test",
  STATE_EXPORT_SECRET: "test",
});
const d1Env = () => ({
  D1_STATE: d1,
  D1_STATE_TABLES: ROOT_BASKET_D1_TABLES.join(","),
  STATE_EXPORT_SECRET: "test",
});
async function sameExport(extra: Record<string, unknown>) {
  const input = { ...scope(), ...extra };
  const expected = await handleRootBasketExport(input, d1Env());
  const actual = await handleRootBasketExport(input, nativeEnv());
  assert.equal(actual.status, expected.status);
  assert.equal(actual.headers.get("cache-control"), "no-store");
  const expectedBody = await expected.text();
  assert.equal(await actual.text(), expectedBody);
  return JSON.parse(expectedBody);
}
const request = (input: unknown, token = "test") =>
  new Request("https://example.com/internal", {
    method: "POST",
    headers: {
      "x-root-basket-capture-sync-token": token,
      "x-state-export-token": token,
    },
    body: JSON.stringify(input),
  });

describe("native Root basket source parity", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    runtime = createPgStoreRuntime({
      connectionString,
      maxConnections: 2,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 1000,
      statementTimeoutMillis: 5000,
      onIdleError: (error) => {
        throw error;
      },
    });
    native = createPgRootBasketStore(runtime);
  });
  beforeEach(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.query(migration("0020_root_basket.sql"));
    await control.query("BEGIN");
    await control.query(migration("0021_root_basket_activate.sql"));
    await control.query("COMMIT");
    sqlite?.close();
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON");
    for (const kind of ["table", "other"])
      for (const definition of definitions.filter(
        (row) =>
          ROOT_BASKET_D1_TABLES.includes(
            row.tbl_name as (typeof ROOT_BASKET_D1_TABLES)[number],
          ) && (kind === "table" ? row.type === "table" : row.type !== "table"),
      ))
        sqlite.exec(definition.sql);
    d1 = binding();
  });
  after(async () => {
    sqlite?.close();
    await runtime?.close();
    try {
      await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    } finally {
      await control.end();
    }
  });

  it("preserves exact counters, receipt provenance, unordered replay and source current order", async () => {
    const value = syntheticBasketCapture();
    value.finalized_block = "18446744073709551615";
    value.funds[0]!.shares_atomic = "18446744073709551615";
    value.funds[0]!.display_shares_q64_bits =
      "340282366920938463463374607431768211455";
    value.funds[0]!.baseline.rate0_q32_bits =
      "-170141183460469231731687303715884105728";
    await both(value);
    const replay = structuredClone(value);
    replay.capture_id = "00000000-0000-4000-8000-000000000002";
    replay.started_at_ms = "4000";
    replay.finished_at_ms = "5000";
    replay.funds[0]!.holdings.reverse();
    replay.funds[0]!.targets.reverse();
    assert.equal((await both(replay, 6000)).replayed, true);
    const older = {
      ...value,
      capture_id: "00000000-0000-4000-8000-000000000003",
      finalized_block: "501",
      finalized_block_hash: `0x${"ab".repeat(32)}`,
    };
    await both(older);
    assert.equal(
      (await native.read.first<{ capture_id: string }>(
        "SELECT capture_id FROM root_basket_current",
      ))!.capture_id,
      value.capture_id,
    );
  });

  it("rejects source conflicts atomically through the protected sync handler", async () => {
    const value = syntheticBasketCapture();
    await both(value);
    const content = structuredClone(value);
    content.funds[0]!.deposited_rao = "9";
    const fork = {
      ...value,
      capture_id: "00000000-0000-4000-8000-000000000004",
      finalized_block_hash: `0x${"ab".repeat(32)}`,
    };
    const reused = {
      ...value,
      finalized_block: "501",
      finalized_block_hash: `0x${"cd".repeat(32)}`,
    };
    for (const input of [content, fork, reused]) {
      const response = await handleRootBasketCaptureSync(
        request(input),
        nativeEnv(),
      );
      assert.equal(response.status, 409, await response.clone().text());
      await assert.rejects(
        writeRootBasketCaptureD1(source(), input, 4000),
        /ROOT_BASKET_CAPTURE_CONFLICT/,
      );
      await equivalent();
    }
    assert.equal(
      (await handleRootBasketCaptureSync(request(value, "wrong"), nativeEnv()))
        .status,
      401,
    );
  });

  it("rolls back every family row after a mid-capture error and allows an exact retry", async () => {
    const broken = createPgRootBasketStore({
      transaction: (callback, options) =>
        runtime.transaction(
          (tx) =>
            callback({
              ...tx,
              run: (text, values) => {
                if (text.includes("INSERT INTO app.root_basket_targets"))
                  throw new Error("injected target failure");
                return tx.run(text, values);
              },
            }),
          options,
        ),
    });
    await assert.rejects(
      broken.write(syntheticBasketCapture(), 1),
      /injected target failure/,
    );
    for (const table of ROOT_BASKET_D1_TABLES)
      assert.equal(
        (await control.query(`SELECT COUNT(*)::int AS n FROM app.${table}`))
          .rows[0].n,
        0,
      );
    await both();
  });

  it("concurrent identical attempts retain the first complete provenance without closing the pool", async () => {
    const first = syntheticBasketCapture();
    const second = {
      ...first,
      capture_id: "00000000-0000-4000-8000-000000000005",
      started_at_ms: "3000",
      finished_at_ms: "4000",
    };
    const results = await Promise.all([
      native.write(first, 5000),
      native.write(second, 6000),
    ]);
    assert.equal(results[0]!.capture_id, results[1]!.capture_id);
    assert.deepEqual(results.map((r) => r.replayed).sort(), [false, true]);
    const retainedFirst = results[0]!.capture_id === first.capture_id;
    await writeRootBasketCaptureD1(
      source(),
      retainedFirst ? first : second,
      retainedFirst ? 5000 : 6000,
    );
    await equivalent();
    assert.equal((await native.read.query("SELECT 1 AS alive")).length, 1);
  });

  it("exports identical scoped envelopes, exact strings, keyset pages and empty captures", async () => {
    const value = syntheticBasketCapture();
    const fund = value.funds[0]!;
    fund.holdings = Array.from({ length: 1001 }, (_, i) => ({
      ...fund.holdings[1]!,
      netuid: i + 1,
    }));
    fund.targets = Array.from({ length: 501 }, (_, i) => ({
      netuid: i + 1,
      weight: 1,
    }));
    await both(value);
    await sameExport({ operation: "ceiling" });
    await sameExport({
      operation: "discover",
      through: value.capture_id,
      limit: 1,
    });
    for (const table of ROOT_BASKET_D1_TABLES.slice(0, 5)) {
      let cursor: unknown;
      do {
        const page = await sameExport({
          operation: "rows",
          table,
          capture_id: value.capture_id,
          ...(cursor ? { cursor } : {}),
        });
        cursor = page.next_cursor;
      } while (cursor);
    }
    const empty = {
      ...value,
      capture_id: "00000000-0000-4000-8000-000000000006",
      finalized_block: "501",
      finalized_block_hash: `0x${"aa".repeat(32)}`,
      expected_funds: 0,
      funds: [],
      pages: [{ ...value.pages[0]!, fund_count: 0 }],
    };
    await both(empty);
    await sameExport({
      operation: "rows",
      table: "root_basket_holdings",
      capture_id: empty.capture_id,
    });
    await sameExport({ operation: "ceiling", network: "test" });
    const protectedInput = { ...scope(), operation: "ceiling" };
    const response = await handleD1StateExport(
      request(protectedInput),
      nativeEnv(),
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await handleD1StateExport(request(protectedInput, "wrong"), nativeEnv()))
        .status,
      401,
    );
  });

  it("refuses unactivated native state and does not fall back to a valid source", async () => {
    await control.query(
      "ALTER TABLE app.root_basket_captures DISABLE TRIGGER root_basket_check_replay",
    );
    await assert.rejects(
      native.write(syntheticBasketCapture(), 1),
      /not activated/,
    );
    assert.equal(
      (
        await handleRootBasketExport(
          { ...scope(), operation: "ceiling" },
          { ...d1Env(), ROOT_BASKET_STORE: native },
        )
      ).status,
      503,
    );
  });
});
