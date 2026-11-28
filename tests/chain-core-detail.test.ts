import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, test } from "vitest";
import { createPgChainCore } from "../src/chain-core-pg.ts";
import {
  accountEventsHotFloorMs,
  answerBlockDetail,
  chainDetailCoverage,
  loadAccountBasketClaimEventsHotTier,
  loadAccountEventsAboveFloorHotTier,
  loadAccountEventsHotTier,
  loadBlockChainEventsHotTier,
  loadBlockEventsHotTier,
  loadBlockExtrinsicsHotTier,
  loadChainEventsHeadHotTier,
  loadExtrinsicHotTier,
  loadExtrinsicsHeadHotTier,
} from "../src/chain-detail-hot-tier.ts";
import type { ChainDetailSyncRows } from "../src/chain-detail-sync-payload.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";
import { encodeAccountId32 } from "../src/ss58.ts";

// The block-detail hot tier over the chain core (ADR 0029 phase 1b): every
// read the D1-era tables answered, from the typed tables through their views,
// in the row shapes the formatters already read.
const sql = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
const BASE = 9_700_000;
/** The first block's own time; each later block is twelve seconds after. */
const T0 = 1_795_800_000_000;
const DAY = 86_400_000;
const ALICE = encodeAccountId32(new Uint8Array(32).fill(1))!;
const BOB = encodeAccountId32(new Uint8Array(32).fill(2))!;
const CAROL = encodeAccountId32(new Uint8Array(32).fill(3))!;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const xhash = (n: number, i: number) => hash(n * 10 + i + 1);

let db: PGlite;
let env: Record<string, unknown>;

/** Block BASE + i: the timestamp inherent, then one signed call, and the
 * events and account events they emitted. Even blocks stake (ALICE onto
 * BOB); odd blocks make a failed transfer by BOB. */
function block(i: number): ChainDetailSyncRows {
  const n = BASE + i;
  const produced = T0 + i * 12_000;
  const even = i % 2 === 0;
  return {
    blockRows: [
      {
        block_number: n,
        block_hash: hash(n),
        spec_version: 497,
        // Block 0 is backfilled: read ten days after it was produced.
        observed_at: i === 0 ? produced + 10 * DAY : produced + 900,
      },
    ],
    extrinsicRows: [
      {
        block_number: n,
        extrinsic_index: 0,
        extrinsic_hash: xhash(n, 0),
        signer: null,
        call_module: "Timestamp",
        call_function: "set",
        success: true,
        fee_tao: "0",
        tip_tao: "0",
        call_args: JSON.stringify([
          { name: "now", type: "Compact<u64>", value: produced },
        ]),
        observed_at: produced,
      },
      {
        block_number: n,
        extrinsic_index: 1,
        extrinsic_hash: xhash(n, 1),
        signer: even ? ALICE : BOB,
        call_module: even ? "SubtensorModule" : "Balances",
        call_function: even ? "add_stake" : "transfer_keep_alive",
        success: even,
        fee_tao: "0.0001",
        tip_tao: "0",
        call_args: "[]",
        observed_at: produced,
      },
    ],
    chainEventRows: [
      {
        block_number: n,
        event_index: 0,
        pallet: "System",
        method: "ExtrinsicSuccess",
        args: "[]",
        phase: "ApplyExtrinsic",
        extrinsic_index: 0,
        observed_at: produced,
      },
      {
        block_number: n,
        event_index: 1,
        pallet: even ? "SubtensorModule" : "System",
        method: even ? "StakeAdded" : "ExtrinsicFailed",
        args: "[]",
        phase: "ApplyExtrinsic",
        extrinsic_index: 1,
        observed_at: produced,
      },
      {
        block_number: n,
        event_index: 2,
        pallet: "Balances",
        method: "Withdraw",
        args: "[]",
        phase: "ApplyExtrinsic",
        extrinsic_index: 1,
        observed_at: produced,
      },
    ],
    accountEventRows: [
      ...(even
        ? [
            {
              block_number: n,
              event_index: 1,
              extrinsic_index: 1,
              event_kind: "StakeAdded",
              hotkey: BOB,
              coldkey: ALICE,
              netuid: 7,
              uid: null,
              amount_tao: "1.5",
              alpha_amount: "3",
              observed_at: produced,
            },
          ]
        : []),
      {
        block_number: n,
        event_index: 2,
        extrinsic_index: 1,
        event_kind: "Withdraw",
        hotkey: null,
        coldkey: even ? ALICE : BOB,
        netuid: null,
        uid: null,
        amount_tao: "0.0001",
        alpha_amount: null,
        observed_at: produced,
      },
    ],
    head: n,
  };
}

