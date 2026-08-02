// Same properties as the sibling cold tiers: no silent widening, parity via
// the shared formatters, data-api's exact cursor token and order — the
// hyperparams-specific piece is the derived column lists, which must carry
// the full insert set rather than a hand-restated subset.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadSubnetHyperparamsColdTier,
  loadSubnetHyperparamsHistoryColdTier,
} from "../src/subnet-hyperparams-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };

function latestRow() {
  return {
    kappa_ratio: 0.5,
    immunity_period: 5000,
    tempo: 360,
    registration_allowed: true,
    min_burn_tao: 0.5,
    block_number: 8_700_000,
    captured_at: 1_700_000_000_000,
  };
}

function historyRow(id: number, observedAt = 1_700_000_000_000 + id) {
  return {
    id,
    block_number: 8_600_000 + id,
    observed_at: observedAt,
    tempo: 360,
    hyperparams_hash: `hash-${id}`,
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

describe("loadSubnetHyperparamsColdTier", () => {
  test("reads the full derived column set for one netuid", async () => {
    const q = sqlFetch([latestRow()]);
    const data = await loadSubnetHyperparamsColdTier(TOKEN as never, 12);
    assert.match(
      q[0]!,
      /FROM chain\.subnet_hyperparams WHERE netuid = 12 LIMIT 1/,
    );
    // Spot-check both ends of the derived list: a hand-restated subset would
    // typically lose the tail.
    assert.match(q[0]!, /kappa_ratio/);
    assert.match(q[0]!, /min_childkey_take_ratio/);
    assert.match(q[0]!, /captured_at/);
    assert.ok(
      !/SELECT netuid/.test(q[0]!),
      "netuid is WHERE-known, not selected",
    );
    const params = data!.hyperparameters as Record<string, unknown>;
    assert.equal(params.tempo, 360);
    assert.equal(data!.netuid, 12);
  });

  test("a confirmed absence is an answer, not a decline", async () => {
    sqlFetch([]);
    const data = await loadSubnetHyperparamsColdTier(TOKEN as never, "7");
    assert.ok(
      data,
      "empty result is the Postgres tier's own null-hyperparams payload",
    );
    assert.equal(data!.hyperparameters, null);
  });

  test("declines an unusable netuid without issuing a query", async () => {
    const q = sqlFetch([latestRow()]);
    assert.equal(
      await loadSubnetHyperparamsColdTier(TOKEN as never, "12; DROP"),
      null,
    );
    assert.equal(q.length, 0);
  });

  test("a failed query yields null", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(await loadSubnetHyperparamsColdTier(TOKEN as never, 1), null);
  });
});

describe("loadSubnetHyperparamsHistoryColdTier", () => {
  test("reads one subnet's timeline in data-api's exact order", async () => {
    const q = sqlFetch([historyRow(9), historyRow(8)]);
    const data = await loadSubnetHyperparamsHistoryColdTier(TOKEN as never, 3, {
      limit: 5,
    });
    assert.match(
      q[0]!,
      /FROM chain\.subnet_hyperparams_history WHERE netuid = 3/,
    );
    assert.match(q[0]!, /ORDER BY observed_at DESC, id DESC LIMIT 5/);
    assert.match(q[0]!, /hyperparams_hash/);
    assert.equal((data!.entries as unknown[]).length, 2);
    assert.equal(data!.next_cursor, null, "a short page carries no cursor");
  });

  test("a cursor page seeks data-api's 2-part tuple and ignores offset", async () => {
    const q = sqlFetch([historyRow(9), historyRow(8)]);
    const data = await loadSubnetHyperparamsHistoryColdTier(TOKEN as never, 3, {
      limit: 2,
      offset: 7,
      cursor: "1700000000010.10",
    });
    assert.match(q[0]!, /\(observed_at, id\) < \(1700000000010, 10\)/);
    assert.match(q[0]!, /LIMIT 2/, "no over-fetch on a cursor page");
    // A full page emits the SAME token data-api would for its last row.
    assert.equal(data!.next_cursor, "1700000000008.8");
  });

  test("a malformed cursor means page 1 — data-api's exact behavior", async () => {
    const q = sqlFetch([historyRow(9)]);
    const data = await loadSubnetHyperparamsHistoryColdTier(TOKEN as never, 3, {
      limit: 5,
      cursor: "junk",
    });
    assert.ok(data, "page 1, not a decline");
    assert.ok(!/junk/.test(q[0]!));
  });

  test("offset is emulated by over-fetch and slice, and refused when deep", async () => {
    const q = sqlFetch([historyRow(9), historyRow(8), historyRow(7)]);
    const data = await loadSubnetHyperparamsHistoryColdTier(TOKEN as never, 3, {
      limit: 1,
      offset: 2,
    });
    assert.match(q[0]!, /LIMIT 3/);
    assert.equal(
      (data!.entries as Record<string, unknown>[])[0]!.hyperparams_hash,
      "hash-7",
    );

    const q2 = sqlFetch([]);
    assert.equal(
      await loadSubnetHyperparamsHistoryColdTier(TOKEN as never, 3, {
        limit: 5,
        offset: 100_000,
      }),
      null,
    );
    assert.equal(q2.length, 0);
  });

  test("declines any unusable paging or netuid value rather than dropping it", async () => {
    for (const [netuid, page] of [
      ["3; DROP", { limit: 5 }],
      [3, { limit: "abc" }],
      [3, { limit: 5, offset: -1 }],
      [3, { limit: 0 }],
    ] as [unknown, Record<string, unknown>][]) {
      const q = sqlFetch([historyRow(1)]);
      assert.equal(
        await loadSubnetHyperparamsHistoryColdTier(
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
    sqlFetch([{ ...historyRow(3), observed_at: "bad" }]);
    const odd = await loadSubnetHyperparamsHistoryColdTier(TOKEN as never, 3, {
      limit: 1,
    });
    assert.equal(odd!.next_cursor, null);

    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadSubnetHyperparamsHistoryColdTier(TOKEN as never, 3, {
        limit: 5,
      }),
      null,
    );
  });
});
