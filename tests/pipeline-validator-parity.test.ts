import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { repoRoot } from "../scripts/lib.ts";

// #1767: the local `npm run check` (scripts/pipeline.ts checkCommands) had
// silently drifted from CI (.github/workflows/validate.yml) — CI ran
// validate:committed-seed / validate:mcp / validate:ai / validate:surface that
// the local gate never invoked. This meta-test reads BOTH files and asserts the
// pipeline's validator set is a SUPERSET of validate.yml's `npm run validate:*`
// steps, so `npm run check` can never again pass while a CI validator is
// missing locally.

const PIPELINE_PATH = path.join(repoRoot, "scripts/pipeline.ts");
const WORKFLOW_PATH = path.join(repoRoot, ".github/workflows/validate.yml");
const WORKFLOW_DIR = path.join(repoRoot, ".github/workflows");
const PACKAGE_PATH = path.join(repoRoot, "package.json");

/**
 * Validators that run somewhere other than a workflow, with the reason.
 *
 * AN ALLOWLIST, so "not in CI" has to be a decision someone wrote down rather
 * than the default state of a new script. Empty today; the entries that used to
 * belong here were the bug (#10251).
 */
const NOT_IN_CI: Readonly<Record<string, string>> = {};

// Every `validate:*` script wired through `step("validate:...")` in pipeline.ts
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

/** Every `validate:*` script package.json declares. */
function declaredValidators() {
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as {
    scripts: Record<string, string>;
  };
  return new Set(
    Object.keys(pkg.scripts).filter((name) => name.startsWith("validate:")),
  );
}

/**
 * Every `validate:*` any workflow runs -- not just validate.yml.
 *
 * ALL of them, because `validate:adapters` legitimately runs from
 * publish-cloudflare.yml and sync-subnets.yml, and a check that only read
 * validate.yml would report it as a gap and teach the next person to silence
 * the test rather than fix it.
 */
function ciValidators() {
  const scripts = new Set<string>();
  for (const file of readdirSync(WORKFLOW_DIR)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const source = readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
    for (const match of source.matchAll(/npm run (validate:[^\s]+)/g)) {
      scripts.add(match[1]!);
    }
  }
  return scripts;
}

// THE DIRECTION THE ORIGINAL TEST COULD NOT SEE (#10251).
//
// #1767 asserted pipeline ⊇ validate.yml, which catches "CI runs something the
// local gate does not". It is silent on the opposite drift, and both instances
// of it were live: `validate:ui-docs-drift` sat in the pipeline and in NO
// workflow, and `validate:readme-catalog` was in neither -- so the 298
// generated API-reference pages and the registry README catalog had no CI
// coverage on exactly the PR that invalidates them, a contract-only change.
//
// Declaring a script is now what enrols it. A validator that exists and runs
// nowhere is the failure mode, and it looks identical to a working one from
// every angle except this test.
describe("every declared validator runs somewhere (#10251)", () => {
  test("the parsers matched something", () => {
    assert.ok(declaredValidators().size > 0, "no validate:* in package.json");
    assert.ok(
      ciValidators().size > 0,
      "no `npm run validate:*` in any workflow",
    );
  });

  test("every declared validator runs in CI", () => {
    const missing = [...declaredValidators()]
      .filter((script) => !ciValidators().has(script) && !(script in NOT_IN_CI))
      .sort();
    assert.deepEqual(
      missing,
      [],
      `declared but run by no workflow: ${missing.join(", ")}. ` +
        "Add each to .github/workflows/ (validate.yml's contract step is the " +
        "usual home), or to NOT_IN_CI with the reason it belongs elsewhere.",
    );
  });

  test("every declared validator runs in the local gate", () => {
    // The other half of the same claim: `npm run check` should not pass while
    // a declared validator has never been invoked.
    const missing = [...declaredValidators()]
      .filter((script) => !pipelineValidators().has(script))
      .sort();
    assert.deepEqual(
      missing,
      [],
      `declared but not in scripts/pipeline.ts: ${missing.join(", ")}.`,
    );
  });

  test("NOT_IN_CI carries a reason for every entry, and none is stale", () => {
    for (const [script, reason] of Object.entries(NOT_IN_CI)) {
      assert.ok(reason.length > 20, `${script}: give a real reason`);
      assert.ok(
        declaredValidators().has(script),
        `${script} is exempted but no longer declared -- drop the entry`,
      );
      assert.ok(
        !ciValidators().has(script),
        `${script} is exempted but DOES run in CI -- drop the entry`,
      );
    }
  });
});

describe("pipeline ↔ validate.yml validator parity (#1767)", () => {
  test("both sets are non-empty (the parsers actually matched something)", () => {
    assert.ok(
      pipelineValidators().size > 0,
      "no validate:* steps found in pipeline.ts",
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
        "Add them to scripts/pipeline.ts checkCommands (and refreshCommands).",
    );
  });
});