beforeAll(async () => {
  db = new PGlite();
  for (const file of [
    "0057_chain_core.sql",
    "0058_chain_core_reads.sql",
    "0059_chain_core_block_time.sql",
  ])
    await db.exec(sql(file));
  const core = createPgChainCore({
    transaction: (callback) =>
      db.transaction((tx) =>
        callback({
          query: async (text, values = []) =>
            (await tx.query(toPositionalPlaceholders(text), values))
              .rows as never,
        }),
      ),
  });
  for (let i = 0; i < 4; i += 1) await core.write("finney", block(i));
  env = {
    NATIVE_CHAIN_READ_STORE: {
      tables: [
        "account_event_rows",
        "block_rows",
        "chain_event_rows",
        "extrinsic_rows",
      ],
      store: {
        query: async (text: string, values: unknown[] = []) =>
          (await db.query(toPositionalPlaceholders(text), values)).rows,
      },
    },
  };
});

const blocks = (rows: Record<string, unknown>[] | null) =>
  (rows ?? []).map((row) => Number(row.block_number));

test("the window is what every detail family holds, timed by the block", async () => {
  assert.deepEqual(await chainDetailCoverage(env), {
    floor: BASE,
    head: BASE + 3,
    headObservedAt: T0 + 3 * 12_000,
  });
});

test("rows tell time by the block, so a backfilled block sorts where it was produced", async () => {
  const rows = await loadExtrinsicsHeadHotTier(env, {
    limit: 10,
    ceilingObservedAt: null,
    block: BASE,
  });
  // Observed ten days late, produced at T0: the view reads T0.
  assert.deepEqual(
    rows?.map((row) => Number(row.observed_at)),
    [T0, T0],
  );
  assert.equal(await accountEventsHotFloorMs(env), T0);
});

test("the extrinsic feed reads newest first and continues from its cursor", async () => {
  const first = await loadExtrinsicsHeadHotTier(env, {
    limit: 3,
    ceilingObservedAt: null,
  });
  assert.deepEqual(
    first?.map((row) => [
      Number(row.block_number),
      Number(row.extrinsic_index),
    ]),
    [
      [BASE + 3, 1],
      [BASE + 3, 0],
      [BASE + 2, 1],
    ],
  );
  const tail = first!.at(-1)!;
  const next = await loadExtrinsicsHeadHotTier(env, {
    limit: 3,
    ceilingObservedAt: null,
    cursor: [
      Number(tail.observed_at),
      Number(tail.block_number),
      Number(tail.extrinsic_index),
    ],
  });
  assert.deepEqual(
    next?.map((row) => [Number(row.block_number), Number(row.extrinsic_index)]),
    [
      [BASE + 2, 0],
      [BASE + 1, 1],
      [BASE + 1, 0],
    ],
  );
});

test("every extrinsic filter narrows the chain core's feed", async () => {
  const signed = await loadExtrinsicsHeadHotTier(env, {
    limit: 10,
    ceilingObservedAt: null,
    signer: ALICE,
  });
  assert.deepEqual(blocks(signed), [BASE + 2, BASE]);
  assert.equal(signed?.[0]?.signer, ALICE);
  const calls = await loadExtrinsicsHeadHotTier(env, {
    limit: 10,
    ceilingObservedAt: null,
    module: "Balances",
    callFunction: "transfer_keep_alive",
  });
  assert.deepEqual(blocks(calls), [BASE + 3, BASE + 1]);
  const failed = await loadExtrinsicsHeadHotTier(env, {
    limit: 10,
    ceilingObservedAt: null,
    success: false,
  });
  assert.deepEqual(blocks(failed), [BASE + 3, BASE + 1]);
  assert.equal(failed?.[0]?.success, false);
  const windowed = await loadExtrinsicsHeadHotTier(env, {
    limit: 10,
    ceilingObservedAt: T0 + 2 * 12_000,
    floorObservedAt: T0 + 12_000,
    blockStart: BASE,
    blockEnd: BASE + 3,
  });
  assert.deepEqual(blocks(windowed), [BASE + 2, BASE + 2, BASE + 1, BASE + 1]);
});

test("chain events page across blocks and filter by pallet and method", async () => {
  const feed = await loadChainEventsHeadHotTier(env, {
    limit: 4,
    ceiling: null,
  });
  assert.deepEqual(
    feed?.map((row) => [Number(row.block_number), Number(row.event_index)]),
    [
      [BASE + 3, 2],
      [BASE + 3, 1],
      [BASE + 3, 0],
      [BASE + 2, 2],
    ],
  );
  const staked = await loadChainEventsHeadHotTier(env, {
    limit: 10,
    ceiling: BASE + 2,
    floor: BASE,
    cursorEventIndex: 2,
    pallet: "SubtensorModule",
    method: "StakeAdded",
  });
  assert.deepEqual(blocks(staked), [BASE + 2, BASE]);
  assert.equal(staked?.[0]?.phase, "ApplyExtrinsic");
});

