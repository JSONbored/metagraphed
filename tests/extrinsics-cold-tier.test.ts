// Same two properties the blocks cold tier is held to, plus one specific to
// extrinsics:
//   1. NO SILENT WIDENING — a filter this tier cannot express must make the
//      whole query decline, never quietly return unfiltered rows.
//   2. PARITY — rows go through the shared src/extrinsics.ts formatters.
//   3. STABLE ORDER — two extrinsics share a block, so block_number alone is
//      not a total order; paging on it would repeat or drop rows.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { loadExtrinsicsHeadHotTier } from "../src/chain-detail-hot-tier.ts";

// The head leg reads `chain_detail_extrinsics` through src/read-store.ts,
// which builds `new Client(...)` itself -- so the module is the seam.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
import {
  loadAccountExtrinsicsColdTier,
  loadBlockExtrinsicsColdTier,
  loadExtrinsicColdTier,
  loadExtrinsicFeedColdTier,
} from "../src/extrinsics-cold-tier.ts";
import { R2_SQL_TOKEN_ENV, r2SqlQuery } from "../src/r2-sql.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };
const SIGNER = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

function row(block: number, index = 0) {
  return {
    block_number: block,
    extrinsic_index: index,
    extrinsic_hash: `0xabc${block}${index}`,
    signer: SIGNER,
    call_module: "SubtensorModule",
    call_function: "set_weights",
    success: true,
    fee_tao: null,
    tip_tao: null,
    call_args: null,
    observed_at: 1_700_000_000_000 + block,
  };
}

