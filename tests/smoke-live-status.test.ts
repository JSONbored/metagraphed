import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { assertLiveApiStatus } from "../scripts/live-smoke-status.ts";

function failure(result: {
  status: unknown;
  body?: unknown;
}): assert.AssertionError {
  try {
    assertLiveApiStatus(result);
  } catch (error) {
    assert.ok(error instanceof assert.AssertionError);
    assert.ok(error.message.length <= 160);
    return error;
  }
  assert.fail("expected the smoke status gate to fail");
}

describe("live smoke serving status diagnostics", () => {
  test("preserves only the allowlisted public error codes", () => {
    for (const code of [
      "history_unavailable",
      "account_summary_unavailable",
      "data_tier_unavailable",
    ]) {
      const error = failure({
        status: 503,
        body: {
          error: {
            code,
            message: "secret-message",
            url: "https://example.invalid/secret-url",
          },
          token: "secret-token",
        },
      });
      assert.equal(
        error.message.split("\n", 1)[0],
        `expected HTTP 200 (status=503; error_code=${code})`,
      );
      assert.equal(error.actual, 503);
      assert.equal(error.expected, 200);
      assert.ok(!String(error).includes("secret"));
      assert.ok(!String(error).includes("https://"));
    }
  });

  test("collapses missing, malformed, unknown and oversized codes", () => {
    for (const body of [
      undefined,
      null,
      false,
      1,
      "secret-body",
      [],
      {},
      { error: null },
      { error: "secret-error" },
      { error: [] },
      { error: {} },
      { error: { code: null } },
      { error: { code: { secret: true } } },
      { error: { code: "secret-code", message: "secret-message" } },
      { error: { code: "history_unavailable\nsecret-message" } },
      { error: { code: "history_unavailable" + "x".repeat(1_000_000) } },
    ]) {
      const error = failure({ status: 503, body });
      assert.equal(
        error.message.split("\n", 1)[0],
        "expected HTTP 200 (status=503; error_code=unclassified)",
      );
      assert.ok(!String(error).includes("secret"));
    }
  });

  test("does not read inherited fields, accessors or unrelated nested data", () => {
    const getter = () => assert.fail("must not invoke a body getter");
    const errorAccessor = Object.defineProperty({}, "error", { get: getter });
    const codeAccessor = {
      error: Object.defineProperty({}, "code", { get: getter }),
    };
    for (const body of [
      Object.create({ error: { code: "history_unavailable" } }),
      { error: Object.create({ code: "history_unavailable" }) },
      errorAccessor,
      codeAccessor,
      { error: { nested: { code: "history_unavailable" } } },
    ]) {
      assert.match(
        failure({ status: 503, body }).message,
        /error_code=unclassified/,
      );
    }
    const body = {
      error: {
        code: "history_unavailable",
        get message() {
          return getter();
        },
      },
      get unrelated() {
        return getter();
      },
      toJSON: getter,
      toString: getter,
    };
    assert.match(
      failure({ status: 503, body }).message,
      /error_code=history_unavailable/,
    );
  });

  test("retains the exact HTTP 200 gate for every bounded HTTP status", () => {
    for (let status = 100; status <= 599; status += 1) {
      if (status === 200) {
        assert.doesNotThrow(() => assertLiveApiStatus({ status }));
      } else {
        const error = failure({ status });
        assert.equal(error.actual, status);
        assert.equal(error.expected, 200);
        assert.match(error.message, /error_code=unclassified/);
      }
    }
  });

  test("collapses invalid statuses without coercion or arbitrary assertion data", () => {
    for (const status of [
      undefined,
      null,
      false,
      0,
      99,
      600,
      -1,
      200.1,
      Infinity,
      NaN,
      "200",
      "secret-status",
      { toString: () => assert.fail("must not coerce an arbitrary status") },
    ]) {
      const error = failure({ status });
      assert.equal(error.actual, "invalid");
      assert.equal(
        error.message.split("\n", 1)[0],
        "expected HTTP 200 (status=invalid; error_code=unclassified)",
      );
      assert.ok(!String(error).includes("secret"));
    }
  });

  test("leaves successful status handling and subsequent envelope checks alone", () => {
    assert.doesNotThrow(() =>
      assertLiveApiStatus({
        status: 200,
        get body() {
          return assert.fail("200 must not read the diagnostic body");
        },
      }),
    );
    assert.doesNotThrow(() =>
      assertLiveApiStatus({
        status: 200,
        body: { ok: false, error: { code: "history_unavailable" } },
      }),
    );
  });
});
