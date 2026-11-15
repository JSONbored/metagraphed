// The coldkey-swap v2 serving family (#13166): the pure builders, the native
// store seam, the PostgreSQL store module, and the REST handlers. The GraphQL
// and MCP mirrors are exercised in tests/graphql.test.ts and
// tests/mcp-neuron-hotkey-lookup.test.ts; the real PostgreSQL schema behind
// createPgColdkeySwapsStore is proven by tests/pg-coldkey-swaps.pg18.ts.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildPendingColdkeySwaps,
  loadPendingColdkeySwaps,
  buildAccountColdkeySwap,
  loadAccountColdkeySwap,
  formatColdkeySwapAnnouncement,
} from "../src/coldkey-swaps.ts";
import { selectedColdkeySwapsStore } from "../src/coldkey-swaps-store.ts";
import { createPgColdkeySwapsStore } from "../src/pg-coldkey-swaps.ts";
import {
  handlePendingColdkeySwaps,
  handleAccountColdkeySwap,
} from "../workers/request-handlers/entities.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

const CAPTURED_MS = 1_763_000_000_000;
const CAPTURED_ISO = new Date(CAPTURED_MS).toISOString();
const COLDKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const HASH = `0x${"ab".repeat(32)}`;

function announcementRow(overrides: Row = {}): Row {
  return {
    coldkey: COLDKEY,
    new_coldkey: OTHER,
    announcement_hash: HASH,
    announced_at: 5_000_000,
    execute_at: 5_036_000,
    disputed: false,
    disputed_at: 5_001_000,
    policy_snapshot: true,
    status: "announced",
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

function policyRow(overrides: Row = {}): Row {
  return {
    announcement_delay: "36000",
    reannouncement_delay: "7200",
    captured_at: CAPTURED_MS,
    ...overrides,
  };
}

describe("formatColdkeySwapAnnouncement", () => {
  test("formats a full row, crossing store numeric strings", () => {
    assert.deepEqual(
      formatColdkeySwapAnnouncement(
        announcementRow({
          announced_at: "5000000",
          execute_at: String(5_036_000),
          captured_at: String(CAPTURED_MS),
        }),
      ),
      {
        coldkey: COLDKEY,
        new_coldkey: OTHER,
        announcement_hash: HASH,
        announced_at: 5_000_000,
        execute_at: 5_036_000,
        disputed: false,
        disputed_at: 5_001_000,
        policy_snapshot: true,
        status: "announced",
        captured_at: CAPTURED_ISO,
      },
    );
  });

  test("a row without its announcing account names no announcement", () => {
    assert.equal(
      formatColdkeySwapAnnouncement(announcementRow({ coldkey: "" })),
      null,
    );
    assert.equal(
      formatColdkeySwapAnnouncement(announcementRow({ coldkey: 7 })),
      null,
    );
  });

  test("soft cells degrade to null rather than fabricating state", () => {
    const formatted = formatColdkeySwapAnnouncement(
      announcementRow({
        new_coldkey: "",
        announcement_hash: "0xZZ",
        announced_at: -1,
        execute_at: "",
        disputed: "yes",
        disputed_at: null,
        policy_snapshot: 1,
        status: null,
        captured_at: -5,
      }),
    )!;
    assert.deepEqual(formatted, {
      coldkey: COLDKEY,
      new_coldkey: null,
      announcement_hash: null,
      announced_at: null,
      execute_at: null,
      disputed: null,
      disputed_at: null,
      policy_snapshot: null,
      status: null,
      captured_at: null,
    });
    // A hash that is not a string at all degrades the same way.
    assert.equal(
      formatColdkeySwapAnnouncement(announcementRow({ announcement_hash: 7 }))!
        .announcement_hash,
      null,
    );
  });
});

describe("buildPendingColdkeySwaps", () => {
  test("null rows and no rows are both the decline: empty, NULL count, null policy", () => {
    for (const rows of [null, { announcements: [], policy: [] }]) {
      assert.deepEqual(buildPendingColdkeySwaps(rows), {
        schema_version: 1,
        // Never 0: an empty list is "the swap capture has not run", not a
        // measured swap-free chain.
        swap_count: null,
        captured_at: null,
        policy: null,
        swaps: [],
      });
    }
  });

  test("formats announcements, the newest capture stamp and the policy", () => {
    const card = buildPendingColdkeySwaps({
      announcements: [
        announcementRow({ captured_at: CAPTURED_MS + 1000 }),
        announcementRow({ coldkey: OTHER }),
        announcementRow({ coldkey: "" }),
      ],
      policy: [policyRow()],
    });
    assert.equal(card.swap_count, 2);
    assert.equal(card.captured_at, new Date(CAPTURED_MS + 1000).toISOString());
    assert.deepEqual(card.policy, {
      announcement_delay: 36_000,
      reannouncement_delay: 7200,
      captured_at: CAPTURED_ISO,
    });
    assert.equal((card.swaps as Row[]).length, 2);
  });

  test("a policy capture carrying nothing declines to null; a partial one serves", () => {
    const empty = buildPendingColdkeySwaps({
      announcements: [],
      policy: [
        { announcement_delay: null, reannouncement_delay: "", captured_at: 0 },
      ],
    });
    assert.equal(empty.policy, null);
    const partial = buildPendingColdkeySwaps({
      announcements: [],
      policy: [policyRow({ reannouncement_delay: null })],
    });
    assert.deepEqual(partial.policy, {
      announcement_delay: 36_000,
      reannouncement_delay: null,
      captured_at: CAPTURED_ISO,
    });
    const junk = buildPendingColdkeySwaps({
      announcements: [],
      policy: ["nope" as unknown as Row],
    });
    assert.equal(junk.policy, null);
  });
});

describe("buildAccountColdkeySwap", () => {
  test("null rows are the decline on every block", () => {
    assert.deepEqual(buildAccountColdkeySwap(null, COLDKEY), {
      schema_version: 1,
      ss58: COLDKEY,
      announcement: null,
      lineage: { coldkey: null, hotkey: [], hotkey_count: null },
      captured_at: null,
    });
  });

  test("formats the announcement and both lineage planes", () => {
    const card = buildAccountColdkeySwap(
      {
        announcement: [announcementRow()],
        lineage: [
          {
            kind: "coldkey",
            netuid: null,
            successor: OTHER,
            root: null,
            captured_at: CAPTURED_MS + 1000,
          },
          {
            kind: "hotkey",
            netuid: 7,
            successor: null,
            root: OTHER,
            captured_at: CAPTURED_MS,
          },
          // Dropped: a hotkey row without its subnet, one past the netuid
          // ceiling, and one naming no lineage at all.
          {
            kind: "hotkey",
            netuid: null,
            successor: OTHER,
            root: null,
            captured_at: CAPTURED_MS,
          },
          {
            kind: "hotkey",
            netuid: 70_000,
            successor: OTHER,
            root: null,
            captured_at: CAPTURED_MS,
          },
          {
            kind: "hotkey",
            netuid: 3,
            successor: null,
            root: "",
            captured_at: CAPTURED_MS,
          },
        ],
      },
      COLDKEY,
    );
    assert.deepEqual(card.lineage, {
      coldkey: {
        successor: OTHER,
        root: null,
        captured_at: new Date(CAPTURED_MS + 1000).toISOString(),
      },
      hotkey: [
        {
          netuid: 7,
          successor: null,
          root: OTHER,
          captured_at: CAPTURED_ISO,
        },
      ],
      hotkey_count: 1,
    });
    assert.equal((card.announcement as Row).announcement_hash, HASH);
    assert.equal(card.captured_at, new Date(CAPTURED_MS + 1000).toISOString());
  });

  test("a coldkey-swap lineage row naming neither side declines to null", () => {
    const card = buildAccountColdkeySwap(
      {
        announcement: [],
        lineage: [
          {
            kind: "coldkey",
            netuid: null,
            successor: null,
            root: null,
            captured_at: CAPTURED_MS,
          },
        ],
      },
      COLDKEY,
    );
    assert.equal((card.lineage as Row).coldkey, null);
    assert.equal(card.announcement, null);
    assert.equal(card.captured_at, null);
  });
});

describe("selectedColdkeySwapsStore / the loaders", () => {
  const store = {
    pending: async () => [announcementRow()],
    announcement: async (coldkey: string) => [announcementRow({ coldkey })],
    policy: async () => [policyRow()],
    lineage: async () => [],
  };

  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedColdkeySwapsStore({}), null);
    assert.equal(selectedColdkeySwapsStore(null), null);
    assert.equal(await loadPendingColdkeySwaps({}), null);
    assert.equal(await loadAccountColdkeySwap({}, COLDKEY), null);
  });

  test("a bound store serves its rows to both loaders", async () => {
    const env = { COLDKEY_SWAPS_STORE: store };
    assert.deepEqual(await loadPendingColdkeySwaps(env), {
      announcements: [announcementRow()],
      policy: [policyRow()],
    });
    assert.deepEqual(await loadAccountColdkeySwap(env, COLDKEY), {
      announcement: [announcementRow()],
      lineage: [],
    });
  });

  test("a failing store read declines rather than erroring the route", async () => {
    const boom = async () => {
      throw new Error("native unavailable");
    };
    assert.equal(
      await loadPendingColdkeySwaps({
        COLDKEY_SWAPS_STORE: { ...store, pending: boom },
      }),
      null,
    );
    assert.equal(
      await loadAccountColdkeySwap(
        { COLDKEY_SWAPS_STORE: { ...store, lineage: boom } },
        COLDKEY,
      ),
      null,
    );
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    assert.throws(
      () => selectedColdkeySwapsStore({ COLDKEY_SWAPS_STORE: {} }),
      /Invalid native coldkey swaps store/,
    );
    assert.throws(
      () =>
        selectedColdkeySwapsStore({
          COLDKEY_SWAPS_STORE: { ...store, lineage: 7 },
        }),
      /Invalid native coldkey swaps store/,
    );
  });
});

