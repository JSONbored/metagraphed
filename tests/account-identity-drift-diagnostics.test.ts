import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
const { captured } = vi.hoisted(() => ({
  captured: [] as { error: unknown; route: string }[],
}));
vi.mock("../src/usage-telemetry.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/usage-telemetry.ts")>()),
  recordExceptionEvent: async (
    _env: unknown,
    event: { error: unknown; route: string },
  ) => {
    captured.push(event);
  },
}));
import { captureDataApiErrorForTest } from "../workers/data-api.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
beforeEach(() => {
  resetModuleState();
  captured.length = 0;
});

test("identity drift dedupes original driver metadata before emitting only safe telemetry", async () => {
  const env = {} as Parameters<typeof captureDataApiErrorForTest>[2];
  for (const code of ["42P01", "42703"]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const error = Object.assign(
        new Error(`private payload token=secret attempt=${attempt}`),
        {
          code,
          table_name: "account_identity_history",
          detail: "secret account address",
        },
      );
      assert.equal(
        await captureDataApiErrorForTest(
          error,
          "account-identity-sync-history",
          env,
        ),
        attempt === 0,
      );
    }
  }
  assert.equal(captured.length, 2);
  for (const event of captured) {
    assert.equal(event.route, "account-identity-sync-history");
    assert.ok(event.error instanceof Error);
    assert.equal(event.error.message, "insert_error");
    assert.equal("code" in event.error, false);
    assert.equal("table_name" in event.error, false);
    assert.doesNotMatch(
      event.error.stack ?? "",
      /private payload|token=secret|secret account/,
    );
  }
  const differentRelation = Object.assign(new Error("private payload"), {
    code: "42P01",
    table_name: "other_relation",
  });
  assert.equal(
    await captureDataApiErrorForTest(
      differentRelation,
      "account-identity-sync-history",
      env,
    ),
    true,
  );
  assert.equal(captured.length, 3);
});
