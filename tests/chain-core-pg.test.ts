import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, test } from "vitest";
import {
  createPgChainCore,
  decimalToRao,
  mergeCoverage,
  producedAtMs,
  type ChainCoreDatabase,
} from "../src/chain-core-pg.ts";
import type { ChainDetailSyncRows } from "../src/chain-detail-sync-payload.ts";
import { encodeAccountId32 } from "../src/ss58.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";

const migration = readFileSync(
  new URL("../migrations/postgres/0057_chain_core.sql", import.meta.url),
  "utf8",
);

const key = (fill: number) => new Uint8Array(32).fill(fill);
const pallet = (() => {
  const bytes = new Uint8Array(32);
  bytes.set([0x6d, 0x6f, 0x64, 0x6c], 0); // "modl"
  bytes.set(new TextEncoder().encode("subtensr"), 4);
  return bytes;
})();
const ALICE = encodeAccountId32(key(1))!;
const BOB = encodeAccountId32(key(2))!;
const SUBNET_ACCOUNT = encodeAccountId32(pallet)!;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const MS = 1_795_783_140_000;

function batch(
  numbers: number[],
  options: { hash?: (n: number) => string } = {},
): ChainDetailSyncRows {
  const blockRows = numbers.map((n) => ({
    block_number: n,
    block_hash: (options.hash ?? hash)(n),
    spec_version: 490,
    observed_at: MS + n,
  }));
  const extrinsicRows = numbers.flatMap((n) => [
    {
      block_number: n,
      extrinsic_index: 0,
      extrinsic_hash: hash(n + 1_000_000),
      signer: null,
      call_module: "Timestamp",
      call_function: "set",
      success: 1,
      fee_tao: "0",
      tip_tao: "0",
      call_args: JSON.stringify([
        { name: "now", type: "Compact<u64>", value: MS + n * 12_000 },
      ]),
      observed_at: MS,
    },
    {
      block_number: n,
      extrinsic_index: 1,
      extrinsic_hash: hash(n + 2_000_000),
      signer: ALICE,
      call_module: "SubtensorModule",
      call_function: "add_stake",
      success: 1,
      fee_tao: "0.00010432",
      tip_tao: "0",
      call_args: "[]",
      observed_at: MS,
    },
  ]);
  const chainEventRows = numbers.flatMap((n) => [
    {
      block_number: n,
      event_index: 0,
      pallet: "Balances",
      method: "Deposit",
      args: "[]",
      phase: "Initialization",
      extrinsic_index: null,
      observed_at: MS,
    },
    {
      block_number: n,
      event_index: 1,
      pallet: "SubtensorModule",
      method: "StakeAdded",
      args: "[]",
      phase: "ApplyExtrinsic",
      extrinsic_index: 1,
      observed_at: MS,
    },
    {
      block_number: n,
      event_index: 2,
      pallet: "Balances",
      method: "Withdraw",
      args: "[]",
      phase: "ApplyExtrinsic",
      extrinsic_index: 1,
      observed_at: MS,
    },
  ]);
  const accountEventRows = numbers.flatMap((n) => [
    // The per-block emission into a subnet's pallet account: not indexed.
    {
      block_number: n,
      event_index: 0,
      extrinsic_index: null,
      event_kind: "Deposit",
      hotkey: null,
      coldkey: SUBNET_ACCOUNT,
      netuid: null,
      uid: null,
      amount_tao: "0.000350795",
      alpha_amount: null,
      observed_at: MS,
    },
    {
      block_number: n,
      event_index: 1,
      extrinsic_index: 1,
      event_kind: "StakeAdded",
      hotkey: BOB,
      coldkey: ALICE,
      netuid: 7,
      uid: null,
      amount_tao: "21000000.123456789",
      alpha_amount: "12.5",
      observed_at: MS,
    },
    // A user's own fee withdrawal is indexed.
    {
      block_number: n,
      event_index: 2,
      extrinsic_index: 1,
      event_kind: "Withdraw",
      hotkey: null,
      coldkey: ALICE,
      netuid: null,
      uid: null,
      amount_tao: "0.00010432",
      alpha_amount: null,
      observed_at: MS,
    },
  ]);
  return {
    blockRows,
    extrinsicRows,
    chainEventRows,
    accountEventRows,
    head: Math.max(...numbers),
  };
}

let db: PGlite;
let core: ReturnType<typeof createPgChainCore>;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(migration);
  const database: ChainCoreDatabase = {
    transaction: (callback) =>
      db.transaction((tx) =>
        callback({
          query: async (text, values = []) =>
            (await tx.query(toPositionalPlaceholders(text), values))
              .rows as never,
        }),
      ),
  };
  core = createPgChainCore(database);
});

const one = async <T>(text: string, values: unknown[] = []) =>
  (await db.query<T>(text, values)).rows[0];

