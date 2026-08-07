// Every D1 dispatcher block must choose its store through the gate.
//
// THE BUG THIS EXISTS TO STOP, which is the one it was written after. There
// are three blocks in dispatchDataApiRequest that match a route to a handler
// and then hand that handler a runner. Only ONE of them consulted
// neonServesRoute; the other two called createD1Sql outright.
//
// That made a whole cutover a no-op without failing anything. #9954 added
// NEON_READ_ROUTE_TABLES entries for /subnets/{netuid}/hyperparameters, its
// /history, /accounts/{ss58}/identity and its -history, and put all four
// tables in NEON_READ_LANES. None of those routes is matched by
// matchNeuronsD1Route -- they belong to the hyperparams/identity block -- so
// the declarations were read by nothing and the routes kept answering from
// D1. Every part of the cutover was in place except the line that asks.
//
// A route-by-route assertion could not have caught it: the declaration was
// correct, the flag was correct, the table was at parity. The defect was that
// nobody called the function. So this test asserts the CALL, structurally.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";

const SOURCE = readFileSync("workers/data-api.ts", "utf8");

/** The body of dispatchDataApiRequest, which is where route dispatch lives.
 * Bounded rather than scanning the file, because createD1Sql is legitimate
 * outside it -- the write paths and the user-state helpers own their store
 * choice for reasons that have nothing to do with a read gate. */
function dispatcherBody(): string {
  const start = SOURCE.indexOf("async function dispatchDataApiRequest(");
  assert.ok(start > 0, "dispatchDataApiRequest not found -- was it renamed?");
  const end = SOURCE.indexOf("\n// --- TAO/USD index ingestion", start);
  assert.ok(end > start, "could not find the end of the dispatcher");
  return SOURCE.slice(start, end);
}

describe("the read dispatcher", () => {
  test("hands every matched handler a gate-chosen store", () => {
    const body = dispatcherBody();
    // Each `return await <name>Handler(` is a block dispatching to a matched
    // handler. Discovered by shape rather than listed, so a FOURTH block added
    // later is covered the day it is written -- listing them is how the third
    // one went unnoticed.
    const dispatches = [
      ...body.matchAll(/return await (\w*Handler)\(\s*([^,)]+)/g),
    ];
    assert.ok(
      dispatches.length >= 3,
      `expected at least the three known dispatcher blocks, found ${dispatches.length}`,
    );
    const offenders = dispatches
      .filter(([, , firstArg]) => !firstArg.trim().startsWith("routeStore("))
      .map(([, name, firstArg]) => `${name} <- ${firstArg.trim()}`);
    assert.deepEqual(
      offenders,
      [],
      "a dispatcher block chose its store without asking neonServesRoute; " +
        "its route's NEON_READ_ROUTE_TABLES entry would be read by nothing",
    );
  });

  test("chooses the store in exactly one place", () => {
    // The property that makes the test above sufficient. Three call sites
    // spelling the same ternary would drift, and the drift is invisible: a
    // block that reads the flag wrongly still returns a schema-stable 200.
    const body = dispatcherBody();
    const direct = [...body.matchAll(/createD1Sql\(/g)].length;
    assert.equal(
      direct,
      0,
      "the dispatcher constructs a D1 runner directly; routeStore is the only " +
        "place that should decide, so the gate cannot be skipped by one block",
    );
  });

  test("routeStore still gates on the flag, not the binding's presence", () => {
    // #9704: reading `env.HYPERDRIVE && ...` alone meant binding Hyperdrive
    // for a WRITE pilot silently moved a READ onto a store nothing had written
    // to, and it served a two-day-old snapshot until the binding was pulled.
    // "The binding exists" and "this route should read Neon" are different
    // questions and both must be answered yes.
    const fn = SOURCE.slice(
      SOURCE.indexOf("function routeStore("),
      SOURCE.indexOf("export function neonServesRoute("),
    );
    assert.match(fn, /env\.HYPERDRIVE/);
    assert.match(fn, /neonServesRoute\(/);
    assert.match(fn, /createD1Sql\(env\.METAGRAPH_HEALTH_DB\)/);
  });
});
