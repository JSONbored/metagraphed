// The chain-detail hot tier and, more importantly, the routing around it
// (#9208).
//
// THE PROPERTY THIS FILE EXISTS FOR: a gap between the live-follow window and
// the decoded lakehouse must DECLINE. An empty extrinsics array is
// indistinguishable from a block that genuinely had none, and serving one for a
// block that has 47 is the bug the whole issue is about. Every "gap" assertion
// below is that property.
//
// The seam comes from src/blocks-cold-tier.ts's resolveBlocksSeam -- the SAME
// resolved watermark the cold tier routes on -- so these tests move the seam by
// publishing a watermark, never by introducing a second knob.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import {
  answerBlockDetail,
  answerExtrinsicDetail,
  chainDetailCoverage,
  chainDetailGapMessage,
  chainDetailHead,
  formatChainEvent,
  hotBlockNumber,
  isEmptyChainEventPayload,
  isEmptyEventPayload,
  isEmptyExtrinsicPayload,
  loadBlockChainEventsHotTier,
  loadBlockEventsHotTier,
  loadBlockExtrinsicsHotTier,
  loadExtrinsicHotTier,
} from "../src/chain-detail-hot-tier.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";
import { safeBlockNumber } from "../src/r2-sql.ts";
import {
  DECODE_WATERMARK_KEY,
  resetDecodeWatermarkCache,
} from "../src/decode-watermark.ts";

const SEAM = DEFAULT_BLOCKS_SEAM; // 8_759_336
const ABOVE = SEAM + 1_000; // a recent block, above the decoded seam
const BELOW = SEAM - 1_000; // history the lakehouse owns
const HASH = `0x${"ab".repeat(32)}`;
const XT_HASH = `0x${"cd".repeat(32)}`;

// The watermark memo is module state that outlives a test.
beforeEach(() => resetDecodeWatermarkCache());

type Handler = (
  sql: string,
  params: unknown[],
) => Record<string, unknown>[] | undefined;

/**
 * A D1 stub driven by a per-query handler, recording every statement. The
 * handler may THROW to fail one specific query (a mid-read D1 blip) and may
 * return undefined to hand back a result envelope with no `results` array at
 * all, which is what the binding does for a statement it could not shape.
 */
function d1(handler: Handler, opts: { throws?: boolean } = {}) {
  const seen: { sql: string; params: unknown[] }[] = [];
  return {
    seen,
    env: {
      METAGRAPH_HEALTH_DB: {
        prepare(raw: string) {
          const sql = raw.replace(/\s+/g, " ").trim();
          return {
            bind(...params: unknown[]) {
              seen.push({ sql, params });
              return {
                async all() {
                  if (opts.throws) throw new Error("d1 cold");
                  return { results: handler(sql, params) };
                },
              };
            },
          };
        },
      },
    },
  };
}

/** The coverage register carrying exactly these block heights. */
function registry(heights: number[], hashes: Record<string, number> = {}) {
  return (sql: string, params: unknown[]): Record<string, unknown>[] => {
    if (sql.startsWith("SELECT MIN(block_number)")) {
      if (!heights.length) return [{ floor: null, head: null, observed: null }];
      return [
        {
          floor: Math.min(...heights),
          head: Math.max(...heights),
          observed: 1_785_800_000_000,
        },
      ];
    }
    if (sql.includes("FROM chain_detail_blocks WHERE block_number = ?"))
      return heights.includes(params[0] as number)
        ? [{ block_number: params[0] }]
        : [];
    if (sql.includes("FROM chain_detail_blocks WHERE block_hash = ?")) {
      const height = hashes[String(params[0])];
      return height == null ? [] : [{ block_number: height }];
    }
    return [];
  };
}

function extrinsicRow(block: number, index = 0) {
  return {
    block_number: block,
    extrinsic_index: index,
    extrinsic_hash: XT_HASH,
    signer: "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM",
    call_module: "SubtensorModule",
    call_function: "set_weights",
    success: 1,
    fee_tao: "0.000002131419",
    tip_tao: "0",
    call_args: null,
    observed_at: 1_785_800_000_000,
  };
}