/** Captures every query issued, which is what the filter assertions check. */
function sqlFetch(...responses: unknown[][]) {
  const queries: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    const rows = responses[Math.min(call, responses.length - 1)] ?? [];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

describe("loadExtrinsicFeedColdTier", () => {
  test("orders by the Postgres tier's exact composite key", async () => {
    const q = sqlFetch([row(10, 1), row(10, 0)]);
    const data = await loadExtrinsicFeedColdTier(TOKEN as never, { limit: 2 });
    assert.equal(data!.extrinsics.length, 2);
    // The cursor token encodes this key, so the order must match data-api
    // EXACTLY or tokens mis-seek across tiers -- and no prefix of it is a
    // total order on its own (extrinsics share a block).
    assert.match(
      q[0]!,
      /ORDER BY observed_at DESC, block_number DESC, extrinsic_index DESC/,
    );
  });

  test("applies every supported filter as a validated literal", async () => {
    const q = sqlFetch([row(5)]);
    await loadExtrinsicFeedColdTier(TOKEN as never, {
      limit: 5,
      signer: SIGNER,
      module: "SubtensorModule",
      callFunction: "set_weights",
      success: true,
      blockStart: 100,
      blockEnd: 900,
      from: 1_700_000_000_000,
      to: 1_800_000_000_000,
      block: 555,
      cursor: "1700000000950.950.2",
    });
    const s = q[0]!;
    assert.match(s, new RegExp(`signer = '${SIGNER}'`));
    assert.match(s, /call_module = 'SubtensorModule'/);
    assert.match(s, /call_function = 'set_weights'/);
    assert.match(s, /success = TRUE/);
    assert.match(s, /block_number = 555/);
    assert.match(s, /block_number >= 100/);
    assert.match(s, /block_number <= 900/);
    assert.match(s, /observed_at >= 1700000000000/);
    assert.match(s, /observed_at <= 1800000000000/);
    // The EXACT tuple seek data-api issues for the same token.
    assert.match(
      s,
      /\(observed_at, block_number, extrinsic_index\) < \(1700000000950, 950, 2\)/,
    );
  });

  test("DECLINES an unsafe signer instead of scanning every signer", async () => {
    const q = sqlFetch([row(1)]);
    const data = await loadExtrinsicFeedColdTier(TOKEN as never, {
      limit: 5,
      signer: "'; DROP TABLE chain.extrinsics; --",
    });
    assert.equal(data, null);
    assert.equal(q.length, 0, "no query issued at all");
  });

  test("DECLINES an unsafe module or call name", async () => {
    for (const bad of [
      { module: "Sub; DROP" },
      { callFunction: "set weights" },
      { module: 42 },
    ]) {
      const q = sqlFetch([row(1)]);
      assert.equal(
        await loadExtrinsicFeedColdTier(
          TOKEN as never,
          {
            limit: 5,
            ...bad,
          } as never,
        ),
        null,
        JSON.stringify(bad),
      );
      assert.equal(q.length, 0);
    }
  });

  test("a non-boolean success filter declines rather than inverting itself", async () => {
    // Truthiness would make the STRING "false" mean success = TRUE, silently
    // returning the exact opposite of what was asked for.
    const q = sqlFetch([row(1)]);
    assert.equal(
      await loadExtrinsicFeedColdTier(
        TOKEN as never,
        {
          limit: 5,
          success: "false",
        } as never,
      ),
      null,
    );
    assert.equal(q.length, 0);
  });

  test("emulates OFFSET by over-fetch and slice, and refuses a deep one", async () => {
    const q = sqlFetch([row(9), row(8), row(7), row(6)]);
    const data = await loadExtrinsicFeedColdTier(TOKEN as never, {
      limit: 2,
      offset: 2,
    });
    assert.match(q[0]!, /LIMIT 4/);
    assert.ok(!/OFFSET/i.test(q[0]!), "never emits an OFFSET clause");
    assert.equal(data!.extrinsics[0]!.block_number, 7);

    const q2 = sqlFetch([]);
    assert.equal(
      await loadExtrinsicFeedColdTier(TOKEN as never, {
        limit: 5,
        offset: 100_000,
      }),
      null,
    );
    assert.equal(q2.length, 0);
  });

  test("a full page carries the Postgres tier's own token format", async () => {
    sqlFetch([row(9), row(8)]);
    const full = await loadExtrinsicFeedColdTier(TOKEN as never, { limit: 2 });
    // observed_at.block_number.extrinsic_index -- the same dot-joined token
    // data-api emits, so paging survives a tier transition in either direction.
    assert.equal(full!.next_cursor, "1700000000008.8.0");

    sqlFetch([row(9)]);
    const short = await loadExtrinsicFeedColdTier(TOKEN as never, { limit: 5 });
    assert.equal(short!.next_cursor ?? null, null);
  });

  test("an invalid limit or offset declines", async () => {
    sqlFetch([]);
    for (const bad of [
      { limit: 0 },
      { limit: "x" },
      { limit: 5, offset: "x" },
    ]) {
      assert.equal(
        await loadExtrinsicFeedColdTier(TOKEN as never, bad as never),
        null,
        JSON.stringify(bad),
      );
    }
  });

  test("a malformed cursor token means page 1 -- the Postgres tier's exact behavior", async () => {
    // decodeCursor(junk) -> null -> no cursor, identical to data-api. Parity
    // demands the SAME page for the SAME request on either tier, so this must
    // not decline.
    const q = sqlFetch([row(9)]);
    const data = await loadExtrinsicFeedColdTier(TOKEN as never, {
      limit: 5,
      cursor: "junk",
    });
    assert.ok(data);
    assert.ok(!/junk/.test(q[0]!), "the bad token never reaches the SQL");
    assert.ok(
      !/</.test(q[0]!.split("ORDER BY")[0]!.replace(/block_number <= /g, "")),
      "no seek predicate for an unusable token",
    );
  });

  test("a cursor page ignores offset, mirroring data-api", async () => {
    const q = sqlFetch([row(9), row(8)]);
    const data = await loadExtrinsicFeedColdTier(TOKEN as never, {
      limit: 2,
      offset: 5,
      cursor: "1700000000009.9.0",
    });
    assert.match(q[0]!, /LIMIT 2/, "no over-fetch on a cursor page");
    assert.equal(data!.extrinsics.length, 2);
  });

  test("success = false is expressed, not dropped", async () => {
    const q = sqlFetch([row(3)]);
    await loadExtrinsicFeedColdTier(TOKEN as never, {
      limit: 5,
      success: false,
    });
    assert.match(q[0]!, /success = FALSE/);
  });

  test("an unparseable block range declines rather than dropping it", async () => {
    for (const bad of [{ blockStart: "abc" }, { blockEnd: -3 }]) {
      const q = sqlFetch([row(1)]);
      assert.equal(
        await loadExtrinsicFeedColdTier(
          TOKEN as never,
          {
            limit: 5,
            ...bad,
          } as never,
        ),
        null,
        JSON.stringify(bad),
      );
      assert.equal(q.length, 0);
    }
  });

  test("a full page whose last row has no usable height carries no cursor", async () => {
    // `null`, not "not-a-height": the catalog types block_number as a long, and
    // the read now VALIDATES against it, so a string there is a row the
    // lakehouse cannot produce. Null is both legal and unusable, which is what
    // this test is actually about.
    sqlFetch([{ ...row(9), block_number: null }]);
    const data = await loadExtrinsicFeedColdTier(TOKEN as never, { limit: 1 });
    assert.equal(
      data!.next_cursor ?? null,
      null,
      "never emit a cursor we cannot page on",
    );
  });

  test("a failed query yields null so the caller keeps its empty", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadExtrinsicFeedColdTier(TOKEN as never, { limit: 5 }),
      null,
    );
  });
});

