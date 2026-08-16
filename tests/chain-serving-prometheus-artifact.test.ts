// The two projection readers added in #11419, held to the same contract as
// their twelve siblings: the stored per-subnet rows and network DISTINCT row
// flow VERBATIM into the shared builder, and anything that is not the artifact
// the lane wrote DECLINES rather than half-serving.
//
// Both readers are why un-gating these routes for testnet is safe. The cold
// tier under them names `chain.account_events` through `chainTable(...)` now,
// and these read a per-network key -- so a testnet request can no longer be
// answered with mainnet's rows, which is what tests/chain-history-networks.ts
// refused to let ship.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  CHAIN_SERVING_PROJECTION_KEY,
  loadChainServingFromArtifact,
} from "../src/chain-serving-artifact.ts";
import {
  CHAIN_PROMETHEUS_PROJECTION_KEY,
  loadChainPrometheusFromArtifact,
} from "../src/chain-prometheus-artifact.ts";
import {
  CHAIN_WEIGHTS_PROJECTION_KEY,
  loadChainWeightsFromArtifact,
} from "../src/chain-weights-artifact.ts";
import {
  CHAIN_WEIGHT_SETTERS_PROJECTION_KEY,
  loadChainWeightSettersFromArtifact,
} from "../src/chain-weight-setters-artifact.ts";

const NEWEST = 1_786_900_000_000;

/** The lane's stored shape: per-subnet rows plus the chain-wide DISTINCT row. */
function artifact(distinctField: string) {
  return {
    schema_version: 1,
    generated_at: "2026-08-16T12:00:00.000Z",
    row_count: 2,
    windows: {
      "7d": {
        days: 7,
        network: { [distinctField]: "5", newest_observed: NEWEST },
        rows: [
          {
            netuid: 3,
            announcements: "10",
            weight_sets: "10",
            [distinctField]: "2",
          },
          {
            netuid: 11,
            announcements: "4",
            weight_sets: "4",
            [distinctField]: "4",
          },
        ],
      },
      "30d": { days: 30, network: null, rows: [] },
    },
  };
}

function bucketWith(body: unknown, { missing = false } = {}) {
  const gets: string[] = [];
  return {
    gets,
    env: {
      METAGRAPH_ARCHIVE: {
        async get(key: string) {
          gets.push(key);
          if (missing) return null;
          return {
            async json() {
              return body;
            },
          };
        },
      },
    } as unknown as Env,
  };
}

const CASES = [
  {
    name: "chain-serving",
    key: CHAIN_SERVING_PROJECTION_KEY,
    distinctField: "distinct_servers",
    load: loadChainServingFromArtifact,
  },
  {
    name: "chain-prometheus",
    key: CHAIN_PROMETHEUS_PROJECTION_KEY,
    distinctField: "distinct_exporters",
    load: loadChainPrometheusFromArtifact,
  },
  // #11418: same per-netuid rollup shape, so it is held to the same contract.
  // Its rows count `weight_sets` rather than `announcements`, which the
  // builder reads and this fixture supplies through `countField`.
  {
    name: "chain-weights",
    key: CHAIN_WEIGHTS_PROJECTION_KEY,
    distinctField: "distinct_setters",
    load: loadChainWeightsFromArtifact,
  },
] as const;

