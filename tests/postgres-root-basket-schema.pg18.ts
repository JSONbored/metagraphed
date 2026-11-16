import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const tables = [
  "root_basket_captures",
  "root_basket_capture_pages",
  "root_basket_fund_snapshots",
  "root_basket_holdings",
  "root_basket_targets",
  "root_basket_capture_completions",
  "root_basket_current",
] as const;
type Table = (typeof tables)[number];
type Row = Record<string, string | number | null>;
const schema = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as { type: string; tbl_name: string; sql: string }[];
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
const connection = () =>
  new Client({
    connectionString: pg18FixtureUrl().toString(),
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
const db = connection();
let source: DatabaseSync;
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const identity = (digit = "1") =>
  `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
const capture = (digit = "1", height = "10"): Row => ({
  capture_id: identity(digit),
  content_sha256: hash(digit),
  network: "local",
  network_genesis_hash: hash("a"),
  finalized_block_hash: hash(digit),
  finalized_block: height,
  runtime_spec_version: 454,
  runtime_api_version: 3,
  decoder_version: "subtensor-v454-14cde641-v1",
  metadata_sha256: hash("b"),
  started_at_ms: "0",
  finished_at_ms: "1",
  expected_pages: 1,
  expected_funds: 1,
  index_status: "not_published",
  index_completed_block: null,
  bag_index_q64_bits: "18446744073709551616",
  stake_index_q64_bits: "18446744073709551616",
});
const page = (digit = "1"): Row => ({
  capture_id: identity(digit),
  page_index: 0,
  start_after: null,
  next_after: null,
  response_sha256: hash("c"),
  fund_count: 1,
});
const fund = (digit = "1"): Row => ({
  capture_id: identity(digit),
  hotkey: hash("d"),
  page_index: 0,
  shares_atomic: "1",
  spot_nav_rao: "0",
  realizable_nav_rao: "0",
  deposited_rao: "0",
  redeemed_rao: "0",
  raw_spot_price_q64_bits: "0",
  display_price_q64_bits: "0",
  display_shares_q64_bits: "0",
  stake_price_q64_bits: "0",
  staker_twr_q64_bits: "0",
  pending_entitlement_q64_bits: "0",
  provisional: 1,
  first_block: "0",
  price_divisor_q64_bits: null,
  rate0_q32_bits: null,
  tr_splice_q64_bits: null,
  holdings_count: 1,
  targets_count: 1,
});
const holding = (digit = "1"): Row => ({
  capture_id: identity(digit),
  hotkey: hash("d"),
  netuid: 0,
  quantity_atomic: "1",
  quantity_unit: "rao",
  spot_value_rao: "0",
  realizable_value_rao: "0",
});
const target = (digit = "1"): Row => ({
  capture_id: identity(digit),
  hotkey: hash("d"),
  netuid: 1,
  weight: 65535,
});
const receipt = (digit = "1"): Row => ({
  capture_id: identity(digit),
  content_sha256: hash(digit),
  accepted_at_ms: "2",
});
const pointer = (digit = "1"): Row => ({
  capture_id: identity(digit),
  network_genesis_hash: hash("a"),
  decoder_version: "subtensor-v454-14cde641-v1",
});

async function insert(
  table: Table,
  row: Row,
  nativeOnly = false,
  client = db,
  suffix = "",
) {
  const columns = Object.keys(row).join(",");
  const values = Object.values(row);
  if (!nativeOnly)
    source
      .prepare(
        `INSERT INTO ${table} (${columns}) VALUES (${values.map(() => "?")}) ${suffix}`,
      )
      .run(...values);
  return client.query(
    `INSERT INTO app.${table} (${columns}) VALUES (${values.map((_, i) => `$${i + 1}`)}) ${suffix}`,
    values,
  );
}
async function activate() {
  await db.query("BEGIN");
  try {
    await db.query(migration("0021_root_basket_activate.sql"));
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
async function populate(digit = "1", height = "10", nativeOnly = false) {
  for (const [table, row] of [
    ["root_basket_captures", capture(digit, height)],
    ["root_basket_capture_pages", page(digit)],
    ["root_basket_fund_snapshots", fund(digit)],
    ["root_basket_holdings", holding(digit)],
    ["root_basket_targets", target(digit)],
  ] as [Table, Row][])
    await insert(table, row, nativeOnly);
}
async function rejectBoth(
  text: string,
  values: (string | number | null)[],
  pattern: RegExp,
) {
  assert.throws(
    () => source.prepare(text.replaceAll(/\$\d+/g, "?")).run(...values),
    pattern,
  );
  await assert.rejects(
    db.query(text.replaceAll(/\broot_basket_/g, "app.root_basket_"), values),
    pattern,
  );
}
async function sameTable(table: Table) {
  const expected = source
    .prepare(`SELECT * FROM ${table} ORDER BY 1,2`)
    .all()
    .map((row) => ({ ...row }));
  const actual = (await db.query(`SELECT * FROM app.${table} ORDER BY 1,2`))
    .rows;
  for (const row of actual) {
    // Textual chain quantities remain strings. Only declared bigint columns
    // are normalized, so this comparison cannot hide decimal text drift.
    for (const column of [
      "runtime_spec_version",
      "runtime_api_version",
      "expected_pages",
      "expected_funds",
      "page_index",
      "fund_count",
      "provisional",
      "holdings_count",
      "targets_count",
      "netuid",
      "weight",
    ]) {
      if (column in row) row[column] = Number(row[column]);
    }
  }
  assert.deepEqual(actual, expected, table);
}
async function waitForAdvisory(client: Client) {
  const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid as number;
  return {
    pid,
    async waiting() {
      for (let attempt = 0; attempt < 100; attempt++) {
        const row = (
          await db.query(
            "SELECT wait_event FROM pg_stat_activity WHERE pid=$1",
            [pid],
          )
        ).rows[0];
        if (row?.wait_event === "advisory") return;
        await setTimeout(10);
      }
      assert.fail("competing writer did not wait on the family lock");
    },
  };
}

describe(
  "staged Root basket schema and source integrity",
  { concurrency: false },
  () => {
    before(async () => {
      await db.connect();
      assert.equal(
        (await db.query("SHOW server_version_num")).rows[0].server_version_num,
        "180006",
      );
    });
    beforeEach(async () => {
      await db.query("DROP SCHEMA IF EXISTS app CASCADE");
      await db.query(migration("0020_root_basket.sql"));
      source?.close();
      source = new DatabaseSync(":memory:");
      source.exec("PRAGMA foreign_keys=ON");
      for (const object of schema.filter(
        (o) => o.type === "table" && tables.includes(o.tbl_name as Table),
      ))
        source.exec(object.sql);
      for (const object of schema.filter(
        (o) => o.type !== "table" && tables.includes(o.tbl_name as Table),
      ))
        source.exec(object.sql);
    });
    after(async () => {
      source?.close();
      try {
        await db.query("DROP SCHEMA IF EXISTS app CASCADE");
      } finally {
        await db.end();
      }
    });

    it("loads receipts before enforcing their six references and 21 source trigger effects", async () => {
      assert.equal(
        (
          await db.query(
            "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='app'::regnamespace)",
          )
        ).rows[0].count,
        "0",
      );
      await populate("1", "10", true);
      await insert("root_basket_capture_completions", receipt(), true);
      await insert("root_basket_current", pointer(), true);
      await activate();
      assert.equal(
        (
          await db.query(
            "SELECT count(*) FROM pg_constraint WHERE connamespace='app'::regnamespace AND contype='f'",
          )
        ).rows[0].count,
        "6",
      );
      const names = (
        await db.query(
          "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='app'::regnamespace)",
        )
      ).rows.map((r) => r.tgname as string);
      const originals = schema
        .filter(
          (o) => o.type === "trigger" && tables.includes(o.tbl_name as Table),
        )
        .map((o) => o.sql.match(/^CREATE TRIGGER (\w+)/)?.[1]);
      assert.equal(originals.length, 21);
      for (const name of originals) assert.ok(names.includes(name!), name);
      assert.equal(names.length, 28);
    });

    it("rejects an inconsistent imported completion atomically", async () => {
      await populate("1", "10", true);
      await insert(
        "root_basket_capture_completions",
        { ...receipt(), content_sha256: hash("f") },
        true,
      );
      await assert.rejects(
        activate(),
        /imported root basket completion is inconsistent/,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*) FROM pg_constraint WHERE connamespace='app'::regnamespace AND contype='f'",
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*) FROM pg_proc WHERE pronamespace='app'::regnamespace",
          )
        ).rows[0].count,
        "0",
      );
    });

    it("refuses imported pointer mismatches and missing completion references", async () => {
      await populate("1", "10", true);
      await insert(
        "root_basket_current",
        { ...pointer(), network_genesis_hash: hash("f") },
        true,
      );
      await assert.rejects(
        activate(),
        /imported root basket current scope is inconsistent/,
      );
      await db.query(
        "UPDATE app.root_basket_current SET network_genesis_hash=$1",
        [hash("a")],
      );
      await assert.rejects(activate(), /foreign key constraint/);
      await insert("root_basket_capture_completions", receipt(), true);
      await activate();
    });

    it("preserves complete rows and rejects even no-op writes to receipts and completed observations", async () => {
      await activate();
      await populate();
      await insert("root_basket_capture_completions", receipt());
      await insert("root_basket_current", pointer());
      for (const table of tables) await sameTable(table);
      for (const table of tables.slice(0, 5)) {
        await rejectBoth(
          `UPDATE ${table} SET capture_id=capture_id WHERE capture_id=$1`,
          [identity()],
          /immutable/,
        );
        await rejectBoth(
          `DELETE FROM ${table} WHERE capture_id=$1`,
          [identity()],
          /immutable/,
        );
      }
      await rejectBoth(
        "UPDATE root_basket_capture_completions SET accepted_at_ms=accepted_at_ms WHERE capture_id=$1",
        [identity()],
        /completion is immutable/,
      );
      await rejectBoth(
        "DELETE FROM root_basket_capture_completions WHERE capture_id=$1",
        [identity()],
        /completion is immutable/,
      );
      await rejectBoth(
        "INSERT INTO root_basket_targets SELECT capture_id,hotkey,2,weight FROM root_basket_targets",
        [],
        /completed root basket observation is immutable/,
      );
      await insert(
        "root_basket_captures",
        capture(),
        false,
        db,
        "ON CONFLICT DO NOTHING",
      );
      for (const table of tables) await sameTable(table);
    });

    it("checks persisted page chains, complete child counts and content identity", async () => {
      await activate();
      await populate();
      const complete =
        "INSERT INTO root_basket_capture_completions VALUES ($1,$2,$3)";
      await rejectBoth(complete, [identity(), hash("f"), "2"], /incomplete/);
      for (const column of ["expected_pages", "expected_funds"]) {
        source.exec(`UPDATE root_basket_captures SET ${column}=2`);
        await db.query(`UPDATE app.root_basket_captures SET ${column}=2`);
        await rejectBoth(complete, [identity(), hash("1"), "2"], /incomplete/);
        source.exec(`UPDATE root_basket_captures SET ${column}=1`);
        await db.query(`UPDATE app.root_basket_captures SET ${column}=1`);
      }
      await db.query(
        "UPDATE app.root_basket_fund_snapshots SET holdings_count=2",
      );
      source.exec("UPDATE root_basket_fund_snapshots SET holdings_count=2");
      await rejectBoth(complete, [identity(), hash("1"), "2"], /incomplete/);
      await db.query(
        "UPDATE app.root_basket_fund_snapshots SET holdings_count=1,targets_count=2",
      );
      source.exec(
        "UPDATE root_basket_fund_snapshots SET holdings_count=1,targets_count=2",
      );
      await rejectBoth(complete, [identity(), hash("1"), "2"], /incomplete/);
      await db.query(
        "UPDATE app.root_basket_fund_snapshots SET targets_count=1,provisional=0,first_block='11',price_divisor_q64_bits='1',rate0_q32_bits='0',tr_splice_q64_bits='1'",
      );
      source.exec(
        "UPDATE root_basket_fund_snapshots SET targets_count=1,provisional=0,first_block='11',price_divisor_q64_bits='1',rate0_q32_bits='0',tr_splice_q64_bits='1'",
      );
      await rejectBoth(complete, [identity(), hash("1"), "2"], /incomplete/);
      await db.query(
        "UPDATE app.root_basket_fund_snapshots SET first_block='10'",
      );
      source.exec("UPDATE root_basket_fund_snapshots SET first_block='10'");
      await insert("root_basket_capture_completions", receipt());
      await sameTable("root_basket_capture_completions");
    });

    it("preserves canonical signed/unsigned text and rejects out-of-range or noncanonical decimals", async () => {
      await activate();
      await populate();
      for (const value of [
        "18446744073709551616",
        "01",
        "+1",
        "1.0",
        "-1",
        "1\n",
      ]) {
        await rejectBoth(
          "UPDATE root_basket_fund_snapshots SET shares_atomic=$1",
          [value],
          /constraint|CHECK/,
        );
      }
      await rejectBoth(
        "UPDATE root_basket_fund_snapshots SET raw_spot_price_q64_bits=$1",
        ["340282366920938463463374607431768211456"],
        /constraint|CHECK/,
      );
      for (const value of [
        "-170141183460469231731687303715884105729",
        "170141183460469231731687303715884105728",
        "-0",
        "00",
      ]) {
        await rejectBoth(
          "UPDATE root_basket_fund_snapshots SET provisional=0,first_block='1',price_divisor_q64_bits='1',tr_splice_q64_bits='1',rate0_q32_bits=$1",
          [value],
          /constraint|CHECK/,
        );
      }
      const update =
        "UPDATE root_basket_fund_snapshots SET provisional=0,first_block='1',price_divisor_q64_bits='340282366920938463463374607431768211455',tr_splice_q64_bits='1',rate0_q32_bits='-170141183460469231731687303715884105728',shares_atomic='18446744073709551615'";
      source.exec(update);
      await db.query(update.replace("root_basket_", "app.root_basket_"));
      await sameTable("root_basket_fund_snapshots");
    });

    it("requires complete cursor receipts and preserves pending page immutability", async () => {
      await activate();
      await insert("root_basket_captures", { ...capture(), expected_pages: 2 });
      await insert("root_basket_capture_pages", {
        ...page(),
        next_after: hash("1"),
        fund_count: 0,
      });
      await insert("root_basket_capture_pages", {
        ...page(),
        page_index: 1,
        start_after: hash("2"),
        fund_count: 1,
      });
      await insert("root_basket_fund_snapshots", { ...fund(), page_index: 1 });
      await insert("root_basket_holdings", holding());
      await insert("root_basket_targets", target());
      await rejectBoth(
        "INSERT INTO root_basket_capture_completions VALUES ($1,$2,$3)",
        [identity(), hash("1"), "2"],
        /incomplete/,
      );
      await rejectBoth(
        "UPDATE root_basket_capture_pages SET start_after=start_after",
        [],
        /receipt is immutable/,
      );
    });

    it("rejects replay conflicts and preserves monotonically increasing current scope", async () => {
      await activate();
      await populate();
      await insert("root_basket_capture_completions", receipt());
      await insert("root_basket_current", pointer());
      const conflicting = { ...capture("2"), finalized_block_hash: hash("f") };
      const cols = Object.keys(conflicting).join(",");
      const values = Object.values(conflicting);
      await rejectBoth(
        `INSERT INTO root_basket_captures (${cols}) VALUES (${values.map((_, i) => `$${i + 1}`)})`,
        values,
        /finalized height has a different hash/,
      );
      await populate("2", "11");
      await insert("root_basket_capture_completions", receipt("2"));
      const update = "UPDATE root_basket_current SET capture_id=$1";
      source.prepare(update.replace("$1", "?")).run(identity("2"));
      await db.query(update.replace("root_basket_", "app.root_basket_"), [
        identity("2"),
      ]);
      await rejectBoth(update, [identity()], /cannot regress/);
      await rejectBoth(
        "UPDATE root_basket_current SET network_genesis_hash=$1",
        [hash("f")],
        /scope mismatch/,
      );
      await sameTable("root_basket_current");
    });

    it("serializes a child mutation behind completion before taking row locks", async () => {
      await activate();
      await populate("1", "10", true);
      const first = connection();
      const second = connection();
      await first.connect();
      await second.connect();
      try {
        const watch = await waitForAdvisory(second);
        await first.query("BEGIN");
        await second.query("BEGIN");
        await insert("root_basket_capture_completions", receipt(), true, first);
        const pending = second
          .query("UPDATE app.root_basket_fund_snapshots SET shares_atomic='2'")
          .then(
            () => null,
            (error: Error) => error,
          );
        await watch.waiting();
        await first.query("COMMIT");
        assert.match(
          String(await pending),
          /completed root basket observation is immutable/,
        );
        assert.equal(
          (
            await db.query(
              "SELECT shares_atomic FROM app.root_basket_fund_snapshots",
            )
          ).rows[0].shares_atomic,
          "1",
        );
      } finally {
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");
        await first.end();
        await second.end();
      }
    });

    it("sees a competing committed height and rejects stale isolation for writes", async () => {
      await activate();
      const first = connection();
      const second = connection();
      await first.connect();
      await second.connect();
      try {
        const watch = await waitForAdvisory(second);
        await first.query("BEGIN");
        await second.query("BEGIN");
        await insert("root_basket_captures", capture(), true, first);
        const pending = insert(
          "root_basket_captures",
          capture("2"),
          true,
          second,
        ).then(
          () => null,
          (error: Error) => error,
        );
        await watch.waiting();
        await first.query("COMMIT");
        assert.match(
          String(await pending),
          /finalized height has a different hash/,
        );
        await second.query("ROLLBACK");
        await second.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await assert.rejects(
          insert("root_basket_captures", capture("3", "12"), true, second),
          /require read committed/,
        );
      } finally {
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");
        await first.end();
        await second.end();
      }
    });

    it("rechecks completeness after waiting for a preceding child mutation", async () => {
      await activate();
      await populate("1", "10", true);
      const first = connection();
      const second = connection();
      await first.connect();
      await second.connect();
      try {
        const watch = await waitForAdvisory(second);
        await first.query("BEGIN");
        await second.query("BEGIN");
        await first.query(
          "UPDATE app.root_basket_fund_snapshots SET targets_count=2",
        );
        const pending = insert(
          "root_basket_capture_completions",
          receipt(),
          true,
          second,
        ).then(
          () => null,
          (error: Error) => error,
        );
        await watch.waiting();
        await first.query("COMMIT");
        assert.match(String(await pending), /persisted capture is incomplete/);
        assert.equal(
          (
            await db.query(
              "SELECT count(*) FROM app.root_basket_capture_completions",
            )
          ).rows[0].count,
          "0",
        );
      } finally {
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");
        await first.end();
        await second.end();
      }
    });
  },
);
