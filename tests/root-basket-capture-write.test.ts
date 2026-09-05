import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import {
  createProducerStore,
  type ProducerStoreClient,
} from "../src/producer-store.ts";
import {
  rootBasketCaptureDigest,
  rootBasketCaptureFits,
  writeRootBasketCapture,
} from "../src/root-basket-capture-write.ts";
import { syntheticBasketCapture } from "./fixtures/root-basket-capture.ts";

let pg: PGlite;
const migrations = [
  "0036_root_basket_observations.sql",
  "0037_root_basket_capture_completion.sql",
];
const log: string[] = [];
const makeStore = (intercept?: (text: string, values: unknown[]) => void) => {
  const client: ProducerStoreClient = {
    connect: async () => {},
    end: async () => {},
    query: async (text, values = []) => {
      log.push(text);
      intercept?.(text, values);
      const result = await pg.query(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    },
  };
  return createProducerStore("postgresql://example/db", {
    clientFactory: () => client,
  });
};
const count = async (table: string) =>
  (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))
    .rows[0]!.n;
const current = async () =>
  (
    await pg.query<{ capture_id: string }>(
      "SELECT capture_id FROM root_basket_current",
    )
  ).rows[0]?.capture_id;
const secondId = "00000000-0000-4000-8000-000000000002";
const otherHash = `0x${"ee".repeat(32)}`;

beforeAll(async () => {
  pg = new PGlite();
  for (const migration of migrations)
    await pg.exec(readFileSync(`migrations/neon/${migration}`, "utf8"));
});
beforeEach(async () => {
  await pg.exec("TRUNCATE root_basket_captures CASCADE");
  log.length = 0;
});
afterAll(async () => pg.close());

