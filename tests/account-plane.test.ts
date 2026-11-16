// The account-plane serving families (#13166): proxies, multisigs, and the
// stored child-key detail -- the pure builders, the native store seams, the
// PostgreSQL store modules, and the REST handlers. The GraphQL and MCP
// mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// the three stores is proven by tests/pg-account-plane.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountProxies,
  loadAccountProxies,
} from "../src/account-proxies.ts";
import { selectedAccountProxiesStore } from "../src/account-proxies-store.ts";
import { createPgAccountProxiesStore } from "../src/pg-proxies.ts";
import {
  buildAccountMultisigs,
  loadAccountMultisigs,
  formatMultisig,
} from "../src/account-multisigs.ts";
import { selectedAccountMultisigsStore } from "../src/account-multisigs-store.ts";
import { createPgAccountMultisigsStore } from "../src/pg-multisigs.ts";
import {
  buildChildKeyDetail,
  buildParentKeyDetail,
  loadChildKeyDetail,
} from "../src/child-key-detail.ts";
import { selectedChildKeysStore } from "../src/child-keys-store.ts";
import { createPgChildKeysStore } from "../src/pg-child-keys.ts";
import {
  handleAccountProxies,
  handleAccountMultisigs,
} from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();
const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

function proxyRow(overrides: Row = {}): Row {
  return {
    delegate: OTHER,
    proxy_type: "Staking",
    delay: "0",
    deposit: "1000000000",
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

function multisigRow(overrides: Row = {}): Row {
  return {
    multisig: OTHER,
    threshold: "2",
    signatories: [SS58, OTHER],
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("buildAccountProxies", () => {
  test("null rows and no rows are both the decline: empty, NULL count", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(buildAccountProxies(rows, SS58), {
        schema_version: 1,
        ss58: SS58,
        // Never 0: an empty list is "the proxy capture has not run", not a
        // measured delegation-free account.
        proxy_count: null,
        deposit: null,
        captured_at: null,
        proxies: [],
      });
    }
  });

  test("formats rows, the account-level reserve and the newest stamp", () => {
    const card = buildAccountProxies(
      [
        proxyRow({ deposit: null, captured_at: CAPTURED_MS + 1000 }),
        proxyRow({ proxy_type: "Any", delay: 10 }),
      ],
      SS58,
    );
    assert.equal(card.proxy_count, 2);
    // The reserve comes from the first row that carries one.
    assert.equal(card.deposit, "1000000000");
    assert.equal(card.captured_at, new Date(CAPTURED_MS + 1000).toISOString());
    assert.deepEqual((card.proxies as Row[])[1], {
      delegate: OTHER,
      proxy_type: "Any",
      delay: 10,
      captured_at: CAPTURED_ISO,
    });
  });

  test("a row missing its delegate, variant or delay is dropped", () => {
    const card = buildAccountProxies(
      [
        proxyRow({ delegate: "", deposit: null }),
        proxyRow({ delegate: 7, deposit: null }),
        proxyRow({ proxy_type: "", deposit: null }),
        proxyRow({ delay: null, deposit: null }),
        proxyRow({ delay: -1, deposit: null }),
        proxyRow({ delay: "", deposit: null }),
        proxyRow({ deposit: "01", captured_at: null }),
      ],
      SS58,
    );
    assert.equal(card.proxy_count, 1);
    // Non-canonical reserve text degrades to null rather than serving junk.
    assert.equal(card.deposit, null);
    assert.equal(card.captured_at, null);
  });
});

describe("formatMultisig / buildAccountMultisigs", () => {
  test("null rows and no rows are both the decline: empty, NULL count", () => {
    for (const rows of [null, []]) {
      assert.deepEqual(buildAccountMultisigs(rows, SS58), {
        schema_version: 1,
        ss58: SS58,
        multisig_count: null,
        captured_at: null,
        multisigs: [],
      });
    }
  });

  test("labels which side of the membership matched", () => {
    const card = buildAccountMultisigs(
      [multisigRow(), multisigRow({ multisig: SS58, signatories: null })],
      SS58,
    );
    assert.equal(card.multisig_count, 2);
    assert.deepEqual(card.multisigs, [
      {
        multisig: OTHER,
        threshold: 2,
        signatories: [SS58, OTHER],
        signatory_count: 2,
        role: "signatory",
        captured_at: CAPTURED_ISO,
      },
      {
        multisig: SS58,
        threshold: 2,
        signatories: null,
        signatory_count: null,
        role: "multisig",
        captured_at: CAPTURED_ISO,
      },
    ]);
  });

  test("an unresolved composition declines; junk members are dropped", () => {
    const resolved = formatMultisig(
      multisigRow({ threshold: "0", signatories: [OTHER, "", 7] }),
      SS58,
    )!;
    assert.equal(resolved.threshold, null);
    assert.deepEqual(resolved.signatories, [OTHER]);
    assert.equal(resolved.signatory_count, 1);
    // A non-array signatory cell and an all-junk array both decline.
    assert.equal(
      formatMultisig(multisigRow({ signatories: "nope" }), SS58)!.signatories,
      null,
    );
    assert.equal(
      formatMultisig(multisigRow({ signatories: [""] }), SS58)!.signatories,
      null,
    );
    // A row without its multisig account names nothing.
    assert.equal(formatMultisig(multisigRow({ multisig: "" }), SS58), null);
  });
});

describe("buildChildKeyDetail / buildParentKeyDetail", () => {
  const detailRows = {
    takes: [
      { netuid: 7, take: 11796, captured_at: CAPTURED_MS },
      { netuid: 70_000, take: 1, captured_at: CAPTURED_MS }, // dropped
      { netuid: 3, take: 65536, captured_at: CAPTURED_MS }, // dropped
    ],
    pending: [
      {
        netuid: 7,
        child: OTHER,
        proportion: "9223372036854775808",
        cool_down_block: "5036000",
        captured_at: CAPTURED_MS,
      },
      {
        netuid: 7,
        child: "",
        proportion: "1",
        cool_down_block: null,
        captured_at: CAPTURED_MS,
      }, // dropped
    ],
    threshold: [
      { pending_check: true, suspended: false, captured_at: CAPTURED_MS },
    ],
    history: [
      {
        netuid: 7,
        parent: SS58,
        child: OTHER,
        proportion: "18446744073709551615",
        captured_at: CAPTURED_MS,
      },
      {
        netuid: 7,
        parent: SS58,
        child: OTHER,
        proportion: "01",
        captured_at: CAPTURED_MS,
      }, // dropped: non-canonical text
    ],
  };

  test("null rows are the whole-block decline", () => {
    assert.equal(buildChildKeyDetail(null), null);
    assert.equal(buildParentKeyDetail(null), null);
  });

  test("formats the children view with fractions and NULL-over-empty counts", () => {
    const detail = buildChildKeyDetail(detailRows)!;
    assert.deepEqual(detail.takes, [
      {
        netuid: 7,
        take: 11796,
        take_fraction: 11796 / 65535,
        captured_at: CAPTURED_ISO,
      },
    ]);
    assert.equal(detail.take_count, 1);
    assert.deepEqual(detail.pending, [
      {
        netuid: 7,
        child: OTHER,
        proportion: "9223372036854775808",
        proportion_fraction: 0.5,
        cool_down_block: 5_036_000,
        captured_at: CAPTURED_ISO,
      },
    ]);
    assert.equal(detail.pending_count, 1);
    assert.deepEqual(detail.threshold, {
      pending_check: true,
      suspended: false,
      captured_at: CAPTURED_ISO,
    });
    assert.deepEqual(detail.history, [
      {
        netuid: 7,
        parent: SS58,
        child: OTHER,
        proportion: "18446744073709551615",
        proportion_fraction: 1,
        captured_at: CAPTURED_ISO,
      },
    ]);
    assert.equal(detail.history_count, 1);
    const empty = buildChildKeyDetail({
      takes: [],
      pending: [],
      threshold: [],
      history: [],
    })!;
    assert.deepEqual(empty, {
      takes: [],
      take_count: null,
      pending: [],
      pending_count: null,
      threshold: null,
      history: [],
      history_count: null,
    });
    // A threshold row carrying no answer from either map declines too.
    assert.equal(
      buildChildKeyDetail({
        ...detailRows,
        threshold: [{ pending_check: "yes", suspended: null, captured_at: 0 }],
      })!.threshold,
      null,
    );
  });

  test("the parents view carries takes and history only", () => {
    const detail = buildParentKeyDetail(detailRows)!;
    assert.deepEqual(Object.keys(detail).sort(), [
      "history",
      "history_count",
      "take_count",
      "takes",
    ]);
    assert.equal(detail.take_count, 1);
    assert.equal(detail.history_count, 1);
  });
});

describe("the store seams and loaders", () => {
  const childStore = {
    takes: async () => [],
    pending: async () => [],
    threshold: async () => [],
    historyByParent: async () => [],
    historyByChild: async () => [],
  };

  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedAccountProxiesStore({}), null);
    assert.equal(selectedAccountMultisigsStore({}), null);
    assert.equal(selectedChildKeysStore({}), null);
    assert.equal(selectedChildKeysStore(null), null);
    assert.equal(await loadAccountProxies({}, SS58), null);
    assert.equal(await loadAccountMultisigs({}, SS58), null);
    assert.equal(await loadChildKeyDetail({}, SS58, "children", true), null);
  });

  test("a testnet-addressed detail read declines before touching any store", async () => {
    let called = false;
    const env = {
      CHILD_KEYS_STORE: {
        ...childStore,
        takes: async () => {
          called = true;
          return [];
        },
      },
    };
    assert.equal(await loadChildKeyDetail(env, SS58, "children", false), null);
    assert.equal(called, false);
  });

  test("a bound store serves both child-key views", async () => {
    const env = {
      CHILD_KEYS_STORE: {
        takes: async () => [{ netuid: 7 }],
        pending: async () => [{ netuid: 7 }],
        threshold: async () => [{ suspended: false }],
        historyByParent: async () => [{ parent: SS58 }],
        historyByChild: async () => [{ child: SS58 }],
      },
    };
    assert.deepEqual(await loadChildKeyDetail(env, SS58, "children", true), {
      takes: [{ netuid: 7 }],
      pending: [{ netuid: 7 }],
      threshold: [{ suspended: false }],
      history: [{ parent: SS58 }],
    });
    assert.deepEqual(await loadChildKeyDetail(env, SS58, "parents", true), {
      takes: [{ netuid: 7 }],
      pending: null,
      threshold: null,
      history: [{ child: SS58 }],
    });
  });

  test("failing store reads decline rather than erroring the routes", async () => {
    const boom = async () => {
      throw new Error("native unavailable");
    };
    assert.equal(
      await loadAccountProxies({ ACCOUNT_PROXIES_STORE: { rows: boom } }, SS58),
      null,
    );
    assert.equal(
      await loadAccountMultisigs(
        { ACCOUNT_MULTISIGS_STORE: { byMember: boom } },
        SS58,
      ),
      null,
    );
    assert.equal(
      await loadChildKeyDetail(
        { CHILD_KEYS_STORE: { ...childStore, historyByParent: boom } },
        SS58,
        "children",
        true,
      ),
      null,
    );
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    assert.throws(
      () => selectedAccountProxiesStore({ ACCOUNT_PROXIES_STORE: {} }),
      /Invalid native account proxies store/,
    );
    assert.throws(
      () => selectedAccountMultisigsStore({ ACCOUNT_MULTISIGS_STORE: {} }),
      /Invalid native account multisigs store/,
    );
    assert.throws(
      () =>
        selectedChildKeysStore({
          CHILD_KEYS_STORE: { ...childStore, historyByChild: 7 },
        }),
      /Invalid native child keys store/,
    );
  });
});

