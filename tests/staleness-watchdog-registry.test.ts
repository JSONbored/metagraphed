import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { STALENESS_WATCHDOGS } from "../workers/api.ts";
import * as workerConfig from "../workers/config.ts";

/** The heartbeat's tick interval, derived from the cron rather than restated. */
function tickMinutes(cron: string): number {
  const minutes = cron
    .split(" ")[0]!
    .split(",")
    .map(Number)
    .sort((a, b) => a - b);
  const gaps = minutes.map(
    (m, i) => (minutes[(i + 1) % minutes.length]! - m + 60) % 60,
  );
  return Math.min(...gaps.map((g) => (g === 0 ? 60 : g)));
}

// The eight per-lane cron tests these replace asserted the same three things
// about eight expressions. There is one expression now, so they are asserted
// once -- but they are still asserted: a heartbeat that wrangler never fires is
// eight silent alarms, not one.
describe("the watchdog heartbeat's own cron (#10849)", () => {
  test("no other cron in workers/config.ts shares the literal string", () => {
    // Dispatch keys on the LITERAL cron string, so a duplicate silently routes
    // this lane into another branch entirely.
    const crons = Object.entries(workerConfig)
      .filter(([key]) => key.endsWith("_CRON"))
      .flatMap(([, value]) => (typeof value === "string" ? [value] : []));
    const mine = workerConfig.WATCHDOG_HEARTBEAT_CRON;
    assert.equal(
      crons.filter((cron) => cron === mine).length,
      1,
      `${mine} is declared by more than one lane`,
    );
  });

  test("wrangler.jsonc declares the trigger", () => {
    // A cron the Worker dispatches on but wrangler never fires is dead code,
    // and the failure is silent: the branch simply never runs. With eight lanes
    // behind it, that is the whole staleness family going quiet.
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    )
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(raw) as { triggers?: { crons?: string[] } };
    assert.ok(
      parsed.triggers?.crons?.includes(workerConfig.WATCHDOG_HEARTBEAT_CRON),
      "the heartbeat is not in wrangler.jsonc",
    );
  });

  test("it stays off the five- and fifteen-minute grids", () => {
    // Both fire on every minute divisible by 5, so a lane sharing one contends
    // with the raw-capture and probe lanes on the same tick.
    for (const part of workerConfig.WATCHDOG_HEARTBEAT_CRON.split(
      " ",
    )[0]!.split(",")) {
      assert.equal(Number.isInteger(Number(part)), true);
      assert.notEqual(
        Number(part) % 5,
        0,
        `:${part} sits on the 5-minute grid`,
      );
    }
  });

  test("it ticks at 15 minutes, which is what makes the cadences exact", () => {
    assert.equal(tickMinutes(workerConfig.WATCHDOG_HEARTBEAT_CRON), 15);
  });
});

describe("the staleness watchdog registry", () => {
  test("every lane has a distinct name", () => {
    // The name is the `lane_health.lane` key the cadence gate reads. Two lanes
    // sharing one would make each read the other's last run.
    const names = STALENESS_WATCHDOGS.map((lane) => lane.name);
    assert.equal(new Set(names).size, names.length);
  });

  // THE MIGRATION, PINNED. These eight cadences are what the eight cron
  // expressions ran at before #10849 item 5 collapsed them. A staleness alarm
  // sells detection latency and nothing else, so a change here is a change to
  // the product -- it should have to be typed deliberately.
  test("each lane keeps the cadence its own cron used to run at", () => {
    assert.deepEqual(
      Object.fromEntries(
        STALENESS_WATCHDOGS.map((lane) => [lane.name, lane.everyMinutes]),
      ),
      {
        // was 6,21,36,51
        "neurons-staleness": 15,
        // was 14,29,44,59
        "chain-detail-staleness": 15,
        // was 2,32
        "projection-staleness": 30,
        // was 8,38
        "nominator-positions-staleness": 30,
        // was 19,49
        "validator-nominator-counts-staleness": 30,
        // was 4,34
        "account-balances-staleness": 30,
        // was 22,52
        "top-holders-flow-staleness": 30,
        // was 54
        "hotkey-alpha-staleness": 60,
        // NOT one of the eight, and it never had a cron of its own: it was
        // added because the five lanes in metagraphed-infra's decode container
        // had NO watchdog at all -- `lane_health` held zero rows for them, and
        // the account-summary projection went dark for 32 hours unnoticed.
        // Hourly because that is the container's own pass cadence; a
        // quarter-hourly tick would buy four times the R2 GETs and no earlier
        // detection.
        "container-lanes": 60,
      },
    );
  });

  test("every cadence is a MULTIPLE of the tick, so declared equals effective", () => {
    // The grid quantises: a lane declaring 20 minutes against a 15-minute tick
    // runs every 30, not every 20. Only multiples of the tick get the cadence
    // they ask for, and a watchdog quietly running at two-thirds the rate it
    // declares is the exact failure this consolidation must not introduce.
    const tick = tickMinutes(workerConfig.WATCHDOG_HEARTBEAT_CRON);
    for (const lane of STALENESS_WATCHDOGS) {
      assert.equal(
        lane.everyMinutes % tick,
        0,
        `${lane.name} declares ${lane.everyMinutes}m against a ${tick}m tick`,
      );
      assert.ok(
        lane.everyMinutes >= tick,
        `${lane.name} asks to run faster than the heartbeat ticks`,
      );
    }
  });

  // The end-to-end half the per-lane tests gave up when they moved to calling
  // their registry entry directly: that the CRON still reaches the REGISTRY.
  // Without this, every lane could be correctly registered behind a heartbeat
  // that dispatch never routes to, and all eight would go quiet together.
  test("the heartbeat cron dispatches into the registry", async () => {
    const { handleScheduled } = await import("../workers/api.ts");
    const result = (await handleScheduled(
      { cron: workerConfig.WATCHDOG_HEARTBEAT_CRON } as never,
      // A bare env: every lane fails or declines, and the heartbeat isolates
      // each one. That is the point -- the tick still reports, and reports per
      // lane, rather than the first failure taking the other seven with it.
      {} as never,
      {} as never,
    )) as { ok: boolean; ran: unknown[]; skipped: number };
    assert.ok(Array.isArray(result.ran), "the tick reports per lane");
    assert.equal(
      result.ran.length + result.skipped,
      STALENESS_WATCHDOGS.length,
      "every registered lane is accounted for as run or not-due",
    );
  });

  test("the eight lanes gave up eight cron expressions", () => {
    // The point of the exercise. If a lane reappears on the grid with a cron of
    // its own, it is both on the heartbeat and on a trigger -- running twice.
    const staleCrons = Object.keys(workerConfig).filter((key) =>
      key.endsWith("_STALENESS_WATCHDOG_CRON"),
    );
    assert.deepEqual(
      staleCrons,
      [],
      "a staleness lane took a cron minute back",
    );
    // Eight consolidated lanes plus `container-lanes`, which joined the
    // heartbeat rather than claiming a ninth cron minute -- the whole point of
    // the registry being the place a lane's cadence lives.
    assert.equal(STALENESS_WATCHDOGS.length, 9);
  });
});
