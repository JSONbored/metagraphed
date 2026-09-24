import { nativeOwnershipEnv } from "./helpers/native-ownership-env.ts";
// The ownership-history composer and its ledger reader (#9312).
//
// The reader combines the complete native event projection with the immutable
// observation archive. Both reads must succeed; a half-history must decline.
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

describe("loadSubnetOwnerObservations", () => {
  test("reads one subnet's captures oldest first from the complete archive", async () => {
    const f = nativeOwnershipEnv(
      [],
      [
        { netuid: 18, owner_coldkey: OWNER_B, captured_at: 2 },
        { netuid: 19, owner_coldkey: "other", captured_at: 0 },
        { netuid: 18, owner_coldkey: OWNER_A, captured_at: 1 },
      ],
    );
    assert.deepEqual(await loadSubnetOwnerObservations(f.env, 18), [
      { owner_coldkey: OWNER_A, captured_at: 1 },
      { owner_coldkey: OWNER_B, captured_at: 2 },
    ]);
  });
  test("a subnet the poller never watched is an empty slice, not a decline", async () => {
    assert.deepEqual(
      await loadSubnetOwnerObservations(nativeOwnershipEnv().env, 0),
      [],
    );
  });
  test("an unavailable archive declines", async () => {
    assert.equal(
      await loadSubnetOwnerObservations(nativeOwnershipEnv([], null).env, 18),
      null,
    );
  });
});
describe("answerSubnetOwnershipHistory", () => {
  test("merges both sources into one labelled history", async () => {
    const f = nativeOwnershipEnv(
      [],
      [
        { netuid: 86, owner_coldkey: OWNER_A, captured_at: 1784537200378 },
        { netuid: 86, owner_coldkey: OWNER_B, captured_at: 1784915720256 },
      ],
    );
    const data = (await answerSubnetOwnershipHistory(
      mockEnv(f.env),
      86,
    )) as Row;
    assert.equal(data.netuid, 86);
    assert.equal(data.count, 1);
    assert.equal(data.ownership_changes[0].source, "owner-observation");
    assert.equal(data.observed_through, new Date(1784915720256).toISOString());
  });
  test("declines when either source cannot be read", async () => {
    for (const f of [
      nativeOwnershipEnv([], null),
      nativeOwnershipEnv(null, []),
    ]) {
      assert.equal(
        await answerSubnetOwnershipHistory(mockEnv(f.env), 86),
        null,
      );
      assert.ok(
        f.keys.length >= 2,
        "both source reads are attempted before decline",
      );
    }
  });
  test("an unusable netuid declines before any storage read", async () => {
    const f = nativeOwnershipEnv();
    assert.equal(
      await answerSubnetOwnershipHistory(mockEnv(f.env), "eighteen"),
      null,
    );
    assert.deepEqual(f.keys, []);
  });
  test("the reader remains injectable for surface composers", async () => {
    assert.deepEqual(
      await answerSubnetOwnershipHistory(TOKEN, 7, {
        coldTier: async () => ({ count: 3 }) as never,
      }),
      { count: 3 },
    );
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
