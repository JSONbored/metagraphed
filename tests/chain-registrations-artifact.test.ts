// The chain-registrations projection reader (#9146).
//
// The failure mode specific to THIS lane is the network rollup. It is a
// separate COUNT(DISTINCT hotkey) over the whole window, not a sum of the
// per-subnet rows: one hotkey registering on three subnets is three
// subnet-level registrants but ONE network-wide distinct registrant. A reader
// that recomputed the rollup from the rows would overcount plausibly and
// silently, so it gets its own test.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_REGISTRATIONS_PROJECTION_KEY,
  loadChainRegistrationsFromArtifact,
} from "../src/chain-registrations-artifact.ts";
import type { Row } from "./row-type.ts";

function subnetRow(netuid: number, registrations: number, registrants: number) {
  return {
    netuid,
    registrations,
    distinct_registrants: registrants,
  };
}

const BODY = {
  schema_version: 1,
  generated_at: "2026-08-03T09:00:00.000Z",
  row_count: 3,
  windows: {
    "7d": {
      days: 7,
      // 463 + 392 + 390 = 1,245 registrations across 3 subnets, but only 900
      // DISTINCT hotkeys network-wide -- deliberately less than the row sum
      // (415 + 368 + 248 = 1,031) so an overcount is visible.
      network: {
        distinct_registrants: 900,
        newest_observed: 1_785_708_492_001,
      },
      rows: [
        subnetRow(5, 463, 415),
        subnetRow(15, 392, 368),
        subnetRow(68, 390, 248),
      ],
    },
    "30d": {
      days: 30,
      network: { distinct_registrants: 12, newest_observed: 1_785_700_000_000 },
      rows: [subnetRow(1, 20, 12)],
    },
  },
};

/** An R2 double returning `body` for the projection key and null otherwise. */
function envWith(body: unknown, opts: { throws?: boolean } = {}) {
  const keys: string[] = [];
  return {
    keys,
    env: {
      METAGRAPH_ARCHIVE: {
        get(key: string) {
          keys.push(key);
          if (opts.throws) return Promise.reject(new Error("r2 down"));
          if (key !== CHAIN_REGISTRATIONS_PROJECTION_KEY) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ json: () => Promise.resolve(body) });
        },
      },
    } as unknown as Env,
  };
}

describe("loadChainRegistrationsFromArtifact", () => {
  test("ranks the per-subnet leaderboard from the stored rows", async () => {
    const { env, keys } = envWith(BODY);
    const out = (await loadChainRegistrationsFromArtifact(env, {
      window: "7d",
    })) as Row;
    assert.ok(out);
    assert.equal(out.window, "7d");
    assert.equal(out.subnet_count, 3);
    assert.deepEqual(
      (out.subnets as Row[]).map((s) => s.netuid),
      [5, 15, 68],
    );
    assert.equal((out.subnets as Row[])[0].registrations, 463);
    assert.deepEqual(keys, [CHAIN_REGISTRATIONS_PROJECTION_KEY]);
  });

  test("uses the stored network rollup, never a sum of the rows", async () => {
    // The rows sum to 1,031 registrants; the true network-wide distinct count
    // is 900. Recomputing from rows would report 1,031 and look reasonable.
    const { env } = envWith(BODY);
    const out = (await loadChainRegistrationsFromArtifact(env, {
      window: "7d",
    })) as Row;
    assert.equal((out.network as Row).distinct_registrants, 900);
    assert.notEqual((out.network as Row).distinct_registrants, 1031);
  });

  test("carries the window's own newest_observed as observed_at", async () => {
    const { env } = envWith(BODY);
    const out = (await loadChainRegistrationsFromArtifact(env, {
      window: "7d",
    })) as Row;
    assert.equal(out.observed_at, new Date(1_785_708_492_001).toISOString());
  });

  test("applies the caller's limit to the leaderboard", async () => {
    const { env } = envWith(BODY);
    const out = (await loadChainRegistrationsFromArtifact(env, {
      window: "7d",
      limit: 2,
    })) as Row;
    assert.equal((out.subnets as Row[]).length, 2);
    // subnet_count stays the true total, not the sliced length.
    assert.equal(out.subnet_count, 3);
  });

  test("serves each window from its own bucket", async () => {
    const { env } = envWith(BODY);
    const out = (await loadChainRegistrationsFromArtifact(env, {
      window: "30d",
    })) as Row;
    assert.deepEqual(
      (out.subnets as Row[]).map((s) => s.netuid),
      [1],
    );
    assert.equal((out.network as Row).distinct_registrants, 12);
  });

  test("defaults to the route's default window", async () => {
    const { env } = envWith(BODY);
    const out = (await loadChainRegistrationsFromArtifact(env, {})) as Row;
    assert.equal(out.window, "7d");
  });

  test("declines a window the lane did not precompute", async () => {
    // The failure this prevents: answering with a DIFFERENT window's numbers.
    const { env } = envWith({
      schema_version: 1,
      windows: { "7d": BODY.windows["7d"] },
    });
    assert.equal(
      await loadChainRegistrationsFromArtifact(env, { window: "30d" }),
      null,
    );
  });

  test("declines a window outside the route's set", async () => {
    const { env } = envWith(BODY);
    assert.equal(
      await loadChainRegistrationsFromArtifact(env, { window: "90d" }),
      null,
    );
  });

  test("tolerates a window with no network aggregate", async () => {
    // An empty window stores network: null (the lane's cold-store guard skips
    // the grouping). That is a genuine zero, not a decline.
    const { env } = envWith({
      schema_version: 1,
      windows: { "7d": { days: 7, network: null, rows: [] } },
    });
    const out = (await loadChainRegistrationsFromArtifact(env, {
      window: "7d",
    })) as Row;
    assert.ok(out);
    assert.equal(out.subnet_count, 0);
    assert.equal((out.network as Row).distinct_registrants, 0);
  });

  test.each([
    ["no binding", null],
    ["wrong schema_version", { schema_version: 2, windows: {} }],
    ["windows absent", { schema_version: 1 }],
    ["windows null", { schema_version: 1, windows: null }],
    ["rows not an array", { schema_version: 1, windows: { "7d": {} } }],
  ] as [string, unknown][])(
    "declines when the artifact is unusable: %s",
    async (_label, body) => {
      const env = body === null ? ({} as unknown as Env) : envWith(body).env;
      assert.equal(
        await loadChainRegistrationsFromArtifact(env, { window: "7d" }),
        null,
      );
    },
  );

  test("declines when the object is missing", async () => {
    const env = {
      METAGRAPH_ARCHIVE: { get: () => Promise.resolve(null) },
    } as unknown as Env;
    assert.equal(
      await loadChainRegistrationsFromArtifact(env, { window: "7d" }),
      null,
    );
  });

  test("declines rather than throwing when the store errors", async () => {
    const { env } = envWith(BODY, { throws: true });
    assert.equal(
      await loadChainRegistrationsFromArtifact(env, { window: "7d" }),
      null,
    );
  });

  test("declines on a null env", async () => {
    assert.equal(
      await loadChainRegistrationsFromArtifact(null, { window: "7d" }),
      null,
    );
  });
});
