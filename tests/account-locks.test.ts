// The account-locks serving family (#13163): the pure builders, the native
// store seam, the PostgreSQL store module, and the REST handler. The GraphQL
// and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// createPgAccountLocksStore is proven by tests/pg-stake-v2.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildAccountLocks, loadAccountLocks } from "../src/account-locks.ts";
import { selectedAccountLocksStore } from "../src/account-locks-store.ts";
import { createPgAccountLocksStore } from "../src/pg-stake-locks.ts";
import { handleAccountLocks } from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();
const COLDKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function lockRow(overrides: Row = {}): Row {
  return {
    hotkey: "5Hotkey_one",
    netuid: 7,
    kind: "Lock",
    amount: "5000000000",
    maturity_block: 9_000_000,
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("buildAccountLocks", () => {
  test("null rows and no rows are both the decline: empty, with a NULL count", () => {
    for (const rows of [null, []]) {
      const card = buildAccountLocks(rows, COLDKEY);
      assert.deepEqual(card, {
        schema_version: 1,
        ss58: COLDKEY,
        // Never 0: an empty list is "the lock capture has not run", not a
        // measured lock-free account.
        lock_count: null,
        captured_at: null,
        locks: [],
      });
    }
  });

  test("formats rows and stamps the newest capture", () => {
    const card = buildAccountLocks(
      [
        lockRow({ captured_at: CAPTURED_MS + 1000 }),
        lockRow({
          hotkey: "5Hotkey_two",
          kind: "DecayingLock",
          maturity_block: null,
        }),
      ],
      COLDKEY,
    );
    assert.equal(card.lock_count, 2);
    assert.equal(card.captured_at, new Date(CAPTURED_MS + 1000).toISOString());
    assert.deepEqual(card.locks, [
      {
        hotkey: "5Hotkey_one",
        netuid: 7,
        kind: "Lock",
        amount: "5000000000",
        maturity_block: 9_000_000,
        captured_at: new Date(CAPTURED_MS + 1000).toISOString(),
      },
      {
        hotkey: "5Hotkey_two",
        netuid: 7,
        kind: "DecayingLock",
        amount: "5000000000",
        maturity_block: null,
        captured_at: CAPTURED_ISO,
      },
    ]);
  });

  test("store numeric strings cross (netuid::int stays int, bigints as text)", () => {
    const [lock] = buildAccountLocks(
      [
        lockRow({
          netuid: "12",
          maturity_block: String(9_000_000),
          captured_at: String(CAPTURED_MS),
        }),
      ],
      COLDKEY,
    ).locks as Row[];
    assert.deepEqual(lock, {
      hotkey: "5Hotkey_one",
      netuid: 12,
      kind: "Lock",
      amount: "5000000000",
      maturity_block: 9_000_000,
      captured_at: CAPTURED_ISO,
    });
  });

  test("a row missing its key parts or amount is dropped; soft cells degrade", () => {
    const card = buildAccountLocks(
      [
        lockRow({ hotkey: "" }),
        lockRow({ hotkey: 7 }),
        lockRow({ kind: "" }),
        lockRow({ kind: null }),
        lockRow({ netuid: null }),
        lockRow({ netuid: -1 }),
        lockRow({ netuid: "" }),
        lockRow({ amount: null }),
        lockRow({ amount: "01" }),
        lockRow({ amount: 5 }),
        lockRow({
          kind: "OwnerLock",
          maturity_block: -4,
          captured_at: -5,
        }),
        lockRow({ kind: "HotkeyLock", maturity_block: "", captured_at: null }),
        // Beyond ECMAScript's maximum time value: a Date this far out is
        // Invalid even though the number is finite.
        lockRow({
          kind: "DecayingOwnerLock",
          captured_at: 9_000_000_000_000_000,
        }),
      ],
      COLDKEY,
    );
    assert.equal(card.lock_count, 3);
    assert.deepEqual(card.locks, [
      {
        hotkey: "5Hotkey_one",
        netuid: 7,
        kind: "OwnerLock",
        amount: "5000000000",
        maturity_block: null,
        captured_at: null,
      },
      {
        hotkey: "5Hotkey_one",
        netuid: 7,
        kind: "HotkeyLock",
        amount: "5000000000",
        maturity_block: null,
        captured_at: null,
      },
      {
        hotkey: "5Hotkey_one",
        netuid: 7,
        kind: "DecayingOwnerLock",
        amount: "5000000000",
        maturity_block: 9_000_000,
        captured_at: null,
      },
    ]);
    assert.equal(card.captured_at, null);
  });
});

describe("selectedAccountLocksStore / loadAccountLocks", () => {
  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedAccountLocksStore({}), null);
    assert.equal(selectedAccountLocksStore(null), null);
    assert.equal(await loadAccountLocks({}, COLDKEY), null);
  });

  test("a bound store serves its rows", async () => {
    const env = {
      ACCOUNT_LOCKS_STORE: {
        rows: async (coldkey: string) => [lockRow({ hotkey: coldkey })],
      },
    };
    assert.deepEqual(await loadAccountLocks(env, COLDKEY), [
      lockRow({ hotkey: COLDKEY }),
    ]);
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const env = {
      ACCOUNT_LOCKS_STORE: {
        rows: async () => {
          throw new Error("native unavailable");
        },
      },
    };
    assert.equal(await loadAccountLocks(env, COLDKEY), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    assert.throws(
      () => selectedAccountLocksStore({ ACCOUNT_LOCKS_STORE: {} }),
      /Invalid native account locks store/,
    );
  });
});

