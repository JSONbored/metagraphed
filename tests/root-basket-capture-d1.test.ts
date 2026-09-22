import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test, vi } from "vitest";
import { Client } from "pg";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import {
  ROOT_BASKET_D1_TABLES,
  writeRootBasketCaptureD1,
} from "../src/root-basket-capture-d1.ts";
import { handleRootBasketCaptureSync } from "../src/root-basket-capture-sync.ts";
import { syntheticBasketCapture } from "./fixtures/root-basket-capture.ts";
import type { ProducerStore } from "../src/producer-store.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let seq = 0;
function capture() {
  const value = syntheticBasketCapture();
  value.network_genesis_hash = `0x${(++seq).toString(16).padStart(64, "0")}`;
  value.capture_id = `00000000-0000-4000-8000-${seq.toString().padStart(12, "0")}`;
  return value;
}
const apply = (value: unknown, store: ProducerStore = createD1Store(db)) =>
  writeRootBasketCaptureD1(store, value, 3000);
const rows = async (sql: string, params: unknown[] = []) =>
  (
    await db
      .prepare(sql)
      .bind(...params)
      .all()
  ).results;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const statement of readFileSync(
    new URL("../migrations/d1/0015_root_basket.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (statement.trim()) await db.prepare(statement).run();
});
afterAll(async () => runtime.dispose());

test("native capture preserves exact signed/unsigned extremes and first provenance on replay", async () => {
  const value = capture();
  value.finalized_block = "18446744073709551615";
  value.funds[0].shares_atomic = "18446744073709551615";
  value.funds[0].display_shares_q64_bits =
    "340282366920938463463374607431768211455";
  value.funds[0].baseline.rate0_q32_bits =
    "-170141183460469231731687303715884105728";
  const first = await apply(value);
  assert.equal(first.replayed, false);
  const replay = {
    ...value,
    capture_id: capture().capture_id,
    started_at_ms: "2500",
    finished_at_ms: "2600",
  };
  assert.deepEqual(await apply(replay), { ...first, replayed: true });
  assert.deepEqual(
    await rows(
      "SELECT shares_atomic,display_shares_q64_bits,rate0_q32_bits FROM root_basket_fund_snapshots WHERE capture_id = ?",
      [value.capture_id],
    ),
    [
      {
        shares_atomic: value.funds[0].shares_atomic,
        display_shares_q64_bits: value.funds[0].display_shares_q64_bits,
        rate0_q32_bits: value.funds[0].baseline.rate0_q32_bits,
      },
    ],
  );
  assert.deepEqual(
    await rows(
      "SELECT started_at_ms,finished_at_ms FROM root_basket_captures WHERE capture_id = ?",
      [value.capture_id],
    ),
    [{ started_at_ms: "1000", finished_at_ms: "2000" }],
  );
  assert.equal(
    (
      await rows(
        "SELECT * FROM root_basket_current WHERE network_genesis_hash = ?",
        [value.network_genesis_hash],
      )
    )[0].capture_id,
    first.capture_id,
  );
});

test("simultaneous replays retain one observation; conflicts do not mutate it", async () => {
  const value = capture();
  const outcomes = await Promise.all([
    apply(value),
    apply({ ...value, capture_id: capture().capture_id }),
  ]);
  assert.equal(outcomes.filter((r) => r.replayed).length, 1);
  assert.equal(outcomes[0].capture_id, outcomes[1].capture_id);
  for (const different of [
    { ...value, finalized_block_hash: `0x${"af".repeat(32)}` },
    {
      ...value,
      capture_id: capture().capture_id,
      finalized_block_hash: `0x${"ae".repeat(32)}`,
    },
    { ...value, metadata_sha256: `0x${"ad".repeat(32)}` },
  ])
    await assert.rejects(apply(different), /ROOT_BASKET_CAPTURE_CONFLICT/);
  assert.equal(
    (
      await rows(
        "SELECT * FROM root_basket_captures WHERE network_genesis_hash = ?",
        [value.network_genesis_hash],
      )
    ).length,
    1,
  );
});

