// Tests for the rule that keeps GitHub Actions' error reporting wired up
// (scripts/workflow-observability.ts, enforced by scripts/validate-workflows.ts).
//
// The rule exists because initObservability() returns early without
// POSTHOG_PROJECT_TOKEN: for a long stretch every instrumented script ran in
// Actions with the var absent, so every one of them was a silent no-op. The
// point of these tests is therefore NOT "the rule runs" -- it is that the rule
// FAILS a workflow that forgets the var. A guard only ever observed passing is
// indistinguishable from the no-op it replaced, which is the exact defect
// being fixed here.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
  OBSERVABILITY_TOKEN_ENV,
  buildStepScripts,
  instrumentedScripts,
  scriptsReachedBy,
  stepsMissingObservabilityToken,
} from "../scripts/workflow-observability.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readScriptSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(path.join(repoRoot, "scripts"), {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!/\.(?:ts|mjs|js)$/.test(entry.name)) continue;
    const full = path.join(entry.parentPath, entry.name);
    sources.set(
      path.relative(repoRoot, full).split(path.sep).join("/"),
      readFileSync(full, "utf8"),
    );
  }
  return sources;
}

function realContext() {
  const scriptSources = readScriptSources();
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  return {
    npmScripts: packageJson.scripts ?? {},
    buildStepScripts: buildStepScripts(
      scriptSources.get("scripts/build.ts") ?? "",
    ),
    instrumented: instrumentedScripts(scriptSources),
  };
}

// A step that runs an instrumented script, with no env block at all.
const UNINSTRUMENTED_WORKFLOW = `name: Example

on:
  workflow_dispatch: {}

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Sync to D1
        run: node scripts/sync-neurons.ts
`;

const SYNTHETIC_CONTEXT = {
  npmScripts: {
    build: "node scripts/build.ts",
    "economics:refresh": "node scripts/refresh-economics.ts --write",
    loops: "npm run loops",
  },
  buildStepScripts: {
    local: new Set(["scripts/build-artifacts.ts"]),
    production: new Set([
      "scripts/build-artifacts.ts",
      "scripts/refresh-og-image.ts",
    ]),
  },
  instrumented: new Set([
    "scripts/sync-neurons.ts",
    "scripts/refresh-economics.ts",
    "scripts/refresh-og-image.ts",
  ]),
};

function withStepEnv(workflow: string, line: string): string {
  return workflow.replace(
    "        run: node scripts/sync-neurons.ts",
    `        env:\n          ${line}\n        run: node scripts/sync-neurons.ts`,
  );
}

describe("stepsMissingObservabilityToken", () => {
  // THE test. Everything else is a refinement of this one.
  test("flags a step that runs an instrumented script with no token in scope", () => {
    const missing = stepsMissingObservabilityToken(
      UNINSTRUMENTED_WORKFLOW,
      SYNTHETIC_CONTEXT,
    );
    assert.deepEqual(missing, [
      { step: "Sync to D1", scripts: ["scripts/sync-neurons.ts"] },
    ]);
  });

  test("a step-level env satisfies it", () => {
    const workflow = withStepEnv(
      UNINSTRUMENTED_WORKFLOW,
      `${OBSERVABILITY_TOKEN_ENV}: \${{ secrets.${OBSERVABILITY_TOKEN_ENV} }}`,
    );
    assert.deepEqual(
      stepsMissingObservabilityToken(workflow, SYNTHETIC_CONTEXT),
      [],
    );
  });

  test("a job-level env satisfies it (hoisting is legitimate, not a violation)", () => {
    const workflow = UNINSTRUMENTED_WORKFLOW.replace(
      "    runs-on: ubuntu-latest",
      `    runs-on: ubuntu-latest\n    env:\n      ${OBSERVABILITY_TOKEN_ENV}: x`,
    );
    assert.deepEqual(
      stepsMissingObservabilityToken(workflow, SYNTHETIC_CONTEXT),
      [],
    );
  });

  test("a workflow-level env satisfies it", () => {
    const workflow = UNINSTRUMENTED_WORKFLOW.replace(
      "jobs:",
      `env:\n  ${OBSERVABILITY_TOKEN_ENV}: x\n\njobs:`,
    );
    assert.deepEqual(
      stepsMissingObservabilityToken(workflow, SYNTHETIC_CONTEXT),
      [],
    );
  });

  test("a step running only uninstrumented scripts is not flagged", () => {
    const workflow = UNINSTRUMENTED_WORKFLOW.replace(
      "node scripts/sync-neurons.ts",
      "node scripts/r2-manifest.ts --write",
    );
    assert.deepEqual(
      stepsMissingObservabilityToken(workflow, SYNTHETIC_CONTEXT),
      [],
    );
  });

  // The distinction that cost nine false failures when the rule first ran:
  // `npm run build` reaches instrumented scripts ONLY in production mode.
  test("`npm run build` is flagged only when METAGRAPH_PRODUCTION_BUILD is in scope", () => {
    const local = UNINSTRUMENTED_WORKFLOW.replace(
      "node scripts/sync-neurons.ts",
      "npm run build",
    );
    assert.deepEqual(
      stepsMissingObservabilityToken(local, SYNTHETIC_CONTEXT),
      [],
      "a plain validate-lane build runs no instrumented step and must not be flagged",
    );

    const production = local.replace(
      "    runs-on: ubuntu-latest",
      '    runs-on: ubuntu-latest\n    env:\n      METAGRAPH_PRODUCTION_BUILD: "1"',
    );
    assert.deepEqual(
      stepsMissingObservabilityToken(production, SYNTHETIC_CONTEXT),
      [{ step: "Sync to D1", scripts: ["scripts/refresh-og-image.ts"] }],
      "the production build DOES run an instrumented step and must be flagged",
    );
  });
});