describe("atomic Root basket capture acceptance", () => {
  test("persists every family before completion in one connection/transaction", async () => {
    const capture = syntheticBasketCapture();
    const result = await writeRootBasketCapture(makeStore(), capture, 3000);
    assert.equal(result.capture_id, capture.capture_id);
    assert.equal(result.replayed, false);
    for (const [table, expected] of [
      ["root_basket_captures", 1],
      ["root_basket_capture_pages", 1],
      ["root_basket_fund_snapshots", 1],
      ["root_basket_holdings", 3],
      ["root_basket_targets", 2],
      ["root_basket_capture_completions", 1],
    ] as const) {
      assert.equal(await count(table), expected, table);
    }
    assert.equal(await current(), capture.capture_id);
    assert.equal(log[0], "BEGIN");
    assert.equal(log.at(-2), "COMMIT");
    assert.ok(
      log.findIndex((sql) => sql.includes("root_basket_complete_capture")) <
        log.indexOf("COMMIT"),
    );
    const stored = (
      await pg.query<{ bits: string }>(
        "SELECT display_shares_q64_bits::text AS bits FROM root_basket_fund_snapshots",
      )
    ).rows[0]!;
    assert.equal(stored.bits, capture.funds[0]!.display_shares_q64_bits);
  });

  test("reordered identical observations retain the accepted ID and original attempt timestamps", async () => {
    const capture = syntheticBasketCapture();
    const first = await writeRootBasketCapture(makeStore(), capture, 3000);
    const retry = {
      ...capture,
      capture_id: secondId,
      started_at_ms: "4000",
      finished_at_ms: "5000",
    };
    retry.funds[0]!.holdings.reverse();
    retry.funds[0]!.targets.reverse();
    // Reverse object construction order recursively without dropping child fields.
    const reverseObjects = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseObjects)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([k, v]) => [k, reverseObjects(v)]),
            )
          : value;
    const result = await writeRootBasketCapture(
      makeStore(),
      reverseObjects(retry),
      6000,
    );
    assert.deepEqual(result, { ...first, replayed: true });
    const row = (
      await pg.query(
        "SELECT started_at_ms::text, finished_at_ms::text, accepted_at_ms::text FROM root_basket_captures JOIN root_basket_capture_completions USING (capture_id)",
      )
    ).rows[0];
    assert.deepEqual(row, {
      started_at_ms: "1000",
      finished_at_ms: "2000",
      accepted_at_ms: "3000",
    });
    assert.equal(await count("root_basket_holdings"), 3);
  });

  for (const change of [
    "value",
    "receipt",
    "metadata",
    "index",
    "height",
    "network",
    "attempt_id",
    "same_height_hash",
  ] as const) {
    test(`rejects conflicting ${change} replay without changing the current capture`, async () => {
      const capture = syntheticBasketCapture();
      await writeRootBasketCapture(makeStore(), capture, 3000);
      const conflict = structuredClone(capture);
      if (change === "value")
        conflict.funds[0]!.holdings[0]!.quantity_atomic = "123";
      if (change === "receipt") conflict.pages[0]!.response_sha256 = otherHash;
      if (change === "metadata") conflict.metadata_sha256 = otherHash;
      if (change === "index") conflict.index.bag_q64_bits = "123";
      if (change === "height") conflict.finalized_block = "501";
      if (change === "network") conflict.network = "test";
      if (change === "attempt_id") {
        conflict.network_genesis_hash = otherHash;
        conflict.finalized_block_hash = otherHash;
      }
      if (change === "same_height_hash") {
        conflict.capture_id = secondId;
        conflict.finalized_block_hash = otherHash;
      }
      await assert.rejects(
        writeRootBasketCapture(makeStore(), conflict, 4000),
        /ROOT_BASKET_CAPTURE_CONFLICT/,
      );
      assert.equal(await current(), capture.capture_id);
      assert.equal(await count("root_basket_captures"), 1);
    });
  }

  for (const table of [
    "root_basket_captures",
    "root_basket_capture_pages",
    "root_basket_fund_snapshots",
    "root_basket_holdings",
    "root_basket_targets",
    "root_basket_complete_capture",
  ]) {
    test(`a failure at ${table} rolls back all rows and retains the previous current capture`, async () => {
      const previous = syntheticBasketCapture();
      await writeRootBasketCapture(makeStore(), previous, 3000);
      const next = {
        ...previous,
        capture_id: secondId,
        finalized_block: "501",
        finalized_block_hash: otherHash,
      };
      const store = makeStore((sql) => {
        if (
          sql.includes(table) &&
          (sql.startsWith(`INSERT INTO ${table}`) ||
            sql.startsWith("SELECT root_basket_complete_capture"))
        )
          throw new Error("injected stage failure");
      });
      await assert.rejects(
        writeRootBasketCapture(store, next, 4000),
        /injected stage failure/,
      );
      assert.equal(log.at(-1), "ROLLBACK");
      assert.equal(await count("root_basket_captures"), 1);
      assert.equal(await current(), previous.capture_id);
    });
  }

  test("valid late historical captures do not replace the newest finalized observation", async () => {
    const newest = syntheticBasketCapture();
    await writeRootBasketCapture(makeStore(), newest, 3000);
    const older = {
      ...newest,
      capture_id: secondId,
      finalized_block: "499",
      finalized_block_hash: otherHash,
    };
    await writeRootBasketCapture(makeStore(), older, 4000);
    assert.equal(await count("root_basket_capture_completions"), 2);
    assert.equal(await current(), newest.capture_id);
    await assert.rejects(
      pg.query("UPDATE root_basket_current SET capture_id = $1", [secondId]),
      /source order cannot regress/,
    );
  });

  test("an empty terminal capture publishes a verified empty observation", async () => {
    const capture = syntheticBasketCapture();
    capture.funds = [];
    capture.expected_funds = 0;
    capture.pages[0]!.fund_count = 0;
    await writeRootBasketCapture(makeStore(), capture, 3000);
    assert.equal(await count("root_basket_fund_snapshots"), 0);
    assert.equal(await count("root_basket_capture_pages"), 1);
    assert.equal(await current(), capture.capture_id);
  });

  test("SQL completeness throws before commit when a supposedly inserted child is absent", async () => {
    const capture = syntheticBasketCapture();
    let skipped = false;
    const underlying = makeStore();
    const store = {
      ...underlying,
      transaction: (statements: Parameters<typeof underlying.transaction>[0]) =>
        underlying.transaction(
          statements.filter((statement) => {
            if (statement.text.startsWith("INSERT INTO root_basket_holdings")) {
              skipped = true;
              return false;
            }
            return true;
          }),
        ),
    };
    await assert.rejects(
      writeRootBasketCapture(store, capture, 3000),
      /persisted capture is incomplete/,
    );
    assert.equal(skipped, true);
    assert.equal(await count("root_basket_captures"), 0);
    assert.equal(await current(), undefined);
  });

  test("completed observations, receipts and additional children are immutable", async () => {
    const capture = syntheticBasketCapture();
    await writeRootBasketCapture(makeStore(), capture, 3000);
    for (const table of [
      "root_basket_captures",
      "root_basket_capture_pages",
      "root_basket_fund_snapshots",
      "root_basket_holdings",
      "root_basket_targets",
      "root_basket_capture_completions",
    ]) {
      await assert.rejects(pg.query(`DELETE FROM ${table}`), /immutable/);
      await assert.rejects(
        pg.query(`UPDATE ${table} SET capture_id = $1`, [secondId]),
        /immutable/,
      );
    }
    await assert.rejects(
      pg.query("INSERT INTO root_basket_targets VALUES ($1, $2, 51, 1)", [
        capture.capture_id,
        capture.funds[0]!.hotkey,
      ]),
      /immutable/,
    );
    await pg.exec(
      readFileSync(
        "migrations/neon/0037_root_basket_capture_completion.sql",
        "utf8",
      ),
    );
    assert.equal(await current(), capture.capture_id);
  });

  test("schema validation refuses missing pages and duplicate funds before opening a transaction", async () => {
    const capture = syntheticBasketCapture();
    capture.expected_pages = 2;
    await assert.rejects(writeRootBasketCapture(makeStore(), capture, 3000));
    assert.equal(log.length, 0);
  });

  test("validates the independent page budget before opening a transaction", async () => {
    const capture = syntheticBasketCapture();
    capture.expected_pages = 257;
    capture.expected_funds = 0;
    capture.funds = [];
    const cursor = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    capture.pages = Array.from({ length: 257 }, (_, i) => ({
      ...capture.pages[0]!,
      page_index: i,
      start_after: i ? cursor(i) : null,
      next_after: i === 256 ? null : cursor(i + 1),
      fund_count: 0,
    }));
    await assert.rejects(
      writeRootBasketCapture(makeStore(), capture, 3000),
      /exceeds row limits/,
    );
    assert.equal(log.length, 0);
  });

  test("batches multiple pages and funds under parameter limits while preserving order-independent replay", async () => {
    const capture = syntheticBasketCapture();
    const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    capture.expected_pages = 4;
    capture.expected_funds = 1001;
    capture.pages = Array.from({ length: 4 }, (_, i) => ({
      ...capture.pages[0]!,
      page_index: i,
      start_after: i ? key(i) : null,
      next_after: i === 3 ? null : key(i + 1),
      fund_count: i === 3 ? 233 : 256,
    }));
    capture.funds = Array.from({ length: 1001 }, (_, i) => ({
      ...capture.funds[0]!,
      hotkey: key(i + 1),
      page_index: Math.floor(i / 256),
    }));
    let batches = 0;
    await writeRootBasketCapture(
      makeStore((sql, values) => {
        if (sql.includes("jsonb_to_recordset")) {
          batches++;
          assert.equal(values.length, 4);
          assert.ok(JSON.parse(String(values[0])).length <= 1000);
        }
      }),
      capture,
      3000,
    );
    assert.equal(batches, 10); // 1 page, 2 funds, 4 holdings, 3 target batches.
    assert.equal(await count("root_basket_fund_snapshots"), 1001);
    const retry = {
      ...capture,
      capture_id: secondId,
      funds: [...capture.funds].reverse(),
    };
    const result = await writeRootBasketCapture(makeStore(), retry, 4000);
    assert.equal(result.replayed, true);
    assert.equal(result.capture_id, capture.capture_id);
  });

  for (const corruption of [
    "manifest_count",
    "page_count",
    "cursor",
    "terminal",
    "holdings_count",
    "targets_count",
    "baseline",
  ] as const) {
    test(`persisted ${corruption} corruption cannot acquire a completion receipt`, async () => {
      const capture = syntheticBasketCapture();
      capture.expected_pages = 2;
      capture.pages[0]!.next_after = otherHash;
      capture.pages.push({
        ...capture.pages[0]!,
        page_index: 1,
        start_after: otherHash,
        next_after: null,
        fund_count: 0,
      });
      const store = makeStore((sql, values) => {
        if (
          corruption === "manifest_count" &&
          sql.startsWith("INSERT INTO root_basket_captures")
        )
          values[12] = 2;
        if (sql.startsWith("INSERT INTO root_basket_capture_pages")) {
          const pages = JSON.parse(String(values[0]));
          if (corruption === "page_count") pages[0].fund_count = 2;
          if (corruption === "cursor")
            pages[1].start_after = `0x${"dd".repeat(32)}`;
          if (corruption === "terminal")
            pages[1].next_after = `0x${"dd".repeat(32)}`;
          values[0] = JSON.stringify(pages);
        }
        if (sql.startsWith("INSERT INTO root_basket_fund_snapshots")) {
          const funds = JSON.parse(String(values[0]));
          if (corruption === "holdings_count") funds[0].holdings_count++;
          if (corruption === "targets_count") funds[0].targets_count++;
          if (corruption === "baseline") funds[0].first_block = "501";
          values[0] = JSON.stringify(funds);
        }
      });
      await assert.rejects(
        writeRootBasketCapture(store, capture, 3000),
        /persisted capture is incomplete/,
      );
      assert.equal(await count("root_basket_captures"), 0);
      assert.equal(await count("root_basket_capture_completions"), 0);
    });
  }

  test("unpublished index and provisional baselines retain explicit nulls", async () => {
    const capture = syntheticBasketCapture();
    capture.index = {
      status: "not_published",
      completed_block: null,
      bag_q64_bits: "18446744073709551616",
      stake_q64_bits: "18446744073709551616",
    };
    capture.funds[0]!.baseline = {
      provisional: true,
      first_block: "0",
      price_divisor_q64_bits: null,
      rate0_q32_bits: null,
      tr_splice_q64_bits: null,
    };
    capture.funds[0]!.holdings = [];
    capture.funds[0]!.targets = [];
    await writeRootBasketCapture(makeStore(), capture, 3000);
    assert.equal(await count("root_basket_holdings"), 0);
    const rows = (
      await pg.query(
        "SELECT price_divisor_q64_bits, index_completed_block FROM root_basket_fund_snapshots JOIN root_basket_captures USING (capture_id)",
      )
    ).rows;
    assert.deepEqual(rows, [
      { price_divisor_q64_bits: null, index_completed_block: null },
    ]);
  });

  test("bounds row families independently of bytes and preserves every content-bearing field in the digest", () => {
    const capture = RootBasketCaptureSchema.parse(syntheticBasketCapture());
    assert.equal(rootBasketCaptureFits(capture), true);
    assert.equal(
      rootBasketCaptureFits({
        ...capture,
        pages: Array(257).fill(capture.pages[0]),
      }),
      false,
    );
    assert.equal(
      rootBasketCaptureFits({
        ...capture,
        funds: Array(2049).fill(capture.funds[0]),
      }),
      false,
    );
    assert.equal(
      rootBasketCaptureFits({
        ...capture,
        funds: [
          {
            ...capture.funds[0]!,
            targets: Array(32769).fill({ netuid: 1, weight: 1 }),
          },
        ],
      }),
      false,
    );
    assert.notEqual(
      rootBasketCaptureDigest(capture),
      rootBasketCaptureDigest({ ...capture, finalized_block: "501" }),
    );
  });
});
