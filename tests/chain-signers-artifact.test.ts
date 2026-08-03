// Same family contract as chain-transfers-artifact.test.ts: the stored
// leaderboard rows (one list per supported sort) flow through the SAME
// buildChainSigners formatter, sliced to the caller's limit BEFORE the
// formatter (data-api's LIMIT-ed-fetch row set), and anything that is not
// the artifact the lane wrote — including a sort it did not precompute or a
// call_module scope, which is never precomputed — declines.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_SIGNERS_PROJECTION_KEY,
  loadChainSignersFromArtifact,
} from "../src/chain-signers-artifact.ts";

const NEWEST = 1785680000000;

function signerRow(signer: string, txCount: number, fee: number) {
  return {
    signer,
    tx_count: String(txCount),
    total_fee_tao: String(fee),
    total_tip_tao: "0",
    last_tx_block: "123456",
  };
}

function artifact() {
  return {
    schema_version: 1,
    generated_at: "2026-08-02T12:00:00.000Z",
    row_count: 4,
    windows: {
      "7d": {
        days: 7,
        newest_observed: NEWEST,
        sorts: {
          tx_count: [signerRow("5A", 40, 0.1), signerRow("5B", 30, 0.9)],
          total_fee_tao: [signerRow("5B", 30, 0.9), signerRow("5A", 40, 0.1)],
        },
      },
      "30d": {
        days: 30,
        newest_observed: null,
        sorts: { tx_count: [], total_fee_tao: [] },
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

describe("loadChainSignersFromArtifact", () => {
  test("serves the default window/sort through the shared formatter", async () => {
    const { env, gets } = bucketWith(artifact());
    const data = await loadChainSignersFromArtifact(env, { limit: 50 });
    assert.equal(gets[0], CHAIN_SIGNERS_PROJECTION_KEY);
    assert.equal(data!.window, "7d");
    assert.equal(data!.sort, "tx_count");
    assert.equal(data!.signer_count, 2);
    assert.equal(data!.signers[0]!.signer, "5A");
    assert.equal(data!.signers[0]!.tx_count, 40);
    assert.equal(data!.signers[0]!.last_tx_block, 123456);
    assert.equal(data!.observed_at, new Date(NEWEST).toISOString());
  });

  test("the total_fee_tao sort serves its own precomputed order", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainSignersFromArtifact(env, {
      sort: "total_fee_tao",
      limit: 50,
    });
    assert.equal(data!.sort, "total_fee_tao");
    assert.deepEqual(
      data!.signers.map((row) => row.signer),
      ["5B", "5A"],
    );
  });

  test("the limit slices BEFORE the formatter — a prefix of the same total order", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainSignersFromArtifact(env, { limit: 1 });
    assert.equal(data!.signer_count, 1);
    assert.equal(data!.signers[0]!.signer, "5A");
  });

  test("a malformed limit falls back to the route default; an oversize one is capped", async () => {
    const body = artifact();
    body.windows["7d"].sorts.tx_count = Array.from({ length: 120 }, (_, i) =>
      signerRow(`5S${String(i).padStart(3, "0")}`, 120 - i, 0),
    );
    const { env } = bucketWith(body);
    const defaulted = await loadChainSignersFromArtifact(env, {
      limit: "bogus",
    });
    assert.equal(defaulted!.signer_count, 50);
    const capped = await loadChainSignersFromArtifact(env, { limit: 500 });
    assert.equal(capped!.signer_count, 100);
  });

  test("a call_module scope declines — it is never precomputed", async () => {
    const { env, gets } = bucketWith(artifact());
    assert.equal(
      await loadChainSignersFromArtifact(env, {
        limit: 50,
        callModule: "SubtensorModule",
      }),
      null,
    );
    assert.equal(gets.length, 0);
    // An empty scope is the unfiltered route shape, not a filter.
    const data = await loadChainSignersFromArtifact(env, {
      limit: 50,
      callModule: "",
    });
    assert.equal(data!.signer_count, 2);
  });

  test("every precomputed window is servable", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainSignersFromArtifact(env, {
      window: "30d",
      limit: 50,
    });
    assert.equal(data!.window, "30d");
    assert.equal(data!.signer_count, 0);
    assert.equal(data!.observed_at, null);
  });

  test("a window outside the route's set declines — never a different window's numbers", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainSignersFromArtifact(env, { window: "90d", limit: 50 }),
      null,
    );
  });

  test("a supported window the artifact does not carry declines", async () => {
    const body = artifact() as unknown as { windows: Record<string, unknown> };
    delete body.windows["30d"];
    const { env } = bucketWith(body);
    assert.equal(
      await loadChainSignersFromArtifact(env, { window: "30d", limit: 50 }),
      null,
    );
  });

  test("an unknown sort declines — never a different order's rows", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainSignersFromArtifact(env, { sort: "bogus", limit: 50 }),
      null,
    );
  });

  test("an unbound bucket declines", async () => {
    assert.equal(
      await loadChainSignersFromArtifact({} as never, { limit: 50 }),
      null,
    );
    assert.equal(await loadChainSignersFromArtifact(null, { limit: 50 }), null);
  });

  test("a missing object declines", async () => {
    const { env } = bucketWith(null, { missing: true });
    assert.equal(await loadChainSignersFromArtifact(env, { limit: 50 }), null);
  });

  test("a body that is not the artifact declines rather than half-serving", async () => {
    for (const body of [
      null,
      {},
      { schema_version: 2, windows: {} },
      { schema_version: 1 },
      { schema_version: 1, windows: null },
      { schema_version: 1, windows: { "7d": null } },
      { schema_version: 1, windows: { "7d": { sorts: null } } },
      { schema_version: 1, windows: { "7d": { sorts: "no" } } },
      {
        schema_version: 1,
        windows: { "7d": { sorts: { total_fee_tao: [] } } },
      },
      {
        schema_version: 1,
        windows: { "7d": { sorts: { tx_count: "not-an-array" } } },
      },
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadChainSignersFromArtifact(env, { limit: 50 }),
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
    assert.equal(await loadChainSignersFromArtifact(env, { limit: 50 }), null);
  });
});
