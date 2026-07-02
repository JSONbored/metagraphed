import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { repoRoot } from "../scripts/lib.mjs";

// #1767: the local `npm run check` (scripts/pipeline.mjs checkCommands) had
// silently drifted from CI (.github/workflows/validate.yml) — CI ran
// validate:committed-seed / validate:mcp / validate:ai / validate:surface that
// the local gate never invoked. This meta-test reads BOTH files and asserts the
// pipeline's validator set is a SUPERSET of validate.yml's `npm run validate:*`
// steps, so `npm run check` can never again pass while a CI validator is
// missing locally.

const PIPELINE_PATH = path.join(repoRoot, "scripts/pipeline.mjs");
const WORKFLOW_PATH = path.join(repoRoot, ".github/workflows/validate.yml");

// Every `validate:*` script wired through `step("validate:...")` in pipeline.mjs
// (covers both checkCommands and refreshCommands).
function pipelineValidators() {
  const source = readFileSync(PIPELINE_PATH, "utf8");
  const scripts = new Set();
  for (const match of source.matchAll(/step\("(validate:[^"]+)"/g)) {
    scripts.add(match[1]);
  }
  return scripts;
}

// Every `npm run validate:*` invocation in validate.yml's `run:` blocks.
function workflowValidators() {
  const source = readFileSync(WORKFLOW_PATH, "utf8");
  const scripts = new Set();
  for (const match of source.matchAll(/npm run (validate:[^\s]+)/g)) {
    scripts.add(match[1]);
  }
  return scripts;
}

describe("pipeline ↔ validate.yml validator parity (#1767)", () => {
  test("both sets are non-empty (the parsers actually matched something)", () => {
    assert.ok(
      pipelineValidators().size > 0,
      "no validate:* steps found in pipeline.mjs",
    );
    assert.ok(
      workflowValidators().size > 0,
      "no `npm run validate:*` found in validate.yml",
    );
  });

  test("pipeline's validators are a superset of validate.yml's", () => {
    const pipeline = pipelineValidators();
    const workflow = workflowValidators();
    const missing = [...workflow]
      .filter((script) => !pipeline.has(script))
      .sort();
    assert.deepEqual(
      missing,
      [],
      `validate.yml runs validators the local \`npm run check\` does not: ${missing.join(", ")}. ` +
        "Add them to scripts/pipeline.mjs checkCommands (and refreshCommands).",
    );
  });
});
