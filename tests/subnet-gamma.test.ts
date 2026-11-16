// The subnet-gamma serving family (#13164): the pure builders, the native
// store seam, the PostgreSQL store module, and the REST handlers. The GraphQL
// and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// createPgSubnetGammaStore is proven by tests/pg-gamma.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  boolOrNull,
  buildChainGamma,
  buildSubnetGamma,
  buildSubnetGammaHistory,
  formatGammaState,
  loadChainGamma,
  loadSubnetGamma,
  loadSubnetGammaHistory,
  u128TextOrNull,
} from "../src/subnet-gamma.ts";
import { selectedSubnetGammaStore } from "../src/subnet-gamma-store.ts";
import {
  CHAIN_GAMMA_ROW_CAP,
  SUBNET_GAMMA_HISTORY_ROW_CAP,
  createPgSubnetGammaStore,
} from "../src/pg-subnet-gamma.ts";
import {
  handleChainGamma,
  handleSubnetGamma,
  handleSubnetGammaHistory,
} from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();

function gammaRow(overrides: Row = {}): Row {
  return {
    enabled: true,
    price: "340282366920938463463374607431768211455",
    emission: "12500",
    pending_emission: "900",
    unconverted_emission: "0",
    whitelisted: false,
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

const FORMATTED_GAMMA = {
  enabled: true,
  price: "340282366920938463463374607431768211455",
  emission: "12500",
  pending_emission: "900",
  unconverted_emission: "0",
  whitelisted: false,
  captured_at: CAPTURED_ISO,
};

describe("u128TextOrNull / boolOrNull", () => {
  test("accepts canonical u128 decimal text and real booleans only", () => {
    assert.equal(u128TextOrNull("0"), "0");
    assert.equal(
      u128TextOrNull("340282366920938463463374607431768211455"),
      "340282366920938463463374607431768211455",
    );
    assert.equal(boolOrNull(true), true);
    assert.equal(boolOrNull(false), false);
  });

  test("rejects padding, overflow, non-strings and non-booleans", () => {
    for (const value of [
      "01",
      "-1",
      "1.5",
      "340282366920938463463374607431768211456", // u128 max + 1
      "",
      12500,
      null,
      undefined,
    ]) {
      assert.equal(u128TextOrNull(value), null);
    }
    for (const value of ["true", 1, 0, null, undefined]) {
      assert.equal(boolOrNull(value), null);
    }
  });
});

describe("buildSubnetGamma", () => {
  test("null rows and no rows are both the decline: a NULL state", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(buildSubnetGamma(rows, 64), {
        schema_version: 1,
        netuid: 64,
        // NULL, never a zeroed state: an absent capture is "the Gamma
        // capture has not run", not a measured Gamma-off subnet.
        gamma: null,
        captured_at: null,
      });
    }
  });

  test("formats the newest capture", () => {
    assert.deepEqual(buildSubnetGamma([gammaRow()], 64), {
      schema_version: 1,
      netuid: 64,
      gamma: FORMATTED_GAMMA,
      captured_at: CAPTURED_ISO,
    });
  });

  test("unusable cells degrade to null rather than to zero or false", () => {
    const card = buildSubnetGamma(
      [
        gammaRow({
          enabled: "true",
          price: "01",
          emission: "-3",
          pending_emission: 900,
          unconverted_emission: "1.5",
          whitelisted: 0,
          captured_at: -5,
        }),
      ],
      7,
    );
    assert.deepEqual(card.gamma, {
      enabled: null,
      price: null,
      emission: null,
      pending_emission: null,
      unconverted_emission: null,
      whitelisted: null,
      captured_at: null,
    });
    assert.equal(card.captured_at, null);
  });
});

