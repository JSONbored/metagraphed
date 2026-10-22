import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { test } from "vitest";
import { parse } from "yaml";

import { writeDerivatives } from "../scripts/build-logo-thumbnails.ts";

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

const WORKFLOW_PATH = "../.github/workflows/sync-contract-artifacts.yml";
const workflowFile = new URL(WORKFLOW_PATH, import.meta.url);
const workflow = parse(readFileSync(workflowFile, "utf8"));
const steps = workflow.jobs.generate.steps as Step[];
const captures = steps.filter((step) =>
  step.run?.includes("PY_GENERATED_CONTRACT_RECEIPT"),
);
assert.equal(captures.length, 1, "execute the actual single capture block");
const capture = captures[0];
const marker = "PY_GENERATED_CONTRACT_RECEIPT";
const expression = `^python3 - <<'${marker}'\\n([\\s\\S]+)\\n${marker}\\s*$`;
const pattern = new RegExp(expression);
const match = pattern.exec(capture.run!);
assert.ok(match, "capture must remain extractable as the real inline Python");
const captureCode = match[1];

const CONTRACT_PATHS = [
  "public/metagraph/openapi.json",
  "public/metagraph/contracts.json",
  "public/metagraph/api-index.json",
  "public/metagraph/types.d.ts",
  "packages/contract/index.d.ts",
  "generated/metagraphed-client.ts",
  "generated/graphql/schema.ts",
  "generated/graphql/types.ts",
  "packages/client/src/metagraphed-client.ts",
  "packages/client/dist/index.js",
  "packages/client/dist/index.cjs",
  "apps/ui/content/docs/api-reference/example.mdx",
];
const EXCLUDED_PATHS = [
  "public/metagraph/r2-manifest.json",
  "public/metagraph/schemas/index.json",
  "public/metagraph/operational-surfaces.json",
];
const LOGOS = "apps/ui/public/logos";
const MANIFEST = `${LOGOS}/display/manifest.json`;
const IDENTITY = `${LOGOS}/display/sharing-identity.json`;
const NEW_CONTRACT = "generated/graphql/schema.ts";
const D1_SCHEMA_PATHS = ["db/d1-schema.sql", "generated/db/d1-schema.json"];
const D1_MIGRATION = "0039_x402_payment_attempts.sql";
const WORKER_TYPE_PATHS = [
  "workers/worker-configuration.d.ts",
  "workers/data-api.worker-configuration.d.ts",
  "workers/registry-sync-api.worker-configuration.d.ts",
  "workers/wss-lb.worker-configuration.d.ts",
];

interface Fixture {
  base: string;
  root: string;
  runner: string;
  source: string;
}

