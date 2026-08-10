// Does `network: test` actually reach testnet? (#10394)
//
// Twenty Query fields published the argument and the resolvers forward it to
// BOTH legs of their read -- the Postgres tier's path and the cold-tier
// fallback under it. A test that only checked the argument was accepted would
// pass on a resolver that ignored it, which is strictly worse than not
// publishing the argument: the caller asks for testnet and is told mainnet.
//
// So these assert the PATH the tier is asked for, by capturing the Request the
// DATA_API binding receives.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleGraphQLRequest } from "../src/graphql.ts";
import {
  DEFAULT_CHAIN_NETWORK,
  networkScopedRoute,
} from "../src/chain-network.ts";
import type { Row } from "./row-type.ts";

/** A DATA_API double that records every path it is asked for. */
function recordingDataApi(payload: Row) {
  const paths: string[] = [];
  return {
    paths,
    binding: {
      fetch: async (request: Request) => {
        paths.push(new URL(request.url).pathname);
        return Response.json(payload);
      },
    },
  };
}

async function query(text: string, env: Row) {
  const res = await handleGraphQLRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: text }),
    }),
    env as never,
    {},
  );
  return { status: res.status, body: (await res.json()) as Row };
}

describe("networkScopedRoute", () => {
  test("mainnet keeps the base path", () => {
    // The asymmetry every sibling helper uses: an existing caller reaches
    // exactly what it reached before, so this cannot regress mainnet.
    assert.equal(
      networkScopedRoute("/api/v1/blocks", DEFAULT_CHAIN_NETWORK),
      "/api/v1/blocks",
    );
    assert.equal(networkScopedRoute("/api/v1/blocks"), "/api/v1/blocks");
  });

  test("testnet gets the twin the router already serves", () => {
    assert.equal(
      networkScopedRoute("/api/v1/blocks", "testnet"),
      "/api/v1/test/blocks",
    );
    assert.equal(
      networkScopedRoute("/api/v1/chain/stake-flow", "testnet"),
      "/api/v1/test/chain/stake-flow",
    );
  });

  test("a path that is not an /api/v1 route is returned unchanged", () => {
    // Nothing should be rewritten on a guess -- a caller passing something
    // else gets it back rather than a plausible-looking twin.
    assert.equal(
      networkScopedRoute("/metagraph/blocks.json", "testnet"),
      "/metagraph/blocks.json",
    );
  });
});

describe("the resolvers ask the twin path", () => {
  test("blocks(network: test) reads /api/v1/test/blocks", async () => {
    const api = recordingDataApi({ blocks: [], block_count: 0 });
    const { status } = await query(
      "{ blocks(limit: 1, network: test) { total } }",
      { METAGRAPH_BLOCKS_SOURCE: "postgres", DATA_API: api.binding },
    );
    assert.equal(status, 200);
    assert.deepEqual(api.paths, ["/api/v1/test/blocks"]);
  });

  test("blocks() with no network still reads the base path", async () => {
    const api = recordingDataApi({ blocks: [], block_count: 0 });
    await query("{ blocks(limit: 1) { total } }", {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: api.binding,
    });
    assert.deepEqual(api.paths, ["/api/v1/blocks"]);
  });

  test("a chain rollup forwards it too", async () => {
    const api = recordingDataApi({ schema_version: 1, transfers: [] });
    await query('{ chain_transfers(window: "7d", network: test) { window } }', {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: api.binding,
    });
    assert.deepEqual(api.paths, ["/api/v1/test/chain/transfers"]);
  });

  test("a per-block read forwards it", async () => {
    const api = recordingDataApi({ schema_version: 1, ref: "9", block: null });
    await query('{ block(ref: "9", network: test) { ref } }', {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: api.binding,
    });
    assert.deepEqual(api.paths, ["/api/v1/test/blocks/9"]);
  });

  test("a block-detail cascade forwards it to the hot/cold decision", async () => {
    // `answerBlockDetail` is where the network decides whether the D1 hot tier
    // is consulted at all -- off mainnet it is not, because blocks_head is
    // written by the mainnet firehose poller and carries no network column.
    const extrinsics = recordingDataApi({
      data: { block_number: 9, extrinsic_count: 0, extrinsics: [] },
    });
    await query(
      '{ block_extrinsics(ref: "9", network: test) { block_number } }',
      {
        METAGRAPH_EXTRINSICS_SOURCE: "postgres",
        DATA_API: extrinsics.binding,
      },
    );
    assert.deepEqual(extrinsics.paths, ["/api/v1/test/blocks/9/extrinsics"]);

    const events = recordingDataApi({
      data: { block_number: 9, event_count: 0, events: [] },
    });
    await query('{ block_events(ref: "9", network: test) { block_number } }', {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: events.binding,
    });
    assert.deepEqual(events.paths, ["/api/v1/test/blocks/9/events"]);
  });

  test("economics(network: test) skips the mainnet-only live KV", async () => {
    // The live economics KV is written by the mainnet cron and carries no
    // network column. Preferring it off mainnet would answer mainnet rows
    // under a testnet label -- and the memo is keyed by network so one entry
    // cannot serve both.
    let liveReads = 0;
    const env = {
      METAGRAPH_HEALTH_KV: {
        get: async () => {
          liveReads += 1;
          return null;
        },
      },
    };
    const { status } = await query(
      "{ economics(network: test, limit: 1) { total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(liveReads, 0, "the live KV must not be consulted off mainnet");
  });

  test("on MAINNET the same cascade consults the hot tier", async () => {
    // The other side of the branch the network decides. `answerBlockDetail`
    // routes to the hot leg only on mainnet AND only for a ref above the seam
    // -- off mainnet the seam is 0 and every block comes from the lakehouse,
    // which is why a testnet query can never run the hot callback.
    //
    // Reaching it needs the store the deployment actually uses: Hyperdrive in
    // front of Neon, plus the four chain_detail tables declared Neon's.
    // `readStore` refuses a table it was not told the store owns, so binding
    // Hyperdrive alone still answers undefined.
    const env = {
      ICEBERG_BLOCKS_MAX: "1",
      HYPERDRIVE: { connectionString: "postgresql://mock/db" },
      NEON_SOLE_STORE_TABLES:
        "chain_detail_blocks,chain_detail_extrinsics," +
        "chain_detail_chain_events,chain_detail_account_events",
    };
    const extrinsics = await query(
      '{ block_extrinsics(ref: "9") { block_number extrinsic_count } }',
      env,
    );
    assert.equal(extrinsics.status, 200);
    const events = await query(
      '{ block_events(ref: "9") { block_number event_count } }',
      env,
    );
    assert.equal(events.status, 200);
  });

  test("blocks_summary forwards it", async () => {
    const api = recordingDataApi({ schema_version: 1, block_count: 0 });
    await query("{ blocks_summary(network: test) { block_count } }", {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: api.binding,
    });
    assert.deepEqual(api.paths, ["/api/v1/test/blocks/summary"]);
  });
});