describe("createPgAccountLocksStore", () => {
  function fixture() {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgAccountLocksStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return [lockRow()] as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    return { calls, store };
  }

  test("reads one coldkey's locks, ordered by (netuid, hotkey, kind)", async () => {
    const { calls, store } = fixture();
    assert.deepEqual(await store.rows(COLDKEY), [lockRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM app\.stake_locks/);
    assert.match(calls[0].sql, /ORDER BY netuid, hotkey, kind/);
    assert.deepEqual(calls[0].params, [COLDKEY]);
  });

  test("refuses an identity no account can have, before any query", async () => {
    const { calls, store } = fixture();
    for (const coldkey of ["", "not-an-address", "5short"]) {
      await assert.rejects(
        store.rows(coldkey),
        /Invalid native account locks identity/,
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("handleAccountLocks", () => {
  test("rejects an invalid ss58 before touching any store", async () => {
    const res = await handleAccountLocks(
      new Request("https://api.metagraph.sh/api/v1/accounts/nope/locks"),
      {} as unknown as Env,
      "nope",
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).code, "invalid_ss58");
  });

  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handleAccountLocks(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${COLDKEY}/locks`),
      {} as unknown as Env,
      COLDKEY,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.deepEqual(data.locks, []);
    assert.equal(data.lock_count, null);
    assert.equal(data.ss58, COLDKEY);
    assert.equal(
      (body.meta as Row).artifact_path,
      `/metagraph/accounts/${COLDKEY}/locks.json`,
    );
  });

  test("a bound store serves the locks", async () => {
    const env = {
      ACCOUNT_LOCKS_STORE: {
        rows: async () => [lockRow(), lockRow({ kind: "OwnerLock" })],
      },
    };
    const res = await handleAccountLocks(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${COLDKEY}/locks`),
      env as unknown as Env,
      COLDKEY,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.lock_count, 2);
    assert.equal(data.captured_at, CAPTURED_ISO);
    assert.equal((data.locks as Row[])[1].kind, "OwnerLock");
  });
});

describe("the /accounts/{ss58}/locks route through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("dispatches to the handler (decline body on an unbound store)", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${COLDKEY}/locks`),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).lock_count, null);
  });

  test("testnet has no variant (app.stake_locks has no network column)", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/testnet/accounts/${COLDKEY}/locks`,
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 404);
  });

  test("rejects a query parameter: the card takes none", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${COLDKEY}/locks?window=7d`,
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
