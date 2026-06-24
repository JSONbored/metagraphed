import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { applyQueryFilters } from "../workers/list-query.mjs";

function query(path) {
  return new URL(`https://api.metagraph.sh${path}`);
}

describe("list-query field projection", () => {
  test("rejects malformed field lists", () => {
    const result = applyQueryFilters(
      { subnets: [{ netuid: 7, name: "Allways", slug: "allways" }] },
      query("/api/v1/subnets?fields=netuid,,name"),
      "subnets",
    );

    assert.equal(result.error.parameter, "fields");
    assert.match(result.error.message, /comma-separated/);
  });

  test("deduplicates projected fields and leaves malformed rows untouched", () => {
    const result = applyQueryFilters(
      {
        subnets: [
          null,
          ["malformed"],
          { netuid: 7, name: "Allways", slug: "allways" },
        ],
      },
      query("/api/v1/subnets?fields=netuid,netuid,slug"),
      "subnets",
    );

    assert.deepEqual(result.meta.projection.fields, ["netuid", "slug"]);
    assert.deepEqual(result.data.subnets, [
      null,
      ["malformed"],
      { netuid: 7, slug: "allways" },
    ]);
  });

  test("accepts a field that only appears on a later, heterogeneous row (union semantics)", () => {
    // `description` is absent from row 0 but present on row 1 — the lazy
    // known-field scan must still consider it valid (a field is known if it
    // appears on ANY row), not just the first.
    const result = applyQueryFilters(
      {
        subnets: [
          { netuid: 7, name: "Allways" },
          { netuid: 8, name: "Beta", description: "second-row-only" },
        ],
      },
      query("/api/v1/subnets?fields=netuid,description"),
      "subnets",
    );

    assert.equal(result.error, undefined);
    assert.deepEqual(result.meta.projection.fields, ["netuid", "description"]);
    assert.deepEqual(result.data.subnets, [
      { netuid: 7 },
      { netuid: 8, description: "second-row-only" },
    ]);
  });

  test("reports every unsupported field, in requested order", () => {
    const result = applyQueryFilters(
      { subnets: [{ netuid: 7, name: "Allways" }] },
      query("/api/v1/subnets?fields=zeta,netuid,alpha"),
      "subnets",
    );

    assert.equal(result.error.parameter, "fields");
    assert.match(
      result.error.message,
      /unsupported fields for subnets: zeta, alpha\./,
    );
  });
});

describe("list-query pagination order", () => {
  const data = {
    subnets: [{ netuid: 3 }, { netuid: 1 }, { netuid: 2 }],
  };

  test("order=desc without a sort key reports asc (rows are unsorted)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?order=desc"),
      "subnets",
    );
    // sortRows did not run (no sort key) → rows stay in source order …
    assert.deepEqual(
      result.data.subnets.map((r) => r.netuid),
      [3, 1, 2],
    );
    // … so meta must not claim a descending order that wasn't applied.
    assert.equal(result.meta.pagination.sort, null);
    assert.equal(result.meta.pagination.order, "asc");
  });

  test("order=desc with a sort key reports desc and sorts", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=netuid&order=desc"),
      "subnets",
    );
    assert.deepEqual(
      result.data.subnets.map((r) => r.netuid),
      [3, 2, 1],
    );
    assert.equal(result.meta.pagination.sort, "netuid");
    assert.equal(result.meta.pagination.order, "desc");
  });
});

describe("list-query numeric range filters", () => {
  const data = {
    subnets: [
      { netuid: 1, surface_count: 2, tempo: 100 },
      { netuid: 2, surface_count: 9, tempo: 360 },
      { netuid: 3, surface_count: 5, tempo: 360 },
      { netuid: 4 }, // surface_count absent
      { netuid: 5, surface_count: "x" }, // non-numeric
    ],
  };
  const netuids = (result) => result.data.subnets.map((r) => r.netuid);

  test("min_<field> keeps rows >= the bound (inclusive)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_surface_count=5"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [2, 3]);
  });

  test("max_<field> keeps rows <= the bound (inclusive)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?max_surface_count=5"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [1, 3]);
  });

  test("min + max combine into an inclusive range, across fields", () => {
    const result = applyQueryFilters(
      data,
      query(
        "/api/v1/subnets?min_surface_count=3&max_surface_count=9&min_tempo=360",
      ),
      "subnets",
    );
    // surface_count in [3,9] → {2,3}; AND tempo >= 360 → both qualify.
    assert.deepEqual(netuids(result), [2, 3]);
  });

  test("a row whose field is absent or non-numeric is excluded once a bound is set", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_surface_count=0"),
      "subnets",
    );
    // netuid 4 (absent) and 5 (non-numeric) drop out even at min 0.
    assert.deepEqual(netuids(result), [1, 2, 3]);
  });

  test("no range param is a no-op (every row passes)", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?sort=netuid"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [1, 2, 3, 4, 5]);
  });

  test("accepts a negative / decimal bound", () => {
    const result = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_surface_count=-1&max_surface_count=4.5"),
      "subnets",
    );
    assert.deepEqual(netuids(result), [1]); // surface_count 2 only
  });

  test("a non-numeric min_/max_ value is a query error", () => {
    const bad = applyQueryFilters(
      data,
      query("/api/v1/subnets?min_surface_count=lots"),
      "subnets",
    );
    assert.equal(bad.error.parameter, "min_surface_count");
    assert.match(bad.error.message, /must be a number/);

    const badMax = applyQueryFilters(
      data,
      query("/api/v1/subnets?max_tempo="),
      "subnets",
    );
    assert.equal(badMax.error.parameter, "max_tempo");
  });
});
