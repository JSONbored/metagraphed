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
          { netuid: 3, announcements: "10", [distinctField]: "2" },
          { netuid: 11, announcements: "4", [distinctField]: "4" },
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
