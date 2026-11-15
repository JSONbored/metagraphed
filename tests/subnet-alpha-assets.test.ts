// The subnet-alpha-assets serving family (#13165): the pure builder, the
// native store seam, the PostgreSQL store module, and the REST handler. The
// GraphQL and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// createPgSubnetAlphaAssetsStore is proven by tests/pg-swap-liquidity.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetAlphaAssets,
  formatAlphaAssetsState,
  loadSubnetAlphaAssets,
} from "../src/subnet-alpha-assets.ts";
import { selectedSubnetAlphaAssetsStore } from "../src/subnet-alpha-assets-store.ts";
import { createPgSubnetAlphaAssetsStore } from "../src/pg-subnet-alpha-assets.ts";
import { handleSubnetAlphaAssets } from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();

function assetsRow(overrides: Row = {}): Row {
  return {
    total_issuance: "18446744073709551615",
    burned: "900",
    recycled: "0",
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("buildSubnetAlphaAssets", () => {
  test("null rows and no rows are both the decline: a NULL state", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(buildSubnetAlphaAssets(rows, 64), {
        schema_version: 1,
        netuid: 64,
        // Never a zeroed state: an absent capture is "the alpha-assets
        // capture has not run", not a measured zero issuance.
        alpha_assets: null,
        captured_at: null,
      });
    }
  });

  test("formats the newest capture and stamps it", () => {
    assert.deepEqual(buildSubnetAlphaAssets([assetsRow()], 64), {
      schema_version: 1,
      netuid: 64,
      alpha_assets: {
        total_issuance: "18446744073709551615",
        burned: "900",
        recycled: "0",
        captured_at: CAPTURED_ISO,
      },
      captured_at: CAPTURED_ISO,
    });
  });

  test("soft cells degrade to null, never to a fabricated zero", () => {
    const card = buildSubnetAlphaAssets(
      [
        assetsRow({
          // Non-canonical / out-of-range quantities are not u64 text.
          total_issuance: "01",
          burned: "18446744073709551616",
          recycled: null,
          captured_at: null,
        }),
      ],
      7,
    );
    assert.deepEqual(card.alpha_assets, {
      total_issuance: null,
      burned: null,
      recycled: null,
      captured_at: null,
    });
    assert.equal(card.captured_at, null);
  });
});

describe("formatAlphaAssetsState", () => {
  test("blank or non-numeric stamps are not stamps", () => {
    assert.equal(
      formatAlphaAssetsState(assetsRow({ captured_at: "abc" })).captured_at,
      null,
    );
    // Beyond ECMAScript's maximum time value: Invalid Date, so no stamp.
    assert.equal(
      formatAlphaAssetsState(assetsRow({ captured_at: 9_000_000_000_000_000 }))
        .captured_at,
      null,
    );
  });
});

describe("selectedSubnetAlphaAssetsStore / loadSubnetAlphaAssets", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedSubnetAlphaAssetsStore({}), null);
    assert.equal(selectedSubnetAlphaAssetsStore(null), null);
    assert.equal(await loadSubnetAlphaAssets({}, 64), null);
  });

  test("a bound store serves its rows", async () => {
    const env = {
      SUBNET_ALPHA_ASSETS_STORE: {
        latest: async (netuid: number) => [
          assetsRow({ burned: String(netuid) }),
        ],
      },
    };
    assert.deepEqual(await loadSubnetAlphaAssets(env, 3), [
      assetsRow({ burned: "3" }),
    ]);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const env = {
      SUBNET_ALPHA_ASSETS_STORE: {
        latest: async () => {
          throw new Error("native unavailable");
        },
      },
    };
    assert.equal(await loadSubnetAlphaAssets(env, 3), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    for (const store of [null, {}]) {
      assert.throws(
        () =>
          selectedSubnetAlphaAssetsStore({ SUBNET_ALPHA_ASSETS_STORE: store }),
        /Invalid native subnet alpha assets store/,
      );
    }
  });
});

describe("createPgSubnetAlphaAssetsStore", () => {
  function fixture() {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgSubnetAlphaAssetsStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [assetsRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    return { calls, store };
  }

  test("reads one subnet's newest alpha-asset capture", async () => {
    const { calls, store } = fixture();
    assert.deepEqual(await store.latest(64), [assetsRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app\.alpha_assets/);
    assert.match(calls[0].sql, /ORDER BY captured_at DESC LIMIT 1$/);
    assert.deepEqual(calls[0].params, [64]);
  });

  test("refuses an identity no subnet can have, before any query", async () => {
    const { calls, store } = fixture();
    for (const netuid of [-1, 1.5, 65536, Number.NaN]) {
      await assert.rejects(
        store.latest(netuid),
        /Invalid native subnet alpha assets identity/,
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("handleSubnetAlphaAssets", () => {
  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handleSubnetAlphaAssets(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/alpha-assets"),
      {} as unknown as Env,
      64,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.alpha_assets, null);
    assert.equal(data.netuid, 64);
    assert.equal(
      (body.meta as Row).artifact_path,
      "/metagraph/subnets/64/alpha-assets.json",
    );
  });

  test("a bound store serves the accounting", async () => {
    const env = {
      SUBNET_ALPHA_ASSETS_STORE: { latest: async () => [assetsRow()] },
    } as unknown as Env;
    const res = await handleSubnetAlphaAssets(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/alpha-assets"),
      env,
      64,
    );
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(
      (data.alpha_assets as Row).total_issuance,
      "18446744073709551615",
    );
    assert.equal((data.alpha_assets as Row).recycled, "0");
  });
});

describe("the /subnets/{netuid}/alpha-assets route through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("dispatches to the handler (decline body on an unbound store)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/alpha-assets"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).alpha_assets, null);
  });

  test("testnet has no variant (app.alpha_assets has no network column)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/testnet/subnets/64/alpha-assets",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });

  test("rejects a query parameter: the card takes none", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/64/alpha-assets?window=7d",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
