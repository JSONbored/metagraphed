import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetOwnershipHistory,
  OWNERSHIP_CHANGE_EVENT_METHOD,
} from "../src/subnet-ownership-history.ts";
import type { Row } from "./row-type.ts";

// Real-shaped 32-byte AccountId32 raw args (double-wrapped array, matching
// indexer-rs's dynamic-value dump for a tuple-struct-with-one-field --
// mirrors tests/chain-event-args.test.ts's own fixture convention).
const OLD_COLDKEY_BYTES = [
  [
    230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117, 251,
    19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175, 143, 88,
  ],
];
// Same fixture bytes/expected SS58 as tests/chain-event-args.test.ts's own
// "Balances.Transfer" `to` field (real block 8587754/119).
const NEW_COLDKEY_BYTES = [
  [
    109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
];
const NEW_COLDKEY_SS58 = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

function row(overrides = {}) {
  return {
    pallet: "SubtensorModule",
    method: OWNERSHIP_CHANGE_EVENT_METHOD,
    block_number: "8587754",
    observed_at: "1783600000000",
    args: {
      netuid: 7,
      old_coldkey: OLD_COLDKEY_BYTES,
      new_coldkey: NEW_COLDKEY_BYTES,
    },
    ...overrides,
  };
}

describe("buildSubnetOwnershipHistory — empty / cold-store input", () => {
  test("empty, null, and undefined rows all yield a schema-stable empty list", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildSubnetOwnershipHistory(rows, 7);
      assert.equal(data.schema_version, 1);
      assert.equal(data.netuid, 7);
      assert.equal(data.count, 0);
      assert.deepEqual(data.ownership_changes, []);
      assert.equal(data.event_pallet, "SubtensorModule");
      assert.equal(data.event_method, "SubnetOwnerChanged");
    }
  });
});

describe("buildSubnetOwnershipHistory — shaping a real row", () => {
  test("decodes old_coldkey/new_coldkey to SS58, not raw hex", () => {
    const data = buildSubnetOwnershipHistory([row()], 7);
    assert.equal(data.count, 1);
    const change = (data.ownership_changes as Row[])[0];
    assert.equal(change.netuid, 7);
    assert.equal(
      change.old_coldkey,
      "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
    );
    assert.equal(change.new_coldkey, NEW_COLDKEY_SS58);
    assert.equal(change.block_number, 8587754);
    assert.equal(change.observed_at, "2026-07-09T12:26:40.000Z");
  });

  test("preserves row order (caller is expected to ORDER BY block_number ASC)", () => {
    const data = buildSubnetOwnershipHistory(
      [
        row({
          block_number: "100",
          args: { netuid: 7, old_coldkey: null, new_coldkey: null },
        }),
        row({
          block_number: "200",
          args: { netuid: 7, old_coldkey: null, new_coldkey: null },
        }),
      ],
      7,
    );
    assert.deepEqual(
      (data.ownership_changes as Row[]).map((c) => c.block_number),
      [100, 200],
    );
  });

  test("a malformed/non-finite block_number or observed_at degrades to null, never NaN or a throw", () => {
    const data = buildSubnetOwnershipHistory(
      [row({ block_number: "not-a-number", observed_at: "also-not-a-number" })],
      7,
    );
    const change = (data.ownership_changes as Row[])[0];
    assert.equal(change.block_number, null);
    assert.equal(change.observed_at, null);
  });

  test("missing old_coldkey/new_coldkey in args degrades to null, not undefined or a throw", () => {
    const data = buildSubnetOwnershipHistory([row({ args: { netuid: 7 } })], 7);
    const change = (data.ownership_changes as Row[])[0];
    assert.equal(change.old_coldkey, null);
    assert.equal(change.new_coldkey, null);
  });
});

// The opt-in for a tier that cannot express the netuid predicate in SQL --
// the lakehouse stores args as an opaque JSON string. Off by default so the
// Postgres tier, which already filtered in SQL, is untouched.
describe("buildSubnetOwnershipHistory — filterByNetuid", () => {
  const mixed = [
    row({ args: { netuid: 7, old_coldkey: null, new_coldkey: null } }),
    row({ args: { netuid: 18, old_coldkey: null, new_coldkey: null } }),
    // The raw args hold netuid as an array on live rows (#8649); the shaped
    // record has already normalized it, so both forms narrow correctly.
    row({ args: { netuid: [7], old_coldkey: null, new_coldkey: null } }),
  ];

  test("off by default: every row survives, as the Postgres tier expects", () => {
    assert.equal(buildSubnetOwnershipHistory(mixed, 7).count, 3);
  });

  test("on: keeps only this subnet's transfers, scalar or array-encoded", () => {
    const data = buildSubnetOwnershipHistory(mixed, 7, {
      filterByNetuid: true,
    });
    assert.equal(data.count, 2);
    assert.deepEqual(
      (data.ownership_changes as Row[]).map((c) => c.netuid),
      [7, 7],
    );
  });

  test("a subnet with no transfers in the stream is an empty list", () => {
    assert.equal(
      buildSubnetOwnershipHistory(mixed, 99, { filterByNetuid: true }).count,
      0,
    );
  });
});
