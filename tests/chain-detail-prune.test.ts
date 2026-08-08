// Retention for the chain-detail hot tier (#9208).
//
// The rule that matters is not "6 hours". It is that the retained depth FOLLOWS
// THE SEAM: a fixed window would drop rows the lakehouse has not absorbed the
// moment the decode lane fell behind, and every block in between would start
// declining -- the prune would manufacture the exact gap the tier exists to
// close. The floor and the ceiling are the two ends of that adaptation.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
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

beforeEach(() => resetDecodeWatermarkCache());

function fakeDb(
  bounds: { floor: number | null; head: number | null } | Error,
  opts: { batchThrows?: boolean } = {},
) {
  const deletes: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(raw: string) {
      const sql = raw.replace(/\s+/g, " ").trim();
      return {
        bind(...params: unknown[]) {
          const record = { sql, params };
          deletes.push(record);
          return record as never;
        },
        async first() {
          if (bounds instanceof Error) throw bounds;
          return bounds;
        },
      };
    },
    async batch(slice: unknown[]) {
      if (opts.batchThrows) throw new Error("d1 delete failed");
      return slice.map(() => ({}));
    },
  };
  return { env: { METAGRAPH_HEALTH_DB: db }, deletes };
}

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

  test("but never past the 24h ceiling -- D1 is not the archive", () => {
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
  test("deletes below the window, from all four tables, in one batch", async () => {
    const head = SEAM + 5_000;
    const { env, deletes } = fakeDb({ floor: head - 6_000, head });
    const result = await pruneChainDetail(env);
    assert.equal(result.ok, true);
    // The seam is 5,000 blocks back, past the 6h floor, so the seam binds.
    assert.equal(result.retained_blocks, 5_000);
    // Bounded per run: 120 blocks up from the floor, not the whole 1,000-block
    // backlog in a single D1 transaction.
    assert.equal(result.blocks_pruned, CHAIN_DETAIL_PRUNE_MAX_BLOCKS_PER_RUN);
    assert.equal(result.deleted_below, head - 6_000 + 120);

    const tables = deletes
      .filter((d) => d.sql.startsWith("DELETE"))
      .map((d) => /DELETE FROM (\w+)/.exec(d.sql)?.[1]);
    assert.deepEqual(tables, [
      "chain_detail_extrinsics",
      "chain_detail_chain_events",
      "chain_detail_account_events",
      // The coverage register goes LAST, so a reader landing mid-prune sees a
      // short list rather than a decline.
      "chain_detail_blocks",
    ]);
    for (const del of deletes.filter((d) => d.sql.startsWith("DELETE")))
      assert.deepEqual(del.params, [head - 6_000 + 120]);
  });

  test("a tier already inside its window deletes nothing", async () => {
    const head = SEAM + 500;
    const { env, deletes } = fakeDb({ floor: head - 100, head });
    const result = await pruneChainDetail(env);
    assert.equal(result.ok, true);
    assert.equal(result.blocks_pruned, 0);
    assert.equal(deletes.filter((d) => d.sql.startsWith("DELETE")).length, 0);
  });

  test("a run smaller than the per-run cap deletes exactly the backlog", async () => {
    const head = SEAM + 2_000;
    // The seam binds at 2,000 blocks, so everything below SEAM+1 goes: the
    // floor sits 30 blocks under the seam, and the seam block itself is kept
    // (one block of deliberate overlap), for 31 removed in one run.
    const { env } = fakeDb({ floor: head - 2_030, head });
    const result = await pruneChainDetail(env);
    assert.equal(result.blocks_pruned, 31);
    assert.equal(result.deleted_below, SEAM + 1);
  });

  test("an empty tier is a successful no-op, not a failure", async () => {
    const { env } = fakeDb({ floor: null, head: null });
    assert.deepEqual(await pruneChainDetail(env), {
      ok: true,
      reason: "no rows",
      blocks_pruned: 0,
    });
  });

  test("an unparseable bound is treated as no rows, never as block 0", async () => {
    // Number("") is 0 and Number("x") is NaN; deleting "everything below 0" is
    // harmless but deleting on a NaN-derived bound is not, so an unusable
    // aggregate stops the run rather than producing a cutoff.
    const { env, deletes } = fakeDb({
      floor: "not-a-number",
      head: 9_000_000,
    } as never);
    const result = await pruneChainDetail(env);
    assert.equal(result.ok, true);
    assert.equal(result.reason, "no rows");
    assert.equal(deletes.filter((d) => d.sql.startsWith("DELETE")).length, 0);
  });

  test("an unbound D1 and a failing query both report rather than throw", async () => {
    assert.deepEqual(await pruneChainDetail({}), {
      ok: false,
      reason: "d1 binding unavailable",
    });
    assert.deepEqual(await pruneChainDetail(null), {
      ok: false,
      reason: "d1 binding unavailable",
    });
    assert.deepEqual(
      await pruneChainDetail({ METAGRAPH_HEALTH_DB: { prepare() {} } }),
      { ok: false, reason: "d1 binding unavailable" },
    );

    const failing = fakeDb(new Error("bounds query failed"));
    const result = await pruneChainDetail(failing.env);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "prune_failed");
    assert.equal(result.detail, "bounds query failed");
  });

  test("a failing DELETE batch reports rather than throwing", async () => {
    const head = SEAM + 5_000;
    const { env } = fakeDb(
      { floor: head - 6_000, head },
      { batchThrows: true },
    );
    const result = await pruneChainDetail(env);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "prune_failed");
  });

  test("a non-Error throw still reports, with no detail invented", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind: () => ({}),
            first() {
              throw "string thrown";
            },
          };
        },
        async batch() {
          return [];
        },
      },
    };
    const result = await pruneChainDetail(env);
    assert.equal(result.ok, false);
    assert.equal(result.detail, undefined);
  });
});

