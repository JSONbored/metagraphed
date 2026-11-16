// The mechanism (mechid) scope stamp and its shared bound (#13162).
//
// Pure-unit coverage for src/mechanism-scope.ts and the GraphQL argument
// assert built on it; the REST/GraphQL/MCP surfaces that apply the stamp are
// exercised in tests/request-handlers-entities.test.ts, tests/graphql.test.ts
// and tests/mcp-server.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  MECHANISM_SCOPE_MESSAGE,
  invalidMechanismScope,
  stampMechanismScope,
} from "../src/mechanism-scope.ts";

// stampMechanismScope is generic over the payload it returns, which is the
// point for its callers (an unscoped payload keeps its exact type); the tests
// widen the literals so the ADDED key is readable.
const stamp = (
  data: Record<string, unknown>,
  mechid: number | null | undefined,
) => stampMechanismScope(data, mechid);

describe("invalidMechanismScope", () => {
  test("absent means unscoped, which is always servable", () => {
    assert.equal(invalidMechanismScope(null), false);
    assert.equal(invalidMechanismScope(undefined), false);
  });

  test("0 is the one scope today's stores hold", () => {
    assert.equal(invalidMechanismScope(0), false);
  });

  test("anything above 0 cannot be served honestly yet", () => {
    assert.equal(invalidMechanismScope(1), true);
    assert.equal(invalidMechanismScope(7), true);
  });

  test("a non-integer is rejected, not truncated into a scope", () => {
    assert.equal(invalidMechanismScope(0.5), true);
    assert.equal(invalidMechanismScope(Number.NaN), true);
  });
});

describe("stampMechanismScope", () => {
  test("no scope returns the payload untouched -- the same object", () => {
    const data = { schema_version: 1, netuid: 7, neurons: [{ uid: 0 }] };
    assert.equal(stampMechanismScope(data, null), data);
    assert.equal(stampMechanismScope(data, undefined), data);
    assert.equal("mechid" in data, false);
  });

  test("a non-object payload is returned as-is rather than stamped", () => {
    const absent = null as unknown as Record<string, unknown>;
    assert.equal(stampMechanismScope(absent, 0), absent);
  });

  test("stamps the artifact and every neuron row", () => {
    const stamped = stamp(
      { schema_version: 1, netuid: 7, neurons: [{ uid: 0 }, { uid: 1 }] },
      0,
    );
    assert.equal(stamped.mechid, 0);
    assert.deepEqual(stamped.neurons, [
      { uid: 0, mechid: 0 },
      { uid: 1, mechid: 0 },
    ]);
  });

  test("stamps a neuron detail card, and leaves a null neuron null", () => {
    const withRow = stamp(
      { schema_version: 1, netuid: 7, neuron: { uid: 3 } },
      0,
    );
    assert.equal(withRow.mechid, 0);
    assert.deepEqual(withRow.neuron, { uid: 3, mechid: 0 });

    const absent = stamp({ schema_version: 1, netuid: 7, neuron: null }, 0);
    assert.equal(absent.mechid, 0);
    // "Absent from the snapshot" has no mechanism to report.
    assert.equal(absent.neuron, null);
  });

  test("a payload without neuron rows gains only the top-level echo", () => {
    const card = stamp(
      { schema_version: 1, netuid: 7, window: "7d", weight_sets: 0 },
      0,
    );
    assert.equal(card.mechid, 0);
    assert.equal("neurons" in card, false);
  });
});

describe("MECHANISM_SCOPE_MESSAGE", () => {
  test("names the bound and the issue, for the MCP surface that rejects with it", () => {
    assert.match(MECHANISM_SCOPE_MESSAGE, /mechid must be 0/);
    assert.match(MECHANISM_SCOPE_MESSAGE, /#13162/);
  });
});
