import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "../scripts/lib.ts";

interface Step {
  id?: string;
  name?: string;
  run?: string;
  if?: string;
}

// Follow the Python eligibility regression: execute the actual inline shell
// predicates so a second classifier cannot pass while the live job skips.
const workflow = parse(
  readFileSync(path.join(repoRoot, ".github/workflows/validate.yml"), "utf8"),
) as {
  jobs: {
    changes: { steps: Step[] };
    ui: { if: string; steps: Step[] };
  };
};
const source = workflow.jobs.changes.steps.find(
  (step) => step.id === "filter",
)?.run;
assert.equal(typeof source, "string", "the live changes step must be found");

function predicate(flag: string): string {
  const matches = [
    ...source!.matchAll(/^\s*if grep -qE[^\n]+; then\n[\s\S]*?^\s*fi$/gm),
  ]
    .map((match) => match[0])
    .filter((block) => block.includes('echo "' + flag + '=true"'));
  assert.equal(
    matches.length,
    1,
    "find exactly the live " + flag + " predicate",
  );
  return matches[0]!;
}

function select(block: string, files: string[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ui-path-eligibility-"));
  try {
    const output = path.join(directory, "outputs.txt");
    writeFileSync(
      path.join(directory, "changed-files.txt"),
      files.join("\n") + "\n",
    );
    execFileSync("bash", ["-e", "-o", "pipefail", "-c", block], {
      cwd: directory,
      env: { ...process.env, GITHUB_OUTPUT: output },
      timeout: 5_000,
    });
    return readFileSync(output, "utf8").trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("root dependency changes select UI validation and browser tests without widening unrelated paths", () => {
  const fixtures: [string[], boolean, boolean][] = [
    [["package-lock.json"], true, true],
    [["package.json"], true, true],
    [["docs/notes.md", "package-lock.json"], true, true],
    [["src/example.ts", "package.json"], true, true],
    [["apps/ui/package.json"], true, true],
    [["apps/ui/src/routes/index.tsx"], true, true],
    [["packages/client/dist/index.js"], true, true],
    [["packages/chain-summaries/src/index.ts"], true, false],
    [["packages/contract/index.d.ts"], true, false],
    [["packages/ui-kit/src/index.ts"], true, false],
    [["src/example.ts"], false, false],
    [["registry/subnets/example.json"], false, false],
    [["docs/notes.md"], false, false],
    [["package-lock.json.backup"], false, false],
    [["package.json.backup"], false, false],
    [["nested/package-lock.json"], false, false],
    [["nested/package.json"], false, false],
    [["packageXjson"], false, false],
    [["package-lockXjson"], false, false],
  ];
  for (const [files, validation, e2e] of fixtures) {
    for (const [flag, expected] of [
      ["run_ui_validation", validation],
      ["run_ui_e2e", e2e],
    ] as const) {
      assert.equal(
        select(predicate(flag), files),
        flag + "=" + expected,
        files.join(","),
      );
    }
  }
});

test("removing the root dependency alternative reproduces the original skipped-UI failure", () => {
  for (const flag of ["run_ui_validation", "run_ui_e2e"]) {
    const live = predicate(flag);
    const old = live.replace(String.raw`^package(-lock)?\.json$|`, "");
    assert.notEqual(
      old,
      live,
      "the historical-failure control must remove the fix",
    );
    for (const file of ["package.json", "package-lock.json"]) {
      assert.equal(select(old, [file]), flag + "=false");
      assert.equal(select(live, [file]), flag + "=true");
    }
  }
});

test("UI draft and browser-step guards remain intact", () => {
  assert.equal(
    workflow.jobs.ui.if,
    "${{ github.event_name != 'pull_request' || (github.event.pull_request.draft != true && needs.changes.outputs.run_ui_validation == 'true') }}",
  );
  const e2e = workflow.jobs.ui.steps.find((step) => step.id === "ui-e2e");
  assert.ok(e2e);
  assert.equal(e2e.if, "${{ needs.changes.outputs.run_ui_e2e == 'true' }}");
});

test("preview root dependency paths retain the same-repo and fork draft guards", () => {
  const preview = parse(
    readFileSync(path.join(repoRoot, ".github/workflows/ui-preview.yml"), "utf8"),
  ) as {
    on: { pull_request: { paths: string[] } };
    permissions: Record<string, string>;
    jobs: Record<string, { if: string }>;
  };
  assert.deepEqual(preview.on.pull_request.paths, [
    "package.json",
    "package-lock.json",
    "apps/ui/**",
    "packages/client/**",
    "packages/ui-kit/**",
  ]);
  assert.deepEqual(preview.permissions, { contents: "read" });
  assert.equal(
    preview.jobs["build-deploy"]!.if,
    "${{ github.event.pull_request.draft != true && github.event.pull_request.head.repo.fork != true }}",
  );
  assert.equal(
    preview.jobs.build!.if,
    "${{ github.event.pull_request.draft != true && github.event.pull_request.head.repo.fork == true }}",
  );
});