describe("the Neon side of the prune (#10017)", () => {
  /** A D1 double that reports a wide window, so a real prune always runs. */
  function d1WithWindow(floor: number, head: number) {
    const deleted: unknown[] = [];
    return {
      deleted,
      binding: {
        prepare: (sql: string) => ({
          bind: (...v: unknown[]) => {
            deleted.push({ sql, v });
            return { sql, v };
          },
          first: async () => ({ floor, head }),
        }),
        batch: async (s: unknown[]) => s,
      },
    };
  }

  const NEON_LANES =
    "chain_detail_blocks,chain_detail_extrinsics," +
    "chain_detail_chain_events,chain_detail_account_events";

  test("Neon is pruned with the SAME bound D1 was, never a recomputed one", async () => {
    // The entire point of #10017. chainDetailPruneWindow derives an adaptive
    // BLOCK watermark from the head and the lakehouse seam; there is no
    // retentionMs that reproduces it, so a per-store recomputation would drift
    // and the drift is invisible -- a wider Neon window is a permanent parity
    // surplus, a narrower one is silent coverage loss at the seam.
    const d1 = d1WithWindow(1, 10_000_000);
    const seen: { text: string; values: unknown[] }[] = [];
    const result = await pruneChainDetail(
      {
        METAGRAPH_HEALTH_DB: d1.binding,
        HYPERDRIVE: { connectionString: "postgresql://example/db" },
        NEON_BACKFILL_LANES: NEON_LANES,
      },
      { waitUntil: () => undefined },
      {
        sql: {
          unsafe: async (text: string, values: unknown[] = []) => {
            seen.push({ text, values });
            return [];
          },
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.neon_pruned, true);
    // All four tables, and every one of them bound to the SAME number D1 used.
    assert.equal(seen.length, 4);
    for (const { text, values } of seen) {
      assert.match(
        text,
        /DELETE FROM chain_detail_\w+ WHERE block_number < \$1/,
      );
      assert.deepEqual(values, [result.deleted_below]);
    }
    // And it is a real bound, not a vacuous zero that would delete nothing.
    assert.ok((result.deleted_below ?? 0) > 1);
  });

  test("no Hyperdrive binding leaves the D1 prune untouched", async () => {
    const d1 = d1WithWindow(1, 10_000_000);
    const result = await pruneChainDetail(
      { METAGRAPH_HEALTH_DB: d1.binding, NEON_BACKFILL_LANES: NEON_LANES },
      { waitUntil: () => undefined },
    );
    assert.equal(result.ok, true);
    assert.equal(result.neon_pruned, undefined);
    assert.ok((result.blocks_pruned ?? 0) > 0);
  });

  test("ONE unreconciled table skips the Neon prune entirely", async () => {
    // All four or none. They are pruned to a single watermark, so a
    // partially-listed set would leave one table holding blocks its siblings
    // dropped -- a join across the seam then finds a block header with no
    // events, which reads as corruption rather than as retention.
    const d1 = d1WithWindow(1, 10_000_000);
    const result = await pruneChainDetail(
      {
        METAGRAPH_HEALTH_DB: d1.binding,
        HYPERDRIVE: { connectionString: "postgresql://example/db" },
        NEON_BACKFILL_LANES:
          "chain_detail_blocks,chain_detail_extrinsics,chain_detail_chain_events",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(result.neon_pruned, undefined);
  });

  test("a SOLE-STORE table is still pruned, with nothing reconciling it", async () => {
    // The landmine the old gate was carrying (#10084). #10078 established that
    // a table leaves NEON_BACKFILL_LANES exactly when Neon becomes its sole
    // store -- so a gate reading only the backfill lanes would switch this
    // prune off at the precise moment Neon held the only copy, and these four
    // tables would grow without bound with no second store to notice.
    const d1 = d1WithWindow(1, 10_000_000);
    const seen: string[] = [];
    const result = await pruneChainDetail(
      {
        METAGRAPH_HEALTH_DB: d1.binding,
        HYPERDRIVE: { connectionString: "postgresql://example/db" },
        // Reconciled by NOTHING, owned outright by Neon -- the endgame state.
        NEON_BACKFILL_LANES: "",
        NEON_SOLE_STORE_TABLES: NEON_LANES,
      },
      { waitUntil: () => undefined },
      {
        sql: {
          unsafe: async (text: string) => {
            seen.push(text);
            return [];
          },
        },
      },
    );
    assert.equal(result.neon_pruned, true);
    assert.equal(seen.length, 4);
  });

  test("neither reconciled nor owned still skips, so nothing connects for nothing", async () => {
    const d1 = d1WithWindow(1, 10_000_000);
    const result = await pruneChainDetail(
      {
        METAGRAPH_HEALTH_DB: d1.binding,
        HYPERDRIVE: { connectionString: "postgresql://example/db" },
        NEON_BACKFILL_LANES: "",
        NEON_SOLE_STORE_TABLES: "",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(result.neon_pruned, undefined);
    assert.ok((result.blocks_pruned ?? 0) > 0);
  });

  test("no ctx means no Neon prune, and D1 still runs", async () => {
    // createPgSql returns its connection via waitUntil; without somewhere to
    // park the teardown the connection would leak per tick.
    const d1 = d1WithWindow(1, 10_000_000);
    const result = await pruneChainDetail({
      METAGRAPH_HEALTH_DB: d1.binding,
      HYPERDRIVE: { connectionString: "postgresql://example/db" },
      NEON_BACKFILL_LANES: NEON_LANES,
    });
    assert.equal(result.ok, true);
    assert.equal(result.neon_pruned, undefined);
    assert.ok((result.blocks_pruned ?? 0) > 0);
  });
});
