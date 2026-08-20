import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";

describe("the OpenAPI snapshot entry point runs after every declaration", () => {
  // Snapshot work executes at module scope. A declaration below that invocation
  // is still in its temporal dead zone when a captured document reaches it,
  // which stopped the production publish before it could stage a new pointer.
  const source = readFileSync("scripts/snapshot-openapi.ts", "utf8");

  test("the invocation is below every top-level const, let, and class", () => {
    const call = source.lastIndexOf("await runSchemaSnapshot();");
    assert.notEqual(call, -1, "the entry-point call was not found -- renamed?");

    const declarations = [...source.matchAll(/^(?:const|let|class) \w+/gm)];
    assert.ok(
      declarations.some((declaration) =>
        declaration[0].includes("MUTATION_OPERATION_METHODS"),
      ),
      "the scan did not find MUTATION_OPERATION_METHODS among top-level declarations",
    );
    const last = declarations[declarations.length - 1];
    assert.ok(last, "expected at least one top-level declaration");
    assert.ok(
      call > last.index!,
      `\`await runSchemaSnapshot()\` is at ${call} but ${last[0]} is at ${last.index}. ` +
        "Everything below the call is in its temporal dead zone when it runs.",
    );
  });
});
