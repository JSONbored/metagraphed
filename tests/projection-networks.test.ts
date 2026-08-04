// The projection-backed routes on a second network (#9412).
//
// These routes answer from a card a cron precomputed out of one namespace, so
// what makes a network able to serve them is that its LANE has ticked -- a
// strictly later moment than "its decode lane has run", which is what
// tests/chain-history-networks.test.ts covers. The two properties that can
// silently break are the ones asserted here: a reader that keeps mainnet's
// artifact key off mainnet, and an edge cache the two chains share.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { DEFAULT_CHAIN_NETWORK, projectionKey } from "../src/chain-network.ts";
import {
  isProjectionRouteTemplate,
  PROJECTION_ROUTE_PATHS,
} from "../src/projection-routes.ts";
import {
  PROJECTION_LANES,
  PROJECTION_NETWORKS,
} from "../src/projection-lanes.ts";
import { MAINNET_ONLY_ROUTE_PATHS } from "../src/contracts.ts";
import { edgeCacheScope } from "../workers/request-handlers/analytics.ts";
import { concretePath } from "./concrete-path.ts";
import { handleRequest, isMainnetOnlyApiPath } from "../workers/api.ts";
import { BLOCKS_SUMMARY_PROJECTION_KEY as BLOCKS_SUMMARY_KEY } from "../src/blocks-summary-artifact.ts";
import { buildBlocksSummary } from "../src/blocks-summary.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import type { Row } from "./row-type.ts";

/** The shape buildBlocksSummary produces for an empty read, reused so the
 * fixture cannot drift from the card the lane actually writes. */
const ZEROED_SUMMARY = buildBlocksSummary([]);
import { loadChainTransfersFromArtifact } from "../src/chain-transfers-artifact.ts";
import { loadBlocksSummaryFromArtifact } from "../src/blocks-summary-artifact.ts";
import { loadChainActivityFromArtifact } from "../src/chain-activity-artifact.ts";
import { loadChainRegistrationsFromArtifact } from "../src/chain-registrations-artifact.ts";

