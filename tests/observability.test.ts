// Unit tests for scripts/observability.ts -- the shared Sentry init for
// the box-side data-refresh-economics/data-refresh-node scripts, plus the
// release-health (crash-free session) tracking layered on top of it.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

const captureException = vi.hoisted(() => vi.fn());
const sentryInit = vi.hoisted(() => vi.fn());
const setTag = vi.hoisted(() => vi.fn());
const flush = vi.hoisted(() => vi.fn(async () => true));
const startSession = vi.hoisted(() => vi.fn());
const endSession = vi.hoisted(() => vi.fn());
const captureSession = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());
const getIsolationScope = vi.hoisted(() => vi.fn(() => ({ getSession })));
const closeSession = vi.hoisted(() => vi.fn());

vi.mock("@sentry/node", () => ({
  init: sentryInit,
  setTag,
  captureException,
  flush,
  startSession,
  endSession,
  captureSession,
  getIsolationScope,
}));
vi.mock("@sentry/core", () => ({ closeSession }));

import {
  initSentry,
  endSessionAndFlush,
  captureFatalAndExit,
} from "../scripts/observability.ts";

let onSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // initSentry registers real process.on("uncaughtException"/"unhandledRejection")
  // handlers as a side effect -- stub the registration itself so tests don't
  // leak listeners onto the shared vitest worker process, while still letting
  // us assert on how it was called.
  onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
});
afterEach(() => {
  onSpy.mockRestore();
});

test("initSentry: no-ops (never calls Sentry.init, never registers signal handlers) when SENTRY_DSN is unset", () => {
  sentryInit.mockClear();
  setTag.mockClear();
  startSession.mockClear();
  vi.stubEnv("SENTRY_DSN", "");
  initSentry("some-script");
  assert.equal(sentryInit.mock.calls.length, 0);
  assert.equal(setTag.mock.calls.length, 0);
  assert.equal(startSession.mock.calls.length, 0);
  assert.equal(onSpy.mock.calls.length, 0);
  vi.unstubAllEnvs();
});

test("endSessionAndFlush: no-ops when Sentry was never initialized", async () => {
  endSession.mockClear();
  flush.mockClear();
  await endSessionAndFlush();
  assert.equal(endSession.mock.calls.length, 0);
  assert.equal(flush.mock.calls.length, 0);
});

test("initSentry: calls Sentry.init with dsn/environment/release, tags the component, registers crash handlers before init, and starts a session", () => {
  sentryInit.mockClear();
  setTag.mockClear();
  startSession.mockClear();
  onSpy.mockClear();
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  vi.stubEnv("SENTRY_ENVIRONMENT", "staging");
  vi.stubEnv("SENTRY_RELEASE", "deadbeef");
  initSentry("sync-registry-to-postgres");

  assert.equal(sentryInit.mock.calls.length, 1);
  const initArgs = sentryInit.mock.calls[0][0];
  assert.equal(initArgs.dsn, "https://abc@o0.ingest.sentry.io/0");
  assert.equal(initArgs.environment, "staging");
  assert.equal(initArgs.release, "deadbeef");
  assert.equal(initArgs.tracesSampleRate, 0);
  assert.equal(typeof initArgs.integrations, "function");

  assert.deepEqual(setTag.mock.calls[0], [
    "component",
    "sync-registry-to-postgres",
  ]);
  assert.equal(startSession.mock.calls.length, 1);

  // The handlers must be registered before Sentry.init() runs, so that a
  // custom crash handler wins the race against Sentry's own default ones.
  const onNames = onSpy.mock.calls.map((call: unknown[]) => call[0]);
  assert.deepEqual(onNames, ["uncaughtException", "unhandledRejection"]);
  assert.ok(
    onSpy.mock.invocationCallOrder[0] < sentryInit.mock.invocationCallOrder[0],
  );
  assert.ok(
    onSpy.mock.invocationCallOrder[1] < sentryInit.mock.invocationCallOrder[0],
  );

  vi.unstubAllEnvs();
});

test("initSentry: filters Sentry's own OnUncaughtException/OnUnhandledRejection/ProcessSession out of the default integrations", () => {
  sentryInit.mockClear();
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  initSentry("some-script");

  const { integrations } = sentryInit.mock.calls[0][0];
  const filtered = integrations([
    { name: "OnUncaughtException" },
    { name: "OnUnhandledRejection" },
    // The default ProcessSession integration auto-starts its own session
    // during Sentry.init() -- left unfiltered, our own startSession() call
    // below would immediately end that one (a spurious extra "exited"
    // session on every run) and replace it, instead of there being exactly
    // one session per run. Confirmed empirically against a real local
    // Sentry-envelope-receiving HTTP server.
    { name: "ProcessSession" },
    { name: "Http" },
  ]);
  assert.deepEqual(
    filtered.map((i: { name: string }) => i.name),
    ["Http"],
  );

  vi.unstubAllEnvs();
});

test("initSentry: SENTRY_ENVIRONMENT defaults to 'production' when unset", () => {
  sentryInit.mockClear();
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  vi.stubEnv("SENTRY_ENVIRONMENT", "");
  initSentry("some-script");
  assert.equal(sentryInit.mock.calls[0][0].environment, "production");
  vi.unstubAllEnvs();
});

test("endSessionAndFlush: ends the session and flushes once initialized", async () => {
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  initSentry("some-script");
  vi.unstubAllEnvs();

  endSession.mockClear();
  flush.mockClear();
  await endSessionAndFlush();
  assert.equal(endSession.mock.calls.length, 1);
  assert.equal(flush.mock.calls.length, 1);
  assert.equal((flush.mock.calls[0] as unknown[])[0], 2000);
});

test("captureFatalAndExit: captures the exception, marks the active session crashed, flushes, then exits with the given code", async () => {
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  initSentry("some-script");
  vi.unstubAllEnvs();

  captureException.mockClear();
  captureSession.mockClear();
  closeSession.mockClear();
  flush.mockClear();
  const fakeSession = { status: "ok" };
  getSession.mockReturnValue(fakeSession);
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as unknown as (
      code?: string | number | null,
    ) => never);
  const error = new Error("boom");

  await captureFatalAndExit(error, 2);

  assert.equal(captureException.mock.calls.length, 1);
  assert.equal(captureException.mock.calls[0][0], error);
  assert.deepEqual(closeSession.mock.calls[0], [fakeSession, "crashed"]);
  assert.equal(captureSession.mock.calls.length, 1);
  assert.equal(flush.mock.calls.length, 1);
  assert.equal(exitSpy.mock.calls.length, 1);
  assert.equal(exitSpy.mock.calls[0][0], 2);
  exitSpy.mockRestore();
});

test("captureFatalAndExit: skips session close/capture when there is no active session", async () => {
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  initSentry("some-script");
  vi.unstubAllEnvs();

  closeSession.mockClear();
  captureSession.mockClear();
  getSession.mockReturnValue(undefined);
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as unknown as (
      code?: string | number | null,
    ) => never);

  await captureFatalAndExit(new Error("boom"));

  assert.equal(closeSession.mock.calls.length, 0);
  assert.equal(captureSession.mock.calls.length, 0);
  exitSpy.mockRestore();
});

test("captureFatalAndExit: defaults to exit code 1", async () => {
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  initSentry("some-script");
  vi.unstubAllEnvs();

  getSession.mockReturnValue(undefined);
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as unknown as (
      code?: string | number | null,
    ) => never);

  await captureFatalAndExit(new Error("boom"));

  assert.equal(exitSpy.mock.calls[0][0], 1);
  exitSpy.mockRestore();
});
