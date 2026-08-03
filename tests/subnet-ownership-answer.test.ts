// The ownership-history composer and its ledger reader (#9312).
//
// The reader half: `chain.subnet_ownership_history` is read per netuid, in
// SQL, because the ledger DOES carry the netuid as a real column -- unlike the
// event stream beside it, whose args are an opaque JSON string with no netuid
// predicate expressible at all. Both reads must succeed or the whole answer
// declines: half of a two-source history is a wrong answer wearing the shape
// of a complete one.
//
// The composer half: one function REST, MCP and GraphQL all reach, and one
// node builder that fills the contract's fields without projecting away what
// it does not name.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  answerSubnetOwnershipHistory,
  subnetOwnershipHistoryNode,
} from "../src/subnet-ownership-answer.ts";
import { loadSubnetOwnerObservations } from "../src/subnet-ownership-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { mockEnv } from "./row-type.ts";
import type { Row } from "./row-type.ts";

const TOKEN = mockEnv({ [R2_SQL_TOKEN_ENV]: "cfut_test" });
const OWNER_A = "5DHwWLjtpwnZQUQKKXE2N5Gdy2N8PpqhgjLUuzgSB7yuGZkF";
const OWNER_B = "5GgvCi6h7dNsC489T8UnUMv912SoEXpEUDVt71VJU1Td7WKh";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

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

describe("loadSubnetOwnerObservations", () => {
  test("reads one subnet's captures oldest first, narrowed in SQL", async () => {
    const q = sqlFetch([
      { owner_coldkey: OWNER_A, captured_at: 1 },
      { owner_coldkey: OWNER_B, captured_at: 2 },
    ]);
    const rows = await loadSubnetOwnerObservations(TOKEN, 18);
    assert.match(q[0]!, /FROM chain\.subnet_ownership_history/);
    // The ledger carries netuid as a real column, so unlike the event stream
    // beside it the predicate IS expressible here.
    assert.match(q[0]!, /WHERE netuid = 18/);
    assert.match(q[0]!, /ORDER BY captured_at ASC/);
    assert.equal(rows?.length, 2);
  });

  test("a subnet the poller never watched is an empty slice, not a decline", async () => {
    sqlFetch([]);
    assert.deepEqual(await loadSubnetOwnerObservations(TOKEN, 0), []);
  });

  test("a failed query declines", async () => {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(await loadSubnetOwnerObservations(TOKEN, 18), null);
  });
});

describe("answerSubnetOwnershipHistory", () => {
  test("merges both sources into one labelled history", async () => {
    // The event stream first (it is issued first), then the ledger slice.
    sqlFetch(
      [],
      [
        { owner_coldkey: OWNER_A, captured_at: 1_784_537_200_378 },
        { owner_coldkey: OWNER_B, captured_at: 1_784_915_720_256 },
      ],
    );
    const data = (await answerSubnetOwnershipHistory(TOKEN, 86)) as Row;
    assert.equal(data.netuid, 86);
    assert.equal(data.count, 1);
    assert.equal(data.ownership_changes[0].source, "owner-observation");
    assert.equal(
      data.observed_through,
      new Date(1_784_915_720_256).toISOString(),
    );
  });

  // Half a two-source history is a wrong answer wearing the shape of a
  // complete one, so either leg failing declines the whole read.
  test("declines when either source cannot be read", async () => {
    let call = 0;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const query = JSON.parse(String(init.body)).query as string;
      call += 1;
      if (query.includes("subnet_ownership_history")) throw new Error("down");
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows: [] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    assert.equal(await answerSubnetOwnershipHistory(TOKEN, 86), null);
    assert.ok(call >= 2, "both legs are issued before the decline");
  });

  test("an unusable netuid declines before any query is issued", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      throw new Error("must not be reached");
    }) as unknown as typeof fetch;
    assert.equal(await answerSubnetOwnershipHistory(TOKEN, "eighteen"), null);
    assert.equal(called, 0);
  });

  test("the reader is injectable, so a surface test needs no lakehouse", async () => {
    const data = await answerSubnetOwnershipHistory(TOKEN, 7, {
      coldTier: async () => ({ count: 3 }) as never,
    });
    assert.deepEqual(data, { count: 3 });
  });
});

describe("subnetOwnershipHistoryNode", () => {
  test("fills every contract field a thin payload leaves out", () => {
    const node = subnetOwnershipHistoryNode({}, 3);
    assert.deepEqual(node, {
      schema_version: 1,
      netuid: 3,
      event_pallet: null,
      event_method: null,
      count: 0,
      ownership_changes: [],
      observed_through: null,
    });
  });

  test("a null payload is still a complete result", () => {
    assert.equal(subnetOwnershipHistoryNode(null, 3).count, 0);
    assert.equal(subnetOwnershipHistoryNode(undefined, 3).netuid, 3);
  });

  // The projection this replaced listed four fields and dropped the rest, so
  // every field the reader gained reached REST alone.
  test("carries fields the old four-field projection would have dropped", () => {
    const node = subnetOwnershipHistoryNode(
      {
        schema_version: 1,
        netuid: 86,
        event_pallet: "SubtensorModule",
        event_method: "SubnetOwnerChanged",
        count: 1,
        ownership_changes: [{ source: "owner-observation" }],
        observed_through: "2026-08-01T00:00:00.000Z",
      },
      86,
    );
    assert.equal(node.event_pallet, "SubtensorModule");
    assert.equal(node.event_method, "SubnetOwnerChanged");
    assert.equal(node.observed_through, "2026-08-01T00:00:00.000Z");
    assert.equal(
      (node.ownership_changes as Row[])[0]!.source,
      "owner-observation",
    );
  });

  test("a field the contract does not name is forwarded, not projected away", () => {
    const node = subnetOwnershipHistoryNode({ future_field: 7 }, 3);
    assert.equal(node.future_field, 7);
  });

  test("a non-array ownership_changes is normalized rather than passed through", () => {
    assert.deepEqual(
      subnetOwnershipHistoryNode({ ownership_changes: "nope" }, 3)
        .ownership_changes,
      [],
    );
  });

  test("the netuid is the caller's, never the payload's", () => {
    assert.equal(subnetOwnershipHistoryNode({ netuid: 999 }, 3).netuid, 3);
  });
});
