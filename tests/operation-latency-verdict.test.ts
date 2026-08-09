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
import { summarise, type Timing } from "../scripts/check-operation-latency.ts";

/** A declared operation, so the fixtures below name something real. */
const DECLARED_OPERATION = "mcp:get_account_counterparties";
const [DECLARED_SURFACE, DECLARED_NAME] = ["mcp", "get_account_counterparties"];

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
