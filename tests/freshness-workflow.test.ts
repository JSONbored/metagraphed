import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { test } from "vitest";

const workflow = parse(
  readFileSync(
    new URL(
      "../.github/workflows/check-lakehouse-freshness.yml",
      import.meta.url,
    ),
    "utf8",
  ),
);
const steps = workflow.jobs.freshness.steps as {
  run?: string;
  shell?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}[];
const check = steps.find((step) =>
  step.run?.includes("check:lakehouse-freshness"),
)!;

test("manual freshness defaults to check-only while scheduled mode remains explicit", () => {
  assert.deepEqual(workflow.on.schedule, [{ cron: "17 7 * * *" }]);
  assert.equal(workflow.on.push, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.check_only, {
    description: "Check freshness without external notifications",
    type: "boolean",
    required: true,
    default: true,
  });
  assert.equal(
    check.env?.CHECK_ONLY,
    "${{ github.event_name == 'workflow_dispatch' && inputs.check_only }}",
  );
  assert.equal(check.shell, "bash");
});

test.each(["true", "false", "invalid"])(
  "freshness shell forwards mode %s without masking the check exit",
  (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "freshness-workflow-"));
    try {
      const argsFile = path.join(root, "arguments");
      const reportPath = path.join(root, "report with spaces.json");
      // Run the actual workflow shell with a function replacing npm. It has
      // no credentials and never invokes the checker or a package manager.
      const env: Record<string, string | undefined> = {
        CHECK_ONLY: mode,
        REPORT_PATH: reportPath,
        FIXTURE_ARGS: argsFile,
      };
      const child = spawnSync(
        "/bin/bash",
        [
          "--noprofile",
          "--norc",
          "-eo",
          "pipefail",
          "-c",
          'npm() { printf "%s\\n" "$@" > "$FIXTURE_ARGS"; return 23; }\n' +
            check.run,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 5_000,
          env: env as NodeJS.ProcessEnv,
        },
      );
      assert.equal(child.error, undefined);
      if (mode === "invalid") {
        assert.equal(child.status, 1, child.stderr);
        assert.equal(existsSync(argsFile), false);
      } else {
        assert.equal(child.status, 23, child.stderr);
        assert.deepEqual(readFileSync(argsFile, "utf8").trimEnd().split("\n"), [
          "run",
          "check:lakehouse-freshness",
          "--",
          "--report",
          reportPath,
          ...(mode === "true" ? ["--check-only"] : []),
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("freshness retains only its bounded report after a failed check", () => {
  const upload = steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.ok(upload);
  assert.match(upload.uses!, /^actions\/upload-artifact@[a-f0-9]{40}$/);
  assert.equal(upload.if, "${{ always() }}");
  assert.equal(upload.with?.path, check.env?.REPORT_PATH);
  assert.equal(upload.with?.["if-no-files-found"], "error");
  assert.equal(upload.with?.["retention-days"], 7);
});
