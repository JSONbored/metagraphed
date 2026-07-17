// Regression coverage for #6362: scripts/validate-workflows.mjs presence-enforces
// a set of env vars on the publish workflow (it fails CI if the workflow YAML does
// not literally set them). Every env var it POSITIVELY requires must actually be
// read by a script in the tree — otherwise the presence-check guards a documented,
// CI-set no-op, exactly as METAGRAPH_REQUIRE_PROBE_HEALTH did before it was removed
// here: read by nothing after the ADR 0002 live-only-health migration, yet still
// presence-enforced.
//
// The reader scan is repo-wide (scripts/src/workers) rather than resolved to the
// exact npm script the workflow invokes: env vars flow through transitively
// imported modules, so "some script reads it" mirrors the issue's own diagnostic
// (a repo-wide search for METAGRAPH_REQUIRE_PROBE_HEALTH found no reader) without
// the brittleness of statically resolving each workflow step's transitive imports.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Match `receiver.includes('METAGRAPH_FOO: "1"')` presence checks in the workflow
// validator, capturing a leading `!` so a "must NOT be set" negated check is not
// mistaken for a required var.
const PRESENCE_CHECK =
  /(!?)[\w.]+\.includes\(\s*'(METAGRAPH_[A-Z0-9_]+):[^']*'\s*\)/g;

function envVarsEnforcedByWorkflowValidator() {
  const source = readFileSync(
    path.join(repoRoot, "scripts/validate-workflows.mjs"),
    "utf8",
  );
  const required = new Set();
  const forbidden = new Set();
  for (const [, negation, name] of source.matchAll(PRESENCE_CHECK)) {
    (negation === "!" ? forbidden : required).add(name);
  }
  return { required, forbidden };
}

function walkScripts(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkScripts(full, out);
    } else if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
}

function scriptSourcesJoined() {
  const files = [];
  for (const dir of ["scripts", "src", "workers"]) {
    walkScripts(path.join(repoRoot, dir), files);
  }
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

function isReadSomewhere(sources, name) {
  return (
    sources.includes(`process.env.${name}`) ||
    sources.includes(`process.env["${name}"]`) ||
    sources.includes(`process.env['${name}']`)
  );
}

describe("validate-workflows.mjs env-var enforcement (#6362)", () => {
  test("every env var it requires a workflow to set is read by a script", () => {
    const { required } = envVarsEnforcedByWorkflowValidator();
    assert.ok(
      required.size > 0,
      "expected validate-workflows.mjs to presence-enforce at least one env var",
    );
    const sources = scriptSourcesJoined();
    for (const name of required) {
      assert.ok(
        isReadSomewhere(sources, name),
        `${name} is presence-enforced in scripts/validate-workflows.mjs but no script reads process.env.${name}`,
      );
    }
  });

  test("METAGRAPH_REQUIRE_PROBE_HEALTH is no longer presence-enforced anywhere", () => {
    const { required, forbidden } = envVarsEnforcedByWorkflowValidator();
    assert.ok(
      !required.has("METAGRAPH_REQUIRE_PROBE_HEALTH"),
      "the dead METAGRAPH_REQUIRE_PROBE_HEALTH presence-check must stay removed",
    );
    assert.ok(!forbidden.has("METAGRAPH_REQUIRE_PROBE_HEALTH"));
  });

  test("a negated presence check is treated as forbidden, not required", () => {
    // METAGRAPH_WRITE_PROBE_RESULTS is checked as `!publishJob.includes(...)`:
    // the publish job must NOT set it, so it is not a required-reader var.
    const { required, forbidden } = envVarsEnforcedByWorkflowValidator();
    assert.ok(forbidden.has("METAGRAPH_WRITE_PROBE_RESULTS"));
    assert.ok(!required.has("METAGRAPH_WRITE_PROBE_RESULTS"));
  });
});
