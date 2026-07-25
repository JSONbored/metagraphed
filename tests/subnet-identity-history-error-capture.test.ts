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

// latestIdentityHashes only throws when Postgres hands back a truthy but
// non-iterable `hashes` payload (tryPostgresTier itself never throws) --
// see the sibling "returns read_failed" test in
// tests/subnet-identity-history.test.ts for the same trigger.
function pgEnvWithBadPayload(extra: Row = {}): Env {
  return {
    METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        new Response(JSON.stringify({ hashes: { not: "an array" } }), {
          status: 200,
        }),
    },
    ...extra,
  } as unknown as Env;
}

const profiles = [{ netuid: 7, native_identity: { subnet_name: "X" } }];

test("a genuine read failure returns recorded:false, reason:read_failed", async () => {
  const result = await recordSubnetIdentityChanges(pgEnvWithBadPayload(), {
    profiles,
  });
  assert.deepEqual(result, { recorded: false, reason: "read_failed" });
});

test("a genuine read failure reaches PostHog as $exception, tagged error_code read_failed", async () => {
  const original = globalThis.fetch;
  const posted: Row[] = [];
  const env = pgEnvWithBadPayload({
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
  });
  // env.DATA_API.fetch above only intercepts the internal latest-hashes
  // lookup; globalThis.fetch is what recordExceptionEvent posts $exception
  // through, so both must be stubbed independently.
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    posted.push({ url, body: JSON.parse(init!.body as string) });
    return { ok: true };
  }) as unknown as typeof fetch;
  try {
    await recordSubnetIdentityChanges(env, { profiles });
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
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          new Response(JSON.stringify({ hashes: [] }), { status: 200 }),
      },
      [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
    } as unknown as Env;
    const result = await recordSubnetIdentityChanges(env, { profiles });
    assert.equal(result.recorded, true);
    assert.equal(posted.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