for (const { name, key, distinctField, load } of CASES) {
  describe(`${name} projection reader`, () => {
    test("serves the stored window through the shared builder", async () => {
      const { env, gets } = bucketWith(artifact(distinctField));
      const card = await load(env, { window: "7d" });
      assert.ok(card);
      assert.deepEqual(
        gets,
        [key],
        "reads mainnet's unprefixed key by default",
      );
      assert.equal(card.window, "7d");
      // Ranking, the rollup and the distribution are the BUILDER's -- the
      // reader hands over rows and nothing else, which is what keeps the
      // projection tier and the cold tier byte-identical.
      assert.equal(card.subnets.length, 2);
      assert.equal(card.subnet_count, 2);
      assert.ok(card.network);
      assert.equal(card.observed_at, new Date(NEWEST).toISOString());
    });

    test("subnet_count counts the POPULATION even when the page is narrower", async () => {
      // #10249's defect in the other direction: the lane stores every row, so
      // `subnets.length` is the true population and a `limit` must narrow the
      // page WITHOUT moving the count.
      const { env } = bucketWith(artifact(distinctField));
      const card = await load(env, { window: "7d", limit: 1 });
      assert.ok(card);
      assert.equal(card.subnets.length, 1, "the page narrowed");
      assert.equal(card.subnet_count, 2, "the population did not");
    });

    test("a window the lane precomputed but found empty is still an ANSWER", async () => {
      const { env } = bucketWith(artifact(distinctField));
      const card = await load(env, { window: "30d" });
      assert.ok(card, "an empty stored window is not a decline");
      assert.deepEqual(card.subnets, []);
    });

    test("defaults to the route's own window when none is asked for", async () => {
      const { env } = bucketWith(artifact(distinctField));
      const card = await load(env, {});
      assert.ok(card);
      assert.equal(card.window, "7d", "DEFAULT_ANALYTICS_WINDOW");
    });

    test("reads the per-network key off mainnet, never mainnet's", async () => {
      const { env, gets } = bucketWith(artifact(distinctField));
      await load(env, { window: "7d" }, "testnet");
      assert.ok(gets.length > 0, "the reader actually looked");
      assert.ok(
        !gets.includes(key),
        "a testnet request must never reach for the mainnet artifact",
      );
    });

    describe("declines rather than half-serving", () => {
      test("no archive bound at all", async () => {
        assert.equal(await load({} as unknown as Env, { window: "7d" }), null);
      });

      test("the object is missing", async () => {
        const { env } = bucketWith(null, { missing: true });
        assert.equal(await load(env, { window: "7d" }), null);
      });

      test("a body that is not the artifact the lane wrote", async () => {
        for (const body of [
          null,
          { schema_version: 2, windows: {} },
          { schema_version: 1 },
          { schema_version: 1, windows: null },
          { schema_version: 1, windows: "not an object" },
        ]) {
          const { env } = bucketWith(body);
          assert.equal(
            await load(env, { window: "7d" }),
            null,
            `${JSON.stringify(body)} must decline`,
          );
        }
      });

      test("a window outside the route's own set", async () => {
        // Must never be answered with a DIFFERENT window's numbers.
        const { env } = bucketWith(artifact(distinctField));
        assert.equal(await load(env, { window: "90d" }), null);
      });

      test("a window the route publishes but this artifact does not carry", async () => {
        const partial = artifact(distinctField);
        delete (partial.windows as Record<string, unknown>)["30d"];
        const { env } = bucketWith(partial);
        assert.equal(await load(env, { window: "30d" }), null);
      });

      test("rows that are not an array", async () => {
        const bad = artifact(distinctField);
        (bad.windows["7d"] as Record<string, unknown>).rows = "nope";
        const { env } = bucketWith(bad);
        assert.equal(await load(env, { window: "7d" }), null);
      });

      test("a network cell that is neither an object nor null", async () => {
        const bad = artifact(distinctField);
        (bad.windows["7d"] as Record<string, unknown>).network = "nope";
        const { env } = bucketWith(bad);
        assert.equal(await load(env, { window: "7d" }), null);
      });

      test("a bucket that throws", async () => {
        const env = {
          METAGRAPH_ARCHIVE: {
            async get() {
              throw new Error("archive unavailable");
            },
          },
        } as unknown as Env;
        assert.equal(await load(env, { window: "7d" }), null);
      });
    });
  });
}