/** An archive whose only object is the one key it was told to hold. */
function archiveHolding(key: string, body: unknown) {
  const asked: string[] = [];
  return {
    asked,
    env: {
      METAGRAPH_ARCHIVE: {
        async get(requested: string) {
          asked.push(requested);
          if (requested !== key) return null;
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

describe("the projection route list is derived from the router", () => {
  test("every listed route is served off mainnet, and none is still gated", () => {
    for (const template of PROJECTION_ROUTE_PATHS) {
      assert.equal(
        isMainnetOnlyApiPath(concretePath(template)),
        false,
        `${template} is in PROJECTION_ROUTE_PATHS but the router still gates it`,
      );
      assert.ok(
        !MAINNET_ONLY_ROUTE_PATHS.includes(template),
        `${template} is claimed as a projection route but is still on the gate list`,
      );
      assert.ok(
        isProjectionRouteTemplate(template),
        `${template} is listed but the predicate does not recognise it`,
      );
    }
  });

  // The other direction: one route per lane, plus the split's extra reader.
  // A lane whose route is missing here would fill an artifact nobody serves.
  test("every lane's route is listed", () => {
    assert.equal(
      PROJECTION_ROUTE_PATHS.length,
      PROJECTION_LANES.length,
      "each lane backs exactly one chain-scope route",
    );
  });
});

describe("a projection reader reads its own network's artifact", () => {
  const CASES: [
    string,
    string,
    (env: Env, network: "mainnet" | "testnet") => Promise<unknown>,
  ][] = [
    [
      "blocks-summary",
      "metagraph/projections/blocks-summary.json",
      (env, network) => loadBlocksSummaryFromArtifact(env, network),
    ],
    [
      "chain-transfers",
      "metagraph/projections/chain-transfers.json",
      (env, network) =>
        loadChainTransfersFromArtifact(env, { window: "7d" }, network),
    ],
    [
      "chain-activity",
      "metagraph/projections/chain-activity.json",
      (env, network) =>
        loadChainActivityFromArtifact(env, { window: "7d" }, network),
    ],
    [
      "chain-registrations",
      "metagraph/projections/chain-registrations.json",
      (env, network) =>
        loadChainRegistrationsFromArtifact(env, { window: "7d" }, network),
    ],
  ];

  for (const [name, key, load] of CASES) {
    test(`${name} asks for the testnet key, never mainnet's`, async () => {
      const { asked, env } = archiveHolding("nothing", null);
      await load(env, "testnet");
      // The POSITIVE first: the reader actually looked. An assertion that it
      // "did not ask for the mainnet key" passes on a reader that asks for
      // nothing at all.
      assert.ok(asked.length > 0, `${name} never read the archive`);
      assert.ok(
        asked.every((k) => k === projectionKey(key, "testnet")),
        `${name} asked for the wrong key: ${asked.join(", ")}`,
      );
      assert.ok(
        !asked.includes(key),
        `${name} still reaches for the mainnet artifact off mainnet`,
      );
    });

    test(`${name} keeps mainnet's unprefixed key`, async () => {
      const { asked, env } = archiveHolding("nothing", null);
      await load(env, DEFAULT_CHAIN_NETWORK);
      assert.ok(asked.length > 0, `${name} never read the archive`);
      assert.deepEqual(
        [...new Set(asked)],
        [key],
        `${name} must read the exact object it read before #9412`,
      );
    });
  }
});

// The `/{network}/` prefix is stripped before dispatch, so both chains reach
// these handlers with identical paths -- and their card shapes are identical
// too, which is what makes a shared cache entry undetectable downstream.
describe("the edge cache is scoped per network", () => {
  test("mainnet keeps its bare label so warm entries survive", () => {
    assert.equal(edgeCacheScope("chain-transfers"), "chain-transfers");
    assert.equal(
      edgeCacheScope("chain-transfers", "mainnet"),
      "chain-transfers",
    );
  });

  test("every other chain gets its own keyspace", () => {
    for (const network of PROJECTION_NETWORKS) {
      if (network === DEFAULT_CHAIN_NETWORK) continue;
      assert.equal(
        edgeCacheScope("chain-transfers", network),
        `chain-transfers:${network}`,
      );
    }
  });
});

// The /{network}/-prefixed dispatch reaches the SAME handlers the bare path
// does. Both directions matter: a projection route must answer there, and a
// route the table does not cover must fall through rather than be swallowed.
describe("the network-prefixed path reaches the projection table", () => {
  /** An archive holding one network's card for every projection key. */
  function archiveFor(network: "mainnet" | "testnet") {
    return {
      METAGRAPH_ARCHIVE: {
        async get(requested: string) {
          if (requested !== projectionKey(BLOCKS_SUMMARY_KEY, network)) {
            return null;
          }
          return {
            async json() {
              return {
                schema_version: 1,
                summary: { ...ZEROED_SUMMARY, block_count: 7, last_block: 42 },
              };
            },
          };
        },
      },
    } as unknown as Env;
  }

  test("a testnet request is answered from the testnet card", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/blocks/summary"),
      archiveFor("testnet"),
      {},
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).block_count, 7);
    assert.equal((body.data as Row).last_block, 42);
  });

  test("the mainnet card is never served under a testnet path", async () => {
    // Only MAINNET's card exists here; testnet must fall through to its own
    // zeroed floor rather than reach for the neighbour's object.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/blocks/summary"),
      archiveFor("mainnet"),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal((((await res.json()) as Row).data as Row).block_count, 0);
  });

  test("a route the table does not cover still falls through", async () => {
    // /blocks/{ref} is chain HISTORY, matched by the next table down. A
    // projection dispatch that swallowed it would 404 a working route.
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/blocks/7700500"),
      { [R2_SQL_TOKEN_ENV]: "cfut_test" } as unknown as Env,
      {},
    );
    assert.notEqual(res.status, 404);
  });
});
