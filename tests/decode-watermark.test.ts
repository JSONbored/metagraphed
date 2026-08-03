// The published decode watermark: the contract between the private decode
// lane and this Worker's block seam.
//
// Two properties matter and everything here tests one of them:
//   1. IT ONLY EVER FAILS DOWNWARD. Missing, unreadable, malformed, partially
//      understood -- every one of those resolves to null so the caller keeps
//      its configured floor. A watermark that raises the seam on a guess would
//      route reads to a lakehouse that does not hold them.
//   2. IT IS NOT A PER-REQUEST ROUND TRIP. The seam is resolved on every cold
//      block read; an unmemoized R2 GET there would put a network hop in front
//      of a decision about which backend to ask.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import {
  DECODE_TABLES,
  DECODE_WATERMARK_KEY,
  DECODE_WATERMARK_TTL_MS,
  parseDecodeWatermark,
  readDecodeWatermark,
  resetDecodeWatermarkCache,
  resolveDecodeWatermark,
} from "../src/decode-watermark.ts";

beforeEach(() => resetDecodeWatermarkCache());

/** A bucket stub that counts reads and records the keys asked for. */
function bucket(
  body: unknown,
  opts: { throws?: boolean; badJson?: boolean } = {},
) {
  const keys: string[] = [];
  return {
    keys,
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          keys.push(key);
          if (opts.throws) throw new Error("r2 down");
          if (body === undefined) return null;
          return {
            async text() {
              return opts.badJson ? "{not json" : JSON.stringify(body);
            },
          };
        },
      },
    },
  };
}

const FULL = {
  schema_version: 1,
  decoded_through: 8_762_400,
  per_table: {
    blocks: 8_762_550,
    extrinsics: 8_762_400,
    chain_events: 8_762_400,
    account_events: 8_762_400,
  },
  floor: 8_759_336,
  updated_at: "2026-08-03T11:17:42Z",
};

describe("parseDecodeWatermark", () => {
  test("reads the full object the decoder publishes", () => {
    const got = parseDecodeWatermark(FULL);
    assert.equal(got!.decodedThrough, 8_762_400);
    assert.equal(got!.updatedAt, Date.parse("2026-08-03T11:17:42Z"));
    assert.deepEqual(got!.perTable, FULL.per_table);
  });

  test("string heights are accepted — JSON from Python is a wire format", () => {
    const got = parseDecodeWatermark({
      decoded_through: "8762400",
      per_table: { blocks: "8762550" },
    });
    assert.equal(got!.decodedThrough, 8_762_400);
    assert.deepEqual(got!.perTable, { blocks: 8_762_550 });
  });

  test("an unusable decoded_through rejects the WHOLE object", () => {
    // Strict on the one field that routes: a partially-understood watermark
    // would move the seam on a guess.
    for (const bad of [
      {},
      { decoded_through: null },
      { decoded_through: "soon" },
      { decoded_through: -1 },
      { decoded_through: 1.5 },
      { decoded_through: Number.MAX_SAFE_INTEGER + 2 },
      { decoded_through: true },
      { decoded_through: { n: 1 } },
    ]) {
      assert.equal(parseDecodeWatermark(bad), null, JSON.stringify(bad));
    }
  });

  test("a body that is not an object is not a watermark", () => {
    for (const bad of [null, undefined, "x", 7, []]) {
      assert.equal(parseDecodeWatermark(bad), null);
    }
  });

  test("diagnostics degrade to null instead of rejecting the routing value", () => {
    // updated_at and per_table are for the watchdog and for a human; losing
    // them must not cost the seam its advance.
    const got = parseDecodeWatermark({ decoded_through: 10 });
    assert.equal(got!.decodedThrough, 10);
    assert.equal(got!.updatedAt, null);
    assert.equal(got!.perTable, null);
  });

  test("an unparseable timestamp reads as absent, never as epoch 0", () => {
    // Date.parse("later") is NaN; letting that through would make the age
    // arithmetic in the watchdog produce NaN comparisons that are always false.
    for (const bad of ["later", "", 1_700_000_000_000, null]) {
      assert.equal(
        parseDecodeWatermark({ decoded_through: 10, updated_at: bad })!
          .updatedAt,
        null,
      );
    }
  });

  test("per_table keeps only the four tables the lane actually feeds", () => {
    const got = parseDecodeWatermark({
      decoded_through: 10,
      per_table: { blocks: 11, neurons: 99, extrinsics: "x" },
    });
    assert.deepEqual(got!.perTable, { blocks: 11 });
    assert.deepEqual(DECODE_TABLES.slice(0, 2), ["blocks", "extrinsics"]);
  });

  test("a per_table with nothing usable is null, not an empty object", () => {
    for (const raw of [{}, { blocks: "x" }, "not-an-object", null]) {
      assert.equal(
        parseDecodeWatermark({ decoded_through: 10, per_table: raw })!.perTable,
        null,
      );
    }
  });
});

