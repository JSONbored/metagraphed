import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { diffSubnets, subnetsOf } from "../scripts/changelog.ts";

describe("diffSubnets", () => {
  test("classifies added and removed subnets by netuid", () => {
    const previous = [
      { netuid: 1, name: "Apex", slug: "apex" },
      { netuid: 2, name: "Old", slug: "old" },
    ];
    const current = [
      { netuid: 1, name: "Apex", slug: "apex" },
      { netuid: 3, name: "New", slug: "new" },
    ];
    assert.deepEqual(diffSubnets(previous, current), {
      added: [{ netuid: 3, name: "New", slug: "new" }],
      removed: [{ netuid: 2, name: "Old", slug: "old" }],
      renamed: [],
    });
  });

  test("reports a rename (same netuid, changed name) with before/after", () => {
    // slug is unchanged — a rename keys off name, not slug.
    assert.deepEqual(
      diffSubnets(
        [{ netuid: 1, name: "A", slug: "a" }],
        [{ netuid: 1, name: "B", slug: "a" }],
      ),
      {
        added: [],
        removed: [],
        renamed: [{ netuid: 1, before: "A", after: "B" }],
      },
    );
  });

  test("an unchanged subnet is neither added, removed, nor renamed", () => {
    const same = [{ netuid: 5, name: "Stable", slug: "stable" }];
    assert.deepEqual(diffSubnets(same, same), {
      added: [],
      removed: [],
      renamed: [],
    });
  });

  test("empty inputs produce empty buckets", () => {
    assert.deepEqual(diffSubnets([], []), {
      added: [],
      removed: [],
      renamed: [],
    });
  });
});

describe("diffSubnets identifies its own input", () => {
  test("keeps identifiable rows whole, extra fields and all", () => {
    assert.deepEqual(
      diffSubnets([], [{ netuid: 1, name: "Apex", slug: "apex", extra: true }]),
      {
        added: [{ netuid: 1, name: "Apex", slug: "apex" }],
        removed: [],
        renamed: [],
      },
    );
  });

  test("DROPS rows with no netuid, which is what the diff keys on", () => {
    // Two rows missing `netuid` would both key the Map under `undefined`, so
    // the second overwrites the first and one arbitrary subnet stands in for
    // both. Checked, they never reach the Map -- and no cast was needed to
    // write this test, which is the point of narrowing inside diffSubnets
    // rather than at its callers.
    assert.deepEqual(
      diffSubnets(
        [],
        [
          { name: "One", slug: "one" },
          { name: "Two", slug: "two" },
        ],
      ),
      { added: [], removed: [], renamed: [] },
    );
  });

  test("drops a row whose netuid is a STRING, not just a missing one", () => {
    // "7" and 7 are different Map keys, so a stringified netuid would report
    // the same subnet as both added and removed on every publish.
    assert.deepEqual(
      diffSubnets(
        [{ netuid: 7, name: "A", slug: "a" }],
        [{ netuid: "7", name: "A", slug: "a" }],
      ),
      {
        added: [],
        removed: [{ netuid: 7, name: "A", slug: "a" }],
        renamed: [],
      },
    );
  });

  test("drops a row missing name or slug", () => {
    assert.deepEqual(diffSubnets([], [{ netuid: 1, slug: "a" }]), {
      added: [],
      removed: [],
      renamed: [],
    });
    assert.deepEqual(diffSubnets([], [{ netuid: 1, name: "A" }]), {
      added: [],
      removed: [],
      renamed: [],
    });
  });

  test("subnetsOf reads the `subnets` list, or nothing at all", () => {
    assert.deepEqual(subnetsOf({ subnets: [{ netuid: 1 }] }), [{ netuid: 1 }]);
    assert.deepEqual(subnetsOf(null), []);
    assert.deepEqual(subnetsOf(undefined), []);
    // A previous publish whose artifact predates the key, or holds junk there.
    assert.deepEqual(subnetsOf({}), []);
    assert.deepEqual(subnetsOf({ subnets: "not-a-list" }), []);
  });
});
