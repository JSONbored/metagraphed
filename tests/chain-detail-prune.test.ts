// Retention for the chain-detail hot tier (#9208).
//
// The rule that matters is not "6 hours". It is that the retained depth FOLLOWS
// THE SEAM: a fixed window would drop rows the lakehouse has not absorbed the
// moment the decode lane fell behind, and every block in between would start
// declining -- the prune would manufacture the exact gap the tier exists to
// close. The floor and the ceiling are the two ends of that adaptation.
//
// SINCE #10179 THERE IS ONE STORE. The prune used to have two halves: a
// `binding.batch()` of DELETEs against D1, and the same bound applied to Neon.
// D1 is gone, so the whole function is now "read the bound from Neon, apply it
// to Neon" -- which is why the tests that existed to prove the two stores could
// not disagree (a D1 prune surviving an absent Hyperdrive, a Neon prune skipped
// while D1 still ran) are gone with it. What survives is the part that was
// never about which store: the window, the per-run cap, and the all-or-nothing
// table set.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The bounds read goes through readStore, which builds `new Client(...)` from
// the `pg` module. Most tests below inject `deps.readDb` instead and never
// reach it; the two that deliberately do not are what this mock is for. See
// tests/helpers/pg-mock.ts for why it is a module mock built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  CHAIN_DETAIL_MAX_RETAINED_BLOCKS,
  CHAIN_DETAIL_MIN_RETAINED_BLOCKS,
  CHAIN_DETAIL_PRUNE_MAX_BLOCKS_PER_RUN,
  chainDetailPruneWindow,
  pruneChainDetail,
} from "../src/chain-detail-prune.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";
import { resetDecodeWatermarkCache } from "../src/decode-watermark.ts";

const SEAM = DEFAULT_BLOCKS_SEAM; // 8_759_336

const PRUNE_TABLES = [
  "chain_detail_extrinsics",
  "chain_detail_chain_events",
  "chain_detail_account_events",
  "chain_detail_blocks",
];

beforeEach(() => {
  resetDecodeWatermarkCache();
  pg.control.queries.length = 0;
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.onQuery = null;
});

/** An env in which Neon solely owns all four chain-detail tables, which is what
 * both readStore and the prune's own gate ask about. */
function owned(tables: readonly string[] = PRUNE_TABLES) {
  return { ...pgMockEnv(tables) };
}

/**
 * The bounds reader every number in this module is derived from (#10152).
 *
 * Injected rather than answered through the pg mock so each test's window is a
 * literal in the test that needs it; the two tests that want readStore's own
 * choice to run leave `readDb` out on purpose.
 */
function boundsReader(floor: unknown, head: unknown) {
  return { first: async () => ({ floor, head }) } as never;
}

/** A bounds reader whose MIN/MAX read fails, so the failure path is reachable. */
function throwingReader(thrown: unknown) {
  return {
    first: async () => {
      throw thrown;
    },
  } as never;
}

/** Records the DELETEs the prune issues, or fails them. */
function recorder(opts: { throws?: Error } = {}) {
  const seen: { text: string; values: unknown[] }[] = [];
  return {
    seen,
    /** The table each DELETE named, in issue order. */
    tables: () =>
      seen.map((d) => /DELETE FROM (\w+)/.exec(d.text)?.[1] ?? null),
    sql: {
      unsafe: async (text: string, values: unknown[] = []) => {
        if (opts.throws) throw opts.throws;
        seen.push({ text, values });
        return [];
      },
    },
  };
}

const CTX = { waitUntil: () => undefined };

describe("chainDetailPruneWindow", () => {
  test("a caught-up decoder retains the 6h floor, not less", () => {
    // Normal steady state: the seam is ~1h behind the head, well inside the
    // floor, so the floor is what binds.
    const window = chainDetailPruneWindow({ head: 1_000_000, seam: 999_700 });
    assert.equal(window.retainedBlocks, CHAIN_DETAIL_MIN_RETAINED_BLOCKS);
    assert.equal(window.keepFrom, 1_000_000 - 1_800 + 1);
  });

  test("a decoder that falls behind WIDENS the window rather than opening a gap", () => {
    // 3,000 blocks (~10h) uncovered: keeping only 6h here would drop rows the
    // lakehouse has not absorbed, and every block between would decline.
    const window = chainDetailPruneWindow({ head: 1_000_000, seam: 997_000 });
    assert.equal(window.retainedBlocks, 3_000);
    assert.equal(window.keepFrom, 997_001);
  });

  test("but never past the 24h ceiling -- the hot tier is not the archive", () => {
    const window = chainDetailPruneWindow({ head: 1_000_000, seam: 900_000 });
    assert.equal(window.retainedBlocks, CHAIN_DETAIL_MAX_RETAINED_BLOCKS);
    assert.equal(window.keepFrom, 1_000_000 - 7_200 + 1);
  });

  test("a seam AHEAD of the head still yields the floor, never a negative depth", () => {
    const window = chainDetailPruneWindow({ head: 1_000_000, seam: 1_000_500 });
    assert.equal(window.retainedBlocks, CHAIN_DETAIL_MIN_RETAINED_BLOCKS);
  });
});

