// The ownership cold tier's specific properties: it reads the SAME
// SubnetOwnerChanged stream data-api reads (chain_events, not the
// subnet_ownership snapshot tables), the address never reaches the SQL
// (buildAccountEntities filters after decoding, both tiers alike), and a
// lakehouse args cell stored as a JSON string is restored to the parsed
// shape postgres.js would have delivered — or the read declines.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadAccountEntitiesColdTier } from "../src/subnet-ownership-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };

// Same real-shaped fixture bytes as tests/entity-labels.test.ts.
const OLD_COLDKEY_BYTES = [
  [
    230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117, 251,
    19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175, 143, 88,
  ],
];
const NEW_COLDKEY_BYTES = [
  [
    109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
];
const NEW_COLDKEY_SS58 = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

function ownershipRow(overrides: Record<string, unknown> = {}) {
  return {
    pallet: "SubtensorModule",
    method: "SubnetOwnerChanged",
    block_number: 8_587_754,
    observed_at: 1_783_600_000_000,
    args: {
      netuid: 7,
      old_coldkey: OLD_COLDKEY_BYTES,
      new_coldkey: NEW_COLDKEY_BYTES,
    },
    ...overrides,
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

describe("loadAccountEntitiesColdTier", () => {
  test("reads the SubnetOwnerChanged stream with data-api's exact predicate", async () => {
    const q = sqlFetch([ownershipRow()]);
    const data = await loadAccountEntitiesColdTier(
      TOKEN as never,
      NEW_COLDKEY_SS58,
    );
    assert.match(q[0]!, /FROM chain\.chain_events/);
    assert.match(
      q[0]!,
      /WHERE pallet = 'SubtensorModule' AND method = 'SubnetOwnerChanged'/,
    );
    assert.match(q[0]!, /ORDER BY block_number ASC/);
    assert.ok(
      !q[0]!.includes(NEW_COLDKEY_SS58),
      "the address is a JS-side filter on both tiers, never a SQL literal",
    );
    assert.equal(data!.ownership_tie_count, 1);
    assert.equal(data!.ownership_ties[0]!.role, "gained_ownership");
    assert.equal(data!.ownership_ties[0]!.netuid, 7);
    assert.equal(data!.labels.length, 0, "labels join happens in the handler");
  });

  test("restores a JSON-string args cell to the driver shape before decoding", async () => {
    sqlFetch([
      ownershipRow({
        args: JSON.stringify({
          netuid: 18,
          old_coldkey: NEW_COLDKEY_BYTES,
          new_coldkey: OLD_COLDKEY_BYTES,
        }),
      }),
    ]);
    const data = await loadAccountEntitiesColdTier(
      TOKEN as never,
      NEW_COLDKEY_SS58,
    );
    assert.equal(data!.ownership_tie_count, 1);
    assert.equal(data!.ownership_ties[0]!.role, "lost_ownership");
    assert.equal(data!.ownership_ties[0]!.netuid, 18);
  });

  test("declines when an args cell cannot be restored faithfully", async () => {
    sqlFetch([ownershipRow({ args: "{not json" })]);
    assert.equal(
      await loadAccountEntitiesColdTier(TOKEN as never, NEW_COLDKEY_SS58),
      null,
    );
  });

  test("a failed query yields null; no matches is an empty-ties answer", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadAccountEntitiesColdTier(TOKEN as never, NEW_COLDKEY_SS58),
      null,
    );

    sqlFetch([]);
    const empty = await loadAccountEntitiesColdTier(
      TOKEN as never,
      NEW_COLDKEY_SS58,
    );
    assert.equal(empty!.ownership_tie_count, 0);
  });
});