function git(root: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function put(root: string, name: string, value: string | Uint8Array): void {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<Fixture> {
  const base = mkdtempSync(path.join(tmpdir(), "generated-workflow-"));
  const root = path.join(base, "repository");
  const runner = path.join(base, "runner");
  mkdirSync(root);
  mkdirSync(runner);
  put(root, "package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  put(root, ".gitignore", "generated/\napps/ui/public/logos/sharing/\n");
  for (const name of [
    ...CONTRACT_PATHS,
    ...EXCLUDED_PATHS,
    ...WORKER_TYPE_PATHS,
  ]) {
    if (name !== NEW_CONTRACT) put(root, name, `committed ${name}\n`);
  }
  for (const name of D1_SCHEMA_PATHS) put(root, name, `baseline ${name}\n`);
  put(
    root,
    `migrations/d1/${D1_MIGRATION}`,
    "CREATE TABLE payment_attempts(id TEXT PRIMARY KEY);\n",
  );
  const original = await sharp({
    create: {
      width: 320,
      height: 200,
      channels: 4,
      background: { r: 40, g: 80, b: 120, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  put(root, `${LOGOS}/mark.png`, original);
  const manifest = await writeDerivatives(path.join(root, LOGOS));
  const entry = manifest.entries[0];
  const legacy = {
    version: 1,
    format: "webp",
    max_dimension: 96,
    quality: 90,
    entries: [
      {
        source_path: entry.source_path,
        source_sha256: entry.source_sha256,
        source_bytes: entry.source_bytes,
        display_path: entry.display_path,
        display_sha256: entry.display_sha256,
        display_bytes: entry.display_bytes,
        width: entry.width,
        height: entry.height,
      },
    ],
  };
  put(root, MANIFEST, JSON.stringify(legacy));
  rmSync(path.join(root, IDENTITY));
  const display = readFileSync(path.join(root, LOGOS, "display", "mark.webp"));
  put(root, `${LOGOS}/display/removed.webp`, display);
  rmSync(path.join(root, LOGOS, "sharing"), { recursive: true });
  git(root, "init", "-q");
  git(root, "add", "--force", ".");
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  );
  const source = git(root, "rev-parse", "HEAD").toString().trim();
  return { base, root, runner, source };
}

function execute(
  value: Fixture,
  preset?: string,
  source = value.source,
  migrations?: string,
  workerTypes?: string,
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOURCE_SHA: source,
    WORKFLOW_SHA: "1".repeat(40),
    WORKFLOW_REF: "fixture/workflow@refs/heads/main",
    GITHUB_REPOSITORY: "fixture/repository",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_TEMP: value.runner,
  };
  delete env.ARTIFACT_PRESET;
  delete env.D1_MIGRATIONS;
  delete env.WORKER_TYPES;
  if (preset !== undefined) env.ARTIFACT_PRESET = preset;
  if (migrations !== undefined) env.D1_MIGRATIONS = migrations;
  if (workerTypes !== undefined) env.WORKER_TYPES = workerTypes;
  return spawnSync("python3", ["-c", captureCode], {
    cwd: value.root,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function output(value: Fixture, preset: "contracts" | "logos") {
  const kind = preset === "logos" ? "logo" : "contract";
  const directory = path.join(value.runner, `generated-${kind}-output`);
  const receipt = JSON.parse(
    readFileSync(path.join(directory, "receipt.json"), "utf8"),
  );
  const patch = readFileSync(path.join(directory, `generated-${kind}.patch`));
  assert.equal(receipt.status, "success");
  assert.equal(receipt.artifact_preset, preset);
  assert.equal(receipt.source_sha, value.source);
  const tree = git(value.root, "rev-parse", "HEAD^{tree}").toString().trim();
  assert.equal(receipt.source_tree, tree);
  const lock = readFileSync(path.join(value.root, "package-lock.json"));
  assert.equal(receipt.lock_sha256, hash(lock));
  assert.equal(receipt.source_lock_sha256, hash(lock));
  assert.equal(receipt.patch_sha256, hash(patch));
  const changed = JSON.parse(
    readFileSync(path.join(directory, "changed-paths.json"), "utf8"),
  );
  assert.deepEqual(changed, receipt.changed_paths);
  return { directory, receipt, patch };
}

function refused(value: Fixture, preset: string, expected: RegExp): void {
  const result = execute(value, preset);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, expected);
  for (const kind of ["contract", "logo"]) {
    assert.equal(
      existsSync(path.join(value.runner, `generated-${kind}-output`)),
      false,
    );
  }
}

test("generation presets preserve default sync and isolate exact read-only jobs", () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), [
    "artifact_preset",
    "d1_migrations",
    "mode",
    "source_sha",
    "worker_types",
  ]);
  assert.deepEqual(inputs.mode.options, [
    "sync",
    "generate-only",
    "resolve-lock",
  ]);
  assert.equal(inputs.mode.default, "sync");
  assert.deepEqual(inputs.artifact_preset.options, ["contracts", "logos"]);
  assert.equal(inputs.artifact_preset.default, "contracts");
  assert.equal(inputs.d1_migrations.default, "");
  assert.equal(inputs.worker_types.type, "boolean");
  assert.equal(inputs.worker_types.default, false);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.schedule, [{ cron: "40 5 * * *" }]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const sync = workflow.jobs.sync;
  assert.deepEqual(sync.permissions, {
    contents: "write",
    "pull-requests": "write",
  });
  assert.match(sync.if, /inputs\.mode == 'sync'/);
  const built = sync.steps.some((step: Step) => step.run === "npm run build");
  assert.ok(built);
  const job = workflow.jobs.generate;
  assert.match(job.if, /workflow_dispatch/);
  assert.match(job.if, /inputs\.mode == 'generate-only'/);
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.env, undefined);
  assert.equal(
    capture.env?.ARTIFACT_PRESET,
    "${{ steps.source.outputs.preset }}",
  );
  assert.equal(
    capture.env?.D1_MIGRATIONS,
    "${{ steps.source.outputs.d1_migrations }}",
  );
  assert.equal(
    capture.env?.WORKER_TYPES,
    "${{ steps.source.outputs.worker_types }}",
  );
  const source = steps.find((step) => step.id === "source");
  assert.equal(source?.env?.WORKER_TYPES, "${{ inputs.worker_types }}");
  const workerTypes = steps.filter(
    (step) => step.run === "npm run types:workers",
  );
  assert.equal(workerTypes.length, 1);
  assert.equal(
    workerTypes[0].if,
    "steps.source.outputs.preset == 'contracts' && steps.source.outputs.worker_types == 'true'",
  );
  const projection = steps.find((step) =>
    step.run?.startsWith(
      "node scripts/snapshot-d1-schema.ts --project-migrations",
    ),
  );
  assert.ok(projection);
  assert.equal(
    projection.if,
    "steps.source.outputs.preset == 'contracts' && steps.source.outputs.d1_migrations != ''",
  );
  assert.deepEqual(projection.env, {
    D1_MIGRATIONS: "${{ steps.source.outputs.d1_migrations }}",
  });
  const build = steps.find((step) => step.run?.endsWith("npm run build"));
  assert.ok(build);
  assert.ok(steps.indexOf(build) < steps.indexOf(workerTypes[0]));
  assert.ok(steps.indexOf(workerTypes[0]) < steps.indexOf(projection));
  assert.ok(steps.indexOf(projection) < steps.indexOf(capture));
  const checkout = steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout?.with?.["persist-credentials"], false);
  assert.equal(checkout?.with?.ref, "${{ steps.source.outputs.sha }}");
  const generation = JSON.stringify(job);
  assert.ok(!generation.includes("secrets."));
  assert.ok(!generation.includes("create-pull-request"));
  assert.ok(!generation.includes("gh pr"));
  assert.ok(!generation.includes("git push"));
  assert.ok(!generation.includes("npm run deploy"));
  const commands = steps.map((step) => step.run ?? "").join("\n");
  assert.match(commands, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.ok(commands.includes('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"'));
  assert.ok(commands.includes("npm ci --ignore-scripts"));
  assert.ok(commands.includes("npm run build:logo-thumbnails"));
  assert.ok(commands.includes("npm run validate:logo-thumbnails"));
  const fixedCommands = new Map([
    ["npm ci", "contracts"],
    [
      "METAGRAPH_PRODUCTION_BUILD=0 METAGRAPH_PRESERVE_PROBE_HEALTH=1 npm run build",
      "contracts",
    ],
    ["npm run build --workspace=packages/client", "contracts"],
    ["node scripts/generate-openapi-docs.ts", "contracts"],
    ["npm ci --ignore-scripts", "logos"],
    ["npm run build:logo-thumbnails", "logos"],
    ["npm run validate:logo-thumbnails", "logos"],
  ]);
  for (const [command, preset] of fixedCommands) {
    const selected = steps.filter((step) => step.run === command);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].if, `steps.source.outputs.preset == '${preset}'`);
  }
  const check = steps.findIndex(
    (step) => step.run === "npm run validate:logo-thumbnails",
  );
  assert.ok(check < steps.indexOf(capture));

  // Preserve the existing independent lock lane without changing its internals.
  const resolve = workflow.jobs.resolve;
  assert.match(resolve.if, /workflow_dispatch/);
  assert.match(resolve.if, /inputs\.mode == 'resolve-lock'/);
  assert.deepEqual(resolve.permissions, { contents: "read" });
  const lockSteps = resolve.steps as Step[];
  const lockCheckout = lockSteps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(lockCheckout?.with?.["persist-credentials"], false);
  assert.equal(lockCheckout?.with?.ref, "${{ steps.source.outputs.sha }}");
  const resolution = lockSteps.find(
    (step) => step.name === "Resolve root lock without lifecycle scripts",
  );
  const lockCommand =
    'command = ["npm", "install", "--package-lock-only", ' +
    '"--ignore-scripts", "--no-audit", "--no-fund"]';
  assert.ok(resolution?.run?.includes(lockCommand));
  const lockJob = JSON.stringify(resolve);
  assert.ok(!lockJob.includes("secrets."));
  assert.ok(!lockJob.includes("create-pull-request"));
  assert.ok(!lockJob.includes("git push"));
  assert.ok(!lockJob.includes("npm run deploy"));
});

for (const preset of [undefined, "", "contracts"] as const) {
  test(`contract capture keeps legacy allowlist for preset ${String(preset)}`, async () => {
    const value = await fixture();
    try {
      for (const name of [...CONTRACT_PATHS, ...EXCLUDED_PATHS]) {
        put(value.root, name, `generated ${name}\n`);
      }
      const added = "generated/graphql/new.ts";
      // Only the exact two GraphQL outputs belong to this preset.
      put(value.root, added, "ignored and deliberately not selected\n");
      const result = execute(value, preset);
      assert.equal(result.status, 0, result.stderr);
      const captured = output(value, "contracts");
      assert.equal(captured.receipt.worker_types, false);
      assert.deepEqual(
        captured.receipt.changed_paths,
        CONTRACT_PATHS.toSorted(),
      );
      assert.deepEqual(
        captured.receipt.excluded_paths,
        EXCLUDED_PATHS.toSorted(),
      );
      assert.ok(!captured.patch.includes(Buffer.from(added)));
      const commands = captured.receipt.commands.map(
        (entry: { command: string }) => entry.command,
      );
      assert.deepEqual(commands, [
        "npm ci",
        "METAGRAPH_PRODUCTION_BUILD=0 METAGRAPH_PRESERVE_PROBE_HEALTH=1 npm run build",
        "npm run build --workspace=packages/client",
        "cd apps/ui && node scripts/generate-openapi-docs.ts",
      ]);
      for (const name of CONTRACT_PATHS) {
        const body = readFileSync(path.join(value.root, name));
        assert.equal(captured.receipt.output_sha256[name], hash(body));
      }
    } finally {
      rmSync(value.base, { recursive: true, force: true });
    }
  });
}

test("immutable source resolution validates the optional Worker type flag before generation", () => {
  const source = steps.find((step) => step.id === "source");
  assert.ok(source?.run);
  const base = mkdtempSync(path.join(tmpdir(), "worker-types-source-"));
  try {
    for (const [preset, workerTypes, expected] of [
      ["contracts", undefined, "false"],
      ["contracts", "", "false"],
      ["contracts", "false", "false"],
      ["contracts", "true", "true"],
      ["logos", "false", "false"],
      ["logos", "true", /require the contracts preset/],
      ["contracts", "yes", /must be true or false/],
    ] as const) {
      const outputs = path.join(base, "outputs");
      writeFileSync(outputs, "");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ARTIFACT_PRESET: preset,
        DISPATCH_SHA: "2".repeat(40),
        REQUESTED_SHA: "",
        D1_MIGRATIONS: "",
        GITHUB_OUTPUT: outputs,
      };
      delete env.WORKER_TYPES;
      if (workerTypes !== undefined) env.WORKER_TYPES = workerTypes;
      const result: SpawnSyncReturns<string> = spawnSync(
        "bash",
        ["-c", source.run],
        {
          cwd: base,
          env,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      if (typeof expected === "string") {
        assert.equal(result.status, 0, result.stderr);
        const fields = Object.fromEntries(
          readFileSync(outputs, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("=")),
        );
        assert.equal(fields.worker_types, expected);
        assert.equal(fields.preset, preset);
        assert.equal(fields.sha, "2".repeat(40));
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("optional Worker type generation captures exactly its four canonical outputs and receipt", async () => {
  const value = await fixture();
  try {
    for (const name of WORKER_TYPE_PATHS)
      put(value.root, name, `generated ${name}\n`);
    const result = execute(value, "contracts", value.source, undefined, "true");
    assert.equal(result.status, 0, result.stderr);
    const captured = output(value, "contracts");
    assert.equal(captured.receipt.worker_types, true);
    assert.deepEqual(
      captured.receipt.changed_paths,
      WORKER_TYPE_PATHS.toSorted(),
    );
    assert.deepEqual(
      captured.receipt.commands.map(
        (entry: { command: string }) => entry.command,
      ),
      [
        "npm ci",
        "METAGRAPH_PRODUCTION_BUILD=0 METAGRAPH_PRESERVE_PROBE_HEALTH=1 npm run build",
        "npm run types:workers",
        "npm run build --workspace=packages/client",
        "cd apps/ui && node scripts/generate-openapi-docs.ts",
      ],
    );
    for (const name of WORKER_TYPE_PATHS) {
      assert.equal(
        captured.receipt.output_sha256[name],
        hash(readFileSync(path.join(value.root, name))),
      );
    }
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

test("Worker type capture rejects disabled, invalid and expanded output selections", async () => {
  const value = await fixture();
  try {
    put(value.root, WORKER_TYPE_PATHS[0], "generated Worker types\n");
    for (const flag of [undefined, "", "false"]) {
      const result = execute(value, "contracts", value.source, undefined, flag);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unexpected generation changes/);
    }
    const invalid = execute(value, "contracts", value.source, undefined, "yes");
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /must be true or false/);
    const logos = execute(value, "logos", value.source, undefined, "true");
    assert.notEqual(logos.status, 0);
    assert.match(logos.stderr, /require the contracts preset/);
    put(value.root, "workers/extra.worker-configuration.d.ts", "unexpected\n");
    const expanded = execute(
      value,
      "contracts",
      value.source,
      undefined,
      "true",
    );
    assert.notEqual(expanded.status, 0);
    assert.match(expanded.stderr, /Unexpected generation changes/);
    assert.equal(
      existsSync(path.join(value.runner, "generated-contract-output")),
      false,
    );
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

function expectedD1Projection(value: Fixture) {
  return {
    mode: "expected-postmigration",
    live_readback: false,
    written: true,
    migrations: [
      {
        name: D1_MIGRATION,
        sha256: hash(
          git(value.root, "show", `HEAD:migrations/d1/${D1_MIGRATION}`),
        ),
      },
    ],
    baseline_sha256: Object.fromEntries(
      D1_SCHEMA_PATHS.map((name) => [
        name,
        hash(git(value.root, "show", `HEAD:${name}`)),
      ]),
    ),
    output_sha256: Object.fromEntries(
      D1_SCHEMA_PATHS.map((name) => [
        name,
        hash(readFileSync(path.join(value.root, name))),
      ]),
    ),
    changed_objects: ["payment_attempts"],
  };
}

test("explicit expected D1 projection captures only its two schema paths with source-bound provenance", async () => {
  const value = await fixture();
  try {
    for (const name of D1_SCHEMA_PATHS)
      put(value.root, name, `expected ${name}\n`);
    const projection = expectedD1Projection(value);
    put(value.runner, "d1-schema-projection.json", JSON.stringify(projection));
    const result = execute(value, "contracts", value.source, D1_MIGRATION);
    assert.equal(result.status, 0, result.stderr);
    const captured = output(value, "contracts");
    assert.deepEqual(
      captured.receipt.changed_paths,
      D1_SCHEMA_PATHS.toSorted(),
    );
    assert.deepEqual(captured.receipt.d1_schema_projection, projection);
    assert.ok(
      captured.receipt.commands.some(
        (entry: { command: string }) =>
          entry.command ===
          `node scripts/snapshot-d1-schema.ts --project-migrations ${D1_MIGRATION} --write`,
      ),
    );
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

test("Worker types and expected D1 projection preserve independent output scopes and command ordering", async () => {
  const value = await fixture();
  try {
    for (const name of [...WORKER_TYPE_PATHS, ...D1_SCHEMA_PATHS])
      put(value.root, name, `generated ${name}\n`);
    const projection = expectedD1Projection(value);
    put(value.runner, "d1-schema-projection.json", JSON.stringify(projection));
    const result = execute(
      value,
      "contracts",
      value.source,
      D1_MIGRATION,
      "true",
    );
    assert.equal(result.status, 0, result.stderr);
    const captured = output(value, "contracts");
    assert.equal(captured.receipt.worker_types, true);
    assert.deepEqual(captured.receipt.d1_schema_projection, projection);
    assert.deepEqual(
      captured.receipt.changed_paths,
      [...WORKER_TYPE_PATHS, ...D1_SCHEMA_PATHS].toSorted(),
    );
    assert.deepEqual(
      captured.receipt.commands.map(
        (entry: { command: string }) => entry.command,
      ),
      [
        "npm ci",
        "METAGRAPH_PRODUCTION_BUILD=0 METAGRAPH_PRESERVE_PROBE_HEALTH=1 npm run build",
        "npm run types:workers",
        `node scripts/snapshot-d1-schema.ts --project-migrations ${D1_MIGRATION} --write`,
        "npm run build --workspace=packages/client",
        "cd apps/ui && node scripts/generate-openapi-docs.ts",
      ],
    );
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

test("D1 schema paths remain refused without an explicit projection and truthful byte-bound receipt", async () => {
  const value = await fixture();
  try {
    for (const name of D1_SCHEMA_PATHS)
      put(value.root, name, `expected ${name}\n`);
    refused(value, "contracts", /Unexpected generation changes/);
    const projection = expectedD1Projection(value);
    for (const invalid of [
      { ...projection, live_readback: true },
      { ...projection, mode: "actual" },
      { ...projection, written: false },
      { ...projection, migrations: [] },
      { ...projection, baseline_sha256: {} },
      { ...projection, output_sha256: {} },
    ]) {
      put(value.runner, "d1-schema-projection.json", JSON.stringify(invalid));
      const result = execute(value, "contracts", value.source, D1_MIGRATION);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /D1 projection/);
      assert.equal(
        existsSync(path.join(value.runner, "generated-contract-output")),
        false,
      );
    }
    for (const [preset, names] of [
      ["logos", D1_MIGRATION],
      ["contracts", "../0039_x402_payment_attempts.sql"],
      ["contracts", `${D1_MIGRATION},${D1_MIGRATION}`],
    ]) {
      const result = execute(value, preset, value.source, names);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Invalid explicit D1 projection selection/);
    }
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

test("logo capture includes ignored binary additions and display deletions losslessly", async () => {
  const value = await fixture();
  try {
    const manifest = await writeDerivatives(path.join(value.root, LOGOS));
    const result = execute(value, "logos");
    assert.equal(result.status, 0, result.stderr);
    const captured = output(value, "logos");
    assert.equal(captured.receipt.worker_types, false);
    const png = `${LOGOS}/${manifest.entries[0].sharing_path}`;
    const deleted = `${LOGOS}/display/removed.webp`;
    const changed = [MANIFEST, IDENTITY, deleted, png].sort();
    assert.deepEqual(captured.receipt.changed_paths, changed);
    assert.equal(captured.receipt.output_sha256[deleted], null);
    assert.ok(captured.patch.includes(Buffer.from("GIT binary patch")));
    assert.equal(captured.receipt.manifest_entries, 1);
    assert.equal(captured.receipt.unique_sharing_paths, 1);
    const original = `${LOGOS}/mark.png`;
    const source = readFileSync(path.join(value.root, original));
    assert.equal(captured.receipt.original_sha256[original], hash(source));
    const bytes = readFileSync(path.join(value.root, png));
    assert.equal(captured.receipt.sharing_output_sha256[png], hash(bytes));
    const manifestBytes = readFileSync(path.join(value.root, MANIFEST));
    assert.equal(captured.receipt.manifest_sha256, hash(manifestBytes));
    const identityBytes = readFileSync(path.join(value.root, IDENTITY));
    const identityHash = hash(identityBytes);
    const identity = JSON.parse(identityBytes.toString("utf8"));
    assert.equal(identity.version, 1);
    assert.match(identity.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(captured.receipt.sharing_identity, identity);
    assert.equal(captured.receipt.sharing_identity_sha256, identityHash);
    assert.equal(captured.receipt.output_sha256[IDENTITY], identityHash);
    const display = `${LOGOS}/display/${manifest.entries[0].display_path}`;
    const displayBytes = readFileSync(path.join(value.root, display));
    const displayHash = captured.receipt.display_output_sha256[display];
    assert.equal(displayHash, hash(displayBytes));
    assert.deepEqual(captured.receipt.sharing_policy, manifest.sharing);
    const commands = captured.receipt.commands.map(
      (entry: { command: string }) => entry.command,
    );
    assert.deepEqual(commands, [
      "npm ci --ignore-scripts",
      "npm run build:logo-thumbnails",
      "npm run validate:logo-thumbnails",
    ]);
    const restored = path.join(value.base, "restored");
    const clone = ["clone", "-q", "--no-hardlinks", value.root, restored];
    execFileSync("git", clone);
    const patch = path.join(captured.directory, "generated-logo.patch");
    git(restored, "apply", "--binary", patch);
    for (const name of captured.receipt.changed_paths as string[]) {
      const file = path.join(restored, name);
      const expected = captured.receipt.output_sha256[name];
      if (expected === null) assert.equal(existsSync(file), false);
      else assert.equal(hash(readFileSync(file)), expected);
    }
    assert.deepEqual(readFileSync(path.join(restored, original)), source);
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

test("logo capture records the identity hash when generation is unchanged", async () => {
  const value = await fixture();
  try {
    await writeDerivatives(path.join(value.root, LOGOS));
    git(value.root, "add", "--force", LOGOS);
    git(
      value.root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "generated baseline",
    );
    value.source = git(value.root, "rev-parse", "HEAD").toString().trim();
    const identityBytes = readFileSync(path.join(value.root, IDENTITY));
    const result = execute(value, "logos");
    assert.equal(result.status, 0, result.stderr);
    const captured = output(value, "logos");
    assert.deepEqual(captured.receipt.changed_paths, []);
    assert.deepEqual(captured.receipt.output_sha256, {});
    assert.equal(captured.patch.byteLength, 0);
    const identity = JSON.parse(identityBytes.toString("utf8"));
    assert.equal(identity.version, 1);
    assert.match(identity.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(captured.receipt.sharing_identity, identity);
    assert.equal(captured.receipt.sharing_identity_sha256, hash(identityBytes));
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

test("logo capture refuses JSON outside the two exact display indexes", async () => {
  const value = await fixture();
  try {
    await writeDerivatives(path.join(value.root, LOGOS));
    const unexpected = [
      `${LOGOS}/display/unexpected.json`,
      `${LOGOS}/display/nested/sharing-identity.json`,
    ];
    for (const name of unexpected) {
      put(value.root, name, "{}\n");
      refused(value, "logos", /Unexpected logo output path/);
      rmSync(path.join(value.root, name));
    }
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

test("empty generation captures an empty patch rather than the whole diff", async () => {
  const value = await fixture();
  try {
    put(value.root, EXCLUDED_PATHS[0], "excluded drift\n");
    const result = execute(value, "contracts");
    assert.equal(result.status, 0, result.stderr);
    const captured = output(value, "contracts");
    assert.deepEqual(captured.receipt.changed_paths, []);
    assert.equal(captured.patch.byteLength, 0);
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

test("logo capture refuses a manifest hash detached from its PNG bytes", async () => {
  const value = await fixture();
  try {
    const manifest = await writeDerivatives(path.join(value.root, LOGOS));
    manifest.entries[0].sharing_sha256 = "0".repeat(64);
    put(value.root, MANIFEST, JSON.stringify(manifest));
    refused(value, "logos", /Manifest byte identity mismatch/);
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

test("capture refuses unknown presets, wrong source and cross-preset drift", async () => {
  const value = await fixture();
  try {
    refused(value, "unknown", /preset/i);
    const wrong = execute(value, "contracts", "0".repeat(40));
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /source HEAD|source|HEAD/i);
    put(value.root, "src/changed.ts", "source change\n");
    refused(value, "logos", /Unexpected generation changes/);
    rmSync(path.join(value.root, "src"), { recursive: true });
    put(value.root, CONTRACT_PATHS[0], "cross-preset drift\n");
    refused(value, "logos", /Unexpected generation changes/);
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

test("capture refuses symlink ancestors, symlink files and executable outputs", async () => {
  const value = await fixture();
  try {
    const target = path.join(value.root, CONTRACT_PATHS[0]);
    const outside = path.join(value.base, "outside.json");
    writeFileSync(outside, "external sentinel\n");
    rmSync(target);
    symlinkSync(outside, target);
    refused(value, "contracts", /Symlink/);
    rmSync(target);
    put(value.root, CONTRACT_PATHS[0], "generated\n");
    chmodSync(target, 0o755);
    refused(value, "contracts", /executable/i);
    chmodSync(target, 0o644);
    const docs = path.join(value.root, "apps/ui/content/docs/api-reference");
    rmSync(docs, { recursive: true });
    const externalDocs = path.join(value.base, "external-docs");
    mkdirSync(externalDocs);
    writeFileSync(path.join(externalDocs, "intro.mdx"), "external sentinel\n");
    symlinkSync(externalDocs, docs, "dir");
    refused(value, "contracts", /Symlink/);
    assert.equal(readFileSync(outside, "utf8"), "external sentinel\n");
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
});

for (const operation of ["modify", "delete"] as const) {
  test(`logo capture refuses ${operation} of a tracked sharing object`, async () => {
    const value = await fixture();
    try {
      const manifest = await writeDerivatives(path.join(value.root, LOGOS));
      git(value.root, "add", "--force", LOGOS);
      git(
        value.root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "generated baseline",
      );
      value.source = git(value.root, "rev-parse", "HEAD").toString().trim();
      const relative = manifest.entries[0].sharing_path;
      const file = path.join(value.root, LOGOS, relative);
      if (operation === "delete") rmSync(file);
      else writeFileSync(file, "changed immutable bytes");
      refused(value, "logos", /sharing|immutable/i);
    } finally {
      rmSync(value.base, { recursive: true, force: true });
    }
  });
}