describe("pruneChainDetail", () => {
  test("deletes below the window, from all four tables, register LAST", async () => {
    const head = SEAM + 5_000;
    const del = recorder();
    const result = await pruneChainDetail(owned(), CTX, {
      readDb: boundsReader(head - 6_000, head),
      sql: del.sql,
    });
    assert.equal(result.ok, true);
    // The seam is 5,000 blocks back, past the 6h floor, so the seam binds.
    assert.equal(result.retained_blocks, 5_000);
    // Bounded per run: 120 blocks up from the floor, not the whole 1,000-block
    // backlog in a single statement.
    assert.equal(result.blocks_pruned, CHAIN_DETAIL_PRUNE_MAX_BLOCKS_PER_RUN);
    assert.equal(result.deleted_below, head - 6_000 + 120);

    assert.deepEqual(del.tables(), [
      "chain_detail_extrinsics",
      "chain_detail_chain_events",
      "chain_detail_account_events",
      // The coverage register goes LAST, so a reader landing mid-prune sees a
      // short list rather than a decline.
      "chain_detail_blocks",
    ]);
    for (const { values } of del.seen)
      assert.deepEqual(values, [head - 6_000 + 120]);
  });

  test("a tier already inside its window deletes nothing", async () => {
    const head = SEAM + 500;
    const del = recorder();
    const result = await pruneChainDetail(owned(), CTX, {
      readDb: boundsReader(head - 100, head),
      sql: del.sql,
    });
    assert.equal(result.ok, true);
    assert.equal(result.blocks_pruned, 0);
    assert.deepEqual(del.seen, []);
  });

  test("a run smaller than the per-run cap deletes exactly the backlog", async () => {
    const head = SEAM + 2_000;
    // The seam binds at 2,000 blocks, so everything below SEAM+1 goes: the
    // floor sits 30 blocks under the seam, and the seam block itself is kept
    // (one block of deliberate overlap), for 31 removed in one run.
    const result = await pruneChainDetail(owned(), CTX, {
      readDb: boundsReader(head - 2_030, head),
      sql: recorder().sql,
    });
    assert.equal(result.blocks_pruned, 31);
    assert.equal(result.deleted_below, SEAM + 1);
  });

  test("an empty tier is a successful no-op, not a failure", async () => {
    assert.deepEqual(
      await pruneChainDetail(owned(), CTX, {
        readDb: boundsReader(null, null),
        sql: recorder().sql,
      }),
      { ok: true, reason: "no rows", blocks_pruned: 0 },
    );
  });

  test("an unparseable bound is treated as no rows, never as block 0", async () => {
    // Number("") is 0 and Number("x") is NaN; deleting "everything below 0" is
    // harmless but deleting on a NaN-derived bound is not, so an unusable
    // aggregate stops the run rather than producing a cutoff.
    const del = recorder();
    const result = await pruneChainDetail(owned(), CTX, {
      readDb: boundsReader("not-a-number", 9_000_000),
      sql: del.sql,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "no rows");
    assert.deepEqual(del.seen, []);
  });

  test("no store bound, and a failing bounds query, both report rather than throw", async () => {
    // Was "d1 binding unavailable". readStore is the gate now, and it declines
    // for three separate reasons -- no env, no Hyperdrive, and a table this
    // deployment has not declared Neon's -- all of which land here.
    assert.deepEqual(await pruneChainDetail({}), {
      ok: false,
      reason: "no store bound",
    });
    assert.deepEqual(await pruneChainDetail(null), {
      ok: false,
      reason: "no store bound",
    });
    assert.deepEqual(await pruneChainDetail({}), {
      ok: false,
      reason: "no store bound",
    });

    const result = await pruneChainDetail(owned(), CTX, {
      readDb: throwingReader(new Error("bounds query failed")),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "prune_failed");
    assert.equal(result.detail, "bounds query failed");
  });

  test("a failing DELETE is reported, never thrown, and never rethrown at D1", async () => {
    // The old shape of this test failed D1's `batch()` and expected the whole
    // tick to come back `prune_failed`. There is no D1 half to fail; the
    // surviving DELETE is Neon's, and it is swallowed on purpose -- see
    // pruneChainDetailNeon's header. A tick that could not delete is one missed
    // report with the reason attached, not an exception out of a cron.
    const head = SEAM + 5_000;
    const result = await pruneChainDetail(owned(), CTX, {
      readDb: boundsReader(head - 6_000, head),
      sql: recorder({ throws: new Error("neon delete failed") }).sql,
    });
    assert.equal(result.ok, true);
    assert.equal(result.neon_pruned, false);
    assert.equal(result.neon_detail, "neon delete failed");
  });

  test("a non-Error throw still reports, with no detail invented", async () => {
    const result = await pruneChainDetail(owned(), CTX, {
      readDb: throwingReader("string thrown"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.detail, undefined);
  });
});

describe("the bound the four tables share (#10017)", () => {
  test("every table is pruned to the SAME bound, never a recomputed one", async () => {
    // The entire point of #10017. chainDetailPruneWindow derives an adaptive
    // BLOCK watermark from the head and the lakehouse seam; there is no
    // retentionMs that reproduces it, so a per-table recomputation would drift
    // and the drift is invisible -- a wider window is a permanent parity
    // surplus, a narrower one is silent coverage loss at the seam.
    const del = recorder();
    const result = await pruneChainDetail(owned(), CTX, {
      readDb: boundsReader(1, 10_000_000),
      sql: del.sql,
    });
    assert.equal(result.ok, true);
    assert.equal(result.neon_pruned, true);
    assert.equal(del.seen.length, 4);
    for (const { text, values } of del.seen) {
      assert.match(
        text,
        /DELETE FROM chain_detail_\w+ WHERE block_number < \$1/,
      );
      assert.deepEqual(values, [result.deleted_below]);
    }
    // And it is a real bound, not a vacuous zero that would delete nothing.
    assert.ok((result.deleted_below ?? 0) > 1);
  });

  // "ONE table missing from the sole-store list declines the WHOLE prune" retired with NEON_SOLE_STORE_TABLES (#10051): Neon is the only
  // store, so the undeclared/partial state cannot exist; the binding pins
  // survive in this suite.

  test("a SOLE-STORE table is pruned with nothing reconciling it", async () => {
    // The landmine the old gate was carrying (#10084). #10078 established that
    // a table leaves NEON_BACKFILL_LANES exactly when Neon becomes its sole
    // store -- so a gate reading only the backfill lanes would switch this
    // prune off at the precise moment Neon held the only copy, and these four
    // tables would grow without bound with no second store to notice. #10166
    // then deleted the reconciler outright, which makes sole ownership the
    // ONLY state these tables are ever in.
    const del = recorder();
    const result = await pruneChainDetail(
      { ...owned(), NEON_BACKFILL_LANES: "" },
      CTX,
      { readDb: boundsReader(1, 10_000_000), sql: del.sql },
    );
    assert.equal(result.neon_pruned, true);
    assert.equal(del.seen.length, 4);
    assert.ok((result.blocks_pruned ?? 0) > 0);
  });

  test("the window comes from the store that holds the rows (#10152)", async () => {
    // No readDb injected on purpose: this is the one test where readStore's own
    // choice is what runs, so a reader wired to anything but the four
    // chain_detail tables fails here and nowhere else. Every number this
    // function derives comes from this single MIN/MAX, and when it was read
    // from a store that had stopped advancing the retention watermark was
    // pinned to a frozen floor while the tier it bounds grew without limit.
    pg.control.answers = [
      { match: "MIN(block_number)", rows: [{ floor: 1, head: 10_000_000 }] },
    ];
    const del = recorder();
    const result = await pruneChainDetail(owned(), CTX, { sql: del.sql });
    assert.equal(result.ok, true);
    assert.ok((result.blocks_pruned ?? 0) > 0);
    assert.equal(del.seen.length, 4);
    // One read, against the register, through the Postgres client.
    assert.equal(pg.control.queries.length, 1);
    assert.match(
      pg.control.queries[0]!.text,
      /SELECT MIN\(block_number\) AS floor, MAX\(block_number\) AS head FROM chain_detail_blocks/,
    );
  });

  test("an empty store is still 'no rows', not a failure", async () => {
    // A genuinely empty tier means the lane has not written yet, which is a
    // real state on a first deploy and must not alarm.
    const result = await pruneChainDetail(owned(), CTX, {
      readDb: boundsReader(null, null),
      sql: recorder().sql,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "no rows");
  });

  test("no ctx means no DELETE at all -- the connection has nowhere to be closed", async () => {
    // createPgSql returns its connection via waitUntil; without somewhere to
    // park the teardown the connection would leak per tick, so the prune skips
    // rather than leaking. The bounds read is unaffected -- readStore awaits its
    // own teardown and needs no ctx, which is the whole reason it exists.
    const result = await pruneChainDetail(owned(), undefined, {
      readDb: boundsReader(1, 10_000_000),
    });
    assert.equal(result.ok, true);
    assert.equal(result.neon_pruned, undefined);
  });
});
