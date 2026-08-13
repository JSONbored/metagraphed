// buildSubnetGaps and its expected-kinds vocabulary (#11053).
//
// The vocabulary was declared twice (scripts/lib.ts's inline list and
// build-network-registry's mirror-by-comment); it is EXPECTED_GAP_KINDS now,
// and this exercises the gap computation the measured suites never called
// directly -- which is exactly how the duplicate lived unmeasured.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSubnetGaps, EXPECTED_GAP_KINDS } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

describe("buildSubnetGaps (#11053)", () => {
  test("a kind the subnet publishes is not a gap; every absent expected kind is", () => {
    const gaps = buildSubnetGaps(
      [{ kind: "openapi" }, { kind: "subnet-api" }] as Row[],
      { docs_url: "https://example.com/docs" } as Row,
    );
    const missing = gaps.missing_kinds as string[];
    assert.ok(!missing.includes("openapi"));
    assert.ok(!missing.includes("docs"), "overlay docs_url satisfies docs");
    for (const kind of ["website", "dashboard", "sse", "data-artifact"]) {
      assert.ok(missing.includes(kind), `${kind} must be reported missing`);
    }
    // Every reported gap is a member of the one declared vocabulary.
    for (const kind of missing) {
      assert.ok((EXPECTED_GAP_KINDS as readonly string[]).includes(kind));
    }
  });

  test("a fully-published subnet has no gaps", () => {
    const gaps = buildSubnetGaps(
      (EXPECTED_GAP_KINDS as readonly string[]).map((kind) => ({
        kind,
      })) as Row[],
      null,
    );
    assert.deepEqual(gaps.missing_kinds, []);
  });
});
