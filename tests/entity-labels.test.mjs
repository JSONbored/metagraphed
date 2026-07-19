import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildAccountEntities,
  entityLabelsIndex,
  labelsForSs58,
} from "../src/entity-labels.mjs";

// Same real-shaped fixture bytes as tests/subnet-ownership-history.test.mjs.
const OLD_COLDKEY_BYTES = [
  [
    230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117, 251,
    19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175, 143, 88,
  ],
];
const OLD_COLDKEY_SS58 = "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i";
const NEW_COLDKEY_BYTES = [
  [
    109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
];
const NEW_COLDKEY_SS58 = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

function ownershipRow(overrides = {}) {
  return {
    pallet: "SubtensorModule",
    method: "SubnetOwnerChanged",
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

function entity(overrides = {}) {
  return {
    schema_version: 1,
    ss58: NEW_COLDKEY_SS58,
    name: "Example Foundation",
    category: "foundation",
    source_urls: ["https://example.org/proof"],
    review: { state: "maintainer-reviewed" },
    ...overrides,
  };
}

describe("entityLabelsIndex / labelsForSs58", () => {
  test("indexes by ss58 and returns an empty array for an unknown address", () => {
    const index = entityLabelsIndex([entity()]);
    assert.deepEqual(labelsForSs58(index, "unknown-address"), []);
  });

  test("returns the public label shape, omitting review internals", () => {
    const index = entityLabelsIndex([entity()]);
    const labels = labelsForSs58(index, NEW_COLDKEY_SS58);
    assert.equal(labels.length, 1);
    assert.deepEqual(labels[0], {
      name: "Example Foundation",
      category: "foundation",
      notes: null,
      source_urls: ["https://example.org/proof"],
    });
    assert.equal("review" in labels[0], false);
  });

  test("null/undefined entities list yields an empty index, never throws", () => {
    for (const entities of [null, undefined, []]) {
      const index = entityLabelsIndex(entities);
      assert.deepEqual(labelsForSs58(index, NEW_COLDKEY_SS58), []);
    }
  });

  test("an entity with missing optional fields degrades to null/empty, not undefined", () => {
    const index = entityLabelsIndex([
      { ss58: NEW_COLDKEY_SS58, name: "Bare", category: "other" },
    ]);
    const labels = labelsForSs58(index, NEW_COLDKEY_SS58);
    assert.equal(labels[0].notes, null);
    assert.deepEqual(labels[0].source_urls, []);
  });

  test("an entity missing even name/category degrades those to null too", () => {
    const index = entityLabelsIndex([{ ss58: NEW_COLDKEY_SS58 }]);
    const labels = labelsForSs58(index, NEW_COLDKEY_SS58);
    assert.equal(labels[0].name, null);
    assert.equal(labels[0].category, null);
  });

  test("a falsy/malformed entry in the entities list is skipped, not thrown on", () => {
    const index = entityLabelsIndex([null, { ss58: "" }, entity()]);
    assert.equal(index.size, 1);
    assert.deepEqual(
      labelsForSs58(index, NEW_COLDKEY_SS58)[0].name,
      entity().name,
    );
  });
});

describe("buildAccountEntities", () => {
  test("returns empty labels/ties for an address with no entity and no ownership rows", () => {
    const data = buildAccountEntities("some-other-address", {
      entities: [],
      ownershipRows: [],
    });
    assert.equal(data.schema_version, 1);
    assert.equal(data.ss58, "some-other-address");
    assert.deepEqual(data.labels, []);
    assert.equal(data.ownership_tie_count, 0);
    assert.deepEqual(data.ownership_ties, []);
  });

  test("gained_ownership when the address is the new_coldkey", () => {
    const data = buildAccountEntities(NEW_COLDKEY_SS58, {
      entities: [],
      ownershipRows: [ownershipRow()],
    });
    assert.equal(data.ownership_tie_count, 1);
    assert.deepEqual(data.ownership_ties[0], {
      netuid: 7,
      role: "gained_ownership",
      block_number: 8587754,
      observed_at: "2026-07-09T12:26:40.000Z",
    });
  });

  test("lost_ownership when the address is the old_coldkey", () => {
    const data = buildAccountEntities(OLD_COLDKEY_SS58, {
      entities: [],
      ownershipRows: [ownershipRow()],
    });
    assert.equal(data.ownership_tie_count, 1);
    assert.equal(data.ownership_ties[0].role, "lost_ownership");
  });

  test("a row involving neither side of the address is excluded", () => {
    const data = buildAccountEntities("unrelated-address", {
      entities: [],
      ownershipRows: [ownershipRow()],
    });
    assert.equal(data.ownership_tie_count, 0);
  });

  test("multiple ties across subnets are sorted newest block_number first", () => {
    const data = buildAccountEntities(NEW_COLDKEY_SS58, {
      entities: [],
      ownershipRows: [
        ownershipRow({
          block_number: "100",
          args: {
            netuid: 1,
            old_coldkey: OLD_COLDKEY_BYTES,
            new_coldkey: NEW_COLDKEY_BYTES,
          },
        }),
        ownershipRow({
          block_number: "300",
          args: {
            netuid: 2,
            old_coldkey: OLD_COLDKEY_BYTES,
            new_coldkey: NEW_COLDKEY_BYTES,
          },
        }),
        ownershipRow({
          block_number: "200",
          args: {
            netuid: 3,
            old_coldkey: OLD_COLDKEY_BYTES,
            new_coldkey: NEW_COLDKEY_BYTES,
          },
        }),
      ],
    });
    assert.deepEqual(
      data.ownership_ties.map((t) => t.netuid),
      [2, 3, 1],
    );
  });

  test("combines labels and ownership ties for the same address", () => {
    const data = buildAccountEntities(NEW_COLDKEY_SS58, {
      entities: [entity()],
      ownershipRows: [ownershipRow()],
    });
    assert.equal(data.labels.length, 1);
    assert.equal(data.labels[0].name, "Example Foundation");
    assert.equal(data.ownership_tie_count, 1);
  });

  test("missing entities/ownershipRows options default to empty, never throws", () => {
    const data = buildAccountEntities(NEW_COLDKEY_SS58, {});
    assert.deepEqual(data.labels, []);
    assert.equal(data.ownership_tie_count, 0);
    const dataNoOptions = buildAccountEntities(NEW_COLDKEY_SS58);
    assert.deepEqual(dataNoOptions.labels, []);
    const dataExplicitNull = buildAccountEntities(NEW_COLDKEY_SS58, {
      entities: null,
      ownershipRows: null,
    });
    assert.deepEqual(dataExplicitNull.labels, []);
    assert.deepEqual(dataExplicitNull.ownership_ties, []);
  });

  test("a malformed/non-positive/out-of-range observed_at degrades to null, not NaN or a throw", () => {
    const data = buildAccountEntities(NEW_COLDKEY_SS58, {
      entities: [],
      ownershipRows: [
        ownershipRow({ observed_at: "not-a-number" }),
        ownershipRow({
          observed_at: "0",
          args: {
            netuid: 2,
            old_coldkey: OLD_COLDKEY_BYTES,
            new_coldkey: NEW_COLDKEY_BYTES,
          },
        }),
        ownershipRow({
          observed_at: "1e20",
          args: {
            netuid: 3,
            old_coldkey: OLD_COLDKEY_BYTES,
            new_coldkey: NEW_COLDKEY_BYTES,
          },
        }),
      ],
    });
    for (const tie of data.ownership_ties) {
      assert.equal(tie.observed_at, null);
    }
  });

  test("a malformed block_number degrades to null and sorts last (no NaN/throw)", () => {
    const data = buildAccountEntities(NEW_COLDKEY_SS58, {
      entities: [],
      ownershipRows: [
        ownershipRow({ block_number: "not-a-number" }),
        ownershipRow({ block_number: "500" }),
      ],
    });
    assert.equal(data.ownership_ties[0].block_number, 500);
    assert.equal(data.ownership_ties[1].block_number, null);
  });

  test("two ties with both block_numbers malformed both degrade to null without throwing", () => {
    const data = buildAccountEntities(NEW_COLDKEY_SS58, {
      entities: [],
      ownershipRows: [
        ownershipRow({ block_number: "also-not-a-number" }),
        ownershipRow({
          block_number: "still-not-a-number",
          args: {
            netuid: 2,
            old_coldkey: OLD_COLDKEY_BYTES,
            new_coldkey: NEW_COLDKEY_BYTES,
          },
        }),
      ],
    });
    assert.equal(data.ownership_ties.length, 2);
    for (const tie of data.ownership_ties) {
      assert.equal(tie.block_number, null);
    }
  });

  test("missing old_coldkey/new_coldkey in a row's args degrades to null, excluding it from any tie", () => {
    const data = buildAccountEntities(NEW_COLDKEY_SS58, {
      entities: [],
      ownershipRows: [ownershipRow({ args: { netuid: 7 } })],
    });
    assert.equal(data.ownership_tie_count, 0);
  });
});
