import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parse } from "yaml";

test("UI artifacts retain native browser evidence without raw server debug logs", () => {
  const workflow = parse(
    readFileSync(
      new URL("../.github/workflows/validate.yml", import.meta.url),
      "utf8",
    ),
  );
  const uploads = workflow.jobs.ui.steps.filter(
    (step: { uses?: string }) =>
      step.uses?.startsWith("actions/upload-artifact@"),
  ) as { if?: string; with: { name: string; path: string } }[];

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].with.name, "ui-e2e-diagnostics");
  assert.deepEqual(uploads[0].with.path.trim().split("\n"), [
    "apps/ui/playwright-report/**",
    "apps/ui/test-results/**",
  ]);
  assert.equal(
    uploads[0].if,
    "${{ !cancelled() && (steps.ui-e2e.outcome == 'success' || steps.ui-e2e.outcome == 'failure') }}",
  );
});