describe("loadBlockExtrinsicsColdTier", () => {
  test("a numeric ref queries that block directly", async () => {
    const q = sqlFetch([row(8756998, 0), row(8756998, 1)]);
    const data = await loadBlockExtrinsicsColdTier(TOKEN as never, "8756998", {
      limit: 10,
    });
    assert.equal(data!.extrinsics.length, 2);
    assert.match(q[0]!, /block_number = 8756998/);
    assert.equal(q.length, 1, "no hash lookup needed for a height");
  });

  test("a hash ref resolves to a height first", async () => {
    const q = sqlFetch([{ block_number: 4242 }], [row(4242)]);
    const data = await loadBlockExtrinsicsColdTier(TOKEN as never, "0xdeadbe", {
      limit: 10,
    });
    assert.match(q[0]!, /FROM chain\.blocks WHERE block_hash = '0xdeadbe'/);
    assert.match(q[1]!, /block_number = 4242/);
    assert.equal(data!.extrinsics.length, 1);
  });

  test("an unresolvable ref declines without querying extrinsics", async () => {
    const q = sqlFetch([]);
    assert.equal(
      await loadBlockExtrinsicsColdTier(TOKEN as never, "'; DROP --", {
        limit: 10,
      }),
      null,
    );
    assert.equal(q.length, 0);
  });

  test("a failing extrinsics query declines even after the block resolved", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: { rows: [{ block_number: 7 }] },
          }),
        } as unknown as Response;
      }
      throw new Error("extrinsics query failed");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadBlockExtrinsicsColdTier(TOKEN as never, "0xaa11", { limit: 5 }),
      null,
    );
  });

  test("a failing hash resolve declines", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadBlockExtrinsicsColdTier(TOKEN as never, "0xbb22", { limit: 5 }),
      null,
    );
  });

  test("an unknown block hash declines rather than returning every extrinsic", async () => {
    const q = sqlFetch([]); // hash lookup finds nothing
    const data = await loadBlockExtrinsicsColdTier(TOKEN as never, "0xabc123", {
      limit: 10,
    });
    assert.equal(data, null);
    assert.equal(q.length, 1, "stopped after the failed hash resolve");
  });
});

describe("loadAccountExtrinsicsColdTier", () => {
  test("filters by signer", async () => {
    const q = sqlFetch([row(7)]);
    const data = await loadAccountExtrinsicsColdTier(TOKEN as never, SIGNER, {
      limit: 5,
    });
    assert.match(q[0]!, new RegExp(`signer = '${SIGNER}'`));
    assert.equal(data!.extrinsics.length, 1);
  });

  test("a failing query declines", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadAccountExtrinsicsColdTier(TOKEN as never, SIGNER, { limit: 5 }),
      null,
    );
  });

  test("an invalid address declines instead of scanning all signers", async () => {
    const q = sqlFetch([row(1)]);
    assert.equal(
      await loadAccountExtrinsicsColdTier(TOKEN as never, "not-an-address", {
        limit: 5,
      }),
      null,
    );
    assert.equal(q.length, 0);
  });
});

