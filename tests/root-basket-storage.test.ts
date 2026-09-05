import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import { syntheticBasketCapture } from "./fixtures/root-basket-capture.ts";

let db: PGlite;
const secondId = "00000000-0000-4000-8000-000000000002";
const otherAccount = `0x${"22".repeat(32)}`;

// Test-only insertion: exercises the migration itself, not mocked SQL matching.
async function insert(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  return db.query(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(row),
  );
}

async function store(capture = syntheticBasketCapture()) {
  const { index, pages, funds, ...metadata } =
    RootBasketCaptureSchema.parse(capture);
  await insert("root_basket_captures", {
    ...metadata,
    index_status: index.status,
    index_completed_block: index.completed_block,
    bag_index_q64_bits: index.bag_q64_bits,
    stake_index_q64_bits: index.stake_q64_bits,
  });
  for (const page of pages)
    await insert("root_basket_capture_pages", {
      capture_id: capture.capture_id,
      ...page,
    });
  for (const { baseline, holdings, targets, ...fund } of funds) {
    await insert("root_basket_fund_snapshots", {
      capture_id: capture.capture_id,
      ...fund,
      ...baseline,
      holdings_count: holdings.length,
      targets_count: targets.length,
    });
    for (const row of holdings)
      await insert("root_basket_holdings", {
        capture_id: capture.capture_id,
        hotkey: fund.hotkey,
        ...row,
      });
    for (const row of targets)
      await insert("root_basket_targets", {
        capture_id: capture.capture_id,
        hotkey: fund.hotkey,
        ...row,
      });
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    readFileSync("migrations/neon/0036_root_basket_observations.sql", "utf8"),
  );
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.exec("TRUNCATE root_basket_captures CASCADE");
});