describe("createPgColdkeySwapsStore", () => {
  function fixture(rows: Row[] = [announcementRow()]) {
    const calls: { sql: string; params?: readonly unknown[] }[] = [];
    const store = createPgColdkeySwapsStore({
      read: {
        async query<T>(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return rows as T[];
        },
        async first() {
          throw new Error("unexpected first");
        },
      },
    });
    return { calls, store };
  }

  test("lists pending announcements soonest-executable first, capped", async () => {
    const { calls, store } = fixture();
    assert.deepEqual(await store.pending(), [announcementRow()]);
    assert.match(calls[0].sql, /FROM app\.coldkey_swap_announcements/);
    assert.match(calls[0].sql, /ORDER BY execute_at NULLS LAST, coldkey/);
    assert.match(calls[0].sql, /LIMIT 1024/);
  });

  test("reads one account's announcement by its coldkey", async () => {
    const { calls, store } = fixture();
    await store.announcement(COLDKEY);
    assert.match(calls[0].sql, /WHERE coldkey=\$1/);
    assert.deepEqual(calls[0].params, [COLDKEY]);
  });

  test("reads the newest policy capture only", async () => {
    const { calls, store } = fixture([policyRow()]);
    assert.deepEqual(await store.policy(), [policyRow()]);
    assert.match(calls[0].sql, /FROM app\.coldkey_swap_policy/);
    assert.match(calls[0].sql, /ORDER BY captured_at DESC LIMIT 1/);
  });

  test("reads one key's lineage across both planes, capped", async () => {
    const { calls, store } = fixture([]);
    assert.deepEqual(await store.lineage(COLDKEY), []);
    assert.match(calls[0].sql, /FROM app\.key_successors/);
    assert.match(calls[0].sql, /ORDER BY kind, netuid NULLS FIRST/);
    assert.match(calls[0].sql, /LIMIT 256/);
    assert.deepEqual(calls[0].params, [COLDKEY]);
  });

  test("refuses identities no account can have, before any query", async () => {
    const { calls, store } = fixture();
    await assert.rejects(
      store.announcement("not-an-address"),
      /Invalid native coldkey swap identity/,
    );
    await assert.rejects(
      store.lineage("5short"),
      /Invalid native key lineage identity/,
    );
    assert.equal(calls.length, 0);
  });
});

