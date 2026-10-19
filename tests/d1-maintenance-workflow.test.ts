import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
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
    id?: string;
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
    "npm run snapshot:d1-schema -- --verify-ledger",
  ];
  for (const [index, step] of steps.entries()) {
    if (privileged.includes(step.run ?? "")) {
      assert.ok(index > install);
      assert.equal(
        step.env?.CLOUDFLARE_API_TOKEN,
        "${{ secrets.CLOUDFLARE_D1_API_TOKEN }}",
      );
      assert.equal(Object.keys(step.env ?? {}).length, 3);
    } else if (step.id === "migrations") {
      assert.deepEqual(step.env, {
        BEFORE_SHA: "${{ github.event.before }}",
        PUSH_SHA: "${{ github.sha }}",
      });
    } else assert.equal(step.env, undefined);
  }
  assert.equal(
    steps.filter((step) => privileged.includes(step.run ?? "")).length,
    2,
  );
});

test("only changed migration SQL or explicit manual application can apply pending migrations", () => {
  const workflow = parse(
    readFileSync(
      new URL("../.github/workflows/d1-maintenance.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.apply_migrations, {
    description: "Apply pending tracked migrations before verification",
    type: "boolean",
    required: true,
    default: false,
  });
  assert.ok(
    workflow.on.push.paths.includes("scripts/lib/d1-migration-ledger.ts"),
  );
  assert.equal(
    workflow.jobs.maintenance.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/checkout@"),
    ).with["fetch-depth"],
    0,
  );
  const steps = workflow.jobs.maintenance.steps as {
    run?: string;
    if?: string;
  }[];
  const apply = steps.find(
    (step) => step.run === "npm run migrate:d1 -- --remote",
  );
  assert.equal(
    apply?.if,
    "(github.event_name == 'push' && steps.migrations.outputs.changed == 'true') || (github.event_name == 'workflow_dispatch' && inputs.apply_migrations)",
  );
  const verify = steps.find(
    (step) => step.run === "npm run snapshot:d1-schema -- --verify-ledger",
  );
  assert.ok(verify);
  assert.equal(verify.if, undefined);
});

const workflow = parse(
  readFileSync(
    new URL("../.github/workflows/d1-maintenance.yml", import.meta.url),
    "utf8",
  ),
);
const detection = workflow.jobs.maintenance.steps.find(
  (step: { id?: string }) => step.id === "migrations",
) as { if: string; run: string };

function migrationChanges(
  commits: Record<string, string>[],
  unavailableBase = false,
) {
  const directory = mkdtempSync(path.join(tmpdir(), "d1-workflow-"));
  const output = path.join(directory, "output");
  // This shell fixture intentionally has no application settings or credentials.
  const env = {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  } as NodeJS.ProcessEnv;
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Workflow fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: directory, env, encoding: "utf8" },
    ).trim();
  try {
    git("init", "--quiet");
    writeFileSync(path.join(directory, "README.md"), "fixture\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture base");
    const before = git("rev-parse", "HEAD");
    for (const files of commits) {
      for (const [name, content] of Object.entries(files)) {
        const file = path.join(directory, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      git("add", ".");
      git("commit", "--quiet", "-m", "fixture change");
    }
    writeFileSync(output, "");
    const execute = () =>
      execFileSync("bash", ["-e", "-o", "pipefail", "-c", detection.run], {
        cwd: directory,
        env: {
          ...env,
          BEFORE_SHA: unavailableBase ? "0".repeat(40) : before,
          PUSH_SHA: git("rev-parse", "HEAD"),
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: output,
        },
        stdio: "pipe",
      });
    if (unavailableBase) assert.throws(execute);
    else execute();
    return readFileSync(output, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the actual push classifier keeps diagnostic and verification changes read-only", () => {
  assert.equal(detection.if, "github.event_name == 'push'");
  assert.equal(
    migrationChanges([
      {
        "scripts/lib/d1-admin.ts": "// diagnostic\n",
        "scripts/snapshot-d1-schema.ts": "// verify\n",
        "generated/db/d1-schema.json": "[]\n",
        "db/d1-schema.sql": "-- physical snapshot\n",
        ".github/workflows/d1-maintenance.yml": "# workflow\n",
        "migrations/d1/README.md": "documentation\n",
      },
    ]),
    "changed=false\n",
  );
});

test("the actual push classifier detects migration SQL across the entire push", () => {
  assert.equal(
    migrationChanges([
      { "migrations/d1/0001_fixture.sql": "SELECT 1;\n" },
      { "scripts/lib/d1-admin.ts": "// later diagnostic commit\n" },
    ]),
    "changed=true\n",
  );
});

test("the actual push classifier fails closed when the before commit is unavailable", () => {
  assert.equal(migrationChanges([], true), "");
});
