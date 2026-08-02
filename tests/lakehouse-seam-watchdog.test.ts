// The seam-drift rule (#9161), tested without a lakehouse.
//
// Runs as a WORKER CRON, not a GitHub Action (#9164): the check is one R2 SQL
// query and this Worker already holds R2_SQL_TOKEN, so an Actions job would
// need the same secret duplicated repo-side plus a third-party trigger hop to
// ask a question the Worker can ask itself.
//
// `DEFAULT_BLOCKS_SEAM` routes every cold block read, and a seam that lags the
// lakehouse does not fail loudly -- it serves reduced-column rows for a range
// where verified ones exist. The constant went stale exactly that way: a
// decoder extended chain.blocks 2,338 blocks past it and nothing re-measured.
//
// So the rule has to alert on a lag, on a lead, and on a gap -- and stay quiet
// otherwise, because a check that cries wolf gets switched off before the one
// time it matters.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  evaluateSeam,
  runLakehouseSeamWatchdog,
} from "../src/lakehouse-seam-watchdog.ts";
import { DEFAULT_BLOCKS_SEAM } from "../src/blocks-cold-tier.ts";

/** A contiguous lakehouse ending at `hi`. */
function contiguous(hi: number, lo = 0) {
  return { lo, hi, count: hi - lo + 1 };
}

describe("the lakehouse seam-drift rule (#9161)", () => {
  test("a seam exactly at the lakehouse ceiling is quiet", () => {
    const { reasons, summary } = evaluateSeam({
      seam: 8_759_336,
      ...contiguous(8_759_336),
    });
    assert.deepEqual(reasons, []);
    assert.equal(summary.drift, 0);
    assert.equal(summary.contiguous, true);
  });

  test("a lagging seam is reported with the range it would downgrade", () => {
    // The real bug. The message has to name the blocks, because "drift: 2338"
    // alone does not tell a reader what breaks.
    const { reasons } = evaluateSeam({
      seam: 8_756_998,
      ...contiguous(8_759_336),
    });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /lags the lakehouse by 2338/);
    assert.match(reasons[0], /8756999\.\.8759336/);
    assert.match(reasons[0], /null author\/spec_version\/event_count/);
  });

  test("a seam AHEAD of the lakehouse is reported too, and differently", () => {
    // The opposite failure, and it is worse: those blocks route to a lakehouse
    // that cannot answer, so they read as missing rather than as reduced.
    const { reasons } = evaluateSeam({
      seam: 8_760_000,
      ...contiguous(8_759_336),
    });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /664 block\(s\) AHEAD/);
    assert.match(reasons[0], /read as missing/);
  });

  test("a gap in the range is caught, not just a stale ceiling", () => {
    // count != hi - lo + 1. A gap BELOW the seam is unreadable from either
    // tier, so it matters more than the ceiling being off.
    const { reasons, summary } = evaluateSeam({
      seam: 8_759_336,
      lo: 0,
      hi: 8_759_336,
      count: 8_759_000,
    });
    assert.equal(summary.contiguous, false);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /NOT contiguous/);
    assert.match(reasons[0], /337 missing/);
  });

  test("a gap and a drift are reported together, not one at a time", () => {
    // Reporting only the first would turn one investigation into two.
    const { reasons } = evaluateSeam({
      seam: 8_756_998,
      lo: 0,
      hi: 8_759_336,
      count: 8_759_000,
    });
    assert.equal(reasons.length, 2);
  });

  test("an unmeasurable lakehouse alerts rather than passing", () => {
    // r2SqlQuery returns null on ANY failure. Staying quiet here would make an
    // unreachable lakehouse indistinguishable from a healthy one -- the exact
    // false negative that makes a monitor worthless.
    const { reasons } = evaluateSeam({
      seam: 8_759_336,
      lo: null,
      hi: null,
      count: null,
    });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /could not measure/);
  });

  test("the shipped constant is the one the check would pass", () => {
    // Pins the measured value into the suite: the constant and the number this
    // rule was verified against cannot drift apart without a test failing.
    assert.equal(
      DEFAULT_BLOCKS_SEAM,
      8_759_336,
      "DEFAULT_BLOCKS_SEAM changed -- re-measure max(chain.blocks) and update " +
        "this expectation in the same commit, or the seam is unverified",
    );
    assert.deepEqual(
      evaluateSeam({
        seam: DEFAULT_BLOCKS_SEAM,
        ...contiguous(8_759_336),
      }).reasons,
      [],
    );
  });

  test("an unconfigured lakehouse is SKIPPED, not reported as drift", async () => {
    // r2SqlQuery returns null both when a query fails and when the lakehouse is
    // simply not configured -- self-hosters and CI have none. Calling that
    // "drift" would make every such deployment alert forever; the tick reports
    // itself as skipped instead.
    const result = await runLakehouseSeamWatchdog({} as never);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "lakehouse_unavailable");
    assert.equal(
      result.drifted,
      undefined,
      "an unconfigured tick is not drift",
    );
  });

  test("the cron is wired: the schedule reaches the watchdog", async () => {
    // Without this the branch in handleScheduled is unverified, and a cron
    // entry that dispatches nowhere fails SILENTLY -- the schedule fires, the
    // Worker returns, and nothing is ever checked. Same reason the other
    // Worker-native crons carry a dispatch test.
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

  test("a measured lakehouse reports the real numbers, not a placeholder", async () => {
    // The path that actually runs in production. Without a seam to inject the
    // query, this branch only executes against a live lakehouse -- i.e. never
    // in CI -- so a regression in the measured path would ship unnoticed.
    const result = await runLakehouseSeamWatchdog({} as never, {
      query: async () => [{ lo: 0, hi: 8_759_336, n: 8_759_337 }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.drifted, false);
    assert.equal(result.lakehouse_hi, 8_759_336);
    assert.equal(result.contiguous, true);
    assert.deepEqual(result.reasons, []);
  });

  test("string-typed counts from the query are still compared numerically", async () => {
    // R2 SQL returns aggregates as strings often enough that comparing them
    // raw would make `seam !== hi` true for every tick -- a watchdog that
    // alerts constantly is one that gets muted.
    const result = await runLakehouseSeamWatchdog({} as never, {
      query: async () => [{ lo: "0", hi: "8759336", n: "8759337" }] as never,
    });
    assert.equal(
      result.drifted,
      false,
      "a string height must not read as drift",
    );
    assert.equal(result.lakehouse_hi, 8_759_336);
  });

  test("a measured drift is reported through the runner, not just the rule", async () => {
    const result = await runLakehouseSeamWatchdog({} as never, {
      query: async () => [{ lo: 0, hi: 8_760_000, n: 8_760_001 }],
    });
    assert.equal(result.drifted, true);
    assert.match((result.reasons as string[])[0], /lags the lakehouse by 664/);
  });

  test("an EMPTY chain.blocks alerts instead of reading as a healthy zero", async () => {
    // `SELECT min(...), max(...) FROM <empty>` returns NULL aggregates rather
    // than failing, so the query succeeds and the row exists -- it just says
    // nothing. Coercing those to 0 would report a seam 8.7M blocks "ahead" of
    // an empty lakehouse; treating them as unmeasured says the truth.
    const result = await runLakehouseSeamWatchdog({} as never, {
      query: async () => [{ lo: null, hi: null, n: null }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.drifted, true);
    assert.match((result.reasons as string[])[0], /could not measure/);
  });
});
