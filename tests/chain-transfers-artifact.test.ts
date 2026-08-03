// The projection artifact serves every window/limit combination the route
// accepts, so the properties under test are fidelity (rows flow through the
// SAME buildChainTransfers formatter, sliced to the caller's limit BEFORE
// top_sender_share is computed) and the decline contract: anything that is
// not the artifact the lane wrote — including a window it did not precompute
// — is a null, never a guess.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_TRANSFERS_PROJECTION_KEY,
  loadChainTransfersFromArtifact,
} from "../src/chain-transfers-artifact.ts";

const NEWEST = 1785680000000;

function party(address: string, volume: number, count: number) {
  return {
    address,
    volume_tao: String(volume),
    transfer_count: String(count),
  };
}

function artifact() {
  return {
    schema_version: 1,
    generated_at: "2026-08-02T12:00:00.000Z",
    row_count: 5,
    windows: {
      "7d": {
        days: 7,
        totals: {
          transfer_count: "12",
          total_volume_tao: "2000",
          newest_observed: NEWEST,
          unique_senders: "5",
          unique_receivers: "6",
        },
        senders: [party("5A", 600, 7), party("5B", 400, 5)],
        receivers: [party("5C", 2000, 12)],
      },
      "30d": {
        days: 30,
        totals: {
          transfer_count: "40",
          total_volume_tao: "9000",
          newest_observed: NEWEST,
          unique_senders: "9",
          unique_receivers: "9",
        },
        senders: [party("5D", 9000, 40)],
        receivers: [party("5E", 9000, 40)],
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

describe("loadChainTransfersFromArtifact", () => {
  test("serves the default window through the shared formatter", async () => {
    const { env, gets } = bucketWith(artifact());
    const data = await loadChainTransfersFromArtifact(env, { limit: 25 });
    assert.equal(gets[0], CHAIN_TRANSFERS_PROJECTION_KEY);
    assert.equal(data!.window, "7d");
    assert.equal(data!.total_volume_tao, 2000);
    assert.equal(data!.transfer_count, 12);
    assert.equal(data!.unique_senders, 5);
    assert.equal(data!.unique_receivers, 6);
    // The stored MAX(observed_at) surfaces as the same ISO freshness signal
    // the live tier reported.
    assert.equal(data!.observed_at, new Date(NEWEST).toISOString());
    assert.deepEqual(
      data!.top_senders.map((row) => row.address),
      ["5A", "5B"],
    );
    assert.equal(data!.top_sender_share, (600 + 400) / 2000);
  });

  test("the limit slices BEFORE the formatter, so top_sender_share tracks the page", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainTransfersFromArtifact(env, {
      window: "7d",
      limit: 1,
    });
    assert.deepEqual(
      data!.top_senders.map((row) => row.address),
      ["5A"],
    );
    assert.deepEqual(
      data!.top_receivers.map((row) => row.address),
      ["5C"],
    );
    assert.equal(data!.top_sender_share, 600 / 2000);
  });

  test("every precomputed window is servable", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainTransfersFromArtifact(env, {
      window: "30d",
      limit: 25,
    });
    assert.equal(data!.window, "30d");
    assert.equal(data!.total_volume_tao, 9000);
  });

  test("a window outside the route's set declines — never a different window's numbers", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainTransfersFromArtifact(env, { window: "90d", limit: 25 }),
      null,
    );
  });

  test("a supported window the artifact does not carry declines", async () => {
    const body = artifact() as unknown as { windows: Record<string, unknown> };
    delete body.windows["30d"];
    const { env } = bucketWith(body);
    assert.equal(
      await loadChainTransfersFromArtifact(env, { window: "30d", limit: 25 }),
      null,
    );
  });

  test("a malformed limit falls back to the route default; an oversize one is capped", async () => {
    const body = artifact();
    body.windows["7d"].senders = Array.from({ length: 120 }, (_, i) =>
      party(`5S${i}`, 120 - i, 1),
    );
    const { env } = bucketWith(body);
    const defaulted = await loadChainTransfersFromArtifact(env, {
      window: "7d",
      limit: "bogus",
    });
    assert.equal(defaulted!.top_senders.length, 25);
    const capped = await loadChainTransfersFromArtifact(env, {
      window: "7d",
      limit: 500,
    });
    assert.equal(capped!.top_senders.length, 100);
  });

  test("a missing newest_observed yields a null observed_at, not an epoch-0 date", async () => {
    const body = artifact();
    body.windows["7d"].totals.newest_observed = null as unknown as number;
    const { env } = bucketWith(body);
    const data = await loadChainTransfersFromArtifact(env, { limit: 25 });
    assert.equal(data!.observed_at, null);
  });

  test("an unbound bucket declines", async () => {
    assert.equal(
      await loadChainTransfersFromArtifact({} as never, { limit: 25 }),
      null,
    );
    assert.equal(
      await loadChainTransfersFromArtifact(null, { limit: 25 }),
      null,
    );
  });

  test("a missing object declines", async () => {
    const { env } = bucketWith(null, { missing: true });
    assert.equal(
      await loadChainTransfersFromArtifact(env, { limit: 25 }),
      null,
    );
  });

  test("a body that is not the artifact declines rather than half-serving", async () => {
    for (const body of [
      null,
      {},
      { schema_version: 2, windows: {} },
      { schema_version: 1 },
      { schema_version: 1, windows: null },
      { schema_version: 1, windows: { "7d": null } },
      { schema_version: 1, windows: { "7d": { totals: null } } },
      {
        schema_version: 1,
        windows: { "7d": { totals: {}, senders: "no", receivers: [] } },
      },
      {
        schema_version: 1,
        windows: { "7d": { totals: {}, senders: [], receivers: "no" } },
      },
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadChainTransfersFromArtifact(env, { limit: 25 }),
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
    assert.equal(
      await loadChainTransfersFromArtifact(env, { limit: 25 }),
      null,
    );
  });
});
