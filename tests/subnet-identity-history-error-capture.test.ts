// metagraphed#8081: recordSubnetIdentityChanges's read-failure catch
// (src/subnet-identity-history.ts) only ever logged to console -- per its
// own #4832 gap-closure comment, a swallowed read error here "dark-served
// the identity-history diff for an unknown stretch before anyone noticed."
// metagraphed#7766: this file used to also assert Sentry.captureException
// alongside PostHog's $exception capture -- Sentry fully removed once
// PostHog parity was proven. A separate small file rather than folded into
// tests/subnet-identity-history.test.ts (946 lines): that file's other
// tests already exercise the same function through unrelated paths.
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import type { Row } from "./row-type.ts";

const { recordSubnetIdentityChanges } =
  await import("../src/subnet-identity-history.ts");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// THE BASELINE READER, INJECTED (#10190/#10700). This used to trigger the failure
// by stubbing DATA_API behind METAGRAPH_SUBNET_IDENTITY_SOURCE="postgres" and
// returning a truthy-but-non-iterable `hashes` payload. That flag is retired and
// absent from FORWARDABLE_TIER_FLAGS, so the read never happened in production and
// the payload never existed to be malformed. What this file is about is unchanged:
// a baseline read that FAILS must be reported, not swallowed.
function envWith(extra: Row = {}): Env {
  return { ...extra } as unknown as Env;
}

/** A baseline reader that fails the way an unreadable baseline does. */
const failingBaseline = async () => {
  throw new TypeError("hashes is not iterable");
};

const profiles = [{ netuid: 7, native_identity: { subnet_name: "X" } }];

test("a genuine read failure returns recorded:false, reason:read_failed", async () => {
  const result = await recordSubnetIdentityChanges(envWith(), {
    profiles,
    latestHashes: failingBaseline,
  });
  assert.deepEqual(result, { recorded: false, reason: "read_failed" });
});

test("a genuine read failure reaches PostHog as $exception, tagged error_code read_failed", async () => {
  const original = globalThis.fetch;
  const posted: Row[] = [];
  const env = envWith({
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
  });
  // globalThis.fetch is what recordExceptionEvent posts $exception through, so it
  // is stubbed independently of the injected baseline reader.
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    posted.push({ url, body: JSON.parse(init!.body as string) });
    return { ok: true };
  }) as unknown as typeof fetch;
  try {
    await recordSubnetIdentityChanges(env, {
      profiles,
      latestHashes: failingBaseline,
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.event, "$exception");
    assert.equal(
      posted[0].body.properties.route,
      "subnet-identity-history-diff",
    );
    assert.equal(posted[0].body.properties.error_code, "read_failed");
  } finally {
    globalThis.fetch = original;
  }
});

test("an unchanged-identity run (no read failure) never reaches PostHog", async () => {
  const original = globalThis.fetch;
  const posted: Row[] = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    posted.push({ url, body: JSON.parse(init!.body as string) });
    return { ok: true };
  }) as unknown as typeof fetch;
  try {
    const env = envWith({ [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" });
    // An EMPTY baseline, which is what production actually has (#10700) -- and it
    // is not a failure, so nothing may be captured.
    const result = await recordSubnetIdentityChanges(env, { profiles });
    assert.equal(result.recorded, true);
    assert.equal(posted.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
