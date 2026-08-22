// #11599: the spec has to declare the statuses the routes actually return.
//
// Two published lies, both found by pointing an external catalogue validator
// at our own spec and reading what it complained about:
//
//   1. x402 (infra#629) added a live 402 path to every route in a payable
//      family and declared it NOWHERE. The contract said 402 was impossible on
//      routes that return it.
//   2. /api/v1/search/semantic published `q` as optional while the handler
//      returns 400 `invalid_query`, "Query parameter `q` is required." A client
//      generated from the spec would omit the one mandatory input.
//
// Both are asserted against the PUBLISHED document, because that file is what
// a consumer fetches -- and both are derived rather than listed, so a family
// or a schema changing moves the assertion with it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { x402PriceFor } from "../src/x402.ts";
import type { Row } from "./row-type.ts";

const METHODS = ["get", "post", "put", "patch", "delete"];

const doc = JSON.parse(
  readFileSync(
    new URL("../public/metagraph/openapi.json", import.meta.url),
    "utf8",
  ),
) as { paths: Record<string, Row> };

function operations(): Array<{ path: string; method: string; op: Row }> {
  const out: Array<{ path: string; method: string; op: Row }> = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (METHODS.includes(method)) out.push({ path, method, op: op as Row });
    }
  }
  return out;
}

describe("the 402 declaration tracks the gate", () => {
  const ops = operations();

  test("there are operations to check", () => {
    assert.ok(ops.length > 250, `only ${ops.length} operations`);
  });

  test("every x402-payable route declares 402", () => {
    // `x402PriceFor` is the same function the gate prices with, so this is a
    // comparison between the spec and the behaviour -- not between the spec
    // and a second list that can drift with it.
    const missing = ops
      .filter(({ path }) => x402PriceFor(stripNetworkPrefix(path)))
      .filter(({ op }) => !(op.responses as Row)["402"])
      .map(({ method, path }) => `${method} ${path}`);
    assert.deepEqual(missing, []);
  });

  test("no route declares 402 unless it can return one", () => {
    // The opposite error, and the more misleading one: telling a caller that
    // /api/v1/subnets might demand payment.
    const spurious = ops
      .filter(({ op }) => (op.responses as Row)["402"])
      .filter(({ path }) => !x402PriceFor(stripNetworkPrefix(path)))
      .map(({ method, path }) => `${method} ${path}`);
    assert.deepEqual(spurious, []);
  });

  test("at least one route declares it, so the checks above can fail", () => {
    const declared = ops.filter(({ op }) => (op.responses as Row)["402"]);
    assert.ok(declared.length > 0, "no 402 reached the document");
  });

  test("the 402 description states that an unpaid call is NOT refused", () => {
    // The invariant, restated where a spec reader will meet it. A caller who
    // reads "402 Payment Required" and concludes the route needs payment
    // would not call it at all.
    const declared = ops.find(({ op }) => (op.responses as Row)["402"])!;
    const description = String(
      ((declared.op.responses as Row)["402"] as Row).description,
    );
    assert.match(description, /NO payment is never/);
  });
});

/** `/api/v1/{network}/blocks` prices as `/api/v1/blocks`. */
function stripNetworkPrefix(path: string): string {
  return path.replace("/{network}", "");
}

describe("required query parameters are published as required", () => {
  test("semantic search publishes `q` as required", () => {
    const q = ((doc.paths["/api/v1/search/semantic"]!.get as Row)
      .parameters as Row[])!.find((p) => p.name === "q");
    assert.equal(q?.required, true);
  });

  test("keyword search still publishes `q` as OPTIONAL", () => {
    // Not the same contract: /api/v1/search returns 200 with no `q`. A blanket
    // "search routes require q" would have made this one a lie in the other
    // direction.
    const q = ((doc.paths["/api/v1/search"]!.get as Row)
      .parameters as Row[])!.find((p) => p.name === "q");
    assert.equal(q?.required, false);
  });
});
