// Regression coverage for #5552: scripts/validate.mjs hand-rolls a
// `verificationClassifications` allow-list that must stay in lock-step with
// schemas/components/01-enums.schema.json's `Classification` enum (the schema
// that backs the required `classification` property of every surface's and
// candidate's `verification`). The hand-rolled set had drifted — it was
// missing "unknown" — so a schema-legal `classification: "unknown"` would be
// hard-rejected by `npm run validate` as an "invalid classification".
//
// validate.mjs is a top-level script (it runs and process.exit()s on import,
// and in isolation fails on unrelated stale generated-artifact checks), so it
// cannot be imported or run in a unit test to exercise the set directly.
// Instead this asserts source-level parity: the set literal in validate.mjs
// must equal the schema enum exactly, which both proves "unknown" is now
// accepted and guards against either list silently re-diverging in future.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { repoRoot } from "../scripts/lib.ts";

function classificationEnumFromSchema() {
  const schema = JSON.parse(
    readFileSync(
      path.join(repoRoot, "schemas/components/01-enums.schema.json"),
      "utf8",
    ),
  );
  const enumValues = schema.components?.schemas?.Classification?.enum;
  assert.ok(
    Array.isArray(enumValues) && enumValues.length > 0,
    "schema must declare a Classification enum",
  );
  return enumValues;
}

function verificationClassificationsFromValidate() {
  const source = readFileSync(
    path.join(repoRoot, "scripts/validate.mjs"),
    "utf8",
  );
  const match = source.match(
    /const verificationClassifications = new Set\(\[([\s\S]*?)\]\)/,
  );
  assert.ok(
    match,
    "validate.mjs must define verificationClassifications as a Set literal",
  );
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("validate.mjs classification allow-list parity (#5552)", () => {
  test("verificationClassifications matches the schema Classification enum exactly", () => {
    const schemaEnum = classificationEnumFromSchema();
    const validateSet = verificationClassificationsFromValidate();

    // "unknown" is a real classification produced elsewhere in the codebase;
    // it must be present so a schema-legal verification result passes validate.
    assert.ok(
      validateSet.includes("unknown"),
      'verificationClassifications must include "unknown"',
    );

    assert.deepEqual(
      [...validateSet].sort(),
      [...schemaEnum].sort(),
      "validate.mjs verificationClassifications must equal the schema Classification enum",
    );
  });
});
