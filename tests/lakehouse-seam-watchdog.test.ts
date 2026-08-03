// The decode-lane watchdog (#9161), tested without a lakehouse.
//
// Runs as a WORKER CRON, not a GitHub Action (#9164): the check needs
// R2_SQL_TOKEN, the METAGRAPH_ARCHIVE bucket and the D1 binding, and this
// Worker already holds all three.
//
// It used to compare a CONSTANT against `max(chain.blocks)`. That question is
// obsolete now that the constant is only a floor and the seam follows the
// decoder's published watermark -- the two disagreeing is the normal, self-
// correcting state. So the rule now has to catch the things that can actually
// break: nothing publishes, the decoder stops, the decoder loses ground to the
// raw capture, or the watermark and the lakehouse disagree in either
// direction. And it has to stay quiet otherwise, because a check that cries
// wolf gets switched off before the one time it matters.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import {
  DECODE_LAG_BLOCKS,
  DECODE_STALE_MS,
  evaluateDecodeSeam,
  runLakehouseSeamWatchdog,
  type SeamInput,
} from "../src/lakehouse-seam-watchdog.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";
import {
  DECODE_WATERMARK_KEY,
  resetDecodeWatermarkCache,
} from "../src/decode-watermark.ts";

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
const HI = 8_762_000;

beforeEach(() => resetDecodeWatermarkCache());

/** A completely healthy tick: fresh watermark, capture just ahead, a
 * contiguous lakehouse that backs the watermark exactly. */
function healthy(overrides: Partial<SeamInput> = {}): SeamInput {
  return {
    floor: DEFAULT_BLOCKS_SEAM,
    watermark: {
      decodedThrough: HI,
      updatedAt: NOW - 20 * 60 * 1000,
      perTable: null,
    },
    capturedThrough: HI + 120,
    lo: 0,
    hi: HI,
    count: HI + 1,
    now: NOW,
    ...overrides,
  };
}