describe("loadExtrinsicColdTier", () => {
  /**
   * Issue every query but HOLD the extrinsic read open, so "was the events read
   * dispatched yet?" is answerable. A serial implementation cannot have issued
   * it -- it is still awaiting the row that names its key.
   */
  function gatedFetch() {
    const issued: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const sql = String(JSON.parse(String(init.body)).query);
      issued.push(sql);
      const events = sql.includes("account_events");
      if (!events) await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { rows: events ? [] : [row(500, 3)] },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { issued, release: () => release() };
  }

  test("a composite ref issues BOTH reads at once (#11420)", async () => {
    // Measured against production 2026-08-16, this route reported
    // `r2sql;dur=10768;desc="2 calls"` -- two SERIAL reads of a warehouse whose
    // per-query spread is 16.7x, for a key the ref already named.
    const { issued, release } = gatedFetch();
    const pending = loadExtrinsicColdTier(TOKEN as never, "500-3");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(
      issued.length,
      2,
      "both reads must be in flight while the first is still unresolved",
    );
    assert.ok(
      issued.some((q) => q.includes("account_events")),
      "the events read is the one that must not wait",
    );
    release();
    assert.ok(await pending);
  });

  test("a HASH ref stays serial -- its key is what the first read is FOR", async () => {
    // The counterpart control: without it, "issue both" could be implemented by
    // guessing a key, and this test is what makes that impossible to ship.
    const { issued, release } = gatedFetch();
    const pending = loadExtrinsicColdTier(
      TOKEN as never,
      `0x${"ab".repeat(32)}`,
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(
      issued.length,
      1,
      "the events read cannot be issued before the row names its block/index",
    );
    release();
    assert.ok(await pending);
  });

  test("r2SqlQuery DECLINES rather than rejecting, so no catch is owed", async () => {
    // Why `loadExtrinsicColdTier` starts the events read without a `.catch`
    // even though two paths return before awaiting it. This is the fact that
    // makes a floating promise safe, and it is asserted rather than assumed --
    // the first version of this test went through the loader instead and
    // passed with the catch REMOVED, proving nothing.
    const big = JSON.stringify({
      success: true,
      result: { rows: [{ padding: "x".repeat(4000) }] },
    });
    for (const [label, stub] of [
      [
        "a fetch that throws",
        async () => {
          throw new Error("network down");
        },
      ],
      ["a body over the cap", async () => new Response(big, { status: 200 })],
    ] as const) {
      globalThis.fetch = stub as unknown as typeof fetch;
      assert.equal(
        await r2SqlQuery(
          { ...TOKEN, R2_SQL_MAX_BODY_BYTES: 128 } as never,
          "SELECT 1",
        ),
        null,
        `${label} must decline, not reject`,
      );
    }
  });

  test("resolves a composite <block>-<index> id and embeds its events", async () => {
    const q = sqlFetch(
      [row(500, 3)],
      [
        {
          block_number: 500,
          event_index: 0,
          extrinsic_index: 3,
          event_kind: "Transfer",
          hotkey: null,
          coldkey: SIGNER,
          netuid: null,
          uid: null,
          // A double in the catalog, and production serves 0 / 4.99 -- the
          // string here described a row R2 SQL does not emit.
          amount_tao: 1_000_000,
          alpha_amount: null,
          observed_at: 1_700_000_000_500,
        },
      ],
    );
    const data = await loadExtrinsicColdTier(TOKEN as never, "500-3");
    assert.match(q[0]!, /block_number = 500 AND extrinsic_index = 3/);
    assert.match(q[1]!, /FROM chain\.account_events/);
    assert.match(q[1]!, /event_kind/, "selects the REAL event columns");
    assert.match(q[1]!, /LIMIT 50/, "event embedding stays bounded");
    assert.equal(data!.extrinsic!.block_number, 500);
    assert.equal(data!.events.length, 1);
    // Formatted through formatAccountEvent, not embedded raw.
    const ev = data!.events[0] as Record<string, unknown>;
    assert.equal(ev.event_kind, "Transfer");
  });

  test("resolves by hash", async () => {
    const q = sqlFetch([row(11, 2)], []);
    await loadExtrinsicColdTier(TOKEN as never, "0xFEED");
    assert.match(q[0]!, /extrinsic_hash = '0xfeed'/);
  });

  test("a confirmed absence is the shared payload, not null", async () => {
    sqlFetch([]);
    const data = await loadExtrinsicColdTier(TOKEN as never, "999-0");
    assert.ok(data, "an absence is an answer");
    assert.equal(data!.extrinsic ?? null, null);
  });

  test("failing events still return the extrinsic", async () => {
    // The extrinsic resolved; withholding it because a secondary lookup failed
    // would lose data the caller already has a shape for.
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: { rows: [row(12, 0)] },
          }),
        } as unknown as Response;
      }
      throw new Error("events query failed");
    }) as unknown as typeof fetch;
    const data = await loadExtrinsicColdTier(TOKEN as never, "12-0");
    assert.equal(data!.extrinsic!.block_number, 12);
    assert.deepEqual(data!.events, []);
  });

  test("a composite id beyond safe integer range declines", async () => {
    const q = sqlFetch([]);
    assert.equal(
      await loadExtrinsicColdTier(TOKEN as never, "99999999999999999999-0"),
      null,
      "a height that cannot round-trip would address the wrong extrinsic",
    );
    assert.equal(q.length, 0);
  });

  test("a row with no usable identity skips the event lookup", async () => {
    const q = sqlFetch([{ ...row(4, 0), block_number: null }]);
    const data = await loadExtrinsicColdTier(TOKEN as never, "0xcc33");
    assert.equal(
      q.length,
      1,
      "no second query without a usable (block, index)",
    );
    assert.deepEqual(data!.events, []);
  });

  test("refuses a ref that is neither a composite id nor a hash", async () => {
    const q = sqlFetch([]);
    assert.equal(await loadExtrinsicColdTier(TOKEN as never, "nonsense"), null);
    assert.equal(q.length, 0);
  });

  test("a failed lookup yields null, not a false absence", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(await loadExtrinsicColdTier(TOKEN as never, "1-0"), null);
  });
});

