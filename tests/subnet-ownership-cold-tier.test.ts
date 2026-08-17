// The ownership cold tier's specific properties: it reads the SAME
// SubnetOwnerChanged stream data-api reads (chain_events, not the
// subnet_ownership snapshot tables), the address never reaches the SQL
// (buildAccountEntities filters after decoding, both tiers alike), and a
// lakehouse args cell stored as a JSON string is restored to the parsed
// shape postgres.js would have delivered — or the read declines.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadAccountEntitiesColdTier,
  loadSubnetOwnershipHistoryColdTier,
} from "../src/subnet-ownership-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import type { Row } from "./row-type.ts";

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
    // A JSON STRING, because that is what `chain_events.args` is in the
    // catalog -- the object form is the driver shape this tier RESTORES it to
    // (see the test below), never what R2 SQL answers. The read validates
    // against the catalog now, so the object form is a row the lakehouse
    // cannot emit.
    args: JSON.stringify({
      netuid: 7,
      old_coldkey: OLD_COLDKEY_BYTES,
      new_coldkey: NEW_COLDKEY_BYTES,
    }),
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

describe("the projection short-circuits the scan (#11421)", () => {
  /**
   * A stored row carries args PARSED -- the lane restores Iceberg's JSON string
   * before writing, so the artifact holds the driver shape `decodeChainEventArgs`
   * needs. A stored row that still held the string would be one this reader
   * silently drops.
   */
  function storedRow() {
    return {
      ...ownershipRow(),
      args: {
        netuid: 7,
        old_coldkey: OLD_COLDKEY_BYTES,
        new_coldkey: NEW_COLDKEY_BYTES,
      },
    };
  }

  /** An archive that answers the ownership key with `body`. */
  function archive(body: unknown) {
    return {
      ...TOKEN,
      METAGRAPH_ARCHIVE: {
        async get() {
          return body === null
            ? null
            : {
                async json() {
                  return body;
                },
              };
        },
      },
    };
  }

  test("an artifact HIT issues no lakehouse query at all", async () => {
    // The whole point. This read is a measured floor -- minimum 10,420ms in
    // r2sql across five distinct subjects against production 2026-08-16 -- so
    // "the artifact answered" has to mean the scan did not run, not that it ran
    // and was discarded.
    const q = sqlFetch([ownershipRow()]);
    const data = (await loadAccountEntitiesColdTier(
      archive({ schema_version: 1, rows: [storedRow()] }) as never,
      NEW_COLDKEY_SS58,
    )) as Row;
    assert.deepEqual(q, [], "no query reached the warehouse");
    assert.ok(data, "and the route was still answered");
  });

  test("an artifact MISS falls through to the scan, unchanged", async () => {
    // What makes this safe to ship before the lane has ever run: the answer is
    // identical either way, because the lane stores exactly what this returns.
    const q = sqlFetch([ownershipRow()]);
    const data = (await loadAccountEntitiesColdTier(
      archive(null) as never,
      NEW_COLDKEY_SS58,
    )) as Row;
    assert.equal(q.length, 1, "the lakehouse answered instead");
    assert.match(q[0]!, /FROM chain\.chain_events/);
    assert.ok(data);
  });

  test("an EMPTY stored stream is served, not treated as a miss", async () => {
    // A chain on which nothing has been traded is the honest state for 127 of
    // 128 subnets. Falling through on it would leave the scan running forever
    // on exactly the networks whose answer is cheapest to state.
    const q = sqlFetch([ownershipRow()]);
    await loadAccountEntitiesColdTier(
      archive({ schema_version: 1, rows: [] }) as never,
      NEW_COLDKEY_SS58,
    );
    assert.deepEqual(q, [], "an empty artifact still short-circuits");
  });
});

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

describe("loadSubnetOwnershipHistoryColdTier", () => {
  // The netuid predicate data-api writes in SQL (chain_events.args is JSONB
  // there) has no lakehouse form -- args is an opaque JSON string in Iceberg.
  // So the whole stream is read and the SHARED formatter narrows it, which is
  // also why no netuid literal may appear in the query.
  test("narrows the shared stream to one subnet, in JS, not in SQL", async () => {
    const q = sqlFetch([
      ownershipRow(),
      ownershipRow({
        block_number: 8_600_000,
        args: JSON.stringify({
          netuid: 18,
          old_coldkey: OLD_COLDKEY_BYTES,
          new_coldkey: NEW_COLDKEY_BYTES,
        }),
      }),
    ]);
    const data = (await loadSubnetOwnershipHistoryColdTier(
      TOKEN as never,
      7,
    )) as Row;
    // Matched by CONTENT, not by index. The two reads are concurrent, and
    // since #11421 the stream read awaits the projection artifact before
    // falling through to SQL -- so which of them reaches the warehouse first is
    // scheduling, not contract, and pinning `q[0]` asserted the scheduling.
    const streamQuery = q.find((sql) => /FROM chain\.chain_events/.test(sql));
    assert.ok(streamQuery, "the stream is still read from chain_events");
    assert.ok(
      !/netuid/.test(streamQuery),
      "the netuid predicate is not expressible against a JSON-string args column",
    );
    assert.equal(data.netuid, 7);
    assert.equal(data.count, 1);
    assert.equal(data.ownership_changes[0].netuid, 7);
    assert.equal(data.event_method, "SubnetOwnerChanged");
  });

  // A subnet that has never changed hands is the common case, so an empty
  // match set is a real answer -- distinct from a decline.
  test("a subnet with no transfers is an empty list, not a decline", async () => {
    sqlFetch([ownershipRow({ args: JSON.stringify({ netuid: 18 }) })]);
    const data = (await loadSubnetOwnershipHistoryColdTier(
      TOKEN as never,
      7,
    )) as Row;
    assert.equal(data.count, 0);
    assert.deepEqual(data.ownership_changes, []);
  });

  test("declines an unusable netuid rather than echoing it back", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      throw new Error("must not be reached");
    }) as unknown as typeof fetch;
    for (const netuid of [null, "seven", -3]) {
      assert.equal(
        await loadSubnetOwnershipHistoryColdTier(TOKEN as never, netuid),
        null,
      );
    }
    assert.equal(called, 0);
  });

  test("a failed query declines, keeping the caller's schema-stable empty", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(
      await loadSubnetOwnershipHistoryColdTier(TOKEN as never, 7),
      null,
    );
  });
});
