import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { loadExtrinsicsHeadHotTier } from "../src/chain-detail-hot-tier.ts";
import { encodeCursor } from "../src/cursor.ts";
import {
  buildExtrinsicFeed,
  buildAccountExtrinsics,
} from "../src/extrinsics.ts";
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
const native = vi.hoisted(() => ({ feed: vi.fn() }));
vi.mock("../src/indexed-extrinsic-feeds.ts", () => ({
  loadIndexedExtrinsicFeedPage: native.feed,
}));
import {
  loadAccountExtrinsicsColdTier,
  loadExtrinsicFeedColdTier,
} from "../src/extrinsics-cold-tier.ts";
const TOKEN = { R2_SQL_TOKEN: "obsolete-fixture" };
const SIGNER = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const row = (block: number, index = 0) => ({
  block_number: block,
  extrinsic_index: index,
  extrinsic_hash: "0xabc",
  signer: SIGNER,
  call_module: "SubtensorModule",
  call_function: "set_weights",
  success: true,
  fee_tao: null,
  tip_tao: null,
  call_args: null,
  observed_at: 1700000000000 + block,
});
beforeEach(() => {
  native.feed.mockReset().mockResolvedValue([]);
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = [];
  pg.control.onQuery = null;
  pg.control.failNext = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("SQL transport is retired");
    }),
  );
});
afterEach(() => {
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  vi.unstubAllGlobals();
});
function nativeRows(rows: unknown[]) {
  native.feed.mockResolvedValue(rows);
  return vi.mocked(fetch).mock.calls;
}
test("native rows use the canonical formatter, cursor, offset and signer contract", async () => {
  const rows = [row(10, 2), row(9)];
  nativeRows(rows);
  const cursor = encodeCursor([1700000000009, 9, 0]);
  assert.deepEqual(
    await loadExtrinsicFeedColdTier(TOKEN, { limit: 2, offset: 2 }),
    buildExtrinsicFeed(rows, { limit: 2, offset: 2, nextCursor: cursor }),
  );
  assert.equal(native.feed.mock.calls.at(-1)![3], 2);
  assert.deepEqual(
    await loadAccountExtrinsicsColdTier(TOKEN, SIGNER, { limit: 2 }),
    buildAccountExtrinsics(rows, SIGNER, {
      limit: 2,
      offset: 0,
      nextCursor: cursor,
    }),
  );
  assert.equal(native.feed.mock.calls.at(-1)![1].signer, SIGNER);
  nativeRows([row(1)]);
  assert.equal(
    (await loadExtrinsicFeedColdTier(TOKEN, { limit: 2 }))!.next_cursor,
    null,
  );
  nativeRows([{ ...row(1), block_number: null }]);
  assert.equal(
    (await loadExtrinsicFeedColdTier(TOKEN, { limit: 1 }))!.next_cursor,
    null,
  );
});
test("every public filter reaches the native index without coercing false or widening intersections", async () => {
  const cursor = encodeCursor([20, 10, 1]);
  await loadExtrinsicFeedColdTier(
    TOKEN,
    {
      limit: 2,
      offset: 200,
      cursor,
      signer: SIGNER,
      module: "Balances",
      callFunction: "transfer",
      success: false,
      block: 10,
      blockStart: 9,
      blockEnd: 11,
      from: 2,
      to: 20,
    },
    "testnet",
  );
  const [e, selector, limit, offset, network] = native.feed.mock.calls[0];
  assert.equal(e, TOKEN);
  assert.equal(limit, 2);
  assert.equal(offset, 0);
  assert.equal(network, "testnet");
  assert.deepEqual(selector, {
    signer: SIGNER,
    module: "Balances",
    callFunction: "transfer",
    success: false,
    blockStart: 10,
    blockEnd: 10,
    observedStart: 2,
    observedEnd: 20,
    cursor: [20, 10, 1],
  });
  await loadExtrinsicFeedColdTier(TOKEN, {
    limit: 2,
    offset: 1,
    cursor: "bad",
    blockStart: 3,
    blockEnd: 9,
  });
  assert.equal(native.feed.mock.calls.at(-1)![1].cursor, null);
  assert.equal(native.feed.mock.calls.at(-1)![3], 1);
});
test("invalid filters decline before touching the store, even with a legacy token", async () => {
  for (const query of [
    { limit: 0 },
    { limit: NaN },
    { limit: 1, offset: -1 },
    { limit: 1, offset: 251 },
    { limit: 1, signer: "bad" },
    { limit: 1, module: "' OR 1=1" },
    { limit: 1, callFunction: "x;" },
    { limit: 1, success: "false" },
    { limit: 1, block: NaN },
    { limit: 1, blockStart: -1 },
    { limit: 1, blockEnd: -1 },
    { limit: 1, from: -1 },
    { limit: 1, to: NaN },
  ])
    assert.equal(await loadExtrinsicFeedColdTier(TOKEN, query as never), null);
  assert.equal(
    await loadAccountExtrinsicsColdTier(TOKEN, "invalid", { limit: 1 }),
    null,
  );
  assert.equal(native.feed.mock.calls.length, 0);
});
test("missing qualification and failed indexes decline rather than falling back to SQL or returning absence", async () => {
  for (const value of [undefined, null]) {
    native.feed.mockResolvedValue(value);
    assert.equal(await loadExtrinsicFeedColdTier(TOKEN, { limit: 2 }), null);
    assert.equal(
      await loadAccountExtrinsicsColdTier(TOKEN, SIGNER, { limit: 2 }),
      null,
    );
  }
  nativeRows([]);
  assert.deepEqual(
    await loadExtrinsicFeedColdTier(TOKEN, { limit: 2 }),
    buildExtrinsicFeed([], { limit: 2, offset: 0, nextCursor: null }),
  );
});
describe("loadExtrinsicFeedColdTier -- the hot head", () => {
  const hotRow = (block: number, index = 0, over = {}) => ({
    block_number: block,
    extrinsic_index: index,
    extrinsic_hash: `0x${block.toString(16).padStart(64, "0")}`,
    signer: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
    call_module: "SubtensorModule",
    call_function: "set_weights",
    success: true,
    fee_tao: 0,
    tip_tao: 0,
    call_args: "{}",
    observed_at: 1_700_000_000_000 + block,
    ...over,
  });

  function store(rows: Record<string, unknown>[]) {
    const seen: string[] = [];
    pg.control.queries.length = 0;
    pg.control.answers = [];
    pg.control.rows = null;
    pg.control.failNext = null;
    pg.control.onQuery = ({ text }) => {
      seen.push(text);
      pg.control.rows = rows;
    };
    return { seen, env: { ...TOKEN, ...pgMockEnv() } as never };
  }

  test("A FULL PAGE COMES FROM THE HOT STORE, with no lakehouse query", async () => {
    const q = nativeRows([]);
    const { seen, env } = store([hotRow(900), hotRow(899)]);
    // `loadExtrinsicFeedColdTier` returns the BUILT feed, not the raw page --
    // `buildExtrinsicFeed` is what shapes it, so assert on what callers see.
    const page = await loadExtrinsicFeedColdTier(env, { limit: 2 });
    assert.ok(page);
    assert.equal(page.extrinsics.length, 2);
    assert.equal(q.length, 0, `expected no R2 SQL:\n${q.join("\n")}`);
    assert.match(
      seen[0]!,
      /ORDER BY observed_at DESC, block_number DESC, extrinsic_index DESC/,
      "the hot leg must use the feed's own composite order",
    );
  });

  test("A SHORT PAGE FALLS THROUGH -- it does not truncate the feed", async () => {
    const q = nativeRows([]);
    const { env } = store([hotRow(900)]);
    await loadExtrinsicFeedColdTier(env, { limit: 5 });
    assert.equal(native.feed.mock.calls.length, 1, "expected the indexed read");
    assert.equal(q.length, 0);
  });

  test("AN OFFSET PAGE IS NOT SERVED from the hot store", async () => {
    // `offset > 0` means a deep walk, and the over-fetch-then-slice trade the
    // lakehouse leg makes exists only because R2 SQL has no OFFSET. Repeating
    // it here would pull the same rows through a second store for no gain.
    const q = nativeRows([]);
    const { seen, env } = store([hotRow(900), hotRow(899), hotRow(898)]);
    await loadExtrinsicFeedColdTier(env, { limit: 2, offset: 1 });
    assert.equal(seen.length, 0, "the hot store was asked for an offset page");
    assert.equal(native.feed.mock.calls.length, 1);
    assert.equal(q.length, 0);
  });

  test("THE CURSOR SEEKS ON the complete strict tuple the token encodes", async () => {
    // Extrinsics share a block, so no prefix of the composite key is a total
    // order -- and the public token leads with `observed_at`. A hot leg seeking
    // on anything else would mis-page against the lakehouse leg's own tokens.
    const { env } = store([hotRow(900), hotRow(899)]);
    nativeRows([]);
    const first = await loadExtrinsicFeedColdTier(env, { limit: 2 });
    assert.ok(first?.next_cursor, "a full page must paginate");

    const second = store([hotRow(898), hotRow(897)]);
    nativeRows([]);
    await loadExtrinsicFeedColdTier(second.env, {
      limit: 2,
      cursor: first.next_cursor,
    });
    assert.match(
      second.seen[0]!,
      /\(observed_at, block_number, extrinsic_index\) < \(\$\d, \$\d, \$\d\)/,
    );
  });

  test("EVERY FILTER IS APPLIED IN THE QUERY", async () => {
    const { seen, env } = store([hotRow(900)]);
    nativeRows([]);
    await loadExtrinsicFeedColdTier(env, {
      limit: 1,
      signer: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
      module: "SubtensorModule",
      callFunction: "set_weights",
      success: true,
    });
    for (const column of [
      "signer",
      "call_module",
      "call_function",
      "success",
    ]) {
      assert.match(seen[0]!, new RegExp(`${column} = \\$\\d`), column);
    }
  });

  test("AN UNUSABLE ARGUMENT REFUSES, and issues no query", async () => {
    // `loadExtrinsicsHeadHotTier` is EXPORTED, so "the one caller already
    // validated it" is a property of today's code and not of the function.
    // An INVERTED window is in here too: it matches nothing at any height, so
    // refusing beats asking a question whose answer is already known.
    pg.control.queries.length = 0;
    pg.control.onQuery = () => {
      pg.control.rows = [];
    };
    const env = pgMockEnv();
    for (const [label, opts] of [
      ["zero limit", { limit: 0, ceilingObservedAt: null }],
      ["NaN limit", { limit: Number.NaN, ceilingObservedAt: null }],
      ["unusable ceiling", { limit: 5, ceilingObservedAt: Number.NaN }],
      [
        "unusable block_start",
        { limit: 5, ceilingObservedAt: null, blockStart: Number.NaN },
      ],
      [
        "unusable block_end",
        { limit: 5, ceilingObservedAt: null, blockEnd: Number.NaN },
      ],
      [
        "inverted window",
        { limit: 5, ceilingObservedAt: null, blockStart: 500, blockEnd: 100 },
      ],
      [
        "invalid block",
        { limit: 5, ceilingObservedAt: null, block: Number.NaN },
      ],
      [
        "invalid time floor",
        { limit: 5, ceilingObservedAt: null, floorObservedAt: -1 },
      ],
      [
        "non-array cursor",
        { limit: 5, ceilingObservedAt: null, cursor: "bad" as never },
      ],
      [
        "short cursor",
        { limit: 5, ceilingObservedAt: null, cursor: [] as never },
      ],
      [
        "invalid cursor cell",
        { limit: 5, ceilingObservedAt: null, cursor: [1, -1, 0] },
      ],
      ["empty signer", { limit: 5, ceilingObservedAt: null, signer: "" }],
      [
        "non-boolean success",
        { limit: 5, ceilingObservedAt: null, success: "yes" as never },
      ],
    ] as [string, Parameters<typeof loadExtrinsicsHeadHotTier>[1]][]) {
      assert.equal(
        await loadExtrinsicsHeadHotTier(env, opts),
        null,
        `${label} must be refused`,
      );
    }
    assert.equal(
      pg.control.queries.length,
      0,
      "an unusable argument reached the store",
    );
  });

  test("A VALID BLOCK WINDOW IS APPLIED, not dropped", async () => {
    // The first version of this leg ignored `block_start`/`block_end` entirely,
    // which is a WRONG ANSWER rather than a slow one: a windowed request would
    // have been handed the newest N regardless of the window.
    const { seen, env } = store([hotRow(900)]);
    nativeRows([]);
    await loadExtrinsicFeedColdTier(env, {
      limit: 1,
      blockStart: 100,
      blockEnd: 900,
    });
    assert.match(seen[0]!, /block_number >= \$\d/);
    assert.match(seen[0]!, /block_number <= \$\d/);
  });

  test("ANOTHER NETWORK never reads mainnet's hot store", async () => {
    nativeRows([]);
    const { seen, env } = store([hotRow(900), hotRow(899)]);
    await loadExtrinsicFeedColdTier(env, { limit: 2 }, "testnet");
    assert.equal(seen.length, 0, "mainnet's hot store was asked for testnet");
  });
});

test("the hot tier receives the same bounded observation window", async () => {
  await loadExtrinsicFeedColdTier(TOKEN, { limit: 2, from: 100, to: 200 });
  assert.equal(native.feed.mock.calls[0][1].observedStart, 100);
  assert.equal(native.feed.mock.calls[0][1].observedEnd, 200);
});