test("a batch lands typed, and re-sending it changes nothing", async () => {
  const first = await core.write("finney", batch([100, 101]));
  assert.deepEqual(
    { ...first, coverage: first.coverage },
    {
      blocks: 2,
      extrinsics: 4,
      events: 6,
      accountEvents: 4,
      accounts: 3,
      coverage: { from: 100, through: 101 },
    },
  );
  const block = await one<{
    block_hash: Uint8Array;
    produced_at: Date;
    fee_rao: string;
    extrinsic_count: number;
  }>(
    "SELECT block_hash, produced_at, fee_rao::text, extrinsic_count FROM chain.blocks WHERE block_number = 101",
  );
  assert.equal(
    Buffer.from(block.block_hash).toString("hex"),
    hash(101).slice(2),
  );
  assert.equal(block.produced_at.getTime(), MS + 101 * 12_000);
  assert.equal(block.fee_rao, "104320");
  assert.equal(block.extrinsic_count, 2);
  const stake = await one<{
    amount_rao: string;
    alpha_rao: string;
    coldkey: string;
    hotkey: string;
    netuid: number;
  }>(
    `SELECT e.amount_rao::text, e.alpha_rao::text, c.ss58 AS coldkey, h.ss58 AS hotkey, e.netuid
     FROM chain.account_events e JOIN chain.accounts c ON c.account = e.coldkey JOIN chain.accounts h ON h.account = e.hotkey
     WHERE e.block_number = 100 AND e.event_index = 1`,
  );
  // 21M TAO is past JavaScript's safe integers; it lands exact.
  assert.deepEqual(stake, {
    amount_rao: "21000000123456789",
    alpha_rao: "12500000000",
    coldkey: ALICE,
    hotkey: BOB,
    netuid: 7,
  });
  const counts = async () =>
    one<{ b: number; x: number; e: number; a: number; k: number; c: number }>(
      `SELECT (SELECT count(*)::int FROM chain.blocks) b, (SELECT count(*)::int FROM chain.extrinsics) x,
         (SELECT count(*)::int FROM chain.events) e, (SELECT count(*)::int FROM chain.account_events) a,
         (SELECT count(*)::int FROM chain.accounts) k, (SELECT count(*)::int FROM chain.calls) c`,
    );
  const before = await counts();
  await core.write("finney", batch([100, 101]));
  assert.deepEqual(await counts(), before);
  // The re-send drew no identity value: the next new call is id 3.
  await core.write("finney", {
    ...batch([102]),
    extrinsicRows: batch([102]).extrinsicRows.map((row, i) =>
      i === 1 ? { ...row, call_function: "remove_stake" } : row,
    ),
  });
  assert.equal(
    (
      await one<{ max: number }>(
        "SELECT max(call)::int AS max FROM chain.calls",
      )
    ).max,
    3,
  );
});

test("pallet accounts' bookkeeping is kept out of the account index, not out of the events", async () => {
  await core.write("finney", batch([100]));
  const indexed = await db.query<{ event_index: number }>(
    "SELECT event_index FROM chain.account_events ORDER BY event_index",
  );
  assert.deepEqual(
    indexed.rows.map((row) => row.event_index),
    [1, 2],
  );
  assert.equal(
    (
      await one<{ n: number }>(
        "SELECT count(*)::int n FROM chain.events WHERE event_index = 0",
      )
    ).n,
    1,
  );
  assert.equal(
    (
      await one<{ pallet: boolean }>(
        "SELECT pallet FROM chain.accounts WHERE ss58 = $1",
        [SUBNET_ACCOUNT],
      )
    ).pallet,
    true,
  );
  assert.equal(
    (
      await one<{ pallet: boolean }>(
        "SELECT pallet FROM chain.accounts WHERE ss58 = $1",
        [ALICE],
      )
    ).pallet,
    false,
  );
});

test("a block held under another hash refuses the whole batch", async () => {
  await core.write("finney", batch([100]));
  await assert.rejects(
    core.write(
      "finney",
      batch([100, 101], { hash: (n) => (n === 100 ? hash(999) : hash(n)) }),
    ),
    /block 100 is already held with a different hash/,
  );
  // Nothing of the refused batch landed, not even its new block.
  assert.equal(
    (await one<{ n: number }>("SELECT count(*)::int n FROM chain.blocks")).n,
    1,
  );
});

test("coverage is the newest contiguous range, and backfill extends it downward", () => {
  assert.deepEqual(mergeCoverage(null, [5, 3, 4]), { from: 3, through: 5 });
  assert.deepEqual(mergeCoverage({ from: 3, through: 5 }, [6, 7]), {
    from: 3,
    through: 7,
  });
  assert.deepEqual(mergeCoverage({ from: 3, through: 7 }, [1, 2]), {
    from: 1,
    through: 7,
  });
  // A gap: the record never claims across it.
  assert.deepEqual(mergeCoverage({ from: 1, through: 7 }, [9, 10]), {
    from: 9,
    through: 10,
  });
  // An older disconnected run leaves it alone.
  assert.deepEqual(mergeCoverage({ from: 9, through: 10 }, [2]), {
    from: 9,
    through: 10,
  });
});