describe("scriptsReachedBy", () => {
  test("resolves a script named directly", () => {
    assert.ok(
      scriptsReachedBy("node scripts/sync-neurons.ts", {
        npmScripts: SYNTHETIC_CONTEXT.npmScripts,
        spawnedBy: new Map(),
      }).has("scripts/sync-neurons.ts"),
    );
  });

  test("resolves a script hidden behind `npm run <name>`", () => {
    assert.ok(
      scriptsReachedBy("npm run economics:refresh", {
        npmScripts: SYNTHETIC_CONTEXT.npmScripts,
        spawnedBy: new Map(),
      }).has("scripts/refresh-economics.ts"),
    );
  });

  test("resolves scripts a reached runner spawns as children", () => {
    const reached = scriptsReachedBy("npm run build", {
      npmScripts: SYNTHETIC_CONTEXT.npmScripts,
      spawnedBy: new Map([
        ["scripts/build.ts", new Set(["scripts/refresh-og-image.ts"])],
      ]),
    });
    assert.ok(reached.has("scripts/build.ts"));
    assert.ok(reached.has("scripts/refresh-og-image.ts"));
  });

  test("terminates on a self-referential npm script instead of hanging CI", () => {
    assert.deepEqual(
      [
        ...scriptsReachedBy("npm run loops", {
          npmScripts: SYNTHETIC_CONTEXT.npmScripts,
          spawnedBy: new Map(),
        }),
      ],
      [],
    );
  });
});

describe("derivation from the real tree", () => {
  // Guards against the whole rule passing vacuously -- the same failure mode
  // it exists to catch. validate-workflows.ts fails on these too; asserting
  // them here means a break shows up as a named test, not as one line in a
  // validator's output.
  test("the instrumented-script scan finds the known importers", () => {
    const { instrumented } = realContext();
    assert.ok(instrumented.size > 0, "scan returned nothing");
    for (const expected of [
      "scripts/sync-neurons.ts",
      "scripts/refresh-economics.ts",
      "scripts/refresh-native-snapshot.ts",
      "scripts/discover-testnet-surfaces.ts",
      "scripts/refresh-og-image.ts",
    ]) {
      assert.ok(
        instrumented.has(expected),
        `${expected} imports scripts/observability.ts but was not detected`,
      );
    }
    assert.ok(
      !instrumented.has("scripts/observability.ts"),
      "the helper itself is not a consumer of itself",
    );
  });

  test("build.ts's production step list carries instrumented scripts and the local one does not", () => {
    const { buildStepScripts: steps, instrumented } = realContext();
    const inProduction = [...steps.production].filter((s) =>
      instrumented.has(s),
    );
    assert.ok(
      inProduction.length > 0,
      "no instrumented script in productionSteps() -- `npm run build` would stop being checked",
    );
    assert.deepEqual(
      [...steps.local].filter((s) => instrumented.has(s)),
      [],
      "localSteps() must stay free of instrumented scripts, or the validate lane needs the token too",
    );
  });

  test("every committed workflow has the token wired for the scripts it runs", () => {
    const ctx = realContext();
    const workflowRoot = path.join(repoRoot, ".github/workflows");
    const offenders: string[] = [];
    for (const name of readdirSync(workflowRoot)) {
      if (!/\.ya?ml$/.test(name)) continue;
      const content = readFileSync(path.join(workflowRoot, name), "utf8");
      for (const { step, scripts } of stepsMissingObservabilityToken(
        content,
        ctx,
      )) {
        offenders.push(`${name}: "${step}" runs ${scripts.join(", ")}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  // Positive control for the test above: it must be capable of failing.
  // Without this, a bug that made every workflow parse as zero steps would
  // leave that assertion passing on nothing.
  test("...and that sweep would catch a workflow that dropped the token", () => {
    const ctx = realContext();
    const stripped = readFileSync(
      path.join(repoRoot, ".github/workflows/refresh-metagraph.yml"),
      "utf8",
    )
      .split("\n")
      .filter((line) => !line.includes(`${OBSERVABILITY_TOKEN_ENV}:`))
      .join("\n");
    assert.deepEqual(stepsMissingObservabilityToken(stripped, ctx), [
      { step: "Sync to D1", scripts: ["scripts/sync-neurons.ts"] },
    ]);
  });
});
