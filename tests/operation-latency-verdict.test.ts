// The latency sweep's VERDICT, without calling production (#10220).
//
// The sweep itself is out of band -- it needs the deployed surface and ~620
// serial calls -- so what runs in CI is the part that decides. `summarise` is
// split out of `run` for exactly this: feed it recorded timings and check that
// each of the four rulings is the one a reader would expect.
//
// Worth having because three of those rulings are easy to get subtly wrong, and
// two of them WERE wrong in the first draft of this script: a 4xx counted as
// "the operation failed" when it means "the sweep asked badly", and a declared
// entry went stale the moment its operation dipped a millisecond under budget,
// which for a stochastic measurement is a gate that fails on weather.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  confirmOverBudget,
  family,
  summarise,
  type Timing,
} from "../scripts/check-operation-latency.ts";

/**
 * A declared READ, and the three operations that publish it, so the fixtures
 * below name something real on every surface.
 */
const DECLARED_OPERATION = "/api/v1/accounts/{ss58}/counterparties";
const [DECLARED_SURFACE, DECLARED_NAME] = ["mcp", "get_account_counterparties"];
const DECLARED_GRAPHQL_FIELD = "account_counterparties";

const timing = (over: Partial<Timing> = {}): Timing => ({
  surface: "rest",
  operation: "/api/v1/subnets",
  ms: 100,
  answer: "ok",
  ...over,
});

describe("what the latency sweep rules on", () => {
  test("an undeclared operation over budget is reported", () => {
    const report = summarise([timing({ ms: 9000 })]);
    assert.equal(report.overBudget.length, 1);
    assert.equal(report.overBudget[0].operation, "/api/v1/subnets");
  });

  test("a declared operation over budget is not", () => {
    const report = summarise([
      timing({ surface: "mcp", operation: DECLARED_NAME, ms: 9000 }),
    ]);
    assert.deepEqual(report.overBudget, []);
    assert.ok(
      !report.stale.includes(DECLARED_OPERATION),
      "still slow, so still warranted",
    );
  });

  test("a declared operation just under budget is NOT stale", () => {
    // 4900ms against a 5000ms budget is the same operation having a good run.
    // Calling that stale is how a stochastic gate starts failing on weather.
    const report = summarise([
      timing({ surface: "mcp", operation: DECLARED_NAME, ms: 4900 }),
    ]);
    assert.ok(!report.stale.includes(DECLARED_OPERATION));
  });

  test("a declared operation comfortably under budget IS stale", () => {
    // 400ms against a 5000ms budget is a fix, not a good run, and the entry
    // has to come out or the list stops meaning anything.
    const report = summarise([
      timing({ surface: "mcp", operation: DECLARED_NAME, ms: 400 }),
    ]);
    assert.ok(
      report.stale.includes(DECLARED_OPERATION),
      `expected ${DECLARED_OPERATION} to be stale, got ${report.stale.length} stale`,
    );
  });

  test("a 4xx is the sweep's bad question, not a failure or a slow answer", () => {
    const report = summarise([
      timing({ ms: 9000, answer: "unaskable" }),
      timing({ operation: "/api/v1/other", ms: 20, answer: "failed" }),
    ]);
    assert.deepEqual(report.overBudget, [], "an unasked call is not slow");
    assert.equal(report.failed.length, 1, "only the 5xx is a failure");
    assert.equal(report.unaskable.length, 1);
    assert.equal(report.failed[0].operation, "/api/v1/other");
  });

  test("an operation that could not be asked keeps its declared entry", () => {
    // A 404 from a subject that no longer exists says nothing about speed, so
    // treating it as "under budget" would delete a warranted exemption.
    const report = summarise([
      timing({
        surface: DECLARED_SURFACE as Timing["surface"],
        operation: DECLARED_NAME,
        ms: 30,
        answer: "unaskable",
      }),
    ]);
    assert.ok(!report.stale.includes(DECLARED_OPERATION));
  });
});

// The keying itself. These are the cases that made the per-surface ledger
// churn: one read, three surfaces, one sample each (#10312).
describe("a read is one entry, not three", () => {
  test("all three surfaces of a read resolve to the same family", () => {
    const rest = family({
      surface: "rest",
      operation: "/api/v1/accounts/{ss58}/counterparties",
    });
    const mcp = family({ surface: "mcp", operation: DECLARED_NAME });
    const graphql = family({
      surface: "graphql",
      operation: DECLARED_GRAPHQL_FIELD,
    });
    assert.equal(rest, DECLARED_OPERATION);
    assert.equal(mcp, DECLARED_OPERATION);
    assert.equal(graphql, DECLARED_OPERATION);
  });

  // The defect this keying exists to fix, as a test. Under per-surface keying
  // the fast MCP draw made the entry read STALE while the same read was over
  // budget on the other two surfaces in the same sweep -- exactly what
  // `/api/v1/sudo` did on 2026-08-10.
  test("a fast draw on one surface does NOT make the read stale", () => {
    const report = summarise([
      timing({ surface: "mcp", operation: DECLARED_NAME, ms: 400 }),
      timing({
        surface: "graphql",
        operation: DECLARED_GRAPHQL_FIELD,
        ms: 5408,
      }),
    ]);
    assert.ok(
      !report.stale.includes(DECLARED_OPERATION),
      "a sibling surface is still over the line, so the entry is warranted",
    );
  });

  test("a read is stale only when every surface is comfortably under", () => {
    const report = summarise([
      timing({ surface: "mcp", operation: DECLARED_NAME, ms: 400 }),
      timing({
        surface: "graphql",
        operation: DECLARED_GRAPHQL_FIELD,
        ms: 380,
      }),
      timing({ operation: DECLARED_OPERATION, ms: 410 }),
    ]);
    assert.ok(report.stale.includes(DECLARED_OPERATION));
  });

  // A declared read covers the surfaces it is published on, so a sibling going
  // over does not read as a brand-new violation needing its own entry.
  test("a declared read covers every surface that serves it", () => {
    const report = summarise([
      timing({
        surface: "graphql",
        operation: DECLARED_GRAPHQL_FIELD,
        ms: 9000,
      }),
    ]);
    assert.deepEqual(report.overBudget, []);
  });

  // An operation that mirrors no route has no siblings to be confused with,
  // so per-surface keying is already right for it.
  test("an operation with no route falls back to surface:operation", () => {
    assert.equal(
      family({ surface: "mcp", operation: "get_subnet_snapshot" }),
      "mcp:get_subnet_snapshot",
    );
  });
});

