// The subnet-mechanisms serving family (#13162): the pure builders, the native
// store seam, the PostgreSQL store module, and the REST handler. The GraphQL
// and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// createPgSubnetMechanismsStore is proven by
// tests/postgres-mechanisms-schema.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetMechanisms,
  loadSubnetMechanisms,
} from "../src/subnet-mechanisms.ts";
import { selectedSubnetMechanismsStore } from "../src/subnet-mechanisms-store.ts";
import { createPgSubnetMechanismsStore } from "../src/pg-subnet-mechanisms.ts";
import { handleSubnetMechanisms } from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();

function mechanismRow(overrides: Row = {}): Row {
  return {
    mechid: 0,
    emission_split: 0.75,
    consensus_mode: "Yuma3",
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("buildSubnetMechanisms", () => {
  test("null rows and no rows are both the decline: empty, with a NULL count", () => {
    for (const rows of [null, []]) {
      const card = buildSubnetMechanisms(rows, 64);
      assert.deepEqual(card, {
        schema_version: 1,
        netuid: 64,
        // Never 0: every subnet has at least mechanism 0, so a zero count
        // would be a fabricated measurement rather than "not captured".
        mechanism_count: null,
        captured_at: null,
        mechanisms: [],
      });
    }
  });

  test("formats, orders by mechid, and stamps the newest capture", () => {
    const card = buildSubnetMechanisms(
      [
        mechanismRow({ mechid: 1, emission_split: 0.25, captured_at: CAPTURED_MS + 1000 }),
        mechanismRow(),
      ],
      64,
    );
    assert.equal(card.mechanism_count, 2);
    assert.equal(
      card.captured_at,
      new Date(CAPTURED_MS + 1000).toISOString(),
    );
    assert.deepEqual(card.mechanisms, [
      {
        mechid: 0,
        emission_split: 0.75,
        consensus_mode: "Yuma3",
        captured_at: CAPTURED_ISO,
      },
      {
        mechid: 1,
        emission_split: 0.25,
        consensus_mode: "Yuma3",
        captured_at: new Date(CAPTURED_MS + 1000).toISOString(),
      },
    ]);
  });

  test("a store numeric string crosses as a number (captured_at::text, split)", () => {
    const [mechanism] = buildSubnetMechanisms(
      [
        mechanismRow({
          mechid: "2",
          emission_split: "0.5",
          captured_at: String(CAPTURED_MS),
        }),
      ],
      7,
    ).mechanisms as Row[];
    assert.deepEqual(mechanism, {
      mechid: 2,
      emission_split: 0.5,
      consensus_mode: "Yuma3",
      captured_at: CAPTURED_ISO,
    });
  });

  test("unusable cells degrade to null; a row without a mechid is dropped", () => {
    const card = buildSubnetMechanisms(
      [
        mechanismRow({
          emission_split: 1.5, // outside the chain's 0..1
          consensus_mode: "",
          captured_at: -5,
        }),
        mechanismRow({ mechid: null }),
        mechanismRow({ mechid: -1 }),
        mechanismRow({ mechid: "" }),
        mechanismRow({
          mechid: 1,
          emission_split: null,
          consensus_mode: 7,
          captured_at: "",
        }),
        // Beyond ECMAScript's maximum time value: a Date this far out is
        // Invalid even though the number is finite.
        mechanismRow({ mechid: 2, captured_at: 9_000_000_000_000_000 }),
        mechanismRow({ mechid: 3, captured_at: null }),
      ],
      7,
    );
    assert.equal(card.mechanism_count, 4);
    assert.deepEqual(card.mechanisms, [
      { mechid: 0, emission_split: null, consensus_mode: null, captured_at: null },
      { mechid: 1, emission_split: null, consensus_mode: null, captured_at: null },
      {
        mechid: 2,
        emission_split: 0.75,
        consensus_mode: "Yuma3",
        captured_at: null,
      },
      {
        mechid: 3,
        emission_split: 0.75,
        consensus_mode: "Yuma3",
        captured_at: null,
      },
    ]);
    assert.equal(card.captured_at, null);
  });
});

describe("selectedSubnetMechanismsStore / loadSubnetMechanisms", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedSubnetMechanismsStore({}), null);
    assert.equal(selectedSubnetMechanismsStore(null), null);
    assert.equal(await loadSubnetMechanisms({}, 64), null);
  });

  test("a bound store serves its rows", async () => {
    const env = {
      SUBNET_MECHANISMS_STORE: {
        rows: async (netuid: number) => [mechanismRow({ mechid: netuid })],
      },
    };
    assert.deepEqual(await loadSubnetMechanisms(env, 3), [
      mechanismRow({ mechid: 3 }),
    ]);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const env = {
      SUBNET_MECHANISMS_STORE: {
        rows: async () => {
          throw new Error("native unavailable");
        },
      },
    };
    assert.equal(await loadSubnetMechanisms(env, 3), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    assert.throws(
      () => selectedSubnetMechanismsStore({ SUBNET_MECHANISMS_STORE: {} }),
      /Invalid native subnet mechanisms store/,
    );
  });
});

describe("createPgSubnetMechanismsStore", () => {
  function fixture() {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgSubnetMechanismsStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [mechanismRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    return { calls, store };
  }

  test("reads one subnet's registry, ordered by mechid", async () => {
    const { calls, store } = fixture();
    assert.deepEqual(await store.rows(64), [mechanismRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app\.subnet_mechanisms/);
    assert.match(calls[0].sql, /ORDER BY mechid/);
    assert.deepEqual(calls[0].params, [64]);
  });

  test("refuses an identity no subnet can have, before any query", async () => {
    const { calls, store } = fixture();
    for (const netuid of [-1, 1.5, 65536, Number.NaN]) {
      await assert.rejects(
        store.rows(netuid),
        /Invalid native subnet mechanisms identity/,
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("handleSubnetMechanisms", () => {
  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handleSubnetMechanisms(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/mechanisms"),
      {} as unknown as Env,
      64,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.deepEqual(data.mechanisms, []);
    assert.equal(data.mechanism_count, null);
    assert.equal(data.netuid, 64);
    assert.equal(
      (body.meta as Row).artifact_path,
      "/metagraph/subnets/64/mechanisms.json",
    );
  });

  test("a bound store serves the registry", async () => {
    const env = {
      SUBNET_MECHANISMS_STORE: {
        rows: async () => [mechanismRow(), mechanismRow({ mechid: 1 })],
      },
    };
    const res = await handleSubnetMechanisms(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/mechanisms"),
      env as unknown as Env,
      64,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.mechanism_count, 2);
    assert.equal(data.captured_at, CAPTURED_ISO);
    assert.equal((data.mechanisms as Row[])[1].mechid, 1);
  });
});

describe("the /subnets/{netuid}/mechanisms route through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("dispatches to the handler (decline body on an unbound store)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/mechanisms"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).mechanism_count, null);
  });

  test("testnet has no variant (app.subnet_mechanisms has no network column)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/testnet/subnets/64/mechanisms",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });

  test("rejects a query parameter: the card takes none", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/64/mechanisms?window=7d",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