describe("the decode-lane rule", () => {
  test("a lane that is publishing, current and backed is quiet", () => {
    const { reasons, summary } = evaluateDecodeSeam(healthy());
    assert.deepEqual(reasons, []);
    assert.equal(summary.seam, HI);
    assert.equal(summary.capture_lag, 120);
    assert.equal(summary.contiguous, true);
  });

  test("the structural lag of one hourly cycle is NOT an alarm", () => {
    // ~150 blocks of a partial capture object plus ~300 blocks of chain per
    // hour is what a healthy seam looks like the instant before a run. A
    // threshold that fired here would be muted within a day.
    const { reasons } = evaluateDecodeSeam(
      healthy({ capturedThrough: HI + 450 }),
    );
    assert.deepEqual(reasons, []);
  });

  test("no watermark at all is reported as a seam that cannot advance", () => {
    // The failure the dynamic seam exists to end, silently reintroduced.
    const { reasons, summary } = evaluateDecodeSeam(
      healthy({
        watermark: null,
        hi: DEFAULT_BLOCKS_SEAM,
        count: DEFAULT_BLOCKS_SEAM + 1,
      }),
    );
    assert.equal(summary.seam, DEFAULT_BLOCKS_SEAM);
    assert.ok(reasons.some((r) => r.includes(DECODE_WATERMARK_KEY)));
    assert.ok(reasons.some((r) => /pinned at the configured floor/.test(r)));
  });

  test("a stopped decoder is named as stopped, with the frozen seam", () => {
    const { reasons } = evaluateDecodeSeam(
      healthy({
        watermark: {
          decodedThrough: HI,
          updatedAt: NOW - DECODE_STALE_MS - 1,
          perTable: null,
        },
      }),
    );
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /has stopped publishing/);
    assert.match(reasons[0]!, new RegExp(`frozen at ${HI}`));
  });

  test("a watermark exactly at the staleness threshold is still quiet", () => {
    // The boundary is `>`: a run that lands right on the limit is late, not
    // missing, and alarming on it would fire on cron jitter alone.
    const { reasons } = evaluateDecodeSeam(
      healthy({
        watermark: {
          decodedThrough: HI,
          updatedAt: NOW - DECODE_STALE_MS,
          perTable: null,
        },
      }),
    );
    assert.deepEqual(reasons, []);
  });

  test("a watermark with no usable timestamp is a fault, not a pass", () => {
    // Without it a stopped decoder is indistinguishable from a quiet one --
    // precisely the false negative that makes a monitor worthless.
    const { reasons, summary } = evaluateDecodeSeam(
      healthy({
        watermark: { decodedThrough: HI, updatedAt: null, perTable: null },
      }),
    );
    assert.equal(summary.watermark_age_ms, null);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /no usable `updated_at`/);
  });

  test("a decoder that publishes on time and still loses ground is caught", () => {
    // Rule 3: the lane is alive, so the staleness check passes, and it is
    // falling behind anyway.
    const { reasons, summary } = evaluateDecodeSeam(
      healthy({ capturedThrough: HI + DECODE_LAG_BLOCKS + 1 }),
    );
    assert.equal(summary.capture_lag, DECODE_LAG_BLOCKS + 1);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /trails the raw capture by 2401/);
    assert.match(reasons[0]!, new RegExp(`${HI + 1}\\.\\.${HI + 2401}`));
  });

  test("an unreadable capture watermark is reported, not skipped", () => {
    const { reasons, summary } = evaluateDecodeSeam(
      healthy({ capturedThrough: null }),
    );
    assert.equal(summary.capture_lag, null);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /raw_capture_state\.last_contiguous_block/);
  });

  test("a seam AHEAD of the lakehouse is the loudest case", () => {
    // The only direction that answers WRONGLY rather than thinly: those blocks
    // route to a lakehouse that cannot answer, so they read as missing.
    const { reasons } = evaluateDecodeSeam(
      healthy({ hi: HI - 500, count: HI - 499 }),
    );
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /500 block\(s\) AHEAD/);
    assert.match(reasons[0]!, /read as missing/);
  });

  test("a small lakehouse LEAD is normal and stays quiet", () => {
    // chain.blocks is appended before the other three tables and the watermark
    // is the min across all four, so a run in flight always shows a little.
    const { reasons } = evaluateDecodeSeam(
      healthy({
        hi: HI + DECODE_LAG_BLOCKS,
        count: HI + DECODE_LAG_BLOCKS + 1,
      }),
    );
    assert.deepEqual(reasons, []);
  });

  test("a sustained lakehouse lead means the publish half is broken", () => {
    // These two reasons co-occur BY CONSTRUCTION: the capture always runs
    // ahead of the lakehouse, so a lakehouse 2,401 blocks past the seam is a
    // capture at least that far past it too. The point of the second reason is
    // that it distinguishes "the loader stopped" (capture lag alone) from "the
    // loader works and the publish does not" (capture lag AND lakehouse lead).
    const { reasons } = evaluateDecodeSeam(
      healthy({
        hi: HI + DECODE_LAG_BLOCKS + 1,
        count: HI + DECODE_LAG_BLOCKS + 2,
        capturedThrough: HI + DECODE_LAG_BLOCKS + 301,
      }),
    );
    assert.equal(reasons.length, 2);
    const lead = reasons.find((r) => /the seam does not expose/.test(r));
    assert.ok(lead, "the lakehouse lead must be named separately");
    assert.match(lead!, /without the watermark being republished/);
  });

  test("a gap in the range is caught, not just a stale seam", () => {
    // count != hi - lo + 1. A gap BELOW the seam is unreadable from either
    // tier, so it matters more than the seam being off.
    const { reasons, summary } = evaluateDecodeSeam(
      healthy({ count: HI - 336 }),
    );
    assert.equal(summary.contiguous, false);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /NOT contiguous/);
    assert.match(reasons[0]!, /337 missing/);
  });

  test("independent failures are reported together, not one at a time", () => {
    // Reporting only the first would turn one investigation into four. This is
    // the 2026-08-03 production shape with the D1 read also failing: nothing
    // published, the capture unmeasurable, a gap in the range, and a lakehouse
    // that has decoded 2,664 blocks past the frozen floor.
    const { reasons } = evaluateDecodeSeam(
      healthy({
        watermark: null,
        capturedThrough: null,
        count: HI,
      }),
    );
    assert.equal(reasons.length, 4);
    for (const pattern of [
      /pinned at the configured floor/,
      /raw_capture_state/,
      /NOT contiguous/,
      /the seam does not expose/,
    ]) {
      assert.ok(
        reasons.some((r) => pattern.test(r)),
        String(pattern),
      );
    }
  });

  test("an unmeasurable lakehouse alerts rather than passing", () => {
    // r2SqlQuery returns null on ANY failure. Staying quiet here would make an
    // unreachable lakehouse indistinguishable from a healthy one.
    const { reasons, summary } = evaluateDecodeSeam(
      healthy({ lo: null, hi: null, count: null }),
    );
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /could not measure/);
    assert.equal(summary.seam, HI, "the summary still reports the live seam");
  });

  test("the thresholds are the ones the rationale was written against", () => {
    // Pins them into the suite: a silent widening turns the watchdog off
    // without anyone editing the watchdog.
    assert.equal(DECODE_STALE_MS, 3 * 60 * 60 * 1000);
    assert.equal(DECODE_LAG_BLOCKS, 2_400);
  });
});

