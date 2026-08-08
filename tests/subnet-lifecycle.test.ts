// Subnet registration/deregistration detection (#10262).
//
// THE TABLE IS APPEND-ONLY, which is what makes the gate the important part. A
// netuid missing because the scan died is not a deregistration, and a false
// `deregistered` row can never be revised by a later pass. The scan does die --
// `lane_health` recorded `scan Delegates: Encountered an error iterating over
// storage` twice within one hour on 2026-08-08.
//
// So the assertions below are weighted toward what must NOT be written: a short
// pass writes nothing, a first run does not claim 129 registrations, and a
// seeded row does not claim a block it cannot know.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { pgMockEnv } from "./helpers/pg-mock.ts";
import {
  SUBNET_LIFECYCLE_LANE,
  diffSubnetSets,
  lifecycleDetail,
  runSubnetLifecycleLane,
} from "../src/subnet-lifecycle.ts";

const set = (...n: number[]) => new Set(n);

describe("diffSubnetSets", () => {
  test("a new netuid is a registration, carrying the pass's block", () => {
    const d = diffSubnetSets(set(1, 2), set(1, 2, 3), 8_800_000);
    assert.equal(d.seeded, false);
    assert.deepEqual(d.events, [
      {
        netuid: 3,
        event: "registered",
        block_number: 8_800_000,
        predates_capture: false,
      },
    ]);
  });

  test("a vanished netuid is a deregistration", () => {
    const d = diffSubnetSets(set(1, 2, 3), set(1, 3), 8_800_000);
    assert.deepEqual(d.events, [
      {
        netuid: 2,
        event: "deregistered",
        block_number: 8_800_000,
        predates_capture: false,
      },
    ]);
  });

  test("no change emits nothing", () => {
    assert.deepEqual(diffSubnetSets(set(1, 2, 3), set(1, 2, 3), 1).events, []);
  });

  test("the FIRST run seeds rather than claiming 129 registrations today", () => {
    // With an empty table every live subnet would otherwise be recorded as
    // newly registered at the moment this lane was deployed -- false, and
    // permanently so in an append-only table.
    const d = diffSubnetSets(set(), set(0, 1, 2), 8_800_000);
    assert.equal(d.seeded, true);
    assert.equal(d.events.length, 3);
    for (const e of d.events) {
      assert.equal(e.event, "registered");
      assert.equal(e.predates_capture, true, "these predate capture");
      assert.equal(
        e.block_number,
        null,
        "a seeded row cannot claim a block: the head is not when it happened",
      );
    }
  });

  test("the seeding run emits NO deregistrations", () => {
    // An empty `known` set means nothing is known to have left -- not that
    // everything did.
    const d = diffSubnetSets(set(), set(1), 1);
    assert.equal(d.events.filter((e) => e.event === "deregistered").length, 0);
  });

  test("re-registration is a second event, not a mutation", () => {
    // known={1} means 1's newest event was `registered`; it vanishes, then
    // returns. Two separate diffs, two separate rows.
    const gone = diffSubnetSets(set(1), set(), 100);
    assert.equal(gone.events[0]!.event, "deregistered");
    const back = diffSubnetSets(set(), set(1), 200);
    assert.equal(back.events[0]!.event, "registered");
  });

  test("events come out in netuid order, registrations before deregistrations", () => {
    const d = diffSubnetSets(set(5, 6), set(1, 5), 1);
    assert.deepEqual(
      d.events.map((e) => [e.netuid, e.event]),
      [
        [1, "registered"],
        [6, "deregistered"],
      ],
    );
  });
});