function accountEventRow(block: number, index = 0) {
  return {
    block_number: block,
    event_index: index,
    extrinsic_index: 0,
    event_kind: "StakeAdded",
    hotkey: "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM",
    coldkey: null,
    netuid: 1,
    uid: 3,
    amount_tao: "1.5",
    alpha_amount: "2.25",
    observed_at: 1_785_800_000_000,
  };
}

/** An env whose R2 bucket publishes a decode watermark at `height`. */
function withWatermark(env: Record<string, unknown>, height: number) {
  return {
    ...env,
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        if (key !== DECODE_WATERMARK_KEY) return null;
        return {
          async text() {
            return JSON.stringify({ decoded_through: height });
          },
        };
      },
    },
  };
}

describe("hotBlockNumber", () => {
  test("is the R2-SQL parser itself, so a short hash is never a height", () => {
    assert.equal(hotBlockNumber, safeBlockNumber);
    assert.equal(hotBlockNumber(42), 42);
    assert.equal(hotBlockNumber("42"), 42);
    assert.equal(hotBlockNumber(null), null);
    assert.equal(hotBlockNumber("   "), null);
    assert.equal(hotBlockNumber(-1), null);
    assert.equal(hotBlockNumber(1.5), null);
    // A loose Number() would read this as block 2,748 and route a hash to a
    // height nobody asked for.
    assert.equal(hotBlockNumber("0xabc"), null);
  });
});

describe("the empty-payload predicates", () => {
  test("each reads ITS OWN count field", () => {
    // Reading `count` on a payload whose field is `extrinsic_count` yields
    // undefined === 0 -> false -> "not empty", and a genuinely empty cold
    // answer would then be served as if it had been measured.
    assert.equal(isEmptyExtrinsicPayload({ extrinsic_count: 0 }), true);
    assert.equal(isEmptyExtrinsicPayload({ extrinsic_count: 3 }), false);
    assert.equal(isEmptyEventPayload({ event_count: 0 }), true);
    assert.equal(isEmptyEventPayload({ event_count: 12 }), false);
    assert.equal(isEmptyChainEventPayload({ count: 0 }), true);
    assert.equal(isEmptyChainEventPayload({ count: 400 }), false);
  });
});

describe("chainDetailCoverage / chainDetailHead", () => {
  test("report the window the register holds", async () => {
    const { env } = d1(registry([ABOVE, ABOVE + 5]));
    assert.deepEqual(await chainDetailCoverage(env), {
      floor: ABOVE,
      head: ABOVE + 5,
      headObservedAt: 1_785_800_000_000,
    });
    assert.equal(await chainDetailHead(env), ABOVE + 5);
  });

  test("an empty register is null, not zero", async () => {
    const { env } = d1(registry([]));
    assert.equal(await chainDetailCoverage(env), null);
    assert.equal(await chainDetailHead(env), null);
  });

  test("an unbound or failing D1 is null, never a throw", async () => {
    assert.equal(await chainDetailCoverage({}), null);
    assert.equal(await chainDetailCoverage(null), null);
    assert.equal(await chainDetailCoverage({ METAGRAPH_HEALTH_DB: {} }), null);
    const { env } = d1(registry([ABOVE]), { throws: true });
    assert.equal(await chainDetailHead(env), null);
  });

  test("a result envelope with no rows array reads as no rows, not a crash", async () => {
    // D1 returns `{}` for a statement it could not shape; treating that as
    // anything but "no rows" would throw inside a read path whose whole job is
    // to degrade quietly.
    const { env } = d1(() => undefined);
    assert.equal(await chainDetailCoverage(env), null);
  });
});