describe("buildSubnetGammaHistory", () => {
  test("null rows and no rows are both the decline: empty, with a NULL count", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(buildSubnetGammaHistory(rows, 64), {
        schema_version: 1,
        netuid: 64,
        point_count: null,
        captured_at: null,
        points: [],
      });
    }
  });

  test("formats points and stamps the newest capture, even out of order", () => {
    const card = buildSubnetGammaHistory(
      [
        gammaRow(),
        gammaRow({ captured_at: CAPTURED_MS + 1000 }),
        // Beyond ECMAScript's maximum time value: Invalid Date, so no stamp.
        gammaRow({ captured_at: 9_000_000_000_000_000 }),
        // Not a number at all: equally no stamp, never "aged since epoch".
        gammaRow({ captured_at: "abc" }),
      ],
      64,
    );
    assert.equal(card.point_count, 4);
    assert.equal(card.captured_at, new Date(CAPTURED_MS + 1000).toISOString());
    assert.deepEqual((card.points as Row[])[0], FORMATTED_GAMMA);
    assert.equal((card.points as Row[])[2].captured_at, null);
    assert.equal((card.points as Row[])[3].captured_at, null);
  });
});

describe("buildChainGamma", () => {
  test("a null load is the decline: NULL flag, empty subnets, NULL count", () => {
    assert.deepEqual(buildChainGamma(null), {
      schema_version: 1,
      // NULL, never false: an unfilled store is not a measured off-switch.
      enabled: null,
      enabled_captured_at: null,
      subnet_count: null,
      captured_at: null,
      subnets: [],
    });
  });

  test("formats the global flag beside the per-subnet states", () => {
    const card = buildChainGamma({
      subnets: [
        { netuid: 1, ...gammaRow() },
        { netuid: 64, ...gammaRow({ captured_at: CAPTURED_MS + 1000 }) },
      ],
      enabled: { enabled: true, captured_at: CAPTURED_MS + 2000 },
    });
    assert.equal(card.enabled, true);
    assert.equal(
      card.enabled_captured_at,
      new Date(CAPTURED_MS + 2000).toISOString(),
    );
    assert.equal(card.subnet_count, 2);
    // The newest stamp anywhere on the card -- here the global flag's.
    assert.equal(card.captured_at, new Date(CAPTURED_MS + 2000).toISOString());
    assert.deepEqual((card.subnets as Row[])[0], {
      netuid: 1,
      ...FORMATTED_GAMMA,
    });
  });

  test("per-subnet rows alone still stamp the card; bad netuids are dropped", () => {
    const card = buildChainGamma({
      subnets: [
        { netuid: 64, ...gammaRow() },
        // A numeric string still names the subnet; everything else does not.
        { netuid: "65", ...gammaRow() },
        { netuid: 70000, ...gammaRow() },
        { netuid: -1, ...gammaRow() },
        { netuid: "", ...gammaRow() },
        { netuid: null, ...gammaRow() },
      ],
      enabled: null,
    });
    assert.equal(card.enabled, null);
    assert.equal(card.enabled_captured_at, null);
    assert.equal(card.subnet_count, 2);
    assert.deepEqual(
      (card.subnets as Row[]).map((s) => s.netuid),
      [64, 65],
    );
    assert.equal(card.captured_at, CAPTURED_ISO);
  });

  test("an unusable global flag degrades to null, not false", () => {
    const card = buildChainGamma({
      subnets: [],
      enabled: { enabled: "yes", captured_at: CAPTURED_MS },
    });
    assert.equal(card.enabled, null);
    assert.equal(card.enabled_captured_at, CAPTURED_ISO);
    assert.equal(card.subnet_count, null);
  });
});

describe("formatGammaState", () => {
  test("a string epoch stamp still formats", () => {
    assert.equal(
      formatGammaState(gammaRow({ captured_at: String(CAPTURED_MS) }))
        .captured_at,
      CAPTURED_ISO,
    );
  });

  test("a missing stamp is null, never aged since the epoch", () => {
    assert.equal(
      formatGammaState(gammaRow({ captured_at: null })).captured_at,
      null,
    );
  });
});