/** A Worker env with a bucket, a D1 and (optionally) a watermark body. */
function env(
  opts: {
    body?: unknown;
    captured?: number | null;
    d1Throws?: boolean;
    noBucket?: boolean;
    noDb?: boolean;
  } = {},
) {
  return {
    ...(opts.noBucket
      ? {}
      : {
          METAGRAPH_ARCHIVE: {
            async get(key: string) {
              if (key !== DECODE_WATERMARK_KEY || opts.body === undefined)
                return null;
              return {
                async text() {
                  return JSON.stringify(opts.body);
                },
              };
            },
          },
        }),
    ...(opts.noDb
      ? {}
      : {
          METAGRAPH_HEALTH_DB: {
            prepare() {
              return {
                bind() {
                  return {
                    async first() {
                      if (opts.d1Throws) throw new Error("d1 cold");
                      return opts.captured === undefined
                        ? { last_contiguous_block: HI + 100 }
                        : { last_contiguous_block: opts.captured };
                    },
                  };
                },
              };
            },
          },
        }),
  };
}

const measured =
  (hi = HI) =>
  async () =>
    [{ lo: 0, hi, n: hi + 1 }] as Record<string, unknown>[];

describe("the watchdog tick", () => {
  test("an unconfigured lakehouse is SKIPPED, not reported as drift", async () => {
    // r2SqlQuery returns null both when a query fails and when the lakehouse is
    // simply not configured -- self-hosters and CI have none. Calling that
    // "drift" would make every such deployment alert forever.
    const result = await runLakehouseSeamWatchdog({} as never);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "lakehouse_unavailable");
    assert.equal(result.seam, DEFAULT_BLOCKS_SEAM, "the floor is still named");
    assert.equal(
      result.drifted,
      undefined,
      "an unconfigured tick is not drift",
    );
  });

  test("a healthy production-shaped tick reports the real numbers", async () => {
    // The path that actually runs in production. Without seams to inject the
    // query and the clock, this branch only executes against live
    // infrastructure -- i.e. never in CI.
    const result = await runLakehouseSeamWatchdog(
      env({
        body: { decoded_through: HI, updated_at: "2026-08-03T11:40:00Z" },
      }) as never,
      { query: measured(), now: () => NOW },
    );
    assert.equal(result.ok, true);
    assert.equal(result.drifted, false);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.seam, HI);
    assert.equal(result.captured_through, HI + 100);
    assert.equal(result.lakehouse_hi, HI);
  });

  test("string-typed counts from the query are still compared numerically", async () => {
    // R2 SQL returns aggregates as strings often enough that comparing them raw
    // would make every tick look like drift -- and a watchdog that alerts
    // constantly is one that gets muted.
    const result = await runLakehouseSeamWatchdog(
      env({
        body: { decoded_through: HI, updated_at: "2026-08-03T11:40:00Z" },
      }) as never,
      {
        query: async () =>
          [{ lo: "0", hi: String(HI), n: String(HI + 1) }] as never,
        now: () => NOW,
      },
    );
    assert.equal(
      result.drifted,
      false,
      "a string height must not read as drift",
    );
    assert.equal(result.lakehouse_hi, HI);
  });

  test("the tick reads the CURRENT watermark, not a memoized one", async () => {
    // Staleness is what this measures, so a value up to a serving TTL old
    // would understate it. Prime the memo with a fresh value, then have the
    // bucket serve a stale one: the tick must see the stale one.
    const { resolveDecodeWatermark } =
      await import("../src/decode-watermark.ts");
    await resolveDecodeWatermark(
      env({
        body: { decoded_through: HI, updated_at: "2026-08-03T11:40:00Z" },
      }),
    );
    const result = await runLakehouseSeamWatchdog(
      env({
        body: { decoded_through: HI, updated_at: "2026-08-01T00:00:00Z" },
      }) as never,
      { query: measured(), now: () => NOW },
    );
    assert.equal(result.drifted, true);
    assert.match((result.reasons as string[])[0]!, /has stopped publishing/);
  });

  test("a missing bucket binding surfaces as no watermark, not as a throw", async () => {
    const result = await runLakehouseSeamWatchdog(
      env({ noBucket: true }) as never,
      { query: measured(DEFAULT_BLOCKS_SEAM), now: () => NOW },
    );
    assert.equal(result.ok, true);
    assert.equal(result.drifted, true);
    assert.equal(result.seam, DEFAULT_BLOCKS_SEAM);
    assert.ok(
      (result.reasons as string[]).some((r) =>
        r.includes(DECODE_WATERMARK_KEY),
      ),
    );
  });

  test("a D1 that throws degrades to an unmeasurable capture lag", async () => {
    const result = await runLakehouseSeamWatchdog(
      env({
        body: { decoded_through: HI, updated_at: "2026-08-03T11:40:00Z" },
        d1Throws: true,
      }) as never,
      { query: measured(), now: () => NOW },
    );
    assert.equal(result.captured_through, null);
    assert.match(
      (result.reasons as string[])[0]!,
      /raw_capture_state\.last_contiguous_block/,
    );
  });

  test("an unbound D1 is the same degrade, not a crash", async () => {
    const result = await runLakehouseSeamWatchdog(
      env({
        body: { decoded_through: HI, updated_at: "2026-08-03T11:40:00Z" },
        noDb: true,
      }) as never,
      { query: measured(), now: () => NOW },
    );
    assert.equal(result.ok, true);
    assert.equal(result.captured_through, null);
  });

  test("a non-numeric capture row reads as unmeasurable, not as zero", async () => {
    // A capture watermark of 0 would report an 8.7M-block lag on every tick.
    const result = await runLakehouseSeamWatchdog(
      env({
        body: { decoded_through: HI, updated_at: "2026-08-03T11:40:00Z" },
        captured: null,
      }) as never,
      { query: measured(), now: () => NOW },
    );
    assert.equal(result.captured_through, null);
  });

  test("an EMPTY chain.blocks alerts instead of reading as a healthy zero", async () => {
    // `SELECT min(...), max(...) FROM <empty>` returns NULL aggregates rather
    // than failing, so the query succeeds and the row exists -- it just says
    // nothing. Coercing those to 0 would report a seam 8.7M blocks "ahead" of
    // an empty lakehouse; treating them as unmeasured says the truth.
    const result = await runLakehouseSeamWatchdog(
      env({
        body: { decoded_through: HI, updated_at: "2026-08-03T11:40:00Z" },
      }) as never,
      { query: async () => [{ lo: null, hi: null, n: null }], now: () => NOW },
    );
    assert.equal(result.ok, true);
    assert.equal(result.drifted, true);
    assert.match((result.reasons as string[])[0]!, /could not measure/);
  });

  test("the real clock is used when none is injected", async () => {
    // Default-parameter branches are exactly the ones a fully-injected suite
    // never executes, and this one decides whether the lane looks stale.
    const result = await runLakehouseSeamWatchdog(
      env({
        body: { decoded_through: HI, updated_at: new Date().toISOString() },
      }) as never,
      { query: measured() },
    );
    assert.equal(result.drifted, false);
  });
});

