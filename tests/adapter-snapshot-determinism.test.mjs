import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  stripObservationTimestamps,
  committedSnapshotIsCurrent,
} from "../scripts/snapshot-adapters.ts";

// A snapshot shaped like the committed registry/adapters/latest/*.json files:
// a top-level generated_at plus per-dimension and per-schema captured_at, with
// a carried-forward metadata_as_of.
function sampleSnapshot(stamp, { repoCount = 2 } = {}) {
  return {
    slug: "sn-22",
    netuid: 22,
    generated_at: stamp,
    status: "ok",
    dimensions: {
      openapi_schemas: {
        captured_at: stamp,
        schemas: Array.from({ length: repoCount }, (_, i) => ({
          path: `/openapi-${i}.json`,
          captured_at: stamp,
        })),
      },
      repository_metadata: {
        captured_at: stamp,
        repositories: [{ full_name: "org/repo", metadata_as_of: stamp }],
      },
    },
  };
}

describe("snapshot-adapters — observation-timestamp determinism", () => {
  test("stripObservationTimestamps nulls every timestamp at any depth", () => {
    const stripped = stripObservationTimestamps(
      sampleSnapshot("2026-06-14T00:00:00.000Z"),
    );
    assert.equal(stripped.generated_at, null);
    assert.equal(stripped.dimensions.openapi_schemas.captured_at, null);
    assert.equal(
      stripped.dimensions.openapi_schemas.schemas[0].captured_at,
      null,
    );
    assert.equal(
      stripped.dimensions.openapi_schemas.schemas[1].captured_at,
      null,
    );
    assert.equal(stripped.dimensions.repository_metadata.captured_at, null);
    assert.equal(
      stripped.dimensions.repository_metadata.repositories[0].metadata_as_of,
      null,
    );
    // Non-timestamp substance is preserved.
    assert.equal(stripped.slug, "sn-22");
    assert.equal(
      stripped.dimensions.openapi_schemas.schemas[0].path,
      "/openapi-0.json",
    );
  });

  test("does not mutate its input", () => {
    const input = sampleSnapshot("2026-06-14T00:00:00.000Z");
    stripObservationTimestamps(input);
    assert.equal(input.generated_at, "2026-06-14T00:00:00.000Z");
    assert.equal(
      input.dimensions.openapi_schemas.captured_at,
      "2026-06-14T00:00:00.000Z",
    );
  });

  test("committedSnapshotIsCurrent: true when only timestamps differ", () => {
    const committed = sampleSnapshot("2026-06-14T09:03:05.163Z");
    // A fresh re-snapshot of unchanged data: every timestamp re-stamped, even
    // the 1970 epoch placeholder a local run would produce.
    const fresh = sampleSnapshot("1970-01-01T00:00:00.000Z");
    assert.equal(committedSnapshotIsCurrent(committed, fresh), true);
  });

  test("committedSnapshotIsCurrent: false when substance changes", () => {
    const committed = sampleSnapshot("2026-06-14T09:03:05.163Z", {
      repoCount: 2,
    });
    const fresh = sampleSnapshot("2026-06-14T09:03:05.163Z", { repoCount: 3 });
    assert.equal(committedSnapshotIsCurrent(committed, fresh), false);
  });

  test("committedSnapshotIsCurrent: false when a non-timestamp field changes", () => {
    const committed = sampleSnapshot("2026-06-14T09:03:05.163Z");
    const fresh = sampleSnapshot("2026-06-14T09:03:05.163Z");
    fresh.status = "degraded";
    assert.equal(committedSnapshotIsCurrent(committed, fresh), false);
  });
});
