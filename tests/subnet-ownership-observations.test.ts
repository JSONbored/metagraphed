// The SECOND source behind /subnets/{netuid}/ownership-history (#9312), and
// why the route needed one.
//
// Measured 2026-08-03: the whole 895M-row chain.chain_events table holds
// exactly ONE SubnetOwnerChanged event (netuid 18, block 8,724,813), while the
// poller's owner-observation ledger recorded three subnets changing coldkey
// across consecutive captures. Serving the event stream alone therefore
// publishes an empty history for transfers that provably happened -- and does
// it with the same words a subnet that never changed hands gets.
//
// Every record is labelled, because the two sources mean different things: an
// event record's observed_at is when the chain announced the transfer and
// carries the block that did it, while an observation record's is when the
// poller NOTICED -- an upper bound, with no block behind it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetOwnershipHistory,
  OWNERSHIP_CHANGE_EVENT_METHOD,
  OWNERSHIP_SOURCE_EVENT,
  OWNERSHIP_SOURCE_OBSERVATION,
} from "../src/subnet-ownership-history.ts";
import type { Row } from "./row-type.ts";

/** The same real-shaped AccountId32 fixture bytes the sibling tests use, and
 * the addresses the shared decoder produces from them. */
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
const OLD_COLDKEY_SS58 = "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i";
const NEW_COLDKEY_SS58 = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

/** Two real owners of netuid 18, from the ledger. */
const OWNER_A = "5DHwWLjtpwnZQUQKKXE2N5Gdy2N8PpqhgjLUuzgSB7yuGZkF";
const OWNER_B = "5GgvCi6h7dNsC489T8UnUMv912SoEXpEUDVt71VJU1Td7WKh";

function event(netuid: unknown, overrides: Row = {}): Row {
  return {
    pallet: "SubtensorModule",
    method: OWNERSHIP_CHANGE_EVENT_METHOD,
    block_number: "8587754",
    observed_at: "1783600000000",
    args: {
      netuid,
      old_coldkey: OLD_COLDKEY_BYTES,
      new_coldkey: NEW_COLDKEY_BYTES,
    },
    ...overrides,
  };
}

function capture(owner: string | null, at: number): Row {
  return { owner_coldkey: owner, captured_at: at };
}

function changes(data: Row): Row[] {
  return data.ownership_changes as Row[];
}

