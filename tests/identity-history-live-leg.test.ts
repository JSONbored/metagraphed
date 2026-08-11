// The LIVE store leg of the identity-history composer (#10773).
//
// `subnet_identity_history` had no writer from the D1 cutover until
// 2026-08-11 -- `syncSubnetIdentityToPostgres` was named as its sole writer in
// four places and never existed -- so #10190 removed the tier read as
// unreachable and the frozen lakehouse export became the only leg. The writer
// landed the same day (#10740 / #10762 and metagraphed-infra#444) and nothing
// repointed the read: the lane wrote 248 rows at 13:15Z while REST, MCP and
// GraphQL all still served 2026-07-31.
//
// These pin the ORDER of the cascade, which is the whole of the fix: live
// ahead of frozen, because the export is a one-time 2026-08-02 seed that never
// advances -- and a live MISS still falling through, because the export holds
// everything from before the writer existed.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  answerChainIdentityHistory,
  answerSubnetIdentityHistory,
} from "../src/identity-history-answer.ts";

/** One live row, as the store hands it back. */
const LIVE_ROW = {
  id: 9,
  netuid: 64,
  block_number: 8_821_000,
  observed_at: 1_786_000_000_000,
  subnet_name: "Live Name",
  symbol: "L",
  description: null,
  github_repo: null,
  subnet_url: null,
  discord: null,
  logo_url: null,
  identity_hash: "abc",
};

/** A live runner that returns `rows` and records the SQL it was asked for. */
function liveRunner(rows: Record<string, unknown>[]) {
  const seen: { sql: string; params: unknown[] }[] = [];
  return {
    seen,
    live: async () => async (sql: string, params: unknown[]) => {
      seen.push({ sql, params });
      return rows;
    },
  };
}

/** A frozen leg that is distinguishable from the live one in the output. */
const frozenChain = async () =>
  ({
    schema_version: 1,
    count: 1,
    subnet_count: 1,
    changes: [{ netuid: 1, subnet_name: "Frozen Name" }],
  }) as never;

const frozenSubnet = async () =>
  ({
    schema_version: 1,
    netuid: 64,
    entry_count: 1,
    entries: [{ subnet_name: "Frozen Name" }],
  }) as never;

describe("the network feed prefers the live store over the frozen export", () => {
  test("a live row answers, and the frozen export is never consulted", async () => {
    let frozenCalls = 0;
    const { live, seen } = liveRunner([LIVE_ROW]);
    const out = (await answerChainIdentityHistory(
      {},
      null,
      { limit: 5 },
      {
        live,
        coldTier: (async () => {
          frozenCalls += 1;
          return frozenChain();
        }) as never,
      },
    )) as Record<string, unknown>;
    const changes = out.changes as Record<string, unknown>[];
    assert.equal(changes[0].subnet_name, "Live Name");
    assert.equal(frozenCalls, 0, "the frozen export must not be paid for");
    assert.match(seen[0].sql, /FROM subnet_identity_history/);
  });

  test("the live query keeps the cold tier's total order", async () => {
    // The two legs answer the same question and a caller cannot tell which
    // one did. Disagreeing orders would show up as rows shuffling whenever
    // the live store went cold.
    const { live, seen } = liveRunner([LIVE_ROW]);
    await answerChainIdentityHistory({}, null, { limit: 5 }, { live });
    assert.match(
      seen[0].sql,
      /ORDER BY block_number DESC, netuid ASC, id DESC/,
    );
  });

  test("an EMPTY live read falls through to the frozen export", async () => {
    // The table is filling from 2026-08-11 forward; everything before that
    // lives only in the export. Treating the empty read as authoritative
    // would publish "no identity has ever changed" for most of the network.
    const { live } = liveRunner([]);
    const out = (await answerChainIdentityHistory(
      {},
      null,
      { limit: 5 },
      { live, coldTier: frozenChain as never },
    )) as Record<string, unknown>;
    const changes = out.changes as Record<string, unknown>[];
    assert.equal(changes[0].subnet_name, "Frozen Name");
  });

  test("a THROWING live read is a miss, not an outage", async () => {
    const out = (await answerChainIdentityHistory(
      {},
      null,
      { limit: 5 },
      {
        live: async () => async () => {
          throw new Error("hyperdrive cold");
        },
        coldTier: frozenChain as never,
      },
    )) as Record<string, unknown>;
    assert.equal(
      (out.changes as Record<string, unknown>[])[0].subnet_name,
      "Frozen Name",
    );
  });

  test("a store that cannot be resolved at all falls through", async () => {
    const out = (await answerChainIdentityHistory(
      {},
      null,
      { limit: 5 },
      { live: async () => null, coldTier: frozenChain as never },
    )) as Record<string, unknown>;
    assert.equal(
      (out.changes as Record<string, unknown>[])[0].subnet_name,
      "Frozen Name",
    );
  });

  test("a THROWING store resolver is a miss too", async () => {
    const out = (await answerChainIdentityHistory(
      {},
      null,
      { limit: 5 },
      {
        live: async () => {
          throw new Error("no binding");
        },
        coldTier: frozenChain as never,
      },
    )) as Record<string, unknown>;
    assert.equal(
      (out.changes as Record<string, unknown>[])[0].subnet_name,
      "Frozen Name",
    );
  });

  test("a caller-supplied tier still wins, and skips the live read entirely", async () => {
    // THE TIER PROBE STAYS WITH THE SURFACE, per this module's header. A
    // surface that did probe must not have its answer overridden here, and
    // must not pay for a store read it does not need.
    let liveCalls = 0;
    const out = (await answerChainIdentityHistory(
      {},
      { changes: [{ subnet_name: "Tier Name" }] },
      { limit: 5 },
      {
        live: async () => {
          liveCalls += 1;
          return null;
        },
        coldTier: frozenChain as never,
      },
    )) as Record<string, unknown>;
    assert.equal(
      (out.changes as Record<string, unknown>[])[0].subnet_name,
      "Tier Name",
    );
    assert.equal(liveCalls, 0);
  });

  test("everything declining still yields the schema-stable empty feed", async () => {
    const out = (await answerChainIdentityHistory(
      {},
      null,
      { limit: 5 },
      { live: async () => null, coldTier: (async () => null) as never },
    )) as Record<string, unknown>;
    assert.equal(out.count, 0);
    assert.deepEqual(out.changes, []);
  });
});

