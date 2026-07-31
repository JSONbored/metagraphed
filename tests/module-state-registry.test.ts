import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  registerModuleStateReset,
  registeredModuleStateKeys,
  resetModuleState,
} from "../src/module-state-registry.ts";

// The registry is process-global and the real Worker modules register into it at
// import time, so these tests use their own uniquely-keyed entries and assert on
// their own effects rather than on the global registry's exact size.
describe("module state registry", () => {
  test("resetModuleState runs every registered reset", () => {
    let a = 0;
    let b = 0;
    registerModuleStateReset("test/only/a.ts", () => {
      a += 1;
    });
    registerModuleStateReset("test/only/b.ts", () => {
      b += 1;
    });

    resetModuleState();

    assert.equal(a, 1);
    assert.equal(b, 1);
  });

  test("re-registering a key replaces the prior reset instead of stacking it", () => {
    let stale = 0;
    let fresh = 0;
    registerModuleStateReset("test/only/replaced.ts", () => {
      stale += 1;
    });
    registerModuleStateReset("test/only/replaced.ts", () => {
      fresh += 1;
    });

    resetModuleState();

    assert.equal(stale, 0, "the replaced reset must not still run");
    assert.equal(fresh, 1);
  });

  test("resets run in registration order, so a later module can re-wire an earlier one", () => {
    // This is the ordering workers/api.ts depends on: each handler module
    // unwires its injected readers, then api.ts (which imports them, so it
    // registers last) wires production back in.
    const order: string[] = [];
    registerModuleStateReset("test/only/first.ts", () => {
      order.push("first");
    });
    registerModuleStateReset("test/only/second.ts", () => {
      order.push("second");
    });

    resetModuleState();

    assert.deepEqual(
      order.filter((entry) => entry === "first" || entry === "second"),
      ["first", "second"],
    );
  });

  test("registeredModuleStateKeys reports the registered keys, sorted", () => {
    registerModuleStateReset("test/only/zzz.ts", () => {});
    registerModuleStateReset("test/only/aaa.ts", () => {});

    const keys = registeredModuleStateKeys();

    assert.deepEqual([...keys].sort(), keys, "keys must come back sorted");
    assert.ok(keys.includes("test/only/aaa.ts"));
    assert.ok(keys.includes("test/only/zzz.ts"));
  });

  test("every Worker module that owns mutable state has registered its reset", () => {
    // Guards the wiring the validator enforces statically: importing api.ts
    // pulls in the whole handler graph, so each of these must be present.
    return import("../workers/api.ts").then(() => {
      const keys = registeredModuleStateKeys();
      for (const expected of [
        "workers/api.ts",
        "workers/storage.ts",
        "workers/postgres-tier.ts",
        "workers/request-handlers/analytics.ts",
        "workers/request-handlers/analytics-routes.ts",
        "workers/request-handlers/rpc-proxy.ts",
        "workers/request-handlers/fullnode-rpc-proxy.ts",
        "workers/request-handlers/discovery.ts",
        "src/icon-proxy.ts",
      ]) {
        assert.ok(keys.includes(expected), `${expected} must register a reset`);
      }
    });
  });
});
