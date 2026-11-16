// src/hyperdrive-state-bindings.ts — the Worker-side storage seam (#13171).
//
// The contract under test is the DARK one first: an env that does not opt in
// with BOTH the selector value and a bound connection string must come back as
// the SAME object, because today's deployments set neither and their behavior
// must be byte-identical. Construction is then exercised against a connection
// string that is never dialed — the pooled runtime connects lazily, so filling
// the binding set performs no I/O until a store is actually queried.

import { expect, test } from "vitest";
import { withHyperdriveStateBindings } from "../src/hyperdrive-state-bindings.ts";

// A syntactically valid connection string that is never dialed: the runtime
// only connects when a store is queried, which no test here does. Built member
// by member rather than as one literal so no credential-shaped string appears.
function fixtureConnection(database: string): string {
  const url = new URL(`postgresql://pg.invalid:5432/${database}`);
  url.username = "metagraphed_fixture";
  url.password = "fixture-only";
  return url.toString();
}
const connectionString = fixtureConnection("fixture");

function selected(env: object): Record<string, unknown> {
  return withHyperdriveStateBindings(env) as Record<string, unknown>;
}

test("returns the same env object when the selector is absent", () => {
  const env = { HYPERDRIVE: { connectionString } };
  expect(withHyperdriveStateBindings(env)).toBe(env);
});

test("returns the same env object for any selector value but 'hyperdrive'", () => {
  const env = {
    METAGRAPH_STATE_SOURCE: "d1",
    HYPERDRIVE: { connectionString },
  };
  expect(withHyperdriveStateBindings(env)).toBe(env);
});

test("returns the same env object when no HYPERDRIVE binding exists", () => {
  const env = { METAGRAPH_STATE_SOURCE: "hyperdrive" };
  expect(withHyperdriveStateBindings(env)).toBe(env);
});

test("returns the same env object when the connection string is not a string", () => {
  const env = {
    METAGRAPH_STATE_SOURCE: "hyperdrive",
    HYPERDRIVE: { connectionString: 42 },
  };
  expect(withHyperdriveStateBindings(env)).toBe(env);
});

test("returns the same env object when the connection string is empty", () => {
  const env = {
    METAGRAPH_STATE_SOURCE: "hyperdrive",
    HYPERDRIVE: { connectionString: "" },
  };
  expect(withHyperdriveStateBindings(env)).toBe(env);
});

test("refuses a connection string that is not a URL before creating resources", () => {
  expect(() =>
    selected({
      METAGRAPH_STATE_SOURCE: "hyperdrive",
      HYPERDRIVE: { connectionString: "not a url" },
    }),
  ).toThrow(TypeError);
});

test("refuses a connection role that cannot be a declared schema owner", () => {
  // The decoded username is the owner for every manifest schema, and the
  // manifest validates it as a PostgreSQL identifier. "Bad User" is not one.
  const invalidOwner = new URL("postgresql://pg.invalid:5432/fixture");
  invalidOwner.username = "Bad%20User";
  invalidOwner.password = "fixture-only";
  expect(() =>
    selected({
      METAGRAPH_STATE_SOURCE: "hyperdrive",
      HYPERDRIVE: { connectionString: invalidOwner.toString() },
    }),
  ).toThrow(/source owner is required/);
});

test("fills the full store-binding set on a NEW env object, never the input", () => {
  const env = {
    METAGRAPH_STATE_SOURCE: "hyperdrive",
    HYPERDRIVE: { connectionString },
    EXISTING: "kept",
  };
  const wrapped = selected(env);
  expect(wrapped).not.toBe(env);
  expect(wrapped.EXISTING).toBe("kept");
  expect(wrapped.METAGRAPH_STATE_SOURCE).toBe("hyperdrive");
  for (const key of [
    "LANE_HEALTH_STORE",
    "NEURON_SNAPSHOT_STORE",
    "VALIDATOR_HISTORY_STORE",
    "NATIVE_READ_STORE",
    "NATIVE_PRODUCER_STORE",
    "NATIVE_WRITE_RUNNERS",
    "RETAINED_BLOCKS_STORE",
  ])
    expect(wrapped[key], key).toBeDefined();
  expect(wrapped.RAW_CAPTURE_STORAGE).toBe("postgresql");
  expect("LANE_HEALTH_STORE" in env, "the input env must stay untouched").toBe(
    false,
  );
});

test("memoizes the wrapped env per input env object", () => {
  const env = {
    METAGRAPH_STATE_SOURCE: "hyperdrive",
    HYPERDRIVE: { connectionString },
  };
  const first = withHyperdriveStateBindings(env);
  expect(withHyperdriveStateBindings(env)).toBe(first);
  // Wrapping the wrapped env is the warm-isolate path and must be stable too.
  expect(withHyperdriveStateBindings(first)).toBe(first);
});

test("memoizes the stores per connection string across env objects", () => {
  const first = selected({
    METAGRAPH_STATE_SOURCE: "hyperdrive",
    HYPERDRIVE: { connectionString },
  });
  const second = selected({
    METAGRAPH_STATE_SOURCE: "hyperdrive",
    HYPERDRIVE: { connectionString },
  });
  expect(second).not.toBe(first);
  expect(second.LANE_HEALTH_STORE).toBe(first.LANE_HEALTH_STORE);
  expect(second.NATIVE_READ_STORE).toBe(first.NATIVE_READ_STORE);
});

test("a different connection string builds its own stores", () => {
  const first = selected({
    METAGRAPH_STATE_SOURCE: "hyperdrive",
    HYPERDRIVE: { connectionString },
  });
  const second = selected({
    METAGRAPH_STATE_SOURCE: "hyperdrive",
    HYPERDRIVE: { connectionString: fixtureConnection("other") },
  });
  expect(second.LANE_HEALTH_STORE).not.toBe(first.LANE_HEALTH_STORE);
});
