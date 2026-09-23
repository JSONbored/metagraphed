import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { test } from "vitest";

test("credentialed D1 maintenance installs without secrets, lifecycle scripts or shared caches", () => {
  const workflow = parse(
    readFileSync(
      new URL("../.github/workflows/d1-maintenance.yml", import.meta.url),
      "utf8",
    ),
  );
  const job = workflow.jobs.maintenance;
  assert.equal(workflow.env, undefined);
  assert.equal(job.env, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const steps = job.steps as {
    run?: string;
    uses?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  }[];
  const install = steps.findIndex(
    (step) => step.run === "npm ci --ignore-scripts",
  );
  assert.ok(install >= 0);
  assert.equal(
    steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with
      ?.cache,
    undefined,
  );
  assert.equal(
    steps.some((step) => step.uses?.startsWith("actions/cache")),
    false,
  );
  const privileged = [
    "npm run migrate:d1 -- --remote",
    "npm run snapshot:d1-schema",
  ];
  for (const [index, step] of steps.entries()) {
    if (privileged.includes(step.run ?? "")) {
      assert.ok(index > install);
      assert.equal(
        step.env?.CLOUDFLARE_API_TOKEN,
        "${{ secrets.CLOUDFLARE_D1_API_TOKEN }}",
      );
      assert.equal(Object.keys(step.env ?? {}).length, 3);
    } else assert.equal(step.env, undefined);
  }
  assert.equal(
    steps.filter((step) => privileged.includes(step.run ?? "")).length,
    2,
  );
});