describe("readDecodeWatermark", () => {
  test("reads the agreed key and nothing else", async () => {
    const { env, keys } = bucket(FULL);
    const got = await readDecodeWatermark(env);
    assert.deepEqual(keys, [DECODE_WATERMARK_KEY]);
    assert.equal(got!.decodedThrough, 8_762_400);
  });

  test("an unbound bucket is null, not a throw", async () => {
    assert.equal(await readDecodeWatermark(undefined), null);
    assert.equal(await readDecodeWatermark({}), null);
    assert.equal(await readDecodeWatermark({ METAGRAPH_ARCHIVE: {} }), null);
  });

  test("a missing object is null", async () => {
    assert.equal(await readDecodeWatermark(bucket(undefined).env), null);
  });

  test("an R2 failure is null, because the caller has a correct fallback", async () => {
    assert.equal(
      await readDecodeWatermark(bucket(FULL, { throws: true }).env),
      null,
    );
  });

  test("a truncated body is null rather than a partial parse", async () => {
    assert.equal(
      await readDecodeWatermark(bucket(FULL, { badJson: true }).env),
      null,
    );
  });
});

describe("resolveDecodeWatermark — the memo", () => {
  test("a warm isolate does not re-read R2 within the TTL", async () => {
    const { env, keys } = bucket(FULL);
    let clock = 1_000;
    const now = () => clock;
    await resolveDecodeWatermark(env, { now });
    clock += DECODE_WATERMARK_TTL_MS - 1;
    const again = await resolveDecodeWatermark(env, { now });
    assert.equal(keys.length, 1, "one GET, not one per call");
    assert.equal(again!.decodedThrough, 8_762_400);
  });

  test("it re-reads once the TTL has passed", async () => {
    const { env, keys } = bucket(FULL);
    let clock = 1_000;
    const now = () => clock;
    await resolveDecodeWatermark(env, { now });
    clock += DECODE_WATERMARK_TTL_MS;
    await resolveDecodeWatermark(env, { now });
    assert.equal(keys.length, 2);
  });

  test("a MISS is cached too, or a Worker with no watermark pays a GET per request", async () => {
    const { env, keys } = bucket(undefined);
    const now = () => 1_000;
    assert.equal(await resolveDecodeWatermark(env, { now }), null);
    assert.equal(await resolveDecodeWatermark(env, { now }), null);
    assert.equal(keys.length, 1);
  });

  test("concurrent cold calls share one GET rather than racing", async () => {
    // The promise is memoized, not the value, so a burst on a cold isolate
    // cannot fan out into N round trips.
    const { env, keys } = bucket(FULL);
    const now = () => 1_000;
    await Promise.all([
      resolveDecodeWatermark(env, { now }),
      resolveDecodeWatermark(env, { now }),
      resolveDecodeWatermark(env, { now }),
    ]);
    assert.equal(keys.length, 1);
  });

  test("`fresh` bypasses the memo without poisoning it", async () => {
    // The watchdog measures staleness, so it must not be handed a value up to
    // a TTL old -- and asking for one must not disturb the serving memo.
    const { env, keys } = bucket(FULL);
    const now = () => 1_000;
    await resolveDecodeWatermark(env, { now });
    await resolveDecodeWatermark(env, { now, fresh: true });
    await resolveDecodeWatermark(env, { now });
    assert.equal(keys.length, 2, "one memoized read plus one forced read");
  });

  test("the real clock is used when none is injected", async () => {
    const { env, keys } = bucket(FULL);
    await resolveDecodeWatermark(env);
    await resolveDecodeWatermark(env);
    assert.equal(keys.length, 1);
  });

  test("resetting the cache forces the next read", async () => {
    const { env, keys } = bucket(FULL);
    await resolveDecodeWatermark(env);
    resetDecodeWatermarkCache();
    await resolveDecodeWatermark(env);
    assert.equal(keys.length, 2);
  });

  test("the module registers its memo with the state registry", async () => {
    // With `isolate: false` an unregistered memo is a cross-FILE channel: the
    // first file to publish a watermark would move the seam for every file
    // after it in the same worker.
    const { registeredModuleStateKeys } =
      await import("../src/module-state-registry.ts");
    assert.ok(registeredModuleStateKeys().includes("src/decode-watermark.ts"));
  });

  test("the TTL is the one the cadence rationale was written against", () => {
    // The decode lane runs hourly; 5 minutes bounds the visible lag at ~8% of
    // the producer's cadence and caps a warm isolate at 12 GETs an hour.
    assert.equal(DECODE_WATERMARK_TTL_MS, 300_000);
  });
});