test("completion rejects lost child rows and rolls the entire transaction back", async () => {
  const value = capture();
  const store = createD1Store(db);
  await assert.rejects(
    apply(value, {
      ...store,
      transaction(statements) {
        return store.transaction(
          statements.filter(
            (s) => !s.text.includes("INSERT INTO root_basket_targets"),
          ),
        );
      },
    }),
    /persisted capture is incomplete/,
  );
  for (const table of ROOT_BASKET_D1_TABLES.filter(
    (t) => t !== "root_basket_current",
  ))
    assert.equal(
      (
        await rows(`SELECT * FROM ${table} WHERE capture_id = ?`, [
          value.capture_id,
        ])
      ).length,
      0,
    );
  await apply(value);
  for (const table of ROOT_BASKET_D1_TABLES.filter(
    (t) => t !== "root_basket_current",
  )) {
    await assert.rejects(
      db
        .prepare(`DELETE FROM ${table} WHERE capture_id = ?`)
        .bind(value.capture_id)
        .run(),
      /immutable/,
    );
    await assert.rejects(
      db
        .prepare(
          `UPDATE ${table} SET capture_id = capture_id WHERE capture_id = ?`,
        )
        .bind(value.capture_id)
        .run(),
      /immutable/,
    );
  }
  for (const table of [
    "root_basket_capture_pages",
    "root_basket_fund_snapshots",
    "root_basket_holdings",
    "root_basket_targets",
  ])
    await assert.rejects(
      db
        .prepare(
          `INSERT INTO ${table} SELECT * FROM ${table} WHERE capture_id = ?`,
        )
        .bind(value.capture_id)
        .run(),
      /immutable/,
    );
});

test("current pointers are scoped and ordered by exact integer height", async () => {
  const value = capture();
  value.finalized_block = "10000";
  await apply(value);
  const older = {
    ...value,
    capture_id: capture().capture_id,
    finalized_block: "999",
    finalized_block_hash: `0x${"fa".repeat(32)}`,
  };
  await apply(older);
  assert.equal(
    (
      await rows(
        "SELECT capture_id FROM root_basket_current WHERE network_genesis_hash = ?",
        [value.network_genesis_hash],
      )
    )[0].capture_id,
    value.capture_id,
  );
  await assert.rejects(
    db
      .prepare(
        "UPDATE root_basket_current SET capture_id = ? WHERE network_genesis_hash = ?",
      )
      .bind(older.capture_id, value.network_genesis_hash)
      .run(),
    /cannot regress/,
  );
  await assert.rejects(
    db
      .prepare(
        "UPDATE root_basket_current SET network_genesis_hash = ? WHERE network_genesis_hash = ?",
      )
      .bind(capture().network_genesis_hash, value.network_genesis_hash)
      .run(),
    /scope mismatch/,
  );
  const newer = {
    ...value,
    capture_id: capture().capture_id,
    finalized_block: "10001",
    finalized_block_hash: `0x${"fb".repeat(32)}`,
  };
  await apply(newer);
  assert.equal(
    (
      await rows(
        "SELECT capture_id FROM root_basket_current WHERE network_genesis_hash = ?",
        [value.network_genesis_hash],
      )
    )[0].capture_id,
    newer.capture_id,
  );
});

test("empty completed captures, row limits, lost receipt and split batches remain explicit", async () => {
  const value = capture();
  value.funds = [];
  value.expected_funds = 0;
  value.pages[0].fund_count = 0;
  value.index = {
    status: "not_published",
    completed_block: null,
    bag_q64_bits: "18446744073709551616",
    stake_q64_bits: "18446744073709551616",
  };
  assert.equal((await apply(value)).replayed, false);
  const large = capture();
  large.funds[0].holdings = Array.from({ length: 1001 }, (_, netuid) => ({
    ...large.funds[0].holdings[1],
    netuid: netuid + 1,
  }));
  large.funds[0].baseline = {
    provisional: true,
    first_block: "0",
    price_divisor_q64_bits: null,
    rate0_q32_bits: null,
    tr_splice_q64_bits: null,
  };
  await apply(large);
  assert.equal(
    (
      await rows(
        "SELECT count(*) n FROM root_basket_holdings WHERE capture_id = ?",
        [large.capture_id],
      )
    )[0].n,
    1001,
  );
  large.funds[0].holdings = Array.from({ length: 32769 }, (_, netuid) => ({
    ...large.funds[0].holdings[0],
    netuid: netuid + 1,
  }));
  await assert.rejects(apply(large), /row limits/);
  await assert.rejects(
    apply(capture(), {
      ...createD1Store(db),
      async first() {
        return null;
      },
    }),
    /accepted root basket capture is absent/,
  );
});

