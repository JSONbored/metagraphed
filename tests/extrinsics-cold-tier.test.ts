// Same two properties the blocks cold tier is held to, plus one specific to
// extrinsics:
//   1. NO SILENT WIDENING — a filter this tier cannot express must make the
//      whole query decline, never quietly return unfiltered rows.
//   2. PARITY — rows go through the shared src/extrinsics.ts formatters.
//   3. STABLE ORDER — two extrinsics share a block, so block_number alone is
//      not a total order; paging on it would repeat or drop rows.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadAccountExtrinsicsColdTier,
  loadBlockExtrinsicsColdTier,
  loadExtrinsicColdTier,
  loadExtrinsicFeedColdTier,
} from "../src/extrinsics-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

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
  test("orders by (block, index) so paging cannot repeat or drop rows", async () => {
    const q = sqlFetch([row(10, 1), row(10, 0)]);
    const data = await loadExtrinsicFeedColdTier(TOKEN as never, { limit: 2 });
    assert.equal(data!.extrinsics.length, 2);
    assert.match(
      q[0]!,
      /ORDER BY block_number DESC, extrinsic_index DESC/,
      "block_number alone is not a total order here",
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
      cursor: 950,
    });
    const s = q[0]!;
    assert.match(s, new RegExp(`signer = '${SIGNER}'`));
    assert.match(s, /call_module = 'SubtensorModule'/);
    assert.match(s, /call_function = 'set_weights'/);
    assert.match(s, /success = TRUE/);
    assert.match(s, /block_number >= 100/);
    assert.match(s, /block_number <= 900/);
    assert.match(s, /block_number < 950/);
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

  test("a full page carries a cursor, a short page does not", async () => {
    sqlFetch([row(9), row(8)]);
    const full = await loadExtrinsicFeedColdTier(TOKEN as never, { limit: 2 });
    assert.equal(full!.next_cursor, "8");

    sqlFetch([row(9)]);
    const short = await loadExtrinsicFeedColdTier(TOKEN as never, { limit: 5 });
    assert.equal(short!.next_cursor ?? null, null);
  });

  test("an invalid limit or cursor declines", async () => {
    sqlFetch([]);
    for (const bad of [
      { limit: 0 },
      { limit: "x" },
      { limit: 5, cursor: "junk" },
      { limit: 5, offset: "x" },
    ]) {
      assert.equal(
        await loadExtrinsicFeedColdTier(TOKEN as never, bad as never),
        null,
        JSON.stringify(bad),
      );
    }
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
    sqlFetch([{ ...row(9), block_number: "not-a-height" }]);
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
          amount_tao: "1000000",
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
    const q = sqlFetch([{ ...row(4, 0), block_number: "bad" }]);
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
