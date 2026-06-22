import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { diffSubnets } from "../scripts/changelog.mjs";

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
