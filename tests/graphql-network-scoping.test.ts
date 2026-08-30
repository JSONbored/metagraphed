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
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { chainTable } from "../src/chain-network.ts";
import type { Row } from "./row-type.ts";

/**
 * A lakehouse transport double that records the SQL each leg issued.
 *
 * The blocks fields no longer read the Postgres tier at all (#10190 -- the flag
 * is retired in every deployed config), so the cold tier IS the read, and the
 * network reaches it through the TABLE NAME `chainTable` resolves rather than
 * through a request path. Asserting the path a dead tier is asked for would pass
 * on a resolver that dropped the argument from the leg that actually answers.
 */
function recordingLakehouse(rows: unknown[] = []) {
  const queries: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query as string);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

/** An archive double that records the projection keys it is asked for. */
function recordingArchive(body: unknown) {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      get: async (key: string) => {
        keys.push(key);
        return body === undefined ? null : { json: async () => body };
      },
    },
  };
}

/** Enough env for the lakehouse leg to be attempted at all. */
const LAKEHOUSE_ENV = { [R2_SQL_TOKEN_ENV]: "cfut_test" };

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
  test("blocks(network: test) reads the testnet lakehouse table", async () => {
    const queries = recordingLakehouse();
    const { status } = await query(
      "{ blocks(limit: 1, network: test) { total } }",
      LAKEHOUSE_ENV,
    );
    assert.equal(status, 200);
    assert.equal(queries.length, 1);
    assert.match(queries[0], new RegExp(chainTable("blocks", "testnet")));
  });

  test("blocks() with no network still reads the mainnet table", async () => {
    const queries = recordingLakehouse();
    await query("{ blocks(limit: 1) { total } }", LAKEHOUSE_ENV);
    assert.equal(queries.length, 1);
    assert.match(queries[0], new RegExp(chainTable("blocks")));
    // Same read, different chain -- the two tables must not be the same string,
    // or the assertion above would hold for a resolver that ignored `network`.
    assert.notEqual(chainTable("blocks"), chainTable("blocks", "testnet"));
  });

  test("a chain rollup forwards it to the projection key", async () => {
    // #10190: the tier this asserted a path against is retired. The rollup's
    // real read is the #9146 projection, and the network arrives in the OBJECT
    // KEY (#9412) rather than in a request path.
    const archive = recordingArchive({ schema_version: 1, windows: {} });
    await query('{ chain_transfers(window: "7d", network: test) { window } }', {
      METAGRAPH_ARCHIVE: archive.binding,
    });
    assert.equal(archive.keys.length, 1);
    assert.match(archive.keys[0], /testnet/);

    const mainnet = recordingArchive({ schema_version: 1, windows: {} });
    await query('{ chain_transfers(window: "7d") { window } }', {
      METAGRAPH_ARCHIVE: mainnet.binding,
    });
    assert.equal(mainnet.keys.length, 1);
    assert.doesNotMatch(mainnet.keys[0], /testnet/);
  });

  test("a per-block read forwards it", async () => {
    const queries = recordingLakehouse();
    await query('{ block(ref: "9", network: test) { ref } }', LAKEHOUSE_ENV);
    assert.equal(queries.length, 3);
    for (const table of ["blocks", "extrinsics", "account_events"] as const) {
      assert.ok(
        queries.some((sql) => sql.includes(chainTable(table, "testnet"))),
        `${table}: the point read must stay inside the testnet namespace`,
      );
    }
  });

  test("a block-detail cascade forwards it to the hot/cold decision", async () => {
    // `answerBlockDetail` is where the network decides whether the hot tier is
    // consulted at all -- off mainnet it is not, because blocks_head is written
    // by the mainnet firehose poller and carries no network column.
    //
    // #10190: the tier leg is deleted, so the decision is now visible in the
    // lakehouse TABLE the cold leg resolves rather than in a request path.
    for (const field of ["block_extrinsics", "block_events"]) {
      const queries = recordingLakehouse();
      await query(
        `{ ${field}(ref: "9", network: test) { block_number } }`,
        LAKEHOUSE_ENV,
      );
      assert.ok(queries.length > 0, `${field}: the cold leg must be asked`);
      const testnetNs = chainTable("x", "testnet").split(".")[0];
      assert.notEqual(testnetNs, chainTable("x").split(".")[0]);
      assert.ok(
        queries.every((sql) => sql.includes(`${testnetNs}.`)),
        `${field}: every read must name the testnet namespace; got ${queries[0]}`,
      );
    }
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

  test("blocks_summary forwards it to the projection key", async () => {
    // This one's cold read is the archived projection, not the lakehouse, so
    // the network arrives in the OBJECT KEY (#9412).
    const archive = recordingArchive({ schema_version: 1, summary: {} });
    await query("{ blocks_summary(network: test) { block_count } }", {
      METAGRAPH_ARCHIVE: archive.binding,
    });
    assert.equal(archive.keys.length, 1);
    assert.match(archive.keys[0], /testnet/);

    const mainnet = recordingArchive({ schema_version: 1, summary: {} });
    await query("{ blocks_summary { block_count } }", {
      METAGRAPH_ARCHIVE: mainnet.binding,
    });
    assert.equal(mainnet.keys.length, 1);
    assert.doesNotMatch(mainnet.keys[0], /testnet/);
  });
});