describe("owner observations as a second ownership source", () => {
  test("two consecutive captures with different owners are a transfer", () => {
    const data = buildSubnetOwnershipHistory([], 86, {
      filterByNetuid: true,
      observations: [
        capture(OWNER_A, 1_784_537_200_378),
        capture(OWNER_B, 1_784_915_720_256),
      ],
    });
    assert.equal(data.count, 1);
    const change = changes(data)[0]!;
    assert.equal(change.old_coldkey, OWNER_A);
    assert.equal(change.new_coldkey, OWNER_B);
    assert.equal(change.netuid, 86);
    assert.equal(change.source, OWNERSHIP_SOURCE_OBSERVATION);
    assert.equal(change.block_number, null, "observed, never announced");
    assert.equal(
      change.observed_at,
      new Date(1_784_915_720_256).toISOString(),
      "when it was noticed, not when it happened",
    );
  });

  // 128 subnets hold exactly one ledger row. It records when tracking began,
  // not a change of hands -- publishing those would invent 128 flips.
  test("a first-ever observation is not a transfer, but is still coverage", () => {
    const data = buildSubnetOwnershipHistory([], 4, {
      filterByNetuid: true,
      observations: [capture(OWNER_A, 1_784_537_200_378)],
    });
    assert.equal(data.count, 0);
    assert.deepEqual(data.ownership_changes, []);
    assert.equal(
      data.observed_through,
      new Date(1_784_537_200_378).toISOString(),
      "watched-and-unchanged must not read like never-watched",
    );
  });

  test("an unchanged owner across captures is not a transfer", () => {
    const data = buildSubnetOwnershipHistory([], 27, {
      filterByNetuid: true,
      observations: [
        capture(OWNER_A, 1_784_537_200_378),
        capture(OWNER_A, 1_784_726_119_143),
      ],
    });
    assert.equal(data.count, 0);
  });

  // Netuid 18 is the one subnet BOTH sources describe, and they agree exactly
  // (the decoded event's old/new coldkeys equal the ledger's consecutive
  // owners). Publishing both would read as two flips of the same subnet.
  test("a transfer both sources saw is published once, from the chain event", () => {
    const data = buildSubnetOwnershipHistory([event(18)], 18, {
      filterByNetuid: true,
      observations: [
        capture(OLD_COLDKEY_SS58, 1_784_537_200_378),
        capture(NEW_COLDKEY_SS58, 1_785_294_351_987),
      ],
    });
    assert.equal(data.count, 1);
    assert.equal(changes(data)[0]!.source, OWNERSHIP_SOURCE_EVENT);
    assert.equal(changes(data)[0]!.block_number, 8_587_754);
  });

  test("a DIFFERENT transfer of the same subnet is not deduped away", () => {
    const data = buildSubnetOwnershipHistory([event(18)], 18, {
      filterByNetuid: true,
      observations: [
        capture(NEW_COLDKEY_SS58, 1_785_294_351_987),
        capture(OWNER_B, 1_785_500_000_000),
      ],
    });
    assert.equal(data.count, 2);
    assert.deepEqual(
      changes(data).map((c) => c.source),
      [OWNERSHIP_SOURCE_EVENT, OWNERSHIP_SOURCE_OBSERVATION],
    );
  });

  test("records from both sources are ordered oldest first", () => {
    const data = buildSubnetOwnershipHistory([event(9)], 9, {
      filterByNetuid: true,
      observations: [
        capture(OWNER_A, 1_790_000_000_000),
        capture(OWNER_B, 1_795_000_000_000),
      ],
    });
    assert.deepEqual(
      changes(data).map((c) => c.source),
      [OWNERSHIP_SOURCE_EVENT, OWNERSHIP_SOURCE_OBSERVATION],
    );
  });

  test("an unstamped record sorts last rather than claiming to be oldest", () => {
    const data = buildSubnetOwnershipHistory(
      [event(9, { observed_at: null })],
      9,
      {
        filterByNetuid: true,
        observations: [
          capture(OWNER_A, 1_790_000_000_000),
          capture(OWNER_B, 1_795_000_000_000),
        ],
      },
    );
    assert.deepEqual(
      changes(data).map((c) => c.source),
      [OWNERSHIP_SOURCE_OBSERVATION, OWNERSHIP_SOURCE_EVENT],
    );
  });

  test("an unusable capture is skipped without breaking the run of owners", () => {
    const data = buildSubnetOwnershipHistory([], 5, {
      filterByNetuid: true,
      observations: [
        capture(OWNER_A, 1_000),
        capture(null, 2_000),
        capture("", 3_000),
        capture(OWNER_B, 4_000),
      ],
    });
    assert.equal(data.count, 1);
    assert.equal(changes(data)[0]!.old_coldkey, OWNER_A);
    assert.equal(changes(data)[0]!.new_coldkey, OWNER_B);
  });

  test("an unreadable capture time leaves observed_through null, not epoch zero", () => {
    const data = buildSubnetOwnershipHistory([], 5, {
      filterByNetuid: true,
      observations: [
        { owner_coldkey: OWNER_A, captured_at: 0 },
        { owner_coldkey: OWNER_A, captured_at: "later" },
      ],
    });
    assert.equal(data.observed_through, null);
  });

  // The ledger is read ORDER BY captured_at ASC, so this cannot happen from
  // the reader -- but observed_through is a max, not a last, and must stay one
  // if a caller ever hands the builder rows in another order.
  test("observed_through is the newest capture, not the last row", () => {
    const data = buildSubnetOwnershipHistory([], 5, {
      filterByNetuid: true,
      observations: [
        capture(OWNER_A, 1_795_000_000_000),
        capture(OWNER_B, 1_790_000_000_000),
      ],
    });
    assert.equal(
      data.observed_through,
      new Date(1_795_000_000_000).toISOString(),
    );
  });

  test("absent event rows are the same answer as an empty array", () => {
    const data = buildSubnetOwnershipHistory(null, 5, {
      filterByNetuid: true,
      observations: [capture(OWNER_A, 1), capture(OWNER_B, 2)],
    });
    assert.equal(data.count, 1);
    assert.equal(buildSubnetOwnershipHistory(undefined, 5).count, 0);
  });

  test("an empty ledger slice is coverage the payload declares as none", () => {
    const data = buildSubnetOwnershipHistory([], 5, {
      filterByNetuid: true,
      observations: [],
    });
    assert.equal(data.count, 0);
    assert.equal(data.observed_through, null);
  });

  // Without the option the payload is byte-identical to what it always was --
  // the DATA_API tier does not read the ledger and must not appear to.
  test("no observations option means no observed_through field at all", () => {
    const data = buildSubnetOwnershipHistory([], 5);
    assert.ok(!("observed_through" in data));
  });

  test("every event record is labelled as a chain event", () => {
    const data = buildSubnetOwnershipHistory([event(7)], 7, {
      filterByNetuid: true,
    });
    assert.equal(changes(data)[0]!.source, OWNERSHIP_SOURCE_EVENT);
    assert.equal(OWNERSHIP_SOURCE_EVENT, "chain-event");
    assert.equal(OWNERSHIP_SOURCE_OBSERVATION, "owner-observation");
  });
});