// The confirmation pass (#11420). The sweep's verdict used to rest on ONE draw
// per operation, and the distribution it draws from is 16.7x wide: measured
// against production 2026-08-16, eleven cold `/api/v1/blocks/{ref}` point
// lookups ran 898ms to 15,032ms around a 3,647ms median. Both "under budget"
// and "at the 15s ceiling" are ordinary draws from that, so a single sample
// decided the verdict by when the sweep happened to call.
describe("confirming an over-budget draw before believing it", () => {
  /** A retime map whose draws are scripted, and which counts what it served. */
  function draws(script: Record<string, number[]>) {
    const calls: string[] = [];
    const map = new Map<string, () => Promise<[number, "ok"]>>();
    for (const [key, values] of Object.entries(script)) {
      let i = 0;
      map.set(key, async () => {
        calls.push(key);
        return [values[Math.min(i++, values.length - 1)]!, "ok"];
      });
    }
    return { map, calls };
  }

  test("an operation that was slow ONCE is scored on its median, not that draw", async () => {
    const timing: Timing = {
      surface: "rest",
      operation: "/api/v1/blocks/{ref}",
      ms: 15032,
      answer: "ok",
      samples: [15032],
    };
    const { map, calls } = draws({ "rest:/api/v1/blocks/{ref}": [898, 3647] });
    await confirmOverBudget([timing], map, 0);
    assert.deepEqual(timing.samples, [15032, 898, 3647]);
    assert.equal(
      timing.ms,
      3647,
      "the median of the three, not the first draw",
    );
    assert.equal(calls.length, 2, "two MORE draws, for three total");
    // And the verdict that follows from it: no longer over budget.
    assert.deepEqual(summarise([timing]).overBudget, []);
  });

  test("an operation that is genuinely slow stays over budget", async () => {
    // The control. Without it, "score on the median" could be satisfied by
    // anything that lowers the number, and a real regression would vanish.
    const timing: Timing = {
      surface: "rest",
      operation: "/api/v1/blocks/{ref}",
      ms: 12000,
      answer: "ok",
      samples: [12000],
    };
    const { map } = draws({ "rest:/api/v1/blocks/{ref}": [11500, 13000] });
    await confirmOverBudget([timing], map, 0);
    assert.equal(timing.ms, 12000);
    assert.equal(summarise([timing]).overBudget.length, 1);
  });

  test("an operation UNDER budget is never re-drawn", async () => {
    // The cost control: re-timing all ~600 operations would triple a sweep that
    // already runs the better part of an hour, against a warehouse this account
    // has been rate-limited on (#9465).
    const timing: Timing = {
      surface: "rest",
      operation: "/api/v1/subnets",
      ms: 300,
      answer: "ok",
      samples: [300],
    };
    const { map, calls } = draws({ "rest:/api/v1/subnets": [9000, 9000] });
    await confirmOverBudget([timing], map, 0);
    assert.deepEqual(calls, [], "no confirmation calls for a fast operation");
    assert.equal(timing.ms, 300);
  });

  test("a re-draw that stops answering `ok` does not become a sample", async () => {
    // A 4xx on the second draw is the sweep's own subject going stale mid-run.
    // Counting it as a time would let an unaskable call decide a latency
    // verdict -- the exact conflation `answer` exists to prevent.
    const timing: Timing = {
      surface: "rest",
      operation: "/api/v1/blocks/{ref}",
      ms: 9000,
      answer: "ok",
      samples: [9000],
    };
    const calls: string[] = [];
    const map = new Map<string, () => Promise<[number, "ok" | "unaskable"]>>([
      [
        "rest:/api/v1/blocks/{ref}",
        async () => {
          calls.push("x");
          return calls.length === 1 ? [12, "unaskable"] : [8000, "ok"];
        },
      ],
    ]);
    await confirmOverBudget([timing], map, 0);
    assert.deepEqual(
      timing.samples,
      [9000, 8000],
      "the 12ms 4xx is not a time",
    );
    // Discarding a draw leaves an EVEN count, and on a tie this gate takes the
    // slower number: half the evidence still says over budget, and calling it
    // fixed on the other half is how a regression hides behind one lucky call.
    assert.equal(timing.ms, 9000, "the upper median, conservatively");
    assert.equal(summarise([timing]).overBudget.length, 1);
  });
});
