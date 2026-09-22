import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { handleD1StateExport } from "../src/d1-state-export.ts";
import { handleRootBasketExport } from "../src/root-basket-export.ts";
import { createD1Store } from "../src/d1-store.ts";
import {
  ROOT_BASKET_D1_TABLES,
  writeRootBasketCaptureD1,
} from "../src/root-basket-capture-d1.ts";
import { syntheticBasketCapture } from "./fixtures/root-basket-capture.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const value = syntheticBasketCapture();
const scope = {
  kind: "basket",
  network: value.network,
  network_genesis_hash: value.network_genesis_hash,
  decoder_version: value.decoder_version,
};
const env = () => ({
  D1_STATE: db,
  D1_STATE_TABLES: ROOT_BASKET_D1_TABLES.join(","),
  STATE_EXPORT_SECRET: "test-secret",
});
type Result = {
  ceiling: string | null;
  captures: string[];
  rows: Record<string, string | null>[];
  next_cursor: (string | number)[] | null;
};
async function get(extra: Record<string, unknown>) {
  const response = await handleRootBasketExport({ ...scope, ...extra }, env());
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json<Result>();
}
const requestRows = (table: string, extra = {}) =>
  get({ operation: "rows", table, capture_id: value.capture_id, ...extra });
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const sql of readFileSync(
    new URL("../migrations/d1/0015_root_basket.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (sql.trim()) await db.prepare(sql).run();
  await db
    .prepare(
      readFileSync(
        new URL(
          "../migrations/d1/0017_root_basket_export.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
    .run();
  value.finalized_block = "18446744073709551615";
  const fund = value.funds[0]!;
  fund.shares_atomic = "18446744073709551615";
  fund.display_shares_q64_bits = "340282366920938463463374607431768211455";
  fund.baseline.rate0_q32_bits = "-170141183460469231731687303715884105728";
  fund.holdings = Array.from({ length: 501 }, (_, i) => ({
    ...fund.holdings[1]!,
    netuid: i + 1,
  }));
  fund.targets = Array.from({ length: 501 }, (_, i) => ({
    netuid: i + 1,
    weight: 1,
  }));
  await writeRootBasketCaptureD1(createD1Store(db), value, 3000);
});
afterAll(async () => runtime.dispose());

test("capture discovery uses the scoped covering index without a sort", async () => {
  for (const suffix of [
    "ORDER BY c.capture_id DESC LIMIT 1",
    "AND c.capture_id > '' AND c.capture_id <= 'ffffffff-ffff-ffff-ffff-ffffffffffff' ORDER BY c.capture_id LIMIT 64",
  ]) {
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT c.capture_id
      FROM root_basket_captures c JOIN root_basket_capture_completions r USING(capture_id)
      WHERE c.network=? AND c.network_genesis_hash=? AND c.decoder_version=? ${suffix}`,
      )
      .bind(scope.network, scope.network_genesis_hash, scope.decoder_version)
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join("\n");
    assert.match(
      detail,
      /SEARCH c USING COVERING INDEX root_basket_captures_export/,
    );
    assert.doesNotMatch(detail, /SCAN c|TEMP B-TREE/);
  }
});

test("protected endpoint exports exact immutable receipt and capture fields", async () => {
  const request = (token: string) =>
    new Request("https://example.com/export", {
      method: "POST",
      headers: { "x-state-export-token": token },
      body: JSON.stringify({ ...scope, operation: "ceiling" }),
    });
  assert.equal(
    (await handleD1StateExport(request("wrong"), env())).status,
    401,
  );
  assert.equal(
    (await handleD1StateExport(request("test-secret"), env())).status,
    200,
  );
  const first = await requestRows("root_basket_captures");
  assert.equal(first.rows[0]!.finalized_block, value.finalized_block);
  assert.equal(first.rows[0]!.accepted_at_ms, "3000");
  assert.equal(first.rows[0]!.expected_funds, "1");
  const funds = await requestRows("root_basket_fund_snapshots");
  assert.equal(funds.rows[0]!.shares_atomic, value.funds[0]!.shares_atomic);
  assert.equal(
    funds.rows[0]!.display_shares_q64_bits,
    value.funds[0]!.display_shares_q64_bits,
  );
  assert.equal(
    funds.rows[0]!.rate0_q32_bits,
    value.funds[0]!.baseline.rate0_q32_bits,
  );
  assert.equal(funds.rows[0]!.provisional, "false");
  await writeRootBasketCaptureD1(
    createD1Store(db),
    {
      ...value,
      capture_id: "00000000-0000-4000-8000-000000000002",
      started_at_ms: "2500",
      finished_at_ms: "2600",
    },
    4000,
  );
  assert.deepEqual(await requestRows("root_basket_captures"), first);
  await db
    .prepare(
      "ALTER TABLE root_basket_captures ADD COLUMN secret_note TEXT DEFAULT 'must remain private'",
    )
    .run();
  assert.deepEqual(await requestRows("root_basket_captures"), first);
});

test("keyset pages cover children exactly and each table accepts only its cursor shape", async () => {
  for (const table of ["root_basket_holdings", "root_basket_targets"]) {
    const first = await requestRows(table);
    assert.equal(first.rows.length, 500);
    assert.deepEqual(first.next_cursor, [value.funds[0]!.hotkey, 500]);
    const last = await requestRows(table, { cursor: first.next_cursor });
    assert.equal(last.rows.length, 1);
    assert.equal(last.rows[0]!.netuid, "501");
    assert.equal(last.next_cursor, null);
  }
  for (const [table, cursor] of [
    ["root_basket_captures", [value.capture_id]],
    ["root_basket_capture_pages", [0]],
    ["root_basket_fund_snapshots", [value.funds[0]!.hotkey]],
  ] as const) {
    assert.equal((await requestRows(table)).rows.length, 1);
    assert.deepEqual((await requestRows(table, { cursor })).rows, []);
  }
});

test("discovery is scoped, bounded, ordered, and hides incomplete captures", async () => {
  const genesis = `0x${"aa".repeat(32)}`;
  const empty = {
    ...value,
    network_genesis_hash: genesis,
    funds: [],
    expected_funds: 0,
    pages: [{ ...value.pages[0]!, fund_count: 0 }],
  };
  const ids: string[] = [];
  for (let n = 10; n < 76; n++) {
    const id = `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
    await writeRootBasketCaptureD1(
      createD1Store(db),
      {
        ...empty,
        capture_id: id,
        finalized_block: String(1000 + n),
        finalized_block_hash: `0x${n.toString(16).padStart(64, "0")}`,
      },
      n,
    );
    ids.push(id);
  }
  const scoped = (extra: Record<string, unknown>) =>
    get({ network_genesis_hash: genesis, ...extra });
  assert.equal((await scoped({ operation: "ceiling" })).ceiling, ids.at(-1));
  const first = await scoped({ operation: "discover", through: ids.at(-1) });
  assert.deepEqual(first.captures, ids.slice(0, 64));
  assert.deepEqual(
    (
      await scoped({
        operation: "discover",
        through: ids.at(-1),
        after: ids[63],
        limit: 1,
      })
    ).captures,
    [ids[64]],
  );
  assert.equal(
    (await scoped({ operation: "ceiling", network: "test" })).ceiling,
    null,
  );
  assert.deepEqual(
    (
      await scoped({
        operation: "rows",
        table: "root_basket_captures",
        capture_id: value.capture_id,
      })
    ).rows,
    [],
  );
  const incomplete = {
    ...(await db
      .prepare("SELECT * FROM root_basket_captures WHERE capture_id=?")
      .bind(value.capture_id)
      .first<Record<string, unknown>>())!,
    capture_id: "00000000-0000-4000-8000-000000000099",
    network_genesis_hash: `0x${"bb".repeat(32)}`,
  };
  await db
    .prepare(
      `INSERT INTO root_basket_captures (${Object.keys(incomplete).join(",")}) VALUES (${Object.keys(
        incomplete,
      )
        .map(() => "?")
        .join(",")})`,
    )
    .bind(...Object.values(incomplete))
    .run();
  assert.equal(
    (
      await get({
        operation: "ceiling",
        network_genesis_hash: incomplete.network_genesis_hash,
      })
    ).ceiling,
    null,
  );
  assert.deepEqual(
    (
      await get({
        operation: "rows",
        table: "root_basket_captures",
        capture_id: incomplete.capture_id,
        network_genesis_hash: incomplete.network_genesis_hash,
      })
    ).rows,
    [],
  );
  const provisional = {
    ...empty,
    network_genesis_hash: `0x${"cc".repeat(32)}`,
    capture_id: "00000000-0000-4000-8000-000000000098",
    expected_funds: 1,
    pages: value.pages,
    funds: [
      {
        ...value.funds[0]!,
        baseline: {
          provisional: true as const,
          first_block: "0" as const,
          price_divisor_q64_bits: null,
          rate0_q32_bits: null,
          tr_splice_q64_bits: null,
        },
      },
    ],
  };
  await writeRootBasketCaptureD1(createD1Store(db), provisional, 1);
  assert.equal(
    (
      await get({
        operation: "rows",
        table: "root_basket_fund_snapshots",
        capture_id: provisional.capture_id,
        network_genesis_hash: provisional.network_genesis_hash,
      })
    ).rows[0]!.provisional,
    "true",
  );
});

test("invalid input and missing or partial D1 ownership fail without another store", async () => {
  for (const extra of [
    { operation: "bad" },
    { operation: "ceiling", decoder_version: "unknown" },
    { operation: "ceiling", extra: "not allowed" },
    { operation: "discover" },
    { operation: "discover", through: value.capture_id, limit: 65 },
    { operation: "rows" },
    { operation: "rows", table: "root_basket_captures" },
    { operation: "rows", table: "api_keys", capture_id: value.capture_id },
    {
      operation: "rows",
      table: "root_basket_capture_pages",
      capture_id: value.capture_id,
      cursor: ["wrong"],
    },
    {
      operation: "rows",
      table: "root_basket_holdings",
      capture_id: value.capture_id,
      cursor: [value.funds[0]!.hotkey],
    },
  ])
    assert.equal(
      (await handleRootBasketExport({ ...scope, ...extra }, env())).status,
      400,
    );
  for (const overrides of [
    { D1_STATE_TABLES: "" },
    { D1_STATE_TABLES: "root_basket_captures" },
    { D1_STATE: undefined },
  ])
    assert.equal(
      (
        await handleRootBasketExport(
          { ...scope, operation: "ceiling" },
          { ...env(), ...overrides },
        )
      ).status,
      503,
    );
});

test("binding failures and oversized export pages never become successful partial archives", async () => {
  for (const results of [
    null,
    [
      {
        _cursor: JSON.stringify([value.capture_id]),
        value: "x".repeat(2 * 1024 * 1024),
      },
    ],
  ]) {
    const statement = {
      bind() {
        return this;
      },
      async all() {
        if (results === null) throw new Error("private binding detail");
        return { results };
      },
    };
    const response = await handleRootBasketExport(
      {
        ...scope,
        operation: "rows",
        table: "root_basket_captures",
        capture_id: value.capture_id,
      },
      {
        ...env(),
        D1_STATE: { prepare: () => statement, batch: async () => [] },
      },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "basket export unavailable",
    });
  }
});
