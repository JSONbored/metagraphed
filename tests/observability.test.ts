// Unit tests for scripts/observability.ts -- the shared PostHog init for the
// box-side data-refresh-economics/data-refresh-node scripts.
// metagraphed#7766: Sentry fully removed (was parallel-run alongside
// PostHog until parity was proven) -- this file used to also assert
// Sentry.init/setTag/session-tracking behavior; that coverage is gone along
// with the code it tested.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

// Every `new PostHog(...)` call returns these SAME shared mock functions
// (not a fresh pair per instance) -- fine here since observability.ts only
// ever holds one client at a time.
const posthogCaptureExceptionImmediate = vi.hoisted(() =>
  vi.fn(
    async (
      _error: unknown,
      _distinctId?: string,
      _additionalProperties?: Record<string, unknown>,
    ) => {},
  ),
);
const posthogShutdown = vi.hoisted(() => vi.fn(async () => {}));
const posthogConstructorCalls = vi.hoisted(() => [] as unknown[][]);
// A real `class`, not an arrow-function mock implementation -- observability.ts
// calls `new PostHog(...)`, and an arrow function can't be invoked with `new`
// ("TypeError: ... is not a constructor"). Cast to mockImplementation's
// function-type parameter -- it's actually invoked via `new`, never called
// plainly, so the shape mismatch is cosmetic only.
const PostHogMock = vi.hoisted(() => {
  class PostHogMockImpl {
    constructor(...args: unknown[]) {
      posthogConstructorCalls.push(args);
      return {
        captureExceptionImmediate: posthogCaptureExceptionImmediate,
        shutdown: posthogShutdown,
      };
    }
  }
  return vi
    .fn()
    .mockImplementation(
      PostHogMockImpl as unknown as (...args: unknown[]) => unknown,
    );
});
vi.mock("posthog-node", () => ({ PostHog: PostHogMock }));

import {
  initObservability,
  endSessionAndFlush,
  captureFatalAndExit,
  captureExceptionAndContinue,
} from "../scripts/observability.ts";

let onSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // initObservability registers real process.on("uncaughtException"/
  // "unhandledRejection") handlers as a side effect -- stub the registration
  // itself so tests don't leak listeners onto the shared vitest worker
  // process, while still letting us assert on how it was called.
  onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
});
afterEach(() => {
  onSpy.mockRestore();
});

test("initObservability: no-ops (never inits PostHog, never registers signal handlers) when POSTHOG_PROJECT_TOKEN is unset", () => {
  PostHogMock.mockClear();
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "");
  initObservability("some-script");
  assert.equal(onSpy.mock.calls.length, 0);
  assert.equal(PostHogMock.mock.calls.length, 0);
  vi.unstubAllEnvs();
});

// Must run before any other test in this file ever initializes a real
// client -- scripts/observability.ts's posthogClient is module-level state
// that, once set, stays set for the rest of the process (matching the
// real script-lifetime behavior this module is designed for), so this is
// the only point at which "never initialized" is actually true.
test("endSessionAndFlush: no-ops when PostHog was never initialized", async () => {
  posthogShutdown.mockClear();
  await endSessionAndFlush();
  assert.equal(posthogShutdown.mock.calls.length, 0);
});

test("initObservability: initializes PostHog and registers crash handlers when POSTHOG_PROJECT_TOKEN is set", () => {
  PostHogMock.mockClear();
  onSpy.mockClear();
  posthogConstructorCalls.length = 0;
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test_token");
  vi.stubEnv("POSTHOG_HOST", "");
  initObservability("some-script");

  assert.equal(PostHogMock.mock.calls.length, 1);
  assert.deepEqual(posthogConstructorCalls[0], [
    "phc_test_token",
    { host: "https://us.i.posthog.com" },
  ]);
  const onNames = onSpy.mock.calls.map((call: unknown[]) => call[0]);
  assert.deepEqual(onNames, ["uncaughtException", "unhandledRejection"]);

  vi.unstubAllEnvs();
});

test("initObservability: honors POSTHOG_HOST when set", () => {
  PostHogMock.mockClear();
  posthogConstructorCalls.length = 0;
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test_token");
  vi.stubEnv("POSTHOG_HOST", "https://eu.i.posthog.com");
  initObservability("some-script");

  assert.deepEqual(posthogConstructorCalls[0], [
    "phc_test_token",
    { host: "https://eu.i.posthog.com" },
  ]);

  vi.unstubAllEnvs();
});

test("endSessionAndFlush: shuts down PostHog when it was initialized", async () => {
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test_token");
  initObservability("some-script");
  vi.unstubAllEnvs();

  posthogShutdown.mockClear();
  await endSessionAndFlush();

  assert.equal(posthogShutdown.mock.calls.length, 1);
});

test("captureFatalAndExit: captures to PostHog (immediate, awaited, tagged by component) and shuts the client down before exiting", async () => {
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test_token");
  initObservability("sync-registry-to-postgres");
  vi.unstubAllEnvs();

  posthogCaptureExceptionImmediate.mockClear();
  posthogShutdown.mockClear();
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as unknown as (
      code?: string | number | null,
    ) => never);
  const error = new Error("boom");

  await captureFatalAndExit(error, 3);

  assert.equal(posthogCaptureExceptionImmediate.mock.calls.length, 1);
  assert.equal(posthogCaptureExceptionImmediate.mock.calls[0][0], error);
  assert.equal(
    posthogCaptureExceptionImmediate.mock.calls[0][1],
    "metagraphed-infra",
  );
  assert.deepEqual(posthogCaptureExceptionImmediate.mock.calls[0][2], {
    component: "sync-registry-to-postgres",
  });
  assert.equal(posthogShutdown.mock.calls.length, 1);
  // The capture must be awaited BEFORE shutdown tears the client down, not
  // just fired -- assert the actual invocation order, not merely that both
  // were called.
  assert.ok(
    posthogCaptureExceptionImmediate.mock.invocationCallOrder[0] <
      posthogShutdown.mock.invocationCallOrder[0],
  );
  assert.equal(exitSpy.mock.calls[0][0], 3);
  exitSpy.mockRestore();
});

test("captureFatalAndExit: defaults to exit code 1", async () => {
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test_token");
  initObservability("some-script");
  vi.unstubAllEnvs();

  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as unknown as (
      code?: string | number | null,
    ) => never);

  await captureFatalAndExit(new Error("boom"));

  assert.equal(exitSpy.mock.calls[0][0], 1);
  exitSpy.mockRestore();
});

test("captureExceptionAndContinue: captures to PostHog (immediate, awaited, tagged by component) without exiting", async () => {
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test_token");
  initObservability("refresh-og-image");
  vi.unstubAllEnvs();

  posthogCaptureExceptionImmediate.mockClear();
  const exitSpy = vi.spyOn(process, "exit");
  const error = new Error("render failed");

  await captureExceptionAndContinue(error);

  assert.equal(posthogCaptureExceptionImmediate.mock.calls.length, 1);
  assert.equal(posthogCaptureExceptionImmediate.mock.calls[0][0], error);
  assert.equal(
    posthogCaptureExceptionImmediate.mock.calls[0][1],
    "metagraphed-infra",
  );
  assert.deepEqual(posthogCaptureExceptionImmediate.mock.calls[0][2], {
    component: "refresh-og-image",
  });
  assert.equal(exitSpy.mock.calls.length, 0);
  exitSpy.mockRestore();
});
