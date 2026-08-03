// Same family contract as chain-transfers-artifact.test.ts: the stored
// daily/median/payer rows flow through the SAME buildChainFees formatter,
// with the payer leaderboard sliced to the caller's limit BEFORE the
// formatter (data-api's LIMIT-ed-fetch row set), and anything that is not
// the artifact the lane wrote — including a call_module scope, which is
// never precomputed — declines rather than half-serving.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_FEES_PROJECTION_KEY,
  loadChainFeesFromArtifact,
} from "../src/chain-fees-artifact.ts";

const NEWEST = 1785680000000;

function payer(signer: string, fee: number, count: number) {
  return {
    signer,
    total_fee_tao: String(fee),
    total_tip_tao: "0",
    extrinsic_count: String(count),
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
        daily_rows: [
          {
            day: "2026-08-02",
            extrinsic_count: "100",
            signed_extrinsic_count: "80",
            total_fee_tao: "1.6",
            total_tip_tao: "0.4",
          },
          {
            day: "2026-08-01",
            extrinsic_count: "40",
            signed_extrinsic_count: "0",
            total_fee_tao: "0",
            total_tip_tao: "0",
          },
        ],
        median_rows: [
          { day: "2026-08-02", median_fee_tao: 0.005, median_tip_tao: 0.001 },
        ],
        payer_rows: [payer("5A", 0.9, 10), payer("5B", 0.7, 8)],
      },
      "30d": {
        days: 30,
        newest_observed: null,
        daily_rows: [],
        median_rows: [],
        payer_rows: [],
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

describe("loadChainFeesFromArtifact", () => {
  test("serves the default window through the shared formatter", async () => {
    const { env, gets } = bucketWith(artifact());
    const data = await loadChainFeesFromArtifact(env, { limit: 25 });
    assert.equal(gets[0], CHAIN_FEES_PROJECTION_KEY);
    assert.equal(data!.window, "7d");
    assert.equal(data!.day_count, 2);
    // Newest day first; medians joined by day; averages over SIGNED counts.
    assert.equal(data!.daily[0]!.day, "2026-08-02");
    assert.equal(data!.daily[0]!.median_fee_tao, 0.005);
    assert.equal(data!.daily[0]!.median_tip_tao, 0.001);
    assert.equal(data!.daily[0]!.avg_fee_tao, 0.02);
    // A day with no signed extrinsics has no fee stats, never fabricated 0s.
    assert.equal(data!.daily[1]!.median_fee_tao, null);
    assert.equal(data!.daily[1]!.avg_fee_tao, null);
    assert.deepEqual(
      data!.top_fee_payers.map((row) => row.signer),
      ["5A", "5B"],
    );
    assert.equal(data!.observed_at, new Date(NEWEST).toISOString());
  });

  test("the limit slices the payer leaderboard BEFORE the formatter", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainFeesFromArtifact(env, { limit: 1 });
    assert.deepEqual(
      data!.top_fee_payers.map((row) => row.signer),
      ["5A"],
    );
    // The daily series is not a leaderboard; the limit never truncates it.
    assert.equal(data!.day_count, 2);
  });

  test("a malformed limit falls back to the route default; an oversize one is capped", async () => {
    const body = artifact();
    body.windows["7d"].payer_rows = Array.from({ length: 120 }, (_, i) =>
      payer(`5P${String(i).padStart(3, "0")}`, 120 - i, 1),
    );
    const { env } = bucketWith(body);
    const defaulted = await loadChainFeesFromArtifact(env, { limit: "bogus" });
    assert.equal(defaulted!.top_fee_payers.length, 25);
    const capped = await loadChainFeesFromArtifact(env, { limit: 500 });
    assert.equal(capped!.top_fee_payers.length, 100);
  });

  test("a call_module scope declines — it is never precomputed", async () => {
    const { env, gets } = bucketWith(artifact());
    assert.equal(
      await loadChainFeesFromArtifact(env, {
        limit: 25,
        callModule: "Balances",
      }),
      null,
    );
    assert.equal(gets.length, 0);
    // An empty scope is the unfiltered route shape, not a filter.
    const data = await loadChainFeesFromArtifact(env, {
      limit: 25,
      callModule: "",
    });
    assert.equal(data!.day_count, 2);
  });

  test("every precomputed window is servable", async () => {
    const { env } = bucketWith(artifact());
    const data = await loadChainFeesFromArtifact(env, {
      window: "30d",
      limit: 25,
    });
    assert.equal(data!.window, "30d");
    assert.equal(data!.day_count, 0);
    assert.equal(data!.observed_at, null);
  });

  test("a window outside the route's set declines — never a different window's numbers", async () => {
    const { env } = bucketWith(artifact());
    assert.equal(
      await loadChainFeesFromArtifact(env, { window: "90d", limit: 25 }),
      null,
    );
  });

  test("a supported window the artifact does not carry declines", async () => {
    const body = artifact() as unknown as { windows: Record<string, unknown> };
    delete body.windows["30d"];
    const { env } = bucketWith(body);
    assert.equal(
      await loadChainFeesFromArtifact(env, { window: "30d", limit: 25 }),
      null,
    );
  });

  test("an unbound bucket declines", async () => {
    assert.equal(
      await loadChainFeesFromArtifact({} as never, { limit: 25 }),
      null,
    );
    assert.equal(await loadChainFeesFromArtifact(null, { limit: 25 }), null);
  });

  test("a missing object declines", async () => {
    const { env } = bucketWith(null, { missing: true });
    assert.equal(await loadChainFeesFromArtifact(env, { limit: 25 }), null);
  });

  test("a body that is not the artifact declines rather than half-serving", async () => {
    for (const body of [
      null,
      {},
      { schema_version: 2, windows: {} },
      { schema_version: 1 },
      { schema_version: 1, windows: null },
      { schema_version: 1, windows: { "7d": null } },
      {
        schema_version: 1,
        windows: {
          "7d": { daily_rows: "no", median_rows: [], payer_rows: [] },
        },
      },
      {
        schema_version: 1,
        windows: {
          "7d": { daily_rows: [], median_rows: "no", payer_rows: [] },
        },
      },
      {
        schema_version: 1,
        windows: {
          "7d": { daily_rows: [], median_rows: [], payer_rows: "no" },
        },
      },
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadChainFeesFromArtifact(env, { limit: 25 }),
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
    assert.equal(await loadChainFeesFromArtifact(env, { limit: 25 }), null);
  });
});
