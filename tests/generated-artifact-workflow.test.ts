import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
  for (const name of [...CONTRACT_PATHS, ...EXCLUDED_PATHS]) {
    if (name !== NEW_CONTRACT) put(root, name, `committed ${name}\n`);
  }
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

function execute(value: Fixture, preset?: string, source = value.source) {
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
  if (preset !== undefined) env.ARTIFACT_PRESET = preset;
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
    "mode",
    "source_sha",
  ]);
  assert.deepEqual(inputs.mode.options, [
    "sync",
    "generate-only",
    "resolve-lock",
  ]);
  assert.equal(inputs.mode.default, "sync");
  assert.deepEqual(inputs.artifact_preset.options, ["contracts", "logos"]);
  assert.equal(inputs.artifact_preset.default, "contracts");
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

test("logo capture includes ignored binary additions and display deletions losslessly", async () => {
  const value = await fixture();
  try {
    const manifest = await writeDerivatives(path.join(value.root, LOGOS));
    const result = execute(value, "logos");
    assert.equal(result.status, 0, result.stderr);
    const captured = output(value, "logos");
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
