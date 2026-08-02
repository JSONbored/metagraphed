// Same properties as the sibling cold tiers: no silent widening, parity via
// the shared formatters, data-api's exact cursor token and orders — including
// the network feed's block_number-leading order, which differs from the
// per-subnet timeline's observed_at-leading one.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadChainIdentityHistoryColdTier,
  loadSubnetIdentityHistoryColdTier,
} from "../src/subnet-identity-cold-tier.ts";
import {
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "../src/chain-identity-history.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };

function identityRow(id: number, netuid = 3) {
  return {
    id,
    netuid,
    block_number: 8_600_000 + id,
    observed_at: 1_700_000_000_000 + id,
    subnet_name: `subnet-${id}`,
    symbol: "SYM",
    description: null,
    github_repo: null,
    subnet_url: null,
    discord: null,
    logo_url: null,
    identity_hash: `hash-${id}`,
  };
}

function sqlFetch(...responses: unknown[][]) {
  const queries: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    const rows = responses[Math.min(call, responses.length - 1)] ?? [];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

describe("loadSubnetIdentityHistoryColdTier", () => {
  test("reads one subnet's timeline in data-api's exact order", async () => {
    const q = sqlFetch([identityRow(9), identityRow(8)]);
    const data = await loadSubnetIdentityHistoryColdTier(TOKEN as never, 3, {
      limit: 5,
    });
    assert.match(q[0]!, /FROM chain\.subnet_identity_history WHERE netuid = 3/);
    assert.match(q[0]!, /ORDER BY observed_at DESC, id DESC LIMIT 5/);
    assert.match(q[0]!, /identity_hash/);
    assert.equal((data!.entries as unknown[]).length, 2);
    assert.equal(data!.next_cursor, null, "a short page carries no cursor");
  });

  test("a cursor page seeks data-api's 2-part tuple and ignores offset", async () => {
    const q = sqlFetch([identityRow(9), identityRow(8)]);
    const data = await loadSubnetIdentityHistoryColdTier(TOKEN as never, 3, {
      limit: 2,
      offset: 7,
      cursor: "1700000000010.10",
    });
    assert.match(q[0]!, /\(observed_at, id\) < \(1700000000010, 10\)/);
    assert.match(q[0]!, /LIMIT 2/, "no over-fetch on a cursor page");
    assert.equal(data!.next_cursor, "1700000000008.8");
  });

  test("a malformed cursor means page 1; offset is emulated and capped", async () => {
    const q = sqlFetch([identityRow(9), identityRow(8), identityRow(7)]);
    const data = await loadSubnetIdentityHistoryColdTier(TOKEN as never, 3, {
      limit: 1,
      offset: 2,
      cursor: "junk",
    });
    assert.ok(!/junk/.test(q[0]!));
    assert.match(q[0]!, /LIMIT 3/);
    assert.equal(
      (data!.entries as Record<string, unknown>[])[0]!.identity_hash,
      "hash-7",
    );

    const q2 = sqlFetch([]);
    assert.equal(
      await loadSubnetIdentityHistoryColdTier(TOKEN as never, 3, {
        limit: 5,
        offset: 100_000,
      }),
      null,
    );
    assert.equal(q2.length, 0);
  });

  test("declines any unusable netuid or paging value rather than dropping it", async () => {
    for (const [netuid, page] of [
      ["3 OR 1=1", { limit: 5 }],
      [3, { limit: "abc" }],
      [3, { limit: 5, offset: -1 }],
      [3, { limit: 0 }],
    ] as [unknown, Record<string, unknown>][]) {
      const q = sqlFetch([identityRow(1)]);
      assert.equal(
        await loadSubnetIdentityHistoryColdTier(
          TOKEN as never,
          netuid,
          page as never,
        ),
        null,
        JSON.stringify({ netuid, page }),
      );
      assert.equal(q.length, 0);
    }
  });

  test("an unusable last row emits no cursor; a failed query yields null", async () => {
    sqlFetch([{ ...identityRow(3), observed_at: "bad" }]);
    const odd = await loadSubnetIdentityHistoryColdTier(TOKEN as never, 3, {
      limit: 1,
    });
    assert.equal(odd!.next_cursor, null);

    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadSubnetIdentityHistoryColdTier(TOKEN as never, 3, { limit: 5 }),
      null,
    );
  });
});

describe("loadChainIdentityHistoryColdTier", () => {
  test("reads the network feed in data-api's block-leading order", async () => {
    const q = sqlFetch([identityRow(9, 4), identityRow(8, 2)]);
    const data = await loadChainIdentityHistoryColdTier(TOKEN as never, {
      limit: 10,
    });
    assert.match(q[0]!, /SELECT netuid, id, /);
    assert.match(q[0]!, /FROM chain\.subnet_identity_history/);
    assert.match(
      q[0]!,
      /ORDER BY block_number DESC, netuid ASC, id DESC LIMIT 10/,
    );
    assert.equal(data!.count, 2);
    assert.equal(data!.subnet_count, 2);
    assert.equal(data!.changes[0]!.netuid, 4);
  });

  test("an absent limit takes the route default, exactly like data-api", async () => {
    const q = sqlFetch([identityRow(1)]);
    const data = await loadChainIdentityHistoryColdTier(TOKEN as never);
    assert.match(
      q[0]!,
      new RegExp(`LIMIT ${CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT}$`),
    );
    assert.equal(data!.count, 1);
  });

  test("declines an unusable or out-of-range limit rather than clamping it", async () => {
    for (const limit of [
      "abc",
      0,
      CHAIN_IDENTITY_HISTORY_LIMIT_MAX + 1,
    ] as unknown[]) {
      const q = sqlFetch([identityRow(1)]);
      assert.equal(
        await loadChainIdentityHistoryColdTier(TOKEN as never, { limit }),
        null,
        String(limit),
      );
      assert.equal(q.length, 0);
    }
  });

  test("a failed query yields null", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadChainIdentityHistoryColdTier(TOKEN as never, { limit: 5 }),
      null,
    );
  });
});
