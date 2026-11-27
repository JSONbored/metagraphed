import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, test } from "vitest";
import { createPgChainCore } from "../src/chain-core-pg.ts";
import {
  loadBlockColdTier,
  loadBlockFeedColdTier,
} from "../src/blocks-cold-tier.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";
import { encodeBlockFeedCursor } from "../src/block-feed-cursor.ts";
import { encodeAccountId32 } from "../src/ss58.ts";

// The block routes' store leg over the chain core (ADR 0029 phase 1b): the
// same feed and detail shapes, from the typed tables through their views.
const sql = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
const BASE = 9_600_000;
const MS = 1_795_783_140_000;
const ALICE = encodeAccountId32(new Uint8Array(32).fill(1))!;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
let db: PGlite;
let env: Record<string, unknown>;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(sql("0057_chain_core.sql"));
  await db.exec(sql("0058_chain_core_reads.sql"));
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
  for (let i = 0; i < 5; i += 1) {
    const n = BASE + i;
    await core.write("finney", {
      blockRows: [
        {
          block_number: n,
          block_hash: hash(n),
          spec_version: i < 3 ? 489 : 490,
          observed_at: MS + i * 12_000,
          account_event_count: 1,
          native_transfer_tao: "0",
          stake_flow_tao: "2.5",
          issuance_tao: "1",
          subnet_ids: "[7]",
          economics_complete: true,
          synced_at: MS + i * 12_000 + 1,
        },
      ],
      extrinsicRows: [
        {
          block_number: n,
          extrinsic_index: 0,
          extrinsic_hash: hash(n + 1),
          signer: ALICE,
          call_module: "SubtensorModule",
          call_function: "add_stake",
          success: true,
          fee_tao: "0.001",
          tip_tao: "0",
          call_args: "[]",
          observed_at: MS,
        },
      ],
      chainEventRows: Array.from({ length: i + 1 }, (_, e) => ({
        block_number: n,
        event_index: e,
        pallet: "System",
        method: "Remarked",
        args: "[]",
        phase: "Finalization",
        extrinsic_index: null,
        observed_at: MS,
      })),
      accountEventRows: [],
    });
  }
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

const numbers = (feed: { blocks: unknown[] } | null) =>
  (feed?.blocks ?? []).map(
    (block) => (block as { block_number: number }).block_number,
  );

test("the feed pages the chain core newest first, with a cursor to continue", async () => {
  const first = await loadBlockFeedColdTier(env, { limit: 2, offset: 0 });
  assert.deepEqual(numbers(first), [BASE + 4, BASE + 3]);
  const block = first!.blocks[0] as unknown as Record<string, unknown>;
  assert.equal(block.stake_flow_tao, 2.5);
  assert.equal(block.economic_activity_tao, 2.5);
  const next = await loadBlockFeedColdTier(env, {
    limit: 2,
    offset: 0,
    cursor:
      (first as { next_cursor?: string; nextCursor?: string }).next_cursor ??
      (first as { nextCursor?: string }).nextCursor ??
      null,
  });
  assert.deepEqual(numbers(next), [BASE + 2, BASE + 1]);
});

test("the feed answers the filters the chain core holds, and leaves an author filter to the lakehouse", async () => {
  assert.deepEqual(
    numbers(
      await loadBlockFeedColdTier(env, {
        limit: 10,
        offset: 0,
        specVersion: 490,
      }),
    ),
    [BASE + 4, BASE + 3],
  );
  assert.deepEqual(
    numbers(
      await loadBlockFeedColdTier(env, { limit: 10, offset: 0, minEvents: 4 }),
    ),
    [BASE + 4, BASE + 3],
  );
  assert.deepEqual(
    numbers(
      await loadBlockFeedColdTier(env, {
        limit: 10,
        offset: 0,
        blockStart: BASE + 1,
        blockEnd: BASE + 2,
      }),
    ),
    [BASE + 2, BASE + 1],
  );
  assert.equal(
    await loadBlockFeedColdTier(env, { limit: 10, offset: 0, author: ALICE }),
    null,
  );
});

test("one block resolves by height and by hash, and an unheld height reads as absent", async () => {
  const byHeight = await loadBlockColdTier(env, String(BASE + 2));
  assert.equal(
    (byHeight?.block as { block_hash?: string } | undefined)?.block_hash,
    hash(BASE + 2),
  );
  const byHash = await loadBlockColdTier(env, hash(BASE + 3));
  assert.equal(
    (byHash?.block as { block_number?: number } | undefined)?.block_number,
    BASE + 3,
  );
  const missing = await loadBlockColdTier(env, String(BASE + 99));
  assert.equal(missing?.block ?? null, null);
});

test("every cursor mode pages the chain core, and a cursor before the chain's start reads nothing", async () => {
  const observed = encodeBlockFeedCursor(
    { observed_at: MS + 3 * 12_000, block_number: BASE + 3 },
    { mode: "observed", height: 0, observed: 0, source: null, ordinal: null },
  );
  assert.deepEqual(
    numbers(
      await loadBlockFeedColdTier(env, {
        limit: 10,
        offset: 0,
        cursor: observed,
      }),
    ),
    [BASE + 2, BASE + 1, BASE],
  );
  const exhausted = encodeBlockFeedCursor(
    { block_number: null, _source_id: 1, _ordinal: 2 },
    null,
  );
  assert.equal(
    await loadBlockFeedColdTier(env, {
      limit: 10,
      offset: 0,
      cursor: exhausted,
    }),
    null,
  );
});

test("an unparseable filter, a failing store and a short hash all leave the chain core alone", async () => {
  assert.equal(
    await loadBlockFeedColdTier(env, {
      limit: 10,
      offset: 0,
      minExtrinsics: -1,
    }),
    null,
  );
  const failing = {
    NATIVE_CHAIN_READ_STORE: {
      tables: [],
      store: {
        query: async () => {
          throw new Error("chain core unavailable");
        },
      },
    },
  } as never;
  assert.equal(
    await loadBlockFeedColdTier(failing, { limit: 10, offset: 0 }),
    null,
  );
  const declined = await loadBlockColdTier(failing, String(BASE + 1));
  assert.equal((declined as { block?: unknown } | null)?.block ?? null, null);
  assert.equal(await loadBlockColdTier(env, "0xabc"), null);
});

test("a hash the chain core does not hold, a failing hash lookup and another network leave it to the lakehouse", async () => {
  assert.equal(await loadBlockColdTier(env, hash(BASE + 999)), null);
  const failing = {
    NATIVE_CHAIN_READ_STORE: {
      tables: [],
      store: {
        query: async () => {
          throw new Error("chain core unavailable");
        },
      },
    },
  } as never;
  assert.equal(await loadBlockColdTier(failing, hash(BASE + 1)), null);
  assert.equal(await loadBlockColdTier(env, String(BASE + 1), "testnet"), null);
});