// The per-IDENTITY reader stores `{ rows, totals }` rather than
// `{ network, rows }`, so it gets its own block rather than being bent into the
// shared table above (#11418).
describe("chain-weight-setters projection reader", () => {
  function settersArtifact() {
    return {
      schema_version: 1,
      generated_at: "2026-08-16T12:00:00.000Z",
      row_count: 2,
      windows: {
        "7d": {
          days: 7,
          totals: { weight_sets: "40", distinct_setters: "9" },
          rows: [
            { netuid: 3, uid: 1, weight_sets: "30", last_set: NEWEST },
            { netuid: 3, uid: 2, weight_sets: "10", last_set: NEWEST - 1000 },
          ],
        },
        "30d": { days: 30, totals: {}, rows: [] },
      },
    };
  }

  test("serves the stored leaderboard through the shared builder", async () => {
    const { env, gets } = bucketWith(settersArtifact());
    const card = await loadChainWeightSettersFromArtifact(env, {
      window: "7d",
    });
    assert.ok(card);
    assert.deepEqual(gets, [CHAIN_WEIGHT_SETTERS_PROJECTION_KEY]);
    assert.equal(card.setters.length, 2);
  });

  test("the SHARE denominator comes from totals, not from the page", async () => {
    // The reason totals ride separately: the page is capped by `limit`, so a
    // share summed from it would grow as the page shrank.
    const { env } = bucketWith(settersArtifact());
    const full = await loadChainWeightSettersFromArtifact(env, {
      window: "7d",
    });
    const { env: env2 } = bucketWith(settersArtifact());
    const paged = await loadChainWeightSettersFromArtifact(env2, {
      window: "7d",
      limit: 1,
    });
    assert.ok(full && paged);
    assert.equal(paged.setters.length, 1, "the page narrowed");
    assert.equal(
      paged.weight_sets,
      full.weight_sets,
      "the denominator did not move with the page",
    );
  });

  test("a missing totals object DECLINES rather than publishing shares of nothing", async () => {
    // Unlike the per-netuid readers, the builder has nothing to fall back to
    // here: without a denominator every share is undefined.
    const bad = settersArtifact();
    delete (bad.windows["7d"] as Record<string, unknown>).totals;
    const { env } = bucketWith(bad);
    assert.equal(
      await loadChainWeightSettersFromArtifact(env, { window: "7d" }),
      null,
    );
  });

  test("reads the per-network key off mainnet", async () => {
    const { env, gets } = bucketWith(settersArtifact());
    await loadChainWeightSettersFromArtifact(env, { window: "7d" }, "testnet");
    assert.ok(gets.length > 0);
    assert.ok(!gets.includes(CHAIN_WEIGHT_SETTERS_PROJECTION_KEY));
  });

  test("declines on every shape that is not the artifact the lane wrote", async () => {
    for (const body of [
      null,
      { schema_version: 2, windows: {} },
      { schema_version: 1, windows: null },
    ]) {
      const { env } = bucketWith(body);
      assert.equal(
        await loadChainWeightSettersFromArtifact(env, { window: "7d" }),
        null,
      );
    }
    const { env: noBucket } = { env: {} as unknown as Env };
    assert.equal(
      await loadChainWeightSettersFromArtifact(noBucket, { window: "7d" }),
      null,
    );
    const bad = settersArtifact();
    (bad.windows["7d"] as Record<string, unknown>).rows = "nope";
    const { env: badRows } = bucketWith(bad);
    assert.equal(
      await loadChainWeightSettersFromArtifact(badRows, { window: "7d" }),
      null,
    );
    const { env: missing } = bucketWith(null, { missing: true });
    assert.equal(
      await loadChainWeightSettersFromArtifact(missing, { window: "7d" }),
      null,
    );
    const throwing = {
      METAGRAPH_ARCHIVE: {
        async get() {
          throw new Error("archive unavailable");
        },
      },
    } as unknown as Env;
    assert.equal(
      await loadChainWeightSettersFromArtifact(throwing, { window: "7d" }),
      null,
    );
    const { env: badWindow } = bucketWith(settersArtifact());
    assert.equal(
      await loadChainWeightSettersFromArtifact(badWindow, { window: "90d" }),
      null,
      "a window outside the route's own set",
    );
    // A window the ROUTE publishes but this artifact does not carry -- a
    // different branch from the one above, and the one that must never be
    // answered with a different window's numbers.
    const partial = settersArtifact();
    delete (partial.windows as Record<string, unknown>)["30d"];
    const { env: absentWindow } = bucketWith(partial);
    assert.equal(
      await loadChainWeightSettersFromArtifact(absentWindow, { window: "30d" }),
      null,
    );
  });
});
