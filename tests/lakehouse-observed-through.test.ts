// The coverage horizon stamped on every account response's meta.
//
// This field exists to separate "this ss58 has no activity" from "coverage has
// not reached it yet" -- both of which are a 200 with zeros, deliberately. So
// the dangerous failure here is publishing a horizon that is NEWER than what
// the tier actually holds: a consumer would then read a real gap as a measured
// absence, which is the exact confusion the field was added to end. Every path
// that cannot establish the horizon must yield null rather than a guess.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The horizon reads blocks_head through `readStore`, which builds its own
// `new Client(...)`, so mocking the module is the only seam. Built inside
// vi.hoisted because vi.mock is hoisted above every import.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  OBSERVED_THROUGH_TTL_MS,
  resetObservedThroughCache,
  resolveObservedThrough,
} from "../src/lakehouse-observed-through.ts";
import {
  DECODE_WATERMARK_KEY,
  resetDecodeWatermarkCache,
} from "../src/decode-watermark.ts";

const THROUGH = 8_847_023;
const OBSERVED_MS = Date.parse("2026-08-15T02:30:36.000Z");
const NOW = Date.parse("2026-08-16T07:00:00.000Z");

beforeEach(() => {
  resetObservedThroughCache();
  resetDecodeWatermarkCache();
  pg.control.answers = [];
  pg.control.failNext = null;
  pg.control.queries.length = 0;
});

/** An env whose archive publishes a watermark and whose store answers
 * blocks_head. `observedAt` null means the head register has no row for that
 * block yet. */
function env({
  decodedThrough = THROUGH,
  observedAt = OBSERVED_MS as number | null,
  noWatermark = false,
  noStore = false,
  storeThrows = false,
}: {
  decodedThrough?: number;
  observedAt?: number | null;
  noWatermark?: boolean;
  noStore?: boolean;
  storeThrows?: boolean;
} = {}) {
  pg.control.failNext = storeThrows ? new Error("store cold") : null;
  pg.control.answers = [
    {
      match: "blocks_head",
      rows: observedAt === null ? [] : [{ observed_at: observedAt }],
    },
  ];
  return {
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        if (key !== DECODE_WATERMARK_KEY || noWatermark) return null;
        return {
          async text() {
            return JSON.stringify({
              decoded_through: decodedThrough,
              updated_at: "2026-08-16T06:00:00Z",
            });
          },
        };
      },
    },
    ...(noStore ? {} : pgMockEnv()),
  } as never;
}

describe("resolveObservedThrough", () => {
  test("converts the decode watermark's BLOCK into the instant it was observed", async () => {
    // The whole conversion: the tier knows its ceiling in blocks, the field
    // publishes an instant, and blocks_head is the only thing that maps one to
    // the other.
    const got = await resolveObservedThrough(env(), { now: () => NOW });
    assert.equal(got, "2026-08-15T02:30:36.000Z");
  });

  test("asks blocks_head for the WATERMARK's block, not the newest one", async () => {
    // Reading the head register's own max would publish the chain tip as the
    // lakehouse's coverage -- a horizon newer than anything the tier holds,
    // which is the one wrong answer that matters here.
    await resolveObservedThrough(env(), { now: () => NOW });
    const sql = pg.control.queries.map((q: { text?: string }) =>
      String(q.text ?? ""),
    );
    assert.ok(
      sql.some((s) => s.includes("block_number = $1")),
      `expected a point lookup by block; got ${JSON.stringify(sql)}`,
    );
    const values = pg.control.queries
      .map((q: { values?: unknown[] }) => q.values ?? [])
      .flat();
    assert.ok(
      values.includes(THROUGH),
      `expected the watermark block ${THROUGH} in ${JSON.stringify(values)}`,
    );
  });

  test("no watermark is null, never a guess", async () => {
    assert.equal(
      await resolveObservedThrough(env({ noWatermark: true }), {
        now: () => NOW,
      }),
      null,
    );
  });

  test("a block the head register has not reached is null", async () => {
    // The decoder can finish a block before blocks_head records it. Answering
    // with some older block's timestamp would understate coverage; answering
    // with none is honest.
    assert.equal(
      await resolveObservedThrough(env({ observedAt: null }), {
        now: () => NOW,
      }),
      null,
    );
  });

  test("an unusable timestamp is null, not epoch zero", async () => {
    for (const bad of [0, -1, Number.NaN]) {
      resetObservedThroughCache();
      resetDecodeWatermarkCache();
      assert.equal(
        await resolveObservedThrough(env({ observedAt: bad }), {
          now: () => NOW,
        }),
        null,
        `observed_at ${bad} must not publish a horizon`,
      );
    }
  });

  test("an unbound or throwing store is null, never an exception", async () => {
    // This runs inside every account response's meta. A horizon that could not
    // be read must cost the caller nothing.
    assert.equal(
      await resolveObservedThrough(env({ noStore: true }), { now: () => NOW }),
      null,
    );
    resetObservedThroughCache();
    resetDecodeWatermarkCache();
    assert.equal(
      await resolveObservedThrough(env({ storeThrows: true }), {
        now: () => NOW,
      }),
      null,
    );
  });

  test("the result is memoized for the TTL, then re-read", async () => {
    // 39 account responses share this; paying a lookup per response would make
    // a coverage marker cost more than the reads it annotates.
    const e = env();
    await resolveObservedThrough(e, { now: () => NOW });
    const afterFirst = pg.control.queries.length;
    await resolveObservedThrough(e, { now: () => NOW + 1_000 });
    assert.equal(pg.control.queries.length, afterFirst, "served from the memo");
    await resolveObservedThrough(e, {
      now: () => NOW + OBSERVED_THROUGH_TTL_MS + 1,
    });
    assert.ok(
      pg.control.queries.length > afterFirst,
      "past the TTL it reads again",
    );
  });

  test("`fresh` bypasses the memo", async () => {
    const e = env();
    await resolveObservedThrough(e, { now: () => NOW });
    const afterFirst = pg.control.queries.length;
    await resolveObservedThrough(e, { fresh: true, now: () => NOW });
    assert.ok(pg.control.queries.length > afterFirst);
  });

  test("a null horizon is cached like a hit", async () => {
    // A deployment with no watermark -- self-hosters, CI, the window before the
    // decoder first publishes -- must not pay a miss on every cold read.
    const e = env({ noWatermark: true });
    await resolveObservedThrough(e, { now: () => NOW });
    const afterFirst = pg.control.queries.length;
    assert.equal(
      await resolveObservedThrough(e, { now: () => NOW + 1_000 }),
      null,
    );
    assert.equal(pg.control.queries.length, afterFirst);
  });

  test("one network's horizon is never served for another", async () => {
    // A horizon is a chain-specific instant. Handing mainnet's to testnet would
    // publish a coverage claim about a chain that was never read.
    const e = env();
    const mainnet = await resolveObservedThrough(
      e,
      { now: () => NOW },
      "mainnet",
    );
    pg.control.answers = [{ match: "blocks_head", rows: [] }];
    const testnet = await resolveObservedThrough(
      e,
      { now: () => NOW },
      "testnet",
    );
    assert.equal(mainnet, "2026-08-15T02:30:36.000Z");
    assert.notEqual(testnet, mainnet);
  });
});
