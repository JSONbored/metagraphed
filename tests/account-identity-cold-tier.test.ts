// Same properties as the sibling cold tiers: no silent widening, parity via
// the shared formatters, data-api's exact cursor token and order — the
// account-specific piece is the SS58 guard on the only caller-controlled
// value that reaches the string-built query.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadAccountIdentityColdTier,
  loadAccountIdentityHistoryColdTier,
} from "../src/account-identity-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };
const ADDR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

function latestRow() {
  return {
    account: ADDR,
    name: "Validator Co",
    url: "https://example.com",
    github: null,
    image: null,
    discord: null,
    description: null,
    additional: null,
    captured_at: 1_700_000_000_000,
  };
}

function historyRow(id: number) {
  return {
    id,
    observed_at: 1_700_000_000_000 + id,
    name: `name-${id}`,
    url: null,
    github: null,
    image: null,
    discord: null,
    description: null,
    additional: null,
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

describe("loadAccountIdentityColdTier", () => {
  test("reads the latest-only row as a validated literal", async () => {
    const q = sqlFetch([latestRow()]);
    const data = await loadAccountIdentityColdTier(TOKEN as never, ADDR);
    assert.match(
      q[0]!,
      new RegExp(`FROM chain\\.account_identity WHERE account = '${ADDR}'`),
    );
    assert.match(
      q[0]!,
      /SELECT account, name, url, github, image, discord, description, additional, captured_at/,
    );
    assert.equal(data!.has_identity, true);
    assert.equal(data!.name, "Validator Co");
  });

  test("a confirmed absence is data-api's own no-identity payload", async () => {
    sqlFetch([]);
    const data = await loadAccountIdentityColdTier(TOKEN as never, ADDR);
    assert.ok(data, "empty result is an answer, not a decline");
    assert.equal(data!.has_identity, false);
  });

  test("declines an unusable address without issuing a query", async () => {
    const q = sqlFetch([latestRow()]);
    assert.equal(
      await loadAccountIdentityColdTier(TOKEN as never, "not-an-address"),
      null,
    );
    assert.equal(q.length, 0);
  });

  test("a failed query yields null", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(await loadAccountIdentityColdTier(TOKEN as never, ADDR), null);
  });
});

describe("loadAccountIdentityHistoryColdTier", () => {
  test("reads one account's timeline in data-api's exact order", async () => {
    const q = sqlFetch([historyRow(9), historyRow(8)]);
    const data = await loadAccountIdentityHistoryColdTier(
      TOKEN as never,
      ADDR,
      {
        limit: 5,
      },
    );
    assert.match(
      q[0]!,
      new RegExp(
        `FROM chain\\.account_identity_history WHERE account = '${ADDR}'`,
      ),
    );
    assert.match(q[0]!, /ORDER BY observed_at DESC, id DESC LIMIT 5/);
    assert.equal(data!.entries.length, 2);
    assert.equal(data!.next_cursor, null, "a short page carries no cursor");
  });

  test("a cursor page seeks data-api's 2-part tuple and ignores offset", async () => {
    const q = sqlFetch([historyRow(9), historyRow(8)]);
    const data = await loadAccountIdentityHistoryColdTier(
      TOKEN as never,
      ADDR,
      {
        limit: 2,
        offset: 7,
        cursor: "1700000000010.10",
      },
    );
    assert.match(q[0]!, /\(observed_at, id\) < \(1700000000010, 10\)/);
    assert.match(q[0]!, /LIMIT 2/, "no over-fetch on a cursor page");
    assert.equal(data!.next_cursor, "1700000000008.8");
  });

  test("a malformed cursor means page 1; offset is emulated and capped", async () => {
    const q = sqlFetch([historyRow(9), historyRow(8), historyRow(7)]);
    const data = await loadAccountIdentityHistoryColdTier(
      TOKEN as never,
      ADDR,
      {
        limit: 1,
        offset: 2,
        cursor: "junk",
      },
    );
    assert.ok(!/junk/.test(q[0]!));
    assert.match(q[0]!, /LIMIT 3/);
    assert.equal(data!.entries[0]!.identity_hash, "hash-7");

    const q2 = sqlFetch([]);
    assert.equal(
      await loadAccountIdentityHistoryColdTier(TOKEN as never, ADDR, {
        limit: 5,
        offset: 100_000,
      }),
      null,
    );
    assert.equal(q2.length, 0);
  });

  test("declines any unusable address or paging value rather than dropping it", async () => {
    for (const [addr, page] of [
      ["not-an-address", { limit: 5 }],
      [ADDR, { limit: "abc" }],
      [ADDR, { limit: 5, offset: -1 }],
      [ADDR, { limit: 0 }],
    ] as [string, Record<string, unknown>][]) {
      const q = sqlFetch([historyRow(1)]);
      assert.equal(
        await loadAccountIdentityHistoryColdTier(
          TOKEN as never,
          addr,
          page as never,
        ),
        null,
        JSON.stringify({ addr, page }),
      );
      assert.equal(q.length, 0);
    }
  });

  test("an unusable last row emits no cursor; a failed query yields null", async () => {
    sqlFetch([{ ...historyRow(3), observed_at: "bad" }]);
    const odd = await loadAccountIdentityHistoryColdTier(TOKEN as never, ADDR, {
      limit: 1,
    });
    assert.equal(odd!.next_cursor, null);

    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadAccountIdentityHistoryColdTier(TOKEN as never, ADDR, {
        limit: 5,
      }),
      null,
    );
  });
});
