// The SafeMode watchdog's history reader (#10765), in its own file so
// the cold-tier module can be mocked without that mock reaching the twenty-odd
// rule tests in tests/safe-mode-watchdog.test.ts.
//
// WHAT THIS PINS is the seam the 522 lived at. The reader used to fetch
// `https://api.metagraph.sh/api/v1/extrinsics?call_module=SafeMode&limit=200`
// -- a custom domain of the very Worker the cron runs on, which Cloudflare
// refuses with a 522 every time, and a `limit` the route caps at 100 anyway.
// It now calls the in-process loader `handleExtrinsics` itself falls through
// to, so the two things worth asserting are that it asks that tier the right
// question and that it keeps the decline distinguishable from an empty answer.
import assert from "node:assert/strict";
import { test, vi } from "vitest";

const { coldTier } = vi.hoisted(() => ({
  coldTier: { calls: [] as unknown[][], result: null as unknown },
}));

vi.mock("../src/extrinsics-cold-tier.ts", () => ({
  loadExtrinsicFeedColdTier: async (...args: unknown[]) => {
    coldTier.calls.push(args);
    if (coldTier.result instanceof Error) throw coldTier.result;
    return coldTier.result;
  },
}));

const { SAFE_MODE_EXTRINSIC_LIMIT, readSafeModeExtrinsics } =
  await import("../src/safe-mode-watchdog.ts");

test("it asks the extrinsics cold tier for the SafeMode module, within the route's own ceiling", async () => {
  coldTier.calls.length = 0;
  coldTier.result = { extrinsics: [] };
  const env = { MARKER: 1 };
  await readSafeModeExtrinsics(env);
  assert.equal(coldTier.calls.length, 1, "one tier read, no HTTP hop");
  const [passedEnv, query] = coldTier.calls[0] as [
    unknown,
    Record<string, unknown>,
  ];
  assert.equal(passedEnv, env, "the reader threads env through to the tier");
  assert.equal(query.module, "SafeMode");
  assert.equal(query.limit, SAFE_MODE_EXTRINSIC_LIMIT);
  assert.ok(
    (query.limit as number) <= 100,
    "the retired HTTP call asked for 200 against a route that caps at 100",
  );
});

test("a DECLINED tier reads as null, never as 'no SafeMode activity'", async () => {
  // loadExtrinsicFeedColdTier returns null when it cannot express the query
  // safely or the lakehouse will not serve it. Collapsing that to [] would
  // publish `succeeded: 0` -- an assertion that no SafeMode call has ever
  // landed, made by a monitor that just failed to look.
  coldTier.result = null;
  assert.equal(await readSafeModeExtrinsics({}), null);
});

test("an EMPTY feed is a real answer, and reads as the empty list", async () => {
  coldTier.result = { extrinsics: [] };
  assert.deepEqual(await readSafeModeExtrinsics({}), []);
});

test("a feed with no extrinsics key still reads as empty rather than throwing", async () => {
  // Shape tolerance on an answered read: the tier said it could serve the
  // query, so an absent list is an empty list.
  coldTier.result = {};
  assert.deepEqual(await readSafeModeExtrinsics({}), []);
});

test("the rows come back as the rule's own shape", async () => {
  const row = {
    block_number: 4_222_830,
    call_function: "force_release_deposit",
    success: false,
    signer: "5H6tCSXfWreW",
  };
  coldTier.result = { extrinsics: [row] };
  assert.deepEqual(await readSafeModeExtrinsics({}), [row]);
});

test("a throwing tier propagates, and the runner turns it into the same blind half", async () => {
  // The reader does not swallow: runSafeModeWatchdog catches, so a throw and a
  // null arrive at the rule identically. Swallowing here would lose the cause.
  coldTier.result = new Error("r2 sql: HTTP 500");
  await assert.rejects(() => readSafeModeExtrinsics({}), /r2 sql: HTTP 500/);
});
