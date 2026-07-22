import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetLeaseHistory,
  SUBNET_LEASE_CREATED_KIND,
  SUBNET_LEASE_TERMINATED_KIND,
} from "../src/subnet-lease-history.ts";

const BENEFICIARY_SS58 = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

function row(overrides = {}) {
  return {
    event_kind: SUBNET_LEASE_CREATED_KIND,
    coldkey: BENEFICIARY_SS58,
    block_number: "8587754",
    observed_at: "1783600000000",
    ...overrides,
  };
}

describe("buildSubnetLeaseHistory — empty / cold-store input", () => {
  test("empty, null, and undefined rows all yield a schema-stable empty list", () => {
    for (const rows of [[], null, undefined]) {
      const data = buildSubnetLeaseHistory(rows, 7);
      assert.equal(data.schema_version, 1);
      assert.equal(data.netuid, 7);
      assert.equal(data.count, 0);
      assert.deepEqual(data.lease_events, []);
      assert.equal(data.event_pallet, "SubtensorModule");
      assert.deepEqual(data.event_kinds, [
        "SubnetLeaseCreated",
        "SubnetLeaseTerminated",
      ]);
    }
  });
});

describe("buildSubnetLeaseHistory — shaping real rows", () => {
  test("account_events.coldkey column maps to the lease's beneficiary field", () => {
    const data = buildSubnetLeaseHistory([row()], 7);
    assert.equal(data.count, 1);
    const event = data.lease_events[0];
    assert.equal(event.event_kind, SUBNET_LEASE_CREATED_KIND);
    assert.equal(event.beneficiary, BENEFICIARY_SS58);
    assert.equal(event.block_number, 8587754);
    assert.equal(event.observed_at, "2026-07-09T12:26:40.000Z");
  });

  test("both lifecycle kinds shape identically", () => {
    const data = buildSubnetLeaseHistory(
      [
        row({ event_kind: SUBNET_LEASE_CREATED_KIND, block_number: "100" }),
        row({
          event_kind: SUBNET_LEASE_TERMINATED_KIND,
          block_number: "200",
        }),
      ],
      7,
    );
    assert.deepEqual(
      data.lease_events.map((e) => [e.event_kind, e.block_number]),
      [
        [SUBNET_LEASE_CREATED_KIND, 100],
        [SUBNET_LEASE_TERMINATED_KIND, 200],
      ],
    );
  });

  test("preserves row order (caller is expected to ORDER BY block_number ASC)", () => {
    const data = buildSubnetLeaseHistory(
      [row({ block_number: "100" }), row({ block_number: "200" })],
      7,
    );
    assert.deepEqual(
      data.lease_events.map((e) => e.block_number),
      [100, 200],
    );
  });

  test("a malformed/non-finite block_number or observed_at degrades to null, never NaN or a throw", () => {
    const data = buildSubnetLeaseHistory(
      [row({ block_number: "not-a-number", observed_at: "also-not-a-number" })],
      7,
    );
    const event = data.lease_events[0];
    assert.equal(event.block_number, null);
    assert.equal(event.observed_at, null);
  });

  test("a missing coldkey degrades to null, not undefined", () => {
    const data = buildSubnetLeaseHistory([row({ coldkey: undefined })], 7);
    assert.equal(data.lease_events[0].beneficiary, null);
  });

  test("an observed_at outside Date's representable range degrades to null, not an Invalid Date string", () => {
    const data = buildSubnetLeaseHistory([row({ observed_at: "1e20" })], 7);
    assert.equal(data.lease_events[0].observed_at, null);
  });
});