describe("the hot loaders", () => {
  test("block extrinsics come back through the shared formatter, in read order", async () => {
    const { env, seen } = d1((sql) =>
      sql.includes("chain_detail_extrinsics")
        ? [extrinsicRow(ABOVE, 0), extrinsicRow(ABOVE, 1)]
        : [],
    );
    const page = await loadBlockExtrinsicsHotTier(env, String(ABOVE), ABOVE, {
      limit: 10,
      offset: 0,
    });
    assert.equal(page?.extrinsic_count, 2);
    assert.equal(page?.block_number, ABOVE);
    // The formatter's own coercions ran: "0.000002131419" is a number here, and
    // the 0/1 flag is a boolean.
    assert.equal(page?.extrinsics[0].success, true);
    // toTaoOrNull rounds to rao precision on READ; the TEXT column keeps the
    // exact decimal the chain reported.
    assert.equal(page?.extrinsics[0].fee_tao, 0.000002131);
    assert.match(seen[0].sql, /ORDER BY extrinsic_index ASC/);
  });

  test("block account-events likewise", async () => {
    const { env, seen } = d1((sql) =>
      sql.includes("chain_detail_account_events")
        ? [accountEventRow(ABOVE)]
        : [],
    );
    const page = await loadBlockEventsHotTier(env, String(ABOVE), ABOVE, {
      limit: 10,
      offset: 0,
    });
    assert.equal(page?.event_count, 1);
    assert.equal(page?.events[0].amount_tao, 1.5);
    assert.match(seen[0].sql, /ORDER BY event_index ASC/);
  });

  test("an unusable page, an unbound D1 and a failing query all decline (null)", async () => {
    const { env } = d1(() => []);
    assert.equal(
      await loadBlockExtrinsicsHotTier(env, "1", 1, { limit: 0 }),
      null,
    );
    assert.equal(
      await loadBlockExtrinsicsHotTier(env, "1", 1, { limit: 10, offset: -1 }),
      null,
    );
    assert.equal(await loadBlockEventsHotTier(env, "1", 1, { limit: 0 }), null);
    assert.equal(
      await loadBlockEventsHotTier(env, "1", 1, { limit: 10, offset: -1 }),
      null,
    );
    assert.equal(
      await loadBlockExtrinsicsHotTier({}, "1", 1, { limit: 10 }),
      null,
    );
    const failing = d1(() => [], { throws: true });
    assert.equal(
      await loadBlockEventsHotTier(failing.env, "1", 1, { limit: 10 }),
      null,
    );
  });
});

