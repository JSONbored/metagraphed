import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createAccountIdentitySyncReporter } from "../src/account-identity-sync-diagnostics.ts";

test("history failures reuse driver classification without leaking error details", () => {
  for (const [error, expected] of [
    [new Error("SQLITE_FULL account=private token=secret"), "insert_capacity"],
    [new Error("near capacity account=private"), "insert_error"],
    [{ cause: { code: "SQLITE_BUSY" } }, "insert_busy"],
  ] as const) {
    const events: unknown[] = [];
    createAccountIdentitySyncReporter(
      () => 0,
      (event) => events.push(event),
    )({
      stage: "history_read",
      error,
    });
    assert.deepEqual(events, [
      {
        stage: "history_read",
        reasons: [expected],
        upstream_status: null,
        confirmed_rows: null,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(events), /private|secret|account=/);
  }
});

test("family diagnostics preserve ambiguity and inspect only canonical tables", () => {
  const events: unknown[] = [];
  createAccountIdentitySyncReporter(
    () => 0,
    (event) => events.push(event),
  )({
    stage: "family_write",
    outcome: {
      attempted: true,
      results: {
        account_identity: { ok: true, rows: 1, statements: 1 },
        account_identity_history: {
          ok: false,
          rows: 1,
          statements: 1,
          reason: "SQLITE_FULL secret",
        },
        private_address: {
          ok: false,
          rows: 1,
          statements: 1,
          reason: "secret",
        },
      },
    },
  });
  assert.deepEqual(events, [
    {
      stage: "family_write",
      reasons: ["insert_capacity"],
      upstream_status: null,
      confirmed_rows: null,
    },
  ]);
  const missing: unknown[] = [];
  createAccountIdentitySyncReporter(
    () => 0,
    (event) => missing.push(event),
  )({ stage: "family_write", outcome: { attempted: false, results: {} } });
  assert.deepEqual(missing, [
    {
      stage: "family_write",
      reasons: ["missing_store"],
      upstream_status: null,
      confirmed_rows: null,
    },
  ]);
});

test("upstream diagnostics retain status only and sample across all stages", () => {
  let clock = 0;
  const events: unknown[] = [];
  const report = createAccountIdentitySyncReporter(
    () => clock,
    (event) => events.push(event),
  );
  report({ stage: "upstream_response", status: 200 });
  report({ stage: "history_read", error: new Error("SQLITE_FULL") });
  assert.deepEqual(events, [
    {
      stage: "upstream_response",
      reasons: ["unreadable_response"],
      upstream_status: 200,
      confirmed_rows: null,
    },
  ]);
  clock = 60_000;
  report({
    stage: "family_write",
    outcome: {
      attempted: true,
      results: { account_identity: { ok: true, rows: 1, statements: 1 } },
    },
  });
  assert.equal(events.length, 2);
});

test("default event label is fixed and diagnostic sink failures cannot escape", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    createAccountIdentitySyncReporter()({
      stage: "upstream_response",
      status: 502,
    });
    assert.equal(warn.mock.calls[0][0], "account_identity_sync_failure");
  } finally {
    warn.mockRestore();
  }
  assert.doesNotThrow(() =>
    createAccountIdentitySyncReporter(
      () => 0,
      () => {
        throw new Error("sink");
      },
    )({ stage: "history_read", error: null }),
  );
});

test("default clock follows later mocks and reset isolates a consumed sampling bucket", () => {
  const events: unknown[] = [];
  // Construct before replacing Date.now, as Workers do at module import.
  const report = createAccountIdentitySyncReporter(undefined, (event) =>
    events.push(event),
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    report({ stage: "upstream_response", status: 200 });
    report({ stage: "upstream_response", status: 502 });
    assert.equal(events.length, 1);
    clock.mockReturnValue(61_000);
    report({ stage: "upstream_response", status: 503 });
    assert.equal(events.length, 2);
    report.reset();
    report({ stage: "upstream_response", status: 504 });
    assert.equal(events.length, 3);
  } finally {
    clock.mockRestore();
  }
});