describe("lifecycleDetail", () => {
  test("names the netuids, because a count sends nobody anywhere", () => {
    const d = diffSubnetSets(set(1, 2), set(1, 3), 9);
    assert.match(lifecycleDetail(d, 2), /registered 3/);
    assert.match(lifecycleDetail(d, 2), /deregistered 2/);
  });

  test("a quiet tick says how many it saw, not just 'ok'", () => {
    const d = diffSubnetSets(set(1), set(1), 9);
    assert.match(lifecycleDetail(d, 129), /no change, 129 subnet\(s\)/);
  });

  test("a seeding run says it seeded", () => {
    const d = diffSubnetSets(set(), set(1, 2), 9);
    assert.match(lifecycleDetail(d, 2), /seeded 2 subnet\(s\) as predating/);
  });
});

describe("the lane tick", () => {
  beforeEach(() => {
    pg.control.queries.length = 0;
    pg.control.answers.length = 0;
    pg.control.failNext = null;
  });

  /** `observed` = netuids in neurons' newest pass; `known` = rows already in
   *  subnet_lifecycle. */
  function answer(observed: number[], known: [number, string][] = []) {
    pg.control.answers.push({
      match: /FROM neurons/,
      rows: observed.map((netuid) => ({ netuid, block_number: 8_800_000 })),
    });
    pg.control.answers.push({
      match: /FROM subnet_lifecycle/,
      rows: known.map(([netuid, event]) => ({ netuid, event })),
    });
    pg.control.answers.push({ match: /.*/, rows: [] });
  }

  const inserts = () =>
    pg.control.queries.filter((q) =>
      q.text.includes("INSERT INTO subnet_lifecycle"),
    );

  const verdict = () => {
    const q = pg.control.queries.find((x) =>
      x.text.includes("INSERT INTO lane_health"),
    );
    assert.ok(q, "a verdict was recorded");
    return { lane: q.values[0], verdict: q.values[1], detail: q.values[3] };
  };

  const env = () =>
    pgMockEnv([...["neurons", "subnet_lifecycle"], "lane_health"]);

  test("A SHORT PASS WRITES NOTHING — the assertion that matters", async () => {
    // 40 of 129 is what a scan dying partway looks like. In an append-only
    // table a false deregistration is permanent; writing nothing is always
    // recoverable, because the next complete pass sees the same difference.
    answer(
      Array.from({ length: 40 }, (_, i) => i),
      [[0, "registered"]],
    );
    const r = (await runSubnetLifecycleLane(env(), {
      now: () => 1_800_000_000_000,
    })) as { ok: boolean; reason?: string };
    assert.equal(r.reason, "partial");
    assert.equal(inserts().length, 0, "no lifecycle rows written");
    const v = verdict();
    assert.equal(v.verdict, "stale");
    assert.match(String(v.detail), /under the \d+ floor -- no events written/);
  });

  test("a complete pass with a new netuid writes one registration", async () => {
    const live = Array.from({ length: 130 }, (_, i) => i);
    const known: [number, string][] = live
      .slice(0, 129)
      .map((n) => [n, "registered"]);
    answer(live, known);
    await runSubnetLifecycleLane(env(), { now: () => 1_800_000_000_000 });
    const rows = inserts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.values[0], 129, "the new netuid");
    assert.equal(rows[0]!.values[1], "registered");
    assert.equal(verdict().verdict, "ok");
  });

  test("a complete pass with a vanished netuid writes one deregistration", async () => {
    const known: [number, string][] = Array.from({ length: 130 }, (_, i) => [
      i,
      "registered",
    ]);
    answer(
      Array.from({ length: 130 }, (_, i) => i).filter((n) => n !== 42),
      known,
    );
    await runSubnetLifecycleLane(env(), { now: () => 1_800_000_000_000 });
    const rows = inserts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.values[0], 42);
    assert.equal(rows[0]!.values[1], "deregistered");
  });

  test("a netuid whose newest event is `deregistered` is not counted as live", async () => {
    // The known set is built from the NEWEST event per netuid. A subnet that
    // left and came back must register again rather than be silently present.
    const live = Array.from({ length: 129 }, (_, i) => i);
    const known: [number, string][] = live.map((n) => [
      n,
      n === 7 ? "deregistered" : "registered",
    ]);
    answer(live, known);
    await runSubnetLifecycleLane(env(), { now: () => 1_800_000_000_000 });
    const rows = inserts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.values[0], 7);
    assert.equal(rows[0]!.values[1], "registered", "re-registered");
  });

  test("a failing read is reported, not rendered as 'no change'", async () => {
    pg.control.failNext = new Error("connection reset");
    const r = (await runSubnetLifecycleLane(env(), {
      now: () => 1_800_000_000_000,
    })) as { ok: boolean; reason?: string };
    assert.equal(r.ok, false);
    assert.equal(r.reason, "query_failed");
    assert.equal(inserts().length, 0);
  });

  test("no store declines rather than reporting an empty network", async () => {
    const r = (await runSubnetLifecycleLane({}, {})) as {
      ok: boolean;
      reason?: string;
    };
    assert.equal(r.ok, false);
    assert.match(r.reason!, /no store/i);
  });

  test("the lane name is stable", () => {
    assert.equal(SUBNET_LIFECYCLE_LANE, "subnet-lifecycle");
  });
});