describe("the PostgreSQL store modules", () => {
  function fixture(rows: Row[] = []) {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const read = {
      async query<T>(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params });
        return rows as T[];
      },
      async first() {
        throw new Error("unexpected first");
      },
    };
    return { calls, read };
  }

  test("proxies: reads one delegator's rows in vector order", async () => {
    const { calls, read } = fixture([proxyRow()]);
    const store = createPgAccountProxiesStore({ read });
    assert.deepEqual(await store.rows(SS58), [proxyRow()]);
    assert.match(calls[0].sql, /FROM app\.proxies WHERE delegator=\$1/);
    assert.match(calls[0].sql, /ORDER BY delegate, proxy_type, delay/);
    assert.deepEqual(calls[0].params, [SS58]);
    await assert.rejects(
      store.rows("nope"),
      /Invalid native account proxies identity/,
    );
  });

  test("multisigs: probes membership with a JSON-text bind, never a raw array", async () => {
    const { calls, read } = fixture([multisigRow()]);
    const store = createPgAccountMultisigsStore({ read });
    assert.deepEqual(await store.byMember(SS58), [multisigRow()]);
    assert.match(
      calls[0].sql,
      /WHERE multisig=\$1 OR signatories @> \$2::jsonb/,
    );
    assert.match(calls[0].sql, /LIMIT 256/);
    // The containment bind is JSON TEXT (#10179): a raw array would be
    // reinterpreted as a Postgres array literal by the driver.
    assert.deepEqual(calls[0].params, [SS58, JSON.stringify([SS58])]);
    await assert.rejects(
      store.byMember(""),
      /Invalid native account multisigs identity/,
    );
  });

  test("child keys: five bounded reads, each identity-guarded", async () => {
    const { calls, read } = fixture([]);
    const store = createPgChildKeysStore({ read });
    await store.takes(SS58);
    await store.pending(SS58);
    await store.threshold(SS58);
    await store.historyByParent(SS58);
    await store.historyByChild(SS58);
    assert.match(calls[0].sql, /FROM app\.childkey_takes WHERE hotkey=\$1/);
    assert.match(calls[1].sql, /FROM app\.pending_child_keys WHERE parent=\$1/);
    assert.match(
      calls[2].sql,
      /FROM app\.childkey_thresholds WHERE parent=\$1/,
    );
    assert.match(calls[3].sql, /WHERE parent=\$1 ORDER BY captured_at DESC/);
    assert.match(calls[4].sql, /WHERE child=\$1 ORDER BY captured_at DESC/);
    assert.match(calls[3].sql, /LIMIT 512/);
    for (const method of [
      "takes",
      "pending",
      "threshold",
      "historyByParent",
      "historyByChild",
    ] as const) {
      await assert.rejects(store[method]("not-an-address"), /Invalid native/);
    }
    assert.equal(calls.length, 5);
  });
});