describe("handlePendingColdkeySwaps / handleAccountColdkeySwap", () => {
  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handlePendingColdkeySwaps(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/pending-coldkey-swaps",
      ),
      {} as unknown as Env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.deepEqual(data.swaps, []);
    assert.equal(data.swap_count, null);
    assert.equal(data.policy, null);
    assert.equal(
      (body.meta as Row).artifact_path,
      "/metagraph/accounts/pending-coldkey-swaps.json",
    );
  });

  test("a bound store serves the pending swaps", async () => {
    const env = {
      COLDKEY_SWAPS_STORE: {
        pending: async () => [announcementRow()],
        announcement: async () => [],
        policy: async () => [policyRow()],
        lineage: async () => [],
      },
    };
    const res = await handlePendingColdkeySwaps(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/pending-coldkey-swaps",
      ),
      env as unknown as Env,
    );
    assert.equal(res.status, 200);
    const data = ((await res.json()) as Row).data as Row;
    assert.equal(data.swap_count, 1);
    assert.equal((data.policy as Row).announcement_delay, 36_000);
  });

  test("rejects an invalid ss58 before touching any store", async () => {
    const res = await handleAccountColdkeySwap(
      new Request("https://api.metagraph.sh/api/v1/accounts/nope/coldkey-swap"),
      {} as unknown as Env,
      "nope",
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).code, "invalid_ss58");
  });

  test("no bound store is the schema-stable per-account decline", async () => {
    const res = await handleAccountColdkeySwap(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${COLDKEY}/coldkey-swap`,
      ),
      {} as unknown as Env,
      COLDKEY,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    const data = body.data as Row;
    assert.equal(data.announcement, null);
    assert.deepEqual(data.lineage, {
      coldkey: null,
      hotkey: [],
      hotkey_count: null,
    });
    assert.equal(
      (body.meta as Row).artifact_path,
      `/metagraph/accounts/${COLDKEY}/coldkey-swap.json`,
    );
  });

  test("a bound store serves the account's swap state", async () => {
    const env = {
      COLDKEY_SWAPS_STORE: {
        pending: async () => [],
        announcement: async () => [announcementRow()],
        policy: async () => [],
        lineage: async () => [
          {
            kind: "coldkey",
            netuid: null,
            successor: OTHER,
            root: null,
            captured_at: CAPTURED_MS,
          },
        ],
      },
    };
    const res = await handleAccountColdkeySwap(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${COLDKEY}/coldkey-swap`,
      ),
      env as unknown as Env,
      COLDKEY,
    );
    assert.equal(res.status, 200);
    const data = ((await res.json()) as Row).data as Row;
    assert.equal((data.announcement as Row).coldkey, COLDKEY);
    assert.equal(((data.lineage as Row).coldkey as Row).successor, OTHER);
  });
});

describe("the coldkey-swap routes through the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  test("the literal pending segment is never read as an ss58", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/accounts/pending-coldkey-swaps",
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).swap_count, null);
  });

  test("dispatches the per-account card (decline body on an unbound store)", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/accounts/${COLDKEY}/coldkey-swap`,
      ),
      {} as unknown as Env,
      ctx,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).announcement, null);
  });

  test("testnet has no variant (the swap tables have no network column)", async () => {
    for (const path of [
      "/api/v1/testnet/accounts/pending-coldkey-swaps",
      `/api/v1/testnet/accounts/${COLDKEY}/coldkey-swap`,
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
    for (const path of [
      "/api/v1/accounts/pending-coldkey-swaps?limit=5",
      `/api/v1/accounts/${COLDKEY}/coldkey-swap?window=7d`,
    ]) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        {} as unknown as Env,
        ctx,
      );
      assert.equal(res.status, 400, path);
    }
  });
});