describe("root basket observation storage constraints", () => {
  test("reapplying the migration preserves observations and receipt immutability", async () => {
    await store();
    await db.exec(
      readFileSync("migrations/neon/0036_root_basket_observations.sql", "utf8"),
    );
    assert.equal(
      (await db.query("SELECT * FROM root_basket_fund_snapshots")).rows.length,
      1,
    );
    await assert.rejects(
      db.query("UPDATE root_basket_capture_pages SET response_sha256 = $1", [
        otherAccount,
      ]),
      /receipt is immutable/,
    );
  });

  test("stores exact synthetic quantities and keeps indexes independently dated", async () => {
    const capture = syntheticBasketCapture();
    capture.funds[0]!.deposited_rao = "9007199254740993";
    await store(capture);
    const row = (
      await db.query<{
        deposited_rao: string;
        display_beta: string;
        spot_nav: string;
        real_nav: string;
      }>(`
      SELECT deposited_rao::text, (display_shares_q64_bits / 18446744073709551616 / 1000000000)::text AS display_beta,
        spot_nav_rao::text AS spot_nav, realizable_nav_rao::text AS real_nav FROM root_basket_fund_snapshots
    `)
    ).rows[0]!;
    assert.equal(row.deposited_rao, "9007199254740993");
    assert.equal(BigInt(row.display_beta.split(".")[0]!), 3n);
    assert.equal(row.spot_nav, "6000000000");
    assert.equal(row.real_nav, "5000000000");
    assert.deepEqual(
      (
        await db.query(
          "SELECT finalized_block::text, index_completed_block::text FROM root_basket_captures",
        )
      ).rows,
      [{ finalized_block: "500", index_completed_block: "100" }],
    );
  });

  for (const [domain, minimum, maximum] of [
    ["root_basket_u16", "0", "65535"],
    ["root_basket_u32", "0", "4294967295"],
    ["root_basket_u64", "0", "18446744073709551615"],
    ["root_basket_u128", "0", "340282366920938463463374607431768211455"],
    [
      "root_basket_i128",
      "-170141183460469231731687303715884105728",
      "170141183460469231731687303715884105727",
    ],
  ]) {
    test(`${domain} preserves bounds and rejects fractional input before any rounding`, async () => {
      for (const value of [minimum!, maximum!]) {
        assert.equal(
          (
            await db.query<{ value: string }>(
              `SELECT ($1::${domain})::text AS value`,
              [value],
            )
          ).rows[0]!.value,
          value,
        );
      }
      for (const value of [
        (BigInt(minimum!) - 1n).toString(),
        (BigInt(maximum!) + 1n).toString(),
        "0.5",
        "1.1",
        "-0.1",
        "NaN",
        "Infinity",
        "-Infinity",
      ]) {
        await assert.rejects(
          db.query(`SELECT $1::${domain}`, [value]),
          /check constraint/,
        );
      }
    });
  }
  test("actual quantity, fixed-point, and weight columns reject fractional numeric binds", async () => {
    await store();
    await assert.rejects(
      db.query("UPDATE root_basket_holdings SET quantity_atomic = $1", ["1.4"]),
      /check constraint/,
    );
    await assert.rejects(
      db.query(
        "UPDATE root_basket_fund_snapshots SET display_shares_q64_bits = $1",
        ["1.4"],
      ),
      /check constraint/,
    );
    await assert.rejects(
      db.query("UPDATE root_basket_fund_snapshots SET rate0_q32_bits = $1", [
        "-0.1",
      ]),
      /check constraint/,
    );
    await assert.rejects(
      db.query("UPDATE root_basket_targets SET weight = $1", ["65534.9"]),
      /check constraint/,
    );
  });
  test("allows an empty terminal page and complete empty targets without fabricating holdings", async () => {
    const capture = syntheticBasketCapture();
    capture.funds[0]!.targets = [];
    await store(capture);
    assert.deepEqual(
      (
        await db.query(
          "SELECT holdings_count::text, targets_count::text FROM root_basket_fund_snapshots",
        )
      ).rows,
      [{ holdings_count: "3", targets_count: "0" }],
    );
    await db.exec("TRUNCATE root_basket_captures CASCADE");
    capture.funds = [];
    capture.expected_funds = 0;
    capture.pages[0]!.fund_count = 0;
    await store(capture);
    assert.deepEqual(
      (
        await db.query(
          "SELECT next_after, fund_count::text FROM root_basket_capture_pages",
        )
      ).rows,
      [{ next_after: null, fund_count: "0" }],
    );
  });
  test("conflicting receipt insertion or update cannot replace the accepted response", async () => {
    const capture = syntheticBasketCapture();
    await store(capture);
    await assert.rejects(
      insert("root_basket_capture_pages", {
        capture_id: capture.capture_id,
        ...capture.pages[0]!,
        response_sha256: otherAccount,
      }),
      /duplicate key/,
    );
    await assert.rejects(
      db.query("UPDATE root_basket_capture_pages SET response_sha256 = $1", [
        otherAccount,
      ]),
      /receipt is immutable/,
    );
    await db.exec(
      "UPDATE root_basket_capture_pages SET response_sha256 = response_sha256",
    );
    assert.equal(
      (
        await db.query<{ response_sha256: string }>(
          "SELECT response_sha256 FROM root_basket_capture_pages",
        )
      ).rows[0]!.response_sha256,
      capture.pages[0]!.response_sha256,
    );
    assert.equal(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM root_basket_capture_pages",
        )
      ).rows[0]!.n,
      1,
    );
  });
  test("rejects duplicate terminal pages, repeated cursors, and self-repeating cursors", async () => {
    const capture = syntheticBasketCapture();
    await store(capture);
    await assert.rejects(
      insert("root_basket_capture_pages", {
        capture_id: capture.capture_id,
        ...capture.pages[0]!,
        page_index: 1,
        start_after: otherAccount,
      }),
      /duplicate key/,
    );
    await assert.rejects(
      insert("root_basket_capture_pages", {
        capture_id: capture.capture_id,
        ...capture.pages[0]!,
        page_index: 1,
        start_after: otherAccount,
        next_after: otherAccount,
      }),
      /check constraint/,
    );
    const next = `0x${"33".repeat(32)}`;
    await insert("root_basket_capture_pages", {
      capture_id: capture.capture_id,
      ...capture.pages[0]!,
      page_index: 1,
      start_after: otherAccount,
      next_after: next,
    });
    await assert.rejects(
      insert("root_basket_capture_pages", {
        capture_id: capture.capture_id,
        ...capture.pages[0]!,
        page_index: 2,
        start_after: otherAccount,
        next_after: next,
      }),
      /duplicate key/,
    );
  });
  test("prevents cross-capture child references without conflating address history", async () => {
    const first = syntheticBasketCapture();
    await store(first);
    const second = syntheticBasketCapture();
    second.capture_id = secondId;
    second.finalized_block_hash = `0x${"05".repeat(32)}`;
    second.funds[0]!.hotkey = otherAccount;
    await store(second);
    for (const table of ["root_basket_holdings", "root_basket_targets"]) {
      const row =
        table === "root_basket_holdings"
          ? first.funds[0]!.holdings[0]!
          : first.funds[0]!.targets[0]!;
      await assert.rejects(
        insert(table, {
          capture_id: secondId,
          hotkey: first.funds[0]!.hotkey,
          ...row,
        }),
        /foreign key/,
      );
    }
    await assert.rejects(
      db.query(
        "UPDATE root_basket_fund_snapshots SET page_index = 1 WHERE capture_id = $1",
        [secondId],
      ),
      /foreign key/,
    );
    // Same baseline height under another observed address is not a uniqueness collision.
    assert.equal(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM root_basket_fund_snapshots",
        )
      ).rows[0]!.n,
      2,
    );
  });
  test("keys the same address independently at a different finalized capture", async () => {
    await store();
    const second = syntheticBasketCapture();
    second.capture_id = secondId;
    second.finalized_block_hash = `0x${"05".repeat(32)}`;
    await store(second);
    assert.equal(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM root_basket_fund_snapshots",
        )
      ).rows[0]!.n,
      2,
    );
  });
  test("rejects malformed account/hash bytes and conflicting source identity", async () => {
    await store();
    for (const value of ["0x12", `0x${"FF".repeat(32)}`, "not-an-address"]) {
      await assert.rejects(
        db.query("UPDATE root_basket_holdings SET hotkey = $1", [value]),
        /check constraint/,
      );
      await assert.rejects(
        db.query("UPDATE root_basket_captures SET finalized_block_hash = $1", [
          value,
        ]),
        /check constraint/,
      );
    }
    const duplicate = syntheticBasketCapture();
    duplicate.capture_id = secondId;
    await assert.rejects(store(duplicate), /duplicate key/);
  });
  test("rejects duplicate holdings/targets and wrong native units", async () => {
    const capture = syntheticBasketCapture();
    await store(capture);
    const identity = {
      capture_id: capture.capture_id,
      hotkey: capture.funds[0]!.hotkey,
    };
    await assert.rejects(
      insert("root_basket_holdings", {
        ...identity,
        ...capture.funds[0]!.holdings[0]!,
      }),
      /duplicate key/,
    );
    await assert.rejects(
      insert("root_basket_targets", {
        ...identity,
        ...capture.funds[0]!.targets[0]!,
      }),
      /duplicate key/,
    );
    await assert.rejects(
      db.exec(
        "UPDATE root_basket_holdings SET quantity_unit = 'alpha_atomic' WHERE netuid = 0",
      ),
      /check constraint/,
    );
    await assert.rejects(
      db.exec(
        "UPDATE root_basket_holdings SET quantity_unit = 'rao' WHERE netuid = 19",
      ),
      /check constraint/,
    );
    await assert.rejects(
      db.exec("UPDATE root_basket_targets SET weight = 65536"),
      /check constraint/,
    );
  });
  test("keeps absent index/baseline explicit and rejects incoherent freshness fields", async () => {
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
    await store(capture);
    await assert.rejects(
      db.exec("UPDATE root_basket_captures SET index_completed_block = 0"),
      /check constraint/,
    );
    await assert.rejects(
      db.exec("UPDATE root_basket_captures SET bag_index_q64_bits = 0"),
      /check constraint/,
    );
    await assert.rejects(
      db.exec("UPDATE root_basket_fund_snapshots SET first_block = 90"),
      /check constraint/,
    );
    await assert.rejects(
      db.exec(
        "UPDATE root_basket_fund_snapshots SET price_divisor_q64_bits = 1",
      ),
      /check constraint/,
    );
    await assert.rejects(
      db.exec("UPDATE root_basket_captures SET finished_at_ms = 999"),
      /check constraint/,
    );
    await assert.rejects(
      db.exec("UPDATE root_basket_captures SET runtime_spec_version = 455"),
      /check constraint/,
    );
  });
});