describe("the lane runs on an existing tick, not a new cron", () => {
  test("it is invoked from the neurons-staleness branch", async () => {
    // #10262 needs exactly what that watchdog already reads -- the netuid set
    // at neurons' newest stamp, and whether the pass cleared the coverage
    // floor. A trigger of its own would re-read the same pass on a different
    // schedule and add a 35th cron expression to the 34 #10226 exists to
    // collapse. This asserts it stayed folded in.
    const { readFileSync } = await import("node:fs");
    const api = readFileSync(
      new URL("../workers/api.ts", import.meta.url),
      "utf8",
    );
    const branch = api.slice(
      api.indexOf("NEURONS_STALENESS_WATCHDOG_CRON) {"),
      api.indexOf("NEURONS_STALENESS_WATCHDOG_CRON) {") + 1400,
    );
    assert.match(branch, /runSubnetLifecycleLane\(/);
    assert.doesNotMatch(
      api,
      /SUBNET_LIFECYCLE_CRON/,
      "it must not gain a cron expression of its own",
    );
  });

  test("its failure cannot cost the estate the staleness verdict", async () => {
    // The alarm is the load-bearing half. The lifecycle write is deliberately
    // after it, detached, and its rejection swallowed.
    const { readFileSync } = await import("node:fs");
    const api = readFileSync(
      new URL("../workers/api.ts", import.meta.url),
      "utf8",
    );
    const i = api.indexOf("NEURONS_STALENESS_WATCHDOG_CRON) {");
    const branch = api.slice(i, i + 1400);
    assert.ok(
      branch.indexOf("runNeuronsStalenessWatchdog") <
        branch.indexOf("runSubnetLifecycleLane"),
      "the watchdog runs first",
    );
    assert.match(branch, /runSubnetLifecycleLane[\s\S]*?\.catch\(/);
  });

  test("a ctx with no waitUntil is awaited, not thrown on", async () => {
    // A bare `{}` ctx reaches the scheduled dispatcher from callers that have
    // none to give, and `ctx.waitUntil(...)` on it throws -- which would take
    // the staleness alarm down with it, the exact outcome the guard exists to
    // prevent. Awaiting is the fallback rather than dropping the promise,
    // because a floating promise in an isolate about to end is work silently
    // not done.
    const { readFileSync } = await import("node:fs");
    const api = readFileSync(
      new URL("../workers/api.ts", import.meta.url),
      "utf8",
    );
    const i = api.indexOf("NEURONS_STALENESS_WATCHDOG_CRON) {");
    const branch = api.slice(i, i + 2000);
    assert.match(branch, /typeof ctx\?\.waitUntil === "function"/);
    assert.match(branch, /else await lifecycle/);
  });
});