describe("the cron wiring", () => {
  test("the schedule reaches the watchdog", async () => {
    // Without this the branch in handleScheduled is unverified, and a cron
    // entry that dispatches nowhere fails SILENTLY -- the schedule fires, the
    // Worker returns, and nothing is ever checked.
    const { default: worker } = await import("../workers/api.ts");
    const { LAKEHOUSE_SEAM_CRON } = await import("../workers/config.ts");
    const result = (await worker.scheduled(
      { cron: LAKEHOUSE_SEAM_CRON, scheduledTime: Date.now() } as never,
      // No R2_SQL_* bindings, so r2SqlQuery declines and the tick reports
      // itself skipped -- which is exactly the shape that proves the branch
      // ran rather than falling through to the health prober.
      {} as never,
      { waitUntil: () => {} } as never,
    )) as Record<string, unknown>;
    assert.equal(
      result.reason,
      "lakehouse_unavailable",
      "the seam cron did not reach runLakehouseSeamWatchdog -- an unmatched " +
        "cron falls through to the health prober and checks nothing",
    );
  });

  test("the cron constant matches a wrangler schedule", async () => {
    // A constant with no matching wrangler entry never fires at all, and a
    // wrangler entry with no matching constant falls through to the health
    // prober. Both are silent.
    const { readFileSync } = await import("node:fs");
    const { LAKEHOUSE_SEAM_CRON } = await import("../workers/config.ts");
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    assert.ok(
      wrangler.includes(`"${LAKEHOUSE_SEAM_CRON}"`),
      `wrangler.jsonc declares no "${LAKEHOUSE_SEAM_CRON}" cron, so this watchdog never runs`,
    );
  });

  test("the cadence can resolve the staleness threshold it enforces", async () => {
    // A daily tick cannot tell a 3-hour stall from a 20-hour one. Whatever the
    // cron is, it must fire at least as often as the threshold it judges.
    const { LAKEHOUSE_SEAM_CRON } = await import("../workers/config.ts");
    const [, hour] = LAKEHOUSE_SEAM_CRON.split(" ");
    assert.equal(
      hour,
      "*",
      `${LAKEHOUSE_SEAM_CRON} samples less often than hourly, so a ` +
        `${DECODE_STALE_MS / 3_600_000}h staleness threshold cannot be observed on time`,
    );
  });
});
