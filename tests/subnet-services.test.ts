// The subnet-services serving family (#13164): the pure builder, the native
// store seam, the PostgreSQL store module, and the REST handler. The GraphQL
// and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// createPgSubnetServicesStore is proven by tests/pg-gamma.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetServices,
  loadSubnetServices,
} from "../src/subnet-services.ts";
import { selectedSubnetServicesStore } from "../src/subnet-services-store.ts";
import { createPgSubnetServicesStore } from "../src/pg-subnet-services.ts";
import { handleSubnetServices } from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();

function serviceRow(overrides: Row = {}): Row {
  return {
    hotkey: "5Hotkey_one",
    service_url: "https://sn64.example.com/v1",
    set_at: 9_000_000,
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("buildSubnetServices", () => {
  test("null rows and no rows are both the decline: empty, with a NULL count", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(buildSubnetServices(rows, 64), {
        schema_version: 1,
        netuid: 64,
        // Never 0: an empty registry is "the service capture has not run",
        // not a measured service-less subnet.
        service_count: null,
        captured_at: null,
        services: [],
      });
    }
  });

  test("formats rows and stamps the newest capture", () => {
    const card = buildSubnetServices(
      [
        serviceRow({ captured_at: CAPTURED_MS + 1000 }),
        serviceRow({ hotkey: "5Hotkey_two", set_at: null }),
      ],
      64,
    );
    assert.equal(card.service_count, 2);
    assert.equal(card.captured_at, new Date(CAPTURED_MS + 1000).toISOString());
    assert.deepEqual(card.services, [
      {
        hotkey: "5Hotkey_one",
        service_url: "https://sn64.example.com/v1",
        set_at: 9_000_000,
        captured_at: new Date(CAPTURED_MS + 1000).toISOString(),
      },
      {
        hotkey: "5Hotkey_two",
        service_url: "https://sn64.example.com/v1",
        set_at: null,
        captured_at: CAPTURED_ISO,
      },
    ]);
  });

  test("a row missing its hotkey or URL is dropped; soft cells degrade", () => {
    const card = buildSubnetServices(
      [
        serviceRow({ hotkey: "" }),
        serviceRow({ hotkey: 7 }),
        serviceRow({ service_url: "" }),
        serviceRow({ service_url: null }),
        serviceRow({
          hotkey: "5Hotkey_soft",
          set_at: "not-a-block",
          captured_at: null,
        }),
        serviceRow({ hotkey: "5Hotkey_blank", set_at: "", captured_at: "abc" }),
        // Beyond ECMAScript's maximum time value: Invalid Date, so no stamp.
        serviceRow({
          hotkey: "5Hotkey_far",
          captured_at: 9_000_000_000_000_000,
        }),
      ],
      7,
    );
    assert.equal(card.service_count, 3);
    assert.deepEqual(card.services, [
      {
        hotkey: "5Hotkey_soft",
        service_url: "https://sn64.example.com/v1",
        set_at: null,
        captured_at: null,
      },
      {
        hotkey: "5Hotkey_blank",
        service_url: "https://sn64.example.com/v1",
        set_at: null,
        captured_at: null,
      },
      {
        hotkey: "5Hotkey_far",
        service_url: "https://sn64.example.com/v1",
        set_at: 9_000_000,
        captured_at: null,
      },
    ]);
    assert.equal(card.captured_at, null);
  });

  test("a string set_at block crosses as its integer", () => {
    const card = buildSubnetServices([serviceRow({ set_at: "9000000" })], 7);
    assert.equal((card.services as Row[])[0].set_at, 9_000_000);
  });
});

describe("selectedSubnetServicesStore / loadSubnetServices", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedSubnetServicesStore({}), null);
    assert.equal(selectedSubnetServicesStore(null), null);
    assert.equal(await loadSubnetServices({}, 64), null);
  });

  test("a bound store serves its rows", async () => {
    const env = {
      SUBNET_SERVICES_STORE: {
        rows: async (netuid: number) => [
          serviceRow({ hotkey: `5Hotkey_${netuid}` }),
        ],
      },
    };
    assert.deepEqual(await loadSubnetServices(env, 3), [
      serviceRow({ hotkey: "5Hotkey_3" }),
    ]);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const env = {
      SUBNET_SERVICES_STORE: {
        rows: async () => {
          throw new Error("native unavailable");
        },
      },
    };
    assert.equal(await loadSubnetServices(env, 3), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    for (const store of [null, {}]) {
      assert.throws(
        () => selectedSubnetServicesStore({ SUBNET_SERVICES_STORE: store }),
        /Invalid native subnet services store/,
      );
    }
  });
});

describe("createPgSubnetServicesStore", () => {
  function fixture() {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgSubnetServicesStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [serviceRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    return { calls, store };
  }

  test("reads one subnet's services ordered by hotkey", async () => {
    const { calls, store } = fixture();
    assert.deepEqual(await store.rows(64), [serviceRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app\.subnet_services/);
    assert.match(calls[0].sql, /ORDER BY hotkey$/);
    assert.deepEqual(calls[0].params, [64]);
  });

  test("refuses an identity no subnet can have, before any query", async () => {
    const { calls, store } = fixture();
    for (const netuid of [-1, 1.5, 65536, Number.NaN]) {
      await assert.rejects(
        store.rows(netuid),
        /Invalid native subnet services identity/,
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("handleSubnetServices", () => {
  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handleSubnetServices(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/services"),
      {} as unknown as Env,
      64,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.deepEqual(data.services, []);
    assert.equal(data.service_count, null);
    assert.equal(data.netuid, 64);
    assert.equal(
      (body.meta as Row).artifact_path,
      "/metagraph/subnets/64/services.json",
    );
  });

  test("a bound store serves the services", async () => {
    const env = {
      SUBNET_SERVICES_STORE: {
        rows: async () => [serviceRow(), serviceRow({ hotkey: "5Hotkey_two" })],
      },
    } as unknown as Env;
    const res = await handleSubnetServices(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/services"),
      env,
      64,
    );
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.service_count, 2);
    assert.equal((data.services as Row[])[1].hotkey, "5Hotkey_two");
  });
});

describe("the /subnets/{netuid}/services route through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("dispatches to the handler (decline body on an unbound store)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/64/services"),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).service_count, null);
  });

  test("testnet has no variant (app.subnet_services has no network column)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/testnet/subnets/64/services",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });

  test("rejects a query parameter: the card takes none", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/64/services?window=7d",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
