import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { classifyContractChanges } from "../scripts/contract-change-summary.ts";

describe("classifyContractChanges", () => {
  test("an enum-only addition is additive, not risky", () => {
    const result = classifyContractChanges(
      { Authority: { type: "string", enum: ["official", "community"] } },
      { Authority: { type: "string", enum: ["official", "community", "dao"] } },
    );
    assert.deepEqual(result.additive, [
      { component: "Authority", reason: "enum_value_added", value: "dao" },
    ]);
    assert.deepEqual(result.risky, []);
    assert.equal(result.classification, "additive");
  });

  test("a component that gains an enum value AND changes structurally stays risky", () => {
    // The enum grew (additive) but the schema also gained `deprecated: true`.
    // The structural change must NOT be swallowed by the enum delta — a reviewer
    // needs to see it flagged as risky.
    const result = classifyContractChanges(
      { Authority: { type: "string", enum: ["official", "community"] } },
      {
        Authority: {
          type: "string",
          enum: ["official", "community", "dao"],
          deprecated: true,
        },
      },
    );
    assert.deepEqual(result.additive, [
      { component: "Authority", reason: "enum_value_added", value: "dao" },
    ]);
    assert.deepEqual(result.risky, [
      { component: "Authority", reason: "schema_changed" },
    ]);
    assert.equal(result.classification, "risky");
    assert.equal(result.counts.risky_changes, 1);
  });

  test("a non-enum structural change with no enum delta is risky", () => {
    const result = classifyContractChanges(
      { Surface: { type: "object", required: ["id"] } },
      { Surface: { type: "object", required: ["id", "url"] } },
    );
    assert.deepEqual(result.risky, [
      { component: "Surface", reason: "schema_changed" },
    ]);
    assert.equal(result.classification, "risky");
  });

  test("a removed enum value is breaking and dominates the classification", () => {
    const result = classifyContractChanges(
      { Authority: { type: "string", enum: ["official", "community"] } },
      { Authority: { type: "string", enum: ["official"] } },
    );
    assert.deepEqual(result.breaking, [
      {
        component: "Authority",
        reason: "enum_value_removed",
        value: "community",
      },
    ]);
    assert.equal(result.classification, "breaking");
  });
});