test("the HTTP receiver selects D1 without Hyperdrive and fails closed on ownership drift", async () => {
  const value = capture();
  const request = (body = value) =>
    new Request("https://example.com/sync", {
      method: "POST",
      headers: { "x-root-basket-capture-sync-token": "secret" },
      body: JSON.stringify(body),
    });
  const env = {
    ROOT_BASKET_CAPTURE_SYNC_SECRET: "secret",
    D1_STATE: db,
    D1_STATE_TABLES: ROOT_BASKET_D1_TABLES.join(","),
  };
  assert.equal((await handleRootBasketCaptureSync(request(), env)).status, 200);
  assert.equal(
    (
      await handleRootBasketCaptureSync(
        request({ ...value, metadata_sha256: `0x${"ff".repeat(32)}` }),
        env,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await handleRootBasketCaptureSync(request(), {
        ...env,
        D1_STATE: undefined,
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await handleRootBasketCaptureSync(request(), {
        ...env,
        D1_STATE_TABLES: "root_basket_captures",
      })
    ).status,
    503,
  );
});

test("database constraints reject incomplete replays, malformed integers, cursors and receipts", async () => {
  const store = createD1Store(db);
  const value = capture();
  await apply(value, {
    ...store,
    transaction: (statements) => store.transaction(statements.slice(0, 1)),
  });
  await assert.rejects(apply(value), /observation is incomplete/);
  for (const invalid of ["01", "-1", "1.1", "1e2", "18446744073709551616", ""])
    await assert.rejects(
      db
        .prepare(
          "UPDATE root_basket_captures SET finalized_block = ? WHERE capture_id = ?",
        )
        .bind(invalid, value.capture_id)
        .run(),
      /CHECK constraint/,
    );
  const corrupt = capture();
  await assert.rejects(
    apply(corrupt, {
      ...store,
      transaction(statements) {
        return store.transaction(
          statements.map((s) =>
            s.text.includes("INSERT INTO root_basket_capture_pages")
              ? {
                  ...s,
                  values: s.values!.map((v, i) =>
                    i === 3
                      ? JSON.stringify([
                          {
                            ...corrupt.pages[0],
                            next_after: `0x${"bc".repeat(32)}`,
                          },
                        ])
                      : v,
                  ),
                }
              : s,
          ),
        );
      },
    }),
    /persisted capture is incomplete/,
  );
  const wrongDigest = capture();
  await assert.rejects(
    apply(wrongDigest, {
      ...store,
      transaction(statements) {
        const changed = [...statements];
        const position = changed.findIndex((s) =>
          s.text.includes("INSERT INTO root_basket_capture_completions"),
        );
        changed.splice(position, 0, {
          text: "UPDATE root_basket_fund_snapshots SET holdings_count = holdings_count + 1 WHERE capture_id = ?",
          values: [wrongDigest.capture_id],
        });
        return store.transaction(changed);
      },
    }),
    /persisted capture is incomplete/,
  );
  assert.equal(
    (
      await rows(
        "SELECT * FROM root_basket_captures WHERE capture_id IN (?,?)",
        [corrupt.capture_id, wrongDigest.capture_id],
      )
    ).length,
    0,
  );
});

test("partial or unbound D1 selection never opens an available Hyperdrive connection", async () => {
  const connect = vi
    .spyOn(Client.prototype, "connect")
    .mockImplementation(() => {
      throw new Error("Postgres must not be opened");
    });
  try {
    for (const selection of [
      { D1_STATE: db, D1_STATE_TABLES: "root_basket_captures" },
      { D1_STATE: undefined, D1_STATE_TABLES: ROOT_BASKET_D1_TABLES.join(",") },
    ]) {
      const request = new Request("https://example.com/sync", {
        method: "POST",
        headers: { "x-root-basket-capture-sync-token": "secret" },
        body: JSON.stringify(capture()),
      });
      const response = await handleRootBasketCaptureSync(request, {
        ...selection,
        ROOT_BASKET_CAPTURE_SYNC_SECRET: "secret",
        HYPERDRIVE: {
          connectionString: "postgresql://user:password@example.com/db",
        },
      });
      assert.equal(response.status, 503);
      assert.equal(connect.mock.calls.length, 0);
    }
  } finally {
    connect.mockRestore();
  }
});