describe("formatChainEvent", () => {
  test("parses the TEXT args, decodes accounts, and summarizes from the DECODED form", () => {
    // A real captured Balances.Transfer payload (block 8,587,754 index 119).
    const args = JSON.stringify({
      to: [
        [
          109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
      ],
      from: [
        [
          109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 15, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
      ],
      amount: 30681,
    });
    const event = formatChainEvent({
      block_number: ABOVE,
      event_index: 4,
      pallet: "Balances",
      method: "Transfer",
      args,
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: 1_785_800_000_000,
    });
    assert.equal(event?.pallet, "Balances");
    assert.equal(event?.extrinsic_index, 2);
    // The 32-byte AccountId32 array became an SS58 address, exactly as the
    // deleted Postgres tier's coerceEvent produced it.
    assert.equal(
      (event?.args as Record<string, unknown>).to,
      "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
    );
  });

  test("malformed args degrade to null rather than emptying the block", () => {
    const event = formatChainEvent({
      block_number: 1,
      event_index: 0,
      pallet: "Balances",
      method: "Transfer",
      args: "{not json",
      phase: "ApplyExtrinsic",
      extrinsic_index: null,
      observed_at: 1,
    });
    assert.ok(event);
    assert.equal(event?.args, null);
    assert.equal(event?.extrinsic_index, null);
  });

  test("a null row and a null args column are both handled", () => {
    assert.equal(formatChainEvent(null), null);
    assert.equal(formatChainEvent(undefined), null);
    const event = formatChainEvent({ pallet: null, method: null, args: null });
    assert.equal(event?.pallet, null);
    assert.equal(event?.summary, null);
  });

  test("an already-parsed args object passes through instead of stringifying", () => {
    // #9260: this formatter is shared with the lakehouse leg. Both live stores
    // hand back TEXT today, but `String({...})` is "[object Object]" -- it
    // would parse-fail and null the args of EVERY event in the block while
    // still returning a full-looking payload.
    const event = formatChainEvent({
      block_number: 1,
      event_index: 0,
      pallet: "Balances",
      method: "Transfer",
      args: { amount: 30681 },
      phase: "ApplyExtrinsic",
      extrinsic_index: null,
      observed_at: 1,
    });
    assert.ok(event?.args && typeof event.args === "object");
    assert.ok(
      Object.hasOwn(event.args as Record<string, unknown>, "amount"),
      "the object survived the decode rather than being stringified to null",
    );
  });
});

describe("loadBlockChainEventsHotTier", () => {
  test("returns the published {block_number,count,events} shape", async () => {
    const { env } = d1((sql) =>
      sql.includes("chain_detail_chain_events")
        ? [
            {
              block_number: ABOVE,
              event_index: 0,
              pallet: "System",
              method: "ExtrinsicSuccess",
              args: null,
              phase: "ApplyExtrinsic",
              extrinsic_index: 0,
              observed_at: 1_785_800_000_000,
            },
          ]
        : [],
    );
    assert.deepEqual((await loadBlockChainEventsHotTier(env, ABOVE))?.count, 1);
    assert.equal(await loadBlockChainEventsHotTier({}, ABOVE), null);
  });
});

describe("loadExtrinsicHotTier", () => {
  test("resolves the composite <block>-<index> form and embeds its events", async () => {
    const { env, seen } = d1((sql) => {
      if (sql.includes("chain_detail_extrinsics"))
        return [extrinsicRow(ABOVE, 3)];
      if (sql.includes("chain_detail_account_events"))
        return [accountEventRow(ABOVE, 9)];
      return [];
    });
    const detail = await loadExtrinsicHotTier(env, `${ABOVE}-3`);
    assert.equal(detail?.extrinsic?.extrinsic_index, 3);
    assert.equal(detail?.events.length, 1);
    assert.deepEqual(seen[0].params, [ABOVE, 3]);
  });

  test("resolves the hash form case-insensitively", async () => {
    const { env, seen } = d1((sql) =>
      sql.includes("chain_detail_extrinsics") ? [extrinsicRow(ABOVE, 1)] : [],
    );
    const detail = await loadExtrinsicHotTier(env, XT_HASH.toUpperCase());
    assert.ok(detail?.extrinsic);
    assert.equal(seen[0].params[0], XT_HASH);
  });

  test("a ref it cannot hold is null -- absence here is never a confirmation", async () => {
    const { env } = d1(() => []);
    assert.equal(await loadExtrinsicHotTier(env, `${ABOVE}-0`), null);
    assert.equal(await loadExtrinsicHotTier(env, "not-a-ref"), null);
    assert.equal(await loadExtrinsicHotTier(env, "0xdead"), null);
    assert.equal(await loadExtrinsicHotTier({}, XT_HASH), null);
    // Digits that overflow a safe integer parse to null: the composite regex
    // proves the SHAPE, never that the value is a usable height.
    assert.equal(
      await loadExtrinsicHotTier(env, "99999999999999999999-0"),
      null,
    );
  });

  test("a failing EVENTS query still yields the extrinsic, with an empty list", async () => {
    // Withholding a row we hold because a second query blipped would be the
    // opposite of this tier's posture; the cold tier makes the same call.
    const { env } = d1((sql) => {
      if (sql.includes("chain_detail_extrinsics"))
        return [extrinsicRow(ABOVE, 3)];
      throw new Error("d1 blip on the events read");
    });
    const detail = await loadExtrinsicHotTier(env, `${ABOVE}-3`);
    assert.equal(detail?.extrinsic?.extrinsic_index, 3);
    assert.deepEqual(detail?.events, []);
  });

  test("an unformattable position still yields the row, with no events", async () => {
    const { env } = d1((sql) =>
      sql.includes("chain_detail_extrinsics")
        ? [
            {
              ...extrinsicRow(ABOVE, 0),
              block_number: null,
              extrinsic_index: null,
            },
          ]
        : [accountEventRow(ABOVE)],
    );
    const detail = await loadExtrinsicHotTier(env, `${ABOVE}-0`);
    assert.ok(detail);
    assert.deepEqual(detail?.events, []);
  });
});

describe("answerBlockDetail — the seam decides, and a gap DECLINES", () => {
  const ops = (hot: unknown, cold: unknown) => ({
    hot: async () => hot as never,
    cold: async () => cold as never,
    isEmpty: (data: unknown) => (data as { count: number }).count === 0,
  });

  test("at or below the seam the lakehouse answers and the hot tier is never asked", async () => {
    const { env, seen } = d1(registry([BELOW]));
    const answer = await answerBlockDetail(env, String(BELOW), {
      hot: async () => {
        throw new Error("the hot tier must not be consulted below the seam");
      },
      cold: async () => ({ count: 3 }) as never,
      isEmpty: (d: { count: number }) => d.count === 0,
    });
    assert.equal(answer.kind, "answer");
    assert.equal(answer.kind === "answer" && answer.tier, "cold");
    // Not one register query was issued for a block the lakehouse owns.
    assert.equal(seen.length, 0);
  });

  test("below the seam, a cold tier that cannot answer is a MISS, not a gap", async () => {
    const { env } = d1(registry([]));
    const answer = await answerBlockDetail(env, String(BELOW), ops(null, null));
    assert.equal(answer.kind, "miss");
  });

  test("above the seam, a covered block is served hot -- including an EMPTY answer", async () => {
    const { env } = d1(registry([ABOVE - 1, ABOVE, ABOVE + 1]));
    const served = await answerBlockDetail(
      env,
      String(ABOVE),
      ops({ count: 7 }, null),
    );
    assert.equal(served.kind === "answer" && served.tier, "hot");

    // The measured zero: the register carries the block, so "no events" is a
    // measurement and must NOT decline.
    const empty = await answerBlockDetail(
      env,
      String(ABOVE),
      ops({ count: 0 }, null),
    );
    assert.equal(empty.kind, "answer");
    assert.equal(empty.kind === "answer" && empty.tier, "hot");
  });

  test("above the seam and UNCOVERED, real lakehouse rows still win over a decline", async () => {
    // The published watermark is a MIN across four tables, so rows can exist
    // above it -- refusing them would be the same failure in a new place.
    const { env } = d1(registry([ABOVE + 500]));
    const answer = await answerBlockDetail(
      env,
      String(ABOVE),
      ops(null, { count: 12 }),
    );
    assert.equal(answer.kind === "answer" && answer.tier, "cold");
  });

  test("above the seam, uncovered, and nothing holds it: GAP", async () => {
    const { env } = d1(registry([ABOVE + 500, ABOVE + 900]));
    const answer = await answerBlockDetail(
      env,
      String(ABOVE),
      ops(null, { count: 0 }),
    );
    assert.equal(answer.kind, "gap");
    if (answer.kind !== "gap") return;
    assert.equal(answer.block, ABOVE);
    assert.equal(answer.seam, SEAM);
    assert.deepEqual(answer.coverage, {
      floor: ABOVE + 500,
      head: ABOVE + 900,
      headObservedAt: 1_785_800_000_000,
    });
    // The message names both boundaries and says what the gap is NOT.
    assert.match(chainDetailGapMessage(answer), /not a block without/);
    assert.match(chainDetailGapMessage(answer), new RegExp(String(SEAM)));
  });

  test("a covered block whose hot loader declines falls through, then gaps", async () => {
    const { env } = d1(registry([ABOVE]));
    const answer = await answerBlockDetail(env, String(ABOVE), ops(null, null));
    assert.equal(answer.kind, "gap");
    assert.equal(answer.kind === "gap" && answer.coverage?.head, ABOVE);
  });

  test("an empty hot tier still reports the gap, with a null window", async () => {
    const { env } = d1(registry([]));
    const answer = await answerBlockDetail(env, String(ABOVE), ops(null, null));
    assert.equal(answer.kind, "gap");
    assert.equal(answer.kind === "gap" && answer.coverage, null);
    assert.match(
      chainDetailGapMessage(answer as never),
      /live-follow window \(empty\)/,
    );
  });

  test("the seam RESOLVES: a published watermark moves the boundary", async () => {
    const base = d1(registry([]));
    // With the watermark past this block, it is the lakehouse's -- so the cold
    // answer is served instead of the decline the floor alone would give.
    const answer = await answerBlockDetail(
      withWatermark(base.env, ABOVE + 1),
      String(ABOVE),
      ops(null, { count: 0 }),
    );
    assert.equal(answer.kind, "answer");
    assert.equal(answer.kind === "answer" && answer.tier, "cold");
  });

  test("a HASH the register carries routes by its resolved height", async () => {
    const { env } = d1(registry([ABOVE], { [HASH]: ABOVE }));
    const answer = await answerBlockDetail(env, HASH, ops({ count: 4 }, null));
    assert.equal(answer.kind === "answer" && answer.tier, "hot");
  });

  test("a hash the register carries BELOW the seam goes cold, or misses", async () => {
    const { env } = d1(registry([BELOW], { [HASH]: BELOW }));
    const answer = await answerBlockDetail(env, HASH, ops(null, { count: 1 }));
    assert.equal(answer.kind === "answer" && answer.tier, "cold");
    // And when the lakehouse cannot answer at all, it is a MISS -- the caller's
    // existing schema-stable empty -- never a gap: the lakehouse OWNS this
    // range, so its silence is about the tier, not about coverage.
    const missing = await answerBlockDetail(env, HASH, ops(null, null));
    assert.equal(missing.kind, "miss");
  });

  test("an unknown hash or an unusable ref keeps the cold tier's own answer", async () => {
    const { env } = d1(registry([ABOVE]));
    // A hash the hot tier does not carry proves nothing: 8.7M blocks are not
    // in this window, so this must NOT decline.
    const unknownHash = await answerBlockDetail(
      env,
      HASH,
      ops(null, { count: 0 }),
    );
    assert.equal(unknownHash.kind === "answer" && unknownHash.tier, "cold");
    const junk = await answerBlockDetail(
      env,
      "banana",
      ops(null, { count: 0 }),
    );
    assert.equal(junk.kind === "answer" && junk.tier, "cold");
    const junkMiss = await answerBlockDetail(env, "banana", ops(null, null));
    assert.equal(junkMiss.kind, "miss");
  });
});

describe("answerExtrinsicDetail — a position declines, a hash does not", () => {
  test("the composite form follows the seam and gaps like a block read", async () => {
    const { env } = d1(registry([ABOVE + 900]));
    const answer = await answerExtrinsicDetail(env, `${ABOVE}-2`, async () => ({
      schema_version: 1,
      ref: `${ABOVE}-2`,
      extrinsic: null,
      events: [],
    }));
    assert.equal(answer.kind, "gap");
  });

  test("the composite form serves the hot row when the register covers it", async () => {
    const { env } = d1((sql, params) => {
      const base = registry([ABOVE])(sql, params);
      if (base.length) return base;
      if (sql.includes("chain_detail_extrinsics"))
        return [extrinsicRow(ABOVE, 2)];
      return [];
    });
    const answer = await answerExtrinsicDetail(
      env,
      `${ABOVE}-2`,
      async () => null,
    );
    assert.equal(answer.kind === "answer" && answer.tier, "hot");
  });

  test("the HASH form asks hot first, then cold, and never declines", async () => {
    const hot = d1((sql) =>
      sql.includes("chain_detail_extrinsics") ? [extrinsicRow(ABOVE, 0)] : [],
    );
    const hotAnswer = await answerExtrinsicDetail(
      hot.env,
      XT_HASH,
      async () => null,
    );
    assert.equal(hotAnswer.kind === "answer" && hotAnswer.tier, "hot");

    const cold = d1(() => []);
    const coldAnswer = await answerExtrinsicDetail(
      cold.env,
      XT_HASH,
      async () => ({
        schema_version: 1,
        ref: XT_HASH,
        extrinsic: null,
        events: [],
      }),
    );
    assert.equal(coldAnswer.kind === "answer" && coldAnswer.tier, "cold");

    const nothing = await answerExtrinsicDetail(
      cold.env,
      XT_HASH,
      async () => null,
    );
    assert.equal(nothing.kind, "miss");
  });
});