describe("selectedSubnetGammaStore / the loaders", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedSubnetGammaStore({}), null);
    assert.equal(selectedSubnetGammaStore(null), null);
    assert.equal(await loadSubnetGamma({}, 64), null);
    assert.equal(await loadSubnetGammaHistory({}, 64), null);
    assert.equal(await loadChainGamma({}), null);
  });

  test("a bound store serves each read", async () => {
    const env = {
      SUBNET_GAMMA_STORE: {
        latest: async (netuid: number) => [gammaRow({ netuid })],
        history: async () => [gammaRow(), gammaRow()],
        chain: async () => [{ netuid: 64, ...gammaRow() }],
        enabled: async () => [{ enabled: true, captured_at: CAPTURED_MS }],
      },
    };
    assert.deepEqual(await loadSubnetGamma(env, 3), [gammaRow({ netuid: 3 })]);
    assert.equal(((await loadSubnetGammaHistory(env, 3)) ?? []).length, 2);
    assert.deepEqual(await loadChainGamma(env), {
      subnets: [{ netuid: 64, ...gammaRow() }],
      enabled: { enabled: true, captured_at: CAPTURED_MS },
    });
  });

  test("an empty enabled series loads as a null flag row", async () => {
    const env = {
      SUBNET_GAMMA_STORE: {
        latest: async () => [],
        history: async () => [],
        chain: async () => [],
        enabled: async () => [],
      },
    };
    assert.deepEqual(await loadChainGamma(env), {
      subnets: [],
      enabled: null,
    });
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const failing = async () => {
      throw new Error("native unavailable");
    };
    const env = {
      SUBNET_GAMMA_STORE: {
        latest: failing,
        history: failing,
        chain: failing,
        enabled: failing,
      },
    };
    assert.equal(await loadSubnetGamma(env, 3), null);
    assert.equal(await loadSubnetGammaHistory(env, 3), null);
    assert.equal(await loadChainGamma(env), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    const fn = async () => [];
    for (const store of [
      null,
      {},
      { latest: fn },
      { latest: fn, history: fn },
      { latest: fn, history: fn, chain: fn },
    ]) {
      assert.throws(
        () => selectedSubnetGammaStore({ SUBNET_GAMMA_STORE: store }),
        /Invalid native subnet gamma store/,
      );
    }
  });
});