describe("the per-subnet timeline takes the same cascade", () => {
  test("a live row answers ahead of the frozen export", async () => {
    let frozenCalls = 0;
    const { live, seen } = liveRunner([LIVE_ROW]);
    const out = (await answerSubnetIdentityHistory(
      {},
      64,
      null,
      { limit: 5 },
      {
        live,
        coldTier: (async () => {
          frozenCalls += 1;
          return frozenSubnet();
        }) as never,
      },
    )) as Record<string, unknown>;
    const entries = out.entries as Record<string, unknown>[];
    assert.equal(entries[0].subnet_name, "Live Name");
    assert.equal(frozenCalls, 0);
    assert.deepEqual(seen[0].params[0], 64, "scoped to the netuid asked for");
  });

  test("an empty live read falls through to the frozen timeline", async () => {
    const { live } = liveRunner([]);
    const out = (await answerSubnetIdentityHistory(
      {},
      64,
      null,
      { limit: 5 },
      { live, coldTier: frozenSubnet as never },
    )) as Record<string, unknown>;
    assert.equal(
      (out.entries as Record<string, unknown>[])[0].subnet_name,
      "Frozen Name",
    );
  });

  test("a throwing live read is a miss", async () => {
    const out = (await answerSubnetIdentityHistory(
      {},
      64,
      null,
      { limit: 5 },
      {
        live: async () => async () => {
          throw new Error("relation does not exist");
        },
        coldTier: frozenSubnet as never,
      },
    )) as Record<string, unknown>;
    assert.equal(
      (out.entries as Record<string, unknown>[])[0].subnet_name,
      "Frozen Name",
    );
  });

  test("a resolver that throws is a miss", async () => {
    const out = (await answerSubnetIdentityHistory(
      {},
      64,
      null,
      { limit: 5 },
      {
        live: async () => {
          throw new Error("no binding");
        },
        coldTier: frozenSubnet as never,
      },
    )) as Record<string, unknown>;
    assert.equal(
      (out.entries as Record<string, unknown>[])[0].subnet_name,
      "Frozen Name",
    );
  });

  test("no store at all falls through", async () => {
    const out = (await answerSubnetIdentityHistory(
      {},
      64,
      null,
      { limit: 5 },
      { live: async () => null, coldTier: frozenSubnet as never },
    )) as Record<string, unknown>;
    assert.equal(
      (out.entries as Record<string, unknown>[])[0].subnet_name,
      "Frozen Name",
    );
  });

  test("a caller-supplied tier wins and skips the live read", async () => {
    let liveCalls = 0;
    const out = (await answerSubnetIdentityHistory(
      {},
      64,
      { entries: [{ subnet_name: "Tier Name" }] },
      { limit: 5 },
      {
        live: async () => {
          liveCalls += 1;
          return null;
        },
        coldTier: frozenSubnet as never,
      },
    )) as Record<string, unknown>;
    assert.equal(
      (out.entries as Record<string, unknown>[])[0].subnet_name,
      "Tier Name",
    );
    assert.equal(liveCalls, 0);
  });

  test("everything declining still yields the schema-stable empty timeline", async () => {
    const out = (await answerSubnetIdentityHistory(
      {},
      64,
      null,
      { limit: 5 },
      { live: async () => null, coldTier: (async () => null) as never },
    )) as Record<string, unknown>;
    assert.equal(out.entry_count, 0);
    assert.deepEqual(out.entries, []);
  });
});

// ---- the DEFAULT resolver, not an injected one ----
//
// Every test above injects `live`, which is what makes the cascade testable --
// and would also let the real `liveStore` be wrong without anything noticing.
// These two drive the default path.
describe("liveStore, the resolver the surfaces actually get", () => {
  test("an env with no store resolves to null and falls through", async () => {
    const out = (await answerChainIdentityHistory(
      {},
      null,
      { limit: 5 },
      { coldTier: frozenChain as never },
    )) as Record<string, unknown>;
    assert.equal(
      (out.changes as Record<string, unknown>[])[0].subnet_name,
      "Frozen Name",
      "no binding must reach the frozen export, not throw",
    );
  });

  test("an env that DOES declare the table resolves a runner and reads it", async () => {
    // readStore is all-or-nothing on the declared set, so this is also the
    // assertion that SUBNET_IDENTITY_HISTORY_TABLES names what the SQL reads:
    // an env declaring only this table must still resolve a store.
    const { pgMockEnv } = await import("./helpers/pg-mock.ts");
    let frozenCalls = 0;
    await answerChainIdentityHistory(
      pgMockEnv(["subnet_identity_history"]),
      null,
      { limit: 5 },
      {
        coldTier: (async () => {
          frozenCalls += 1;
          return frozenChain();
        }) as never,
      },
    );
    // The mock connection cannot actually answer, so the read misses and the
    // frozen leg runs -- which is the point: the resolver produced a runner
    // rather than declining before the query, and a failed query is a MISS.
    assert.equal(frozenCalls, 1);
  });
});
