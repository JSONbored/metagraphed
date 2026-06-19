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
});
