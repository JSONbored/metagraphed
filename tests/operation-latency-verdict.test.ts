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
