// Unit tests for scripts/observability.mjs -- the shared Sentry init for
// the box-side data-refresh-economics/data-refresh-node scripts. Mocked the
// same way tests/chain-firehose-relay.test.mjs mocks @sentry/node.
import assert from "node:assert/strict";
import { test, vi } from "vitest";

const captureException = vi.hoisted(() => vi.fn());
const sentryInit = vi.hoisted(() => vi.fn());
const setTag = vi.hoisted(() => vi.fn());
const flush = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@sentry/node", () => ({
  init: sentryInit,
  setTag,
  captureException,
  flush,
}));

import { initSentry, captureFatalAndExit } from "../scripts/observability.mjs";

test("initSentry: no-ops (never calls Sentry.init) when SENTRY_DSN is unset", () => {
  sentryInit.mockClear();
  setTag.mockClear();
  vi.stubEnv("SENTRY_DSN", "");
  initSentry("some-script");
  assert.equal(sentryInit.mock.calls.length, 0);
  assert.equal(setTag.mock.calls.length, 0);
  vi.unstubAllEnvs();
});

test("initSentry: calls Sentry.init with dsn/environment/release and tags the component when SENTRY_DSN is set", () => {
  sentryInit.mockClear();
  setTag.mockClear();
  vi.stubEnv("SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
  vi.stubEnv("SENTRY_ENVIRONMENT", "staging");
  vi.stubEnv("SENTRY_RELEASE", "deadbeef");
  initSentry("sync-registry-to-postgres");
  assert.equal(sentryInit.mock.calls.length, 1);
  assert.deepEqual(sentryInit.mock.calls[0][0], {
    dsn: "https://abc@o0.ingest.sentry.io/0",
    environment: "staging",
    release: "deadbeef",
    tracesSampleRate: 0,
  });
  assert.deepEqual(setTag.mock.calls[0], [
    "component",
    "sync-registry-to-postgres",
  ]);
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

test("captureFatalAndExit: captures the exception, flushes, then exits with the given code", async () => {
  captureException.mockClear();
  flush.mockClear();
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
  const error = new Error("boom");

  await captureFatalAndExit(error, 2);

  assert.equal(captureException.mock.calls.length, 1);
  assert.equal(captureException.mock.calls[0][0], error);
  assert.equal(flush.mock.calls.length, 1);
  assert.equal(exitSpy.mock.calls.length, 1);
  assert.equal(exitSpy.mock.calls[0][0], 2);
  exitSpy.mockRestore();
});

test("captureFatalAndExit: defaults to exit code 1", async () => {
  captureException.mockClear();
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});

  await captureFatalAndExit(new Error("boom"));

  assert.equal(exitSpy.mock.calls[0][0], 1);
  exitSpy.mockRestore();
});
