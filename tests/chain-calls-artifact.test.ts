// Same family contract as chain-transfers-artifact.test.ts: the stored
// grouped rows flow through the SAME buildChainCalls formatter, sliced to
// the caller's limit BEFORE the formatter (data-api's LIMIT-ed-fetch row
// set) with shares dividing by the stored full-window total, and anything
// that is not the artifact the lane wrote — including a group_by it did not
// precompute or a call_module scope, which is never precomputed — declines.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_CALLS_PROJECTION_KEY,
  loadChainCallsFromArtifact,
} from "../src/chain-calls-artifact.ts";

const NEWEST = 1785680000000;

function artifact() {
  return {
    schema_version: 1,
    generated_at: "2026-08-02T12:00:00.000Z",
    row_count: 5,
    windows: {
      "7d": {
        days: 7,
        newest_observed: NEWEST,
        total: "200",
        groups: {
          module: [
            { call_module: "Balances", count: "120" },
            { call_module: "SubtensorModule", count: "60" },
          ],
          module_function: [
            {
              call_module: "Balances",
              call_function: "transfer_keep_alive",
              count: "90",
            },
          ],
        },
      },
      "30d": {
        days: 30,
        newest_observed: null,
        total: 0,
        groups: { module: [], module_function: [] },
      },
    },
  };
}

function bucketWith(body: unknown, opts: { missing?: boolean } = {}) {
  const gets: string[] = [];
  return {
    gets,
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          gets.push(key);
          if (opts.missing) return null;
          return { json: async () => body };
        },
      },
    } as unknown as Env,
  };
}

describe("loadChainCallsFromArtifact", () => {
  test("serves the default window/group_by through the shared formatter", async () => {
    const { env, gets } = bucketWith(artifact());
    const data = await loadChainCallsFromArtifact(env, { limit: 50 });
    assert.equal(gets[0], CHAIN_CALLS_PROJECTION_KEY);
    assert.equal(data!.window, "7d");
    assert.equal(data!.group_by, "module");
    assert.equal(data!.total_extrinsics, 200);
    assert.equal(data!.call_count, 2);
    // share divides by the stored full-window total, exactly like data-api's
    // separately-read denominator.
    assert.equal(data!.calls[0]!.call_module, "Balances");
    assert.equal(data!.calls[0]!.share, 120 / 200);
    assert.equal(data!.observed_at, new Date(NEWEST).toISOString());
  });

  test("the module_function variant serves its own precomputed rows", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainCallsFromArtifact(env, {
      groupBy: "module_function",
      limit: 50,
    });
    assert.equal(data!.group_by, "module_function");
    assert.equal(data!.calls[0]!.call_function, "transfer_keep_alive");
    assert.equal(data!.calls[0]!.count, 90);
  });

  test("the limit slices BEFORE the formatter — a prefix of the same total order", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainCallsFromArtifact(env, { limit: 1 });
    assert.equal(data!.call_count, 1);
    assert.equal(data!.calls[0]!.call_module, "Balances");
    // The share denominator is limit-independent.
    assert.equal(data!.calls[0]!.share, 120 / 200);
  });

  test("a malformed limit falls back to the route default; an oversize one is capped", async () => {
    const body = artifact();
    body.windows["7d"].groups.module = Array.from({ length: 120 }, (_, i) => ({
      call_module: `Pallet${String(i).padStart(3, "0")}`,
      count: String(120 - i),
    }));
    const { env } = bucketWith(body);
    const defaulted = await loadChainCallsFromArtifact(env, {
      limit: "bogus",
    });
    assert.equal(defaulted!.call_count, 50);
    const capped = await loadChainCallsFromArtifact(env, { limit: 500 });
    assert.equal(capped!.call_count, 100);
  });

  test("a call_module scope declines — it is never precomputed", async () => {
    const { env, gets } = bucketWith(artifact());
    assert.equal(
      await loadChainCallsFromArtifact(env, {
        limit: 50,
        callModule: "Balances",
      }),
      null,
    );
    // Declined before the store is even read.
    assert.equal(gets.length, 0);
    // An empty scope is the unfiltered route shape, not a filter.
    const data = await loadChainCallsFromArtifact(env, {
      limit: 50,
      callModule: "",
    });
    assert.equal(data!.total_extrinsics, 200);
  });

  test("every precomputed window is servable", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainCallsFromArtifact(env, {
      window: "30d",
      limit: 50,
    });
    assert.equal(data!.window, "30d");
    assert.equal(data!.total_extrinsics, 0);
    assert.equal(data!.observed_at, null);
  });

  test("a window outside the route's set declines — never a different window's numbers", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainCallsFromArtifact(env, { window: "90d", limit: 50 }),
      null,
    );
  });

  test("a supported window the artifact does not carry declines", async () => {
    const body = artifact() as unknown as { windows: Record<string, unknown> };
    delete body.windows["30d"];
    const { env } = bucketWith(body);
    assert.equal(
      await loadChainCallsFromArtifact(env, { window: "30d", limit: 50 }),
      null,
    );
  });

  test("an unknown group_by declines — never a different grouping's rows", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainCallsFromArtifact(env, { groupBy: "bogus", limit: 50 }),
      null,
    );
  });

  test("an unbound bucket declines", async () => {
    assert.equal(
      await loadChainCallsFromArtifact({} as never, { limit: 50 }),
      null,
    );
    assert.equal(await loadChainCallsFromArtifact(null, { limit: 50 }), null);
  });

  test("a missing object declines", async () => {
    const { env } = bucketWith(null, { missing: true });
    assert.equal(await loadChainCallsFromArtifact(env, { limit: 50 }), null);
  });

  test("a body that is not the artifact declines rather than half-serving", async () => {
    for (const body of [
      null,
      {},
      { schema_version: 2, windows: {} },
      { schema_version: 1 },
      { schema_version: 1, windows: null },
      { schema_version: 1, windows: { "7d": null } },
      { schema_version: 1, windows: { "7d": { groups: null } } },
      { schema_version: 1, windows: { "7d": { groups: "no" } } },
      {
        schema_version: 1,
        windows: { "7d": { groups: { module_function: [] } } },
      },
      {
        schema_version: 1,
        windows: { "7d": { groups: { module: "not-an-array" } } },
      },
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadChainCallsFromArtifact(env, { limit: 50 }),
        null,
        JSON.stringify(body),
      );
    }
  });

  test("a throwing store declines instead of failing the request", async () => {
    const env = {
      METAGRAPH_ARCHIVE: {
        async get() {
          throw new Error("r2 down");
        },
      },
    } as unknown as Env;
    assert.equal(await loadChainCallsFromArtifact(env, { limit: 50 }), null);
  });
});
