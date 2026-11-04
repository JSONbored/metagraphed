import assert from "node:assert/strict";
import { test } from "vitest";
import { createNativeAuthControls } from "../src/native-auth-controls.ts";
import type { PgKvRuntime } from "../src/pg-kv.ts";

const runtime: PgKvRuntime = {
  producer: {
    async query() {
      return [];
    },
    async first() {
      return null;
    },
    async run() {
      return { changes: 7 };
    },
  },
  async transaction(callback) {
    return callback({
      async query() {
        return [];
      },
      async first<Row>() {
        return { request_limit: 20, period_seconds: 60 } as Row;
      },
      async run() {
        return { changes: 7 };
      },
    });
  },
};

test("native assembly verifies every declared control before request admission", async () => {
  const controls = createNativeAuthControls(
    runtime,
    [{ binding: "AI_RATE_LIMITER", limit: 20, period: 60 }],
    () => {},
  );
  controls.assertEnvironment({ ...controls.bindings, unrelated: true });
  for (const env of [null, undefined, "invalid", {}])
    assert.throws(() => controls.assertEnvironment(env), /authentication/);
  for (const name of Object.keys(controls.bindings)) {
    assert.throws(
      () =>
        controls.assertEnvironment({ ...controls.bindings, [name]: undefined }),
      /binding differs/,
    );
  }
  assert.equal(await controls.pruneExpiredRates(), 7);
  assert.throws(
    () =>
      createNativeAuthControls(
        runtime,
        [{ binding: "CONTROL_KV_STORE", limit: 1, period: 10 }],
        () => {},
      ),
    /collides/,
  );
});