describe("handleAccountProxies / handleAccountMultisigs", () => {
  test("reject an invalid ss58 before touching any store", async () => {
    for (const handler of [handleAccountProxies, handleAccountMultisigs]) {
      const res = await handler(
        new Request("https://api.metagraph.sh/api/v1/accounts/nope/x"),
        {} as unknown as Env,
        "nope",
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as Row;
      assert.equal((body.error as Row).code, "invalid_ss58");
    }
  });

  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const proxies = await handleAccountProxies(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/proxies`),
      {} as unknown as Env,
      SS58,
    );
    assert.equal(proxies.status, 200);
    const proxiesBody = (await proxies.json()) as Row;
    assert.equal((proxiesBody.data as Row).proxy_count, null);
    assert.equal(
      (proxiesBody.meta as Row).artifact_path,
      `/metagraph/accounts/${SS58}/proxies.json`,
    );
    const multisigs = await handleAccountMultisigs(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/multisigs`),
      {} as unknown as Env,
      SS58,
    );
    assert.equal(multisigs.status, 200);
    const multisigsBody = (await multisigs.json()) as Row;
    assert.equal((multisigsBody.data as Row).multisig_count, null);
    assert.equal(
      (multisigsBody.meta as Row).artifact_path,
      `/metagraph/accounts/${SS58}/multisigs.json`,
    );
  });

  test("bound stores serve the rows", async () => {
    const env = {
      ACCOUNT_PROXIES_STORE: { rows: async () => [proxyRow()] },
      ACCOUNT_MULTISIGS_STORE: { byMember: async () => [multisigRow()] },
    };
    const proxies = await handleAccountProxies(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/proxies`),
      env as unknown as Env,
      SS58,
    );
    assert.equal((((await proxies.json()) as Row).data as Row).proxy_count, 1);
    const multisigs = await handleAccountMultisigs(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/multisigs`),
      env as unknown as Env,
      SS58,
    );
    assert.equal(
      (((await multisigs.json()) as Row).data as Row).multisig_count,
      1,
    );
  });
});

describe("the proxies/multisigs routes through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("dispatch (decline bodies on unbound stores)", async () => {
    for (const [path, countKey] of [
      [`/api/v1/accounts/${SS58}/proxies`, "proxy_count"],
      [`/api/v1/accounts/${SS58}/multisigs`, "multisig_count"],
    ] as const) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        {} as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 200, path);
      const body = (await res.json()) as Row;
      assert.equal((body.data as Row)[countKey], null, path);
    }
  });

  test("testnet has no variant (the tables have no network column)", async () => {
    for (const path of [
      `/api/v1/testnet/accounts/${SS58}/proxies`,
      `/api/v1/testnet/accounts/${SS58}/multisigs`,
    ]) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        {} as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 404, path);
    }
  });

  test("rejects a query parameter: the cards take none", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${SS58}/proxies?limit=5`,
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
