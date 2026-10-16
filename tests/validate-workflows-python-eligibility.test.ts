import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "../scripts/lib.ts";

// Execute the actual workflow predicate, rather than a second TypeScript
// classifier that could agree with itself while the live job still skips.
const workflow = parse(
  readFileSync(path.join(repoRoot, ".github/workflows/validate.yml"), "utf8"),
) as {
  jobs: {
    changes: { steps: { id?: string; run?: string }[] };
    python: { if: string };
  };
};
const source = workflow.jobs.changes.steps.find(
  (step) => step.id === "filter",
)?.run;
assert.equal(typeof source, "string", "the live changes step must be found");
const predicates = [
  ...source!.matchAll(/^\s*if grep -qE[^\n]+; then\n[\s\S]*?^\s*fi$/gm),
]
  .map((match) => match[0])
  .filter((block) => block.includes('echo "run_python_validation=true"'));
assert.equal(
  predicates.length,
  1,
  "find exactly the live Python predicate, never pass vacuously",
);

test("Python dependency-only PRs select the installed-lock job while unrelated scripts remain excluded", () => {
  assert.match(
    workflow.jobs.python.if,
    /needs\.changes\.outputs\.run_python_validation == 'true'/,
  );
  const fixtures: [string[], boolean][] = [
    [["scripts/uv.lock"], true],
    [["scripts/pyproject.toml"], true],
    [["scripts/fetch-native-subnets.py"], true],
    [["python/metagraphed/client.py"], true],
    [["scripts/generate.ts", "scripts/uv.lock"], true],
    [["scripts/generate.ts"], false],
    [["scripts/uv.lock.backup"], false],
    [["docs/python-notes.md"], false],
  ];
  for (const [files, expected] of fixtures) {
    const directory = mkdtempSync(
      path.join(tmpdir(), "python-path-eligibility-"),
    );
    try {
      const output = path.join(directory, "outputs.txt");
      writeFileSync(
        path.join(directory, "changed-files.txt"),
        files.join("\n") + "\n",
      );
      execFileSync("bash", ["-e", "-o", "pipefail", "-c", predicates[0]], {
        cwd: directory,
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      assert.equal(
        readFileSync(output, "utf8").trim(),
        `run_python_validation=${expected}`,
        files.join(","),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