test("partitions are created per network and range, and retention drops whole ones", async () => {
  const span = 50_400;
  await core.write("finney", batch([span - 1, span]));
  await core.write("finney", batch([2 * span + 5]));
  const parts = async () =>
    (
      await db.query<{ relname: string }>(
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'chain.events_finney'::regclass ORDER BY 1`,
      )
    ).rows.map((row) => row.relname);
  assert.deepEqual(await parts(), [
    "events_finney_0",
    "events_finney_1",
    "events_finney_2",
  ]);
  assert.equal(
    (
      await one<{ d: number }>(
        "SELECT chain.drop_partitions_below('events', 'finney', $1) d",
        [2 * span],
      )
    ).d,
    2,
  );
  assert.deepEqual(await parts(), ["events_finney_2"]);
  // The partition holding the newest row is never dropped.
  assert.equal(
    (
      await one<{ d: number }>(
        "SELECT chain.drop_partitions_below('events', 'finney', $1) d",
        [3 * span],
      )
    ).d,
    0,
  );
  const coverage = await one<{ complete_from: string }>(
    "SELECT complete_from::text FROM chain.coverage WHERE network_id = 'finney' AND family = 'events'",
  );
  assert.equal(coverage.complete_from, String(2 * span + 5));
  // Blocks are kept for all of history.
  assert.equal(
    (await one<{ n: number }>("SELECT count(*)::int n FROM chain.blocks")).n,
    3,
  );
});

test("the partition helpers refuse anything but a known network and a bounded range", async () => {
  await assert.rejects(
    db.query("SELECT chain.ensure_partitions('nowhere', 0, 1)"),
    /unknown network/,
  );
  await assert.rejects(
    db.query("SELECT chain.ensure_partitions('finney; DROP', 0, 1)"),
    /invalid network/,
  );
  await assert.rejects(
    db.query("SELECT chain.ensure_partitions('finney', 0, 50400 * 100)"),
    /invalid block range/,
  );
  await assert.rejects(
    db.query("SELECT chain.drop_partitions_below('blocks', 'finney', 1)"),
    /invalid family/,
  );
});

test("the migration refuses to replace a populated provenance table", async () => {
  const fresh = new PGlite();
  await fresh.exec(
    `CREATE SCHEMA chain; CREATE TABLE chain.blocks (n int); INSERT INTO chain.blocks VALUES (1);`,
  );
  await assert.rejects(fresh.exec(migration), /chain\.blocks holds 1 rows/);
  const empty = new PGlite();
  await empty.exec(`CREATE SCHEMA chain; CREATE TABLE chain.blocks (n int);`);
  await empty.exec(migration);
  assert.equal(
    (
      await empty.query<{ n: number }>(
        "SELECT count(*)::int n FROM chain.networks",
      )
    ).rows[0].n,
    2,
  );
});

test("amounts convert exactly to rao, and the block time comes from its inherent", () => {
  assert.equal(decimalToRao("0.000350795"), "350795");
  assert.equal(decimalToRao("21000000.123456789"), "21000000123456789");
  assert.equal(decimalToRao("-1.5"), "-1500000000");
  assert.equal(decimalToRao(null), null);
  assert.throws(() => decimalToRao("0.0000000001"), /not exact to the rao/);
  assert.equal(
    producedAtMs([
      {
        call_module: "Timestamp",
        call_function: "set",
        call_args: '[{"name":"now","value":1795783140000}]',
      },
    ]),
    "1795783140000",
  );
  assert.equal(
    producedAtMs([
      { call_module: "Timestamp", call_function: "set", call_args: "not json" },
    ]),
    null,
  );
  assert.equal(producedAtMs([]), null);
});

test("the partition helpers are callable only by a role granted EXECUTE", async () => {
  await db.exec(
    "CREATE ROLE chain_reader NOLOGIN; CREATE ROLE chain_writer NOLOGIN;",
  );
  await db.exec(
    "GRANT EXECUTE ON FUNCTION chain.ensure_partitions(text, bigint, bigint), " +
      "chain.drop_partitions_below(text, text, bigint) TO chain_writer;",
  );
  const can = async (role: string, fn: string) =>
    (
      await one<{ ok: boolean }>(
        "SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok",
        [role, fn],
      )
    ).ok;
  for (const fn of [
    "chain.ensure_partitions(text, bigint, bigint)",
    "chain.drop_partitions_below(text, text, bigint)",
  ]) {
    // Without the revoke PUBLIC would hold EXECUTE, and every role with it.
    assert.equal(await can("chain_reader", fn), false, fn);
    assert.equal(await can("chain_writer", fn), true, fn);
  }
});