test("one block's extrinsics, events and chain events read in order", async () => {
  const extrinsics = await loadBlockExtrinsicsHotTier(
    env,
    String(BASE + 2),
    BASE + 2,
    { limit: 10 },
  );
  assert.equal(extrinsics?.extrinsic_count, 2);
  const events = await loadBlockEventsHotTier(env, String(BASE + 2), BASE + 2, {
    limit: 1,
  });
  // One row on the page, and the block's true indexed total beside it.
  assert.equal(events?.events.length, 1);
  assert.equal(events?.event_count, 2);
  const chainEvents = await loadBlockChainEventsHotTier(env, BASE + 1);
  assert.deepEqual(
    chainEvents?.events.map((event) => event.method),
    ["ExtrinsicSuccess", "ExtrinsicFailed", "Withdraw"],
  );
});

test("an extrinsic resolves by position and by hash, with its events embedded", async () => {
  const byPosition = await loadExtrinsicHotTier(env, `${BASE + 2}-1`);
  assert.equal(byPosition?.extrinsic?.extrinsic_hash, xhash(BASE + 2, 1));
  assert.deepEqual(
    byPosition?.events.map(
      (event) => (event as { event_kind: string }).event_kind,
    ),
    ["StakeAdded", "Withdraw"],
  );
  // Hex case does not matter to a hash.
  const byHash = await loadExtrinsicHotTier(
    env,
    xhash(BASE + 3, 1)
      .toUpperCase()
      .replace("0X", "0x"),
  );
  assert.equal(byHash?.extrinsic?.block_number, BASE + 3);
  assert.equal(await loadExtrinsicHotTier(env, hash(42)), null);
});

test("an account's events merge both sides of the key, newest first", async () => {
  const alice = await loadAccountEventsHotTier(env, ALICE, 10);
  assert.deepEqual(
    alice?.map((row) => [Number(row.block_number), Number(row.event_index)]),
    [
      [BASE + 2, 2],
      [BASE + 2, 1],
      [BASE, 2],
      [BASE, 1],
    ],
  );
  // BOB is a hotkey on the stakes and a coldkey on his own fees.
  const bob = await loadAccountEventsHotTier(env, BOB, 3);
  assert.deepEqual(
    bob?.map((row) => [Number(row.block_number), row.event_kind]),
    [
      [BASE + 3, "Withdraw"],
      [BASE + 2, "StakeAdded"],
      [BASE + 1, "Withdraw"],
    ],
  );
  assert.deepEqual(await loadAccountEventsHotTier(env, CAROL, 5), []);
  const claims = await loadAccountBasketClaimEventsHotTier(
    env,
    ALICE,
    ["StakeAdded"],
    10,
  );
  assert.deepEqual(blocks(claims), [BASE + 2, BASE]);
  // The account index starts at the window's first block, so a floor at or
  // after it is covered and one before it is not.
  assert.equal(
    (await loadAccountEventsAboveFloorHotTier(env, ALICE, T0, 10))?.length,
    4,
  );
  assert.equal(
    await loadAccountEventsAboveFloorHotTier(env, ALICE, T0 - 1, 10),
    null,
  );
});

test("a covered block answers hot, and a block the window does not hold declines", async () => {
  const ops = {
    hot: (height: number) => loadBlockChainEventsHotTier(env, height),
    cold: async () => null,
    isEmpty: () => true,
  };
  const covered = await answerBlockDetail(env, String(BASE + 1), ops);
  assert.equal(covered.kind, "answer");
  const byHash = await answerBlockDetail(env, hash(BASE + 3), ops);
  assert.equal(byHash.kind, "answer");
  const outside = await answerBlockDetail(env, String(BASE + 9), ops);
  assert.equal(outside.kind, "gap");
});

test("with the retained copy unanswerable, the chain core still answers what it holds whole", async () => {
  // The fleet on 2026-11-28: a selected retained owner with no census, which
  // made every block route answer history_unavailable, held blocks included.
  const fleet = { ...env, RETAINED_BLOCKS_NETWORKS: "mainnet" };
  let coldReads = 0;
  const ops = {
    hot: (height: number) => loadBlockChainEventsHotTier(fleet, height),
    cold: async () => {
      coldReads += 1;
      return null;
    },
    isEmpty: () => true,
  };
  const covered = await answerBlockDetail(fleet, String(BASE + 1), ops);
  assert.equal(covered.kind, "answer");
  assert.equal(coldReads, 0);
  // Below the chain core's floor the block stays the retained owner's: its
  // cold loader is asked, which on the fleet raises history_unavailable.
  const below = await answerBlockDetail(fleet, String(BASE - 5), ops);
  assert.equal(coldReads, 1);
  assert.equal(below.kind, "miss");
});

test("a failed chain-core read answers nothing rather than guessing", async () => {
  const broken = {
    NATIVE_CHAIN_READ_STORE: {
      tables: [],
      store: {
        query: async () => {
          throw new Error("unavailable");
        },
      },
    },
  };
  assert.equal(await chainDetailCoverage(broken), null);
  assert.equal(
    await loadExtrinsicsHeadHotTier(broken, {
      limit: 5,
      ceilingObservedAt: null,
    }),
    null,
  );
  assert.equal(await loadAccountEventsHotTier(broken, ALICE, 5), null);
  assert.equal(await loadExtrinsicHotTier(broken, `${BASE}-1`), null);
});