/**
 * The head of the recent-extrinsic feed, from Neon instead of the lakehouse.
 *
 * Measured live 2026-08-17: `/api/v1/extrinsics?limit=11` spent 7,637ms in the
 * lakehouse (`server-timing: r2sql;dur=7637`) for a page that is one index scan
 * here -- 0.088ms, off the `observed_at` index migration 0017 added for the
 * freshness probe, which already presorts this feed's leading key.
 */
describe("loadExtrinsicFeedColdTier -- the Neon head", () => {
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

  test("A FULL PAGE COMES FROM NEON, with no lakehouse query", async () => {
    const q = sqlFetch([]);
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
    const q = sqlFetch([]);
    const { env } = store([hotRow(900)]);
    await loadExtrinsicFeedColdTier(env, { limit: 5 });
    assert.ok(q.length > 0, "expected the lakehouse read");
  });

  test("AN OFFSET PAGE IS NOT SERVED from the hot store", async () => {
    // `offset > 0` means a deep walk, and the over-fetch-then-slice trade the
    // lakehouse leg makes exists only because R2 SQL has no OFFSET. Repeating
    // it here would pull the same rows through a second store for no gain.
    const q = sqlFetch([]);
    const { seen, env } = store([hotRow(900), hotRow(899), hotRow(898)]);
    await loadExtrinsicFeedColdTier(env, { limit: 2, offset: 1 });
    assert.equal(seen.length, 0, "the hot store was asked for an offset page");
    assert.ok(q.length > 0);
  });

  test("THE CURSOR SEEKS ON observed_at, the key the token encodes", async () => {
    // Extrinsics share a block, so no prefix of the composite key is a total
    // order -- and the public token leads with `observed_at`. A hot leg seeking
    // on anything else would mis-page against the lakehouse leg's own tokens.
    const { env } = store([hotRow(900), hotRow(899)]);
    sqlFetch([]);
    const first = await loadExtrinsicFeedColdTier(env, { limit: 2 });
    assert.ok(first?.next_cursor, "a full page must paginate");

    const second = store([hotRow(898), hotRow(897)]);
    sqlFetch([]);
    await loadExtrinsicFeedColdTier(second.env, {
      limit: 2,
      cursor: first.next_cursor,
    });
    assert.match(second.seen[0]!, /observed_at <= \$\d/);
  });

  test("EVERY FILTER IS APPLIED IN THE QUERY", async () => {
    const { seen, env } = store([hotRow(900)]);
    sqlFetch([]);
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
    sqlFetch([]);
    await loadExtrinsicFeedColdTier(env, {
      limit: 1,
      blockStart: 100,
      blockEnd: 900,
    });
    assert.match(seen[0]!, /block_number >= \$\d/);
    assert.match(seen[0]!, /block_number <= \$\d/);
  });

  test("ANOTHER NETWORK never reads mainnet's hot store", async () => {
    sqlFetch([]);
    const { seen, env } = store([hotRow(900), hotRow(899)]);
    await loadExtrinsicFeedColdTier(env, { limit: 2 }, "testnet");
    assert.equal(seen.length, 0, "mainnet's hot store was asked for testnet");
  });
});