describe("createPgSubnetGammaStore", () => {
  function fixture() {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgSubnetGammaStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [gammaRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    return { calls, store };
  }

  test("latest reads one newest capture", async () => {
    const { calls, store } = fixture();
    assert.deepEqual(await store.latest(64), [gammaRow()]);
    assert.match(calls[0].sql, /FROM app\.subnet_gamma/);
    assert.match(calls[0].sql, /ORDER BY captured_at DESC LIMIT 1$/);
    assert.deepEqual(calls[0].params, [64]);
  });

  test("history reads the capped series, newest first", async () => {
    const { calls, store } = fixture();
    await store.history(64);
    assert.match(calls[0].sql, /FROM app\.subnet_gamma/);
    assert.match(
      calls[0].sql,
      new RegExp(`LIMIT ${SUBNET_GAMMA_HISTORY_ROW_CAP}$`),
    );
    assert.deepEqual(calls[0].params, [64]);
  });

  test("chain reads the newest capture per netuid, capped", async () => {
    const { calls, store } = fixture();
    await store.chain();
    assert.match(calls[0].sql, /SELECT DISTINCT ON \(netuid\)/);
    assert.match(calls[0].sql, new RegExp(`LIMIT ${CHAIN_GAMMA_ROW_CAP}$`));
    assert.equal(calls[0].params, undefined);
  });

  test("enabled reads the newest global flag", async () => {
    const { calls, store } = fixture();
    await store.enabled();
    assert.match(calls[0].sql, /FROM app\.chain_gamma/);
    assert.match(calls[0].sql, /ORDER BY captured_at DESC LIMIT 1$/);
  });

  test("refuses an identity no subnet can have, before any query", async () => {
    const { calls, store } = fixture();
    for (const netuid of [-1, 1.5, 65536, Number.NaN]) {
      await assert.rejects(
        store.latest(netuid),
        /Invalid native subnet gamma identity/,
      );
      await assert.rejects(
        store.history(netuid),
        /Invalid native subnet gamma identity/,
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("the REST handlers", () => {
  test("no bound store is the schema-stable decline on all three", async () => {
    const env = {} as unknown as Env;
    const card = await handleSubnetGamma(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/gamma"),
      env,
      64,
    );
    assert.equal(card.status, 200);
    const cardBody = (await card.json()) as Row;
    assert.equal((cardBody.data as Row).gamma, null);
    assert.equal(
      (cardBody.meta as Row).artifact_path,
      "/metagraph/subnets/64/gamma.json",
    );

    const history = await handleSubnetGammaHistory(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/gamma/history"),
      env,
      64,
    );
    assert.equal(history.status, 200);
    const historyBody = (await history.json()) as Row;
    assert.equal((historyBody.data as Row).point_count, null);
    assert.equal(
      (historyBody.meta as Row).artifact_path,
      "/metagraph/subnets/64/gamma/history.json",
    );

    const chain = await handleChainGamma(
      new Request("https://api.metagraph.sh/api/v1/chain/gamma"),
      env,
    );
    assert.equal(chain.status, 200);
    const chainBody = (await chain.json()) as Row;
    assert.equal((chainBody.data as Row).enabled, null);
    assert.equal(
      (chainBody.meta as Row).artifact_path,
      "/metagraph/chain/gamma.json",
    );
  });

  test("a bound store serves the state through each handler", async () => {
    const env = {
      SUBNET_GAMMA_STORE: {
        latest: async () => [gammaRow()],
        history: async () => [gammaRow()],
        chain: async () => [{ netuid: 64, ...gammaRow() }],
        enabled: async () => [{ enabled: true, captured_at: CAPTURED_MS }],
      },
    } as unknown as Env;
    const card = await handleSubnetGamma(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/gamma"),
      env,
      64,
    );
    const cardBody = (await card.json()) as Row;
    assert.deepEqual((cardBody.data as Row).gamma, FORMATTED_GAMMA);

    const history = await handleSubnetGammaHistory(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/gamma/history"),
      env,
      64,
    );
    const historyBody = (await history.json()) as Row;
    assert.equal((historyBody.data as Row).point_count, 1);

    const chain = await handleChainGamma(
      new Request("https://api.metagraph.sh/api/v1/chain/gamma"),
      env,
    );
    const chainBody = (await chain.json()) as Row;
    assert.equal((chainBody.data as Row).enabled, true);
    assert.equal((chainBody.data as Row).subnet_count, 1);
  });
});

describe("the gamma routes through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("the history route dispatches BEFORE the bare card", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/gamma/history"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).point_count, null);
    assert.deepEqual((body.data as Row).points, []);
  });

  test("the card and the chain rollup dispatch to their handlers", async () => {
    for (const [url, field] of [
      ["https://api.metagraph.sh/api/v1/subnets/64/gamma", "gamma"],
      ["https://api.metagraph.sh/api/v1/chain/gamma", "enabled"],
    ] as const) {
      const res = await handleRequest(
        new Request(url),
        {} as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as Row;
      assert.equal((body.data as Row)[field], null);
    }
  });

  test("testnet has no variant (the gamma tables have no network column)", async () => {
    for (const url of [
      "https://api.metagraph.sh/api/v1/testnet/subnets/64/gamma",
      "https://api.metagraph.sh/api/v1/testnet/subnets/64/gamma/history",
      "https://api.metagraph.sh/api/v1/testnet/chain/gamma",
    ]) {
      const res = await handleRequest(
        new Request(url),
        {} as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 404);
    }
  });

  test("rejects a query parameter: the cards take none", async () => {
    for (const url of [
      "https://api.metagraph.sh/api/v1/subnets/64/gamma?window=7d",
      "https://api.metagraph.sh/api/v1/subnets/64/gamma/history?window=7d",
      "https://api.metagraph.sh/api/v1/chain/gamma?window=7d",
    ]) {
      const res = await handleRequest(
        new Request(url),
        {} as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 400);
    }
  });
});
