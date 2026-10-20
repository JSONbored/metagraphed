import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const BASE_COMMIT = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
const FIXTURES = ".github/fixtures/raw-capture-full-validation/";
const MANIFEST = FIXTURES + "manifest.json";
const EXPECTED_PATHS = [
  "src/raw-capture-bulk-lease.ts",
  "src/raw-capture-d1.ts",
  "src/raw-capture-retry-intent.ts",
  "src/raw-capture-retry-store.ts",
  "src/raw-capture-rpc-policy.ts",
  "src/raw-capture-stream-prepare.ts",
  "src/raw-capture-sync.ts",
  "src/raw-chain-capture.ts",
  "tests/raw-capture-bulk-lease.test.ts",
  "tests/raw-capture-cron-wiring.test.ts",
  "tests/raw-capture-d1.test.ts",
  "tests/raw-capture-number-equivalence.test.ts",
  "tests/raw-capture-prepared-producer.test.ts",
  "tests/raw-capture-retry-d1.test.ts",
  "tests/raw-capture-retry-intent.test.ts",
  "tests/raw-capture-rpc-policy.test.ts",
  "tests/raw-capture-single-validation.test.ts",
  "tests/raw-capture-stream-native.test.ts",
  "tests/raw-capture-stream-prepare.test.ts",
  "tests/raw-chain-capture.test.ts",
];
const ALLOWED_CARRIER_FILES = new Set([
  ".github/scripts/apply-raw-capture-full-validation.ts",
  ".github/scripts/report-raw-capture-full-validation.ts",
  ".github/scripts/format-raw-capture-full-validation.ts",
  ".github/workflows/raw-capture-full-validation.yml",
  ".github/workflows/raw-capture-full-format.yml",
]);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const blobSha = (bytes: Uint8Array) =>
  createHash("sha1")
    .update(Buffer.from("blob " + bytes.byteLength + "\0"))
    .update(bytes)
    .digest("hex");
function git(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
interface Entry {
  path: string;
  sha256: string;
  expected_base_blob_sha: string | null;
  bytes: number;
  git_blob_sha: string;
  payload_path: string;
}
interface Manifest {
  format: number;
  payload_version: string;
  base_commit: string;
  base_tree: string;
  canonical_subtrees: Record<string, string>;
  maximum_total_payload_bytes: number;
  files: Entry[];
}

const root = realpathSync(process.cwd());
assert.equal(git(["rev-parse", "--show-toplevel"]), root);
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
const originalHead = git(["rev-parse", "HEAD"]);
const manifestBytes = readFileSync(MANIFEST);
const expectedManifest = process.env.FULL_VALIDATION_MANIFEST_SHA256;
assert.match(expectedManifest ?? "", /^[a-f0-9]{64}$/);
assert.equal(sha256(manifestBytes), expectedManifest);
const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
assert.equal(manifest.format, 1);
assert.equal(manifest.base_commit, BASE_COMMIT);
assert.equal(manifest.maximum_total_payload_bytes, 524_288);
assert.equal(git(["rev-parse", BASE_COMMIT + "^{tree}"]), manifest.base_tree);
git(["merge-base", "--is-ancestor", BASE_COMMIT, originalHead]);
assert.deepEqual(Object.keys(manifest.canonical_subtrees).sort(), [
  "src",
  "tests",
  "workers",
]);
for (const [directory, expected] of Object.entries(
  manifest.canonical_subtrees,
)) {
  assert.match(expected, /^[a-f0-9]{40}$/);
  assert.equal(git(["rev-parse", BASE_COMMIT + ":" + directory]), expected);
  assert.equal(git(["rev-parse", originalHead + ":" + directory]), expected);
}
const submitted = git(["diff", "--name-only", BASE_COMMIT, originalHead]);
for (const file of submitted ? submitted.split("\n") : []) {
  assert.ok(
    file.startsWith(FIXTURES) || ALLOWED_CARRIER_FILES.has(file),
    "Carrier changes must stay within the reviewed fixture/helper/workflow paths",
  );
}
assert.deepEqual(
  manifest.files.map((entry) => entry.path).sort(),
  [...EXPECTED_PATHS].sort(),
);
assert.equal(new Set(manifest.files.map((entry) => entry.path)).size, 20);
const pending = manifest.files.map((entry) => {
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.match(entry.git_blob_sha, /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
  assert.equal(
    entry.payload_path,
    FIXTURES + "candidate/" + entry.path + ".payload",
  );
  assert.ok(lstatSync(entry.payload_path).isFile());
  assert.ok(!lstatSync(entry.payload_path).isSymbolicLink());
  const bytes = readFileSync(entry.payload_path);
  assert.equal(bytes.byteLength, entry.bytes);
  assert.equal(sha256(bytes), entry.sha256);
  assert.equal(blobSha(bytes), entry.git_blob_sha);
  const parent = realpathSync(path.dirname(entry.path));
  assert.ok(parent.startsWith(root + path.sep));
  if (entry.expected_base_blob_sha === null) {
    assert.ok(!existsSync(entry.path));
    assert.equal(
      git(["ls-tree", BASE_COMMIT, "--", entry.path]),
      "",
      "A new payload destination must be absent from canonical main",
    );
  } else {
    assert.match(entry.expected_base_blob_sha, /^[a-f0-9]{40}$/);
    assert.equal(
      git(["rev-parse", BASE_COMMIT + ":" + entry.path]),
      entry.expected_base_blob_sha,
    );
    assert.ok(lstatSync(entry.path).isFile());
    assert.ok(!lstatSync(entry.path).isSymbolicLink());
    assert.equal(
      blobSha(readFileSync(entry.path)),
      entry.expected_base_blob_sha,
    );
  }
  return { entry, bytes };
});
assert.ok(
  pending.reduce((sum, item) => sum + item.bytes.byteLength, 0) <=
    manifest.maximum_total_payload_bytes,
);
assert.equal(git(["rev-parse", "HEAD"]), originalHead);

// All sources and destinations were checked before the first write. This is
// an ephemeral runner overlay; no branch/ref is moved and no network is used.
for (const { entry, bytes } of pending) writeFileSync(entry.path, bytes);
git(["add", "--", ...EXPECTED_PATHS]);
const staged = git(["diff", "--cached", "--name-only"]);
assert.deepEqual(staged.split("\n").sort(), [...EXPECTED_PATHS].sort());
// Git-ref validators need a candidate object, rather than the canonical HEAD.
// Build that unpublished object from a separate base-seeded index, so the
// virtual candidate contains the twenty source edits and no carrier files.
mkdirSync("tmp/raw-capture-full-validation", { recursive: true });
const candidateIndex = path.join(
  root,
  "tmp/raw-capture-full-validation/candidate.index",
);
assert.ok(!existsSync(candidateIndex));
const virtualEnvironment = { ...process.env, GIT_INDEX_FILE: candidateIndex };
let candidateTree: string;
try {
  git(["read-tree", BASE_COMMIT], virtualEnvironment);
  for (const { entry } of pending)
    git(
      [
        "update-index",
        "--add",
        "--cacheinfo",
        "100644," + entry.git_blob_sha + "," + entry.path,
      ],
      virtualEnvironment,
    );
  candidateTree = git(["write-tree"], virtualEnvironment);
} finally {
  rmSync(candidateIndex, { force: true });
}
assert.deepEqual(
  git(["diff", "--name-only", BASE_COMMIT, candidateTree]).split("\n").sort(),
  [...EXPECTED_PATHS].sort(),
);
const virtualCommit = execFileSync(
  "git",
  ["commit-tree", candidateTree, "-p", BASE_COMMIT],
  {
    input: "test: inspect provisional raw capture candidate\n",
    encoding: "utf8",
    maxBuffer: 65_536,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Validation Fixture",
      GIT_AUTHOR_EMAIL: "validation@example.invalid",
      GIT_AUTHOR_DATE: "2026-10-20T00:00:00Z",
      GIT_COMMITTER_NAME: "Validation Fixture",
      GIT_COMMITTER_EMAIL: "validation@example.invalid",
      GIT_COMMITTER_DATE: "2026-10-20T00:00:00Z",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
).trim();
assert.match(virtualCommit, /^[a-f0-9]{40}$/);
assert.equal(git(["rev-parse", "HEAD"]), originalHead);
assert.equal(git(["rev-parse", virtualCommit + "^{tree}"]), candidateTree);
for (const { entry } of pending) {
  assert.equal(sha256(readFileSync(entry.path)), entry.sha256);
  assert.equal(
    git(["rev-parse", virtualCommit + ":" + entry.path]),
    entry.git_blob_sha,
  );
}
const patch = execFileSync(
  "git",
  [
    "diff",
    "--no-ext-diff",
    "--unified=0",
    BASE_COMMIT,
    virtualCommit,
    "--",
    "src",
    "workers",
  ],
  { encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
);
mkdirSync("tmp/raw-capture-full-validation", { recursive: true });
writeFileSync("tmp/raw-capture-full-validation/runtime.patch", patch);
const receipt = {
  status: "overlay_applied_not_qualified",
  payload_version: manifest.payload_version,
  source_head: originalHead,
  canonical_base: BASE_COMMIT,
  candidate_virtual_commit: virtualCommit,
  candidate_tree: candidateTree,
  manifest_sha256: expectedManifest,
  runtime_patch_sha256: sha256(Buffer.from(patch)),
  run_id: process.env.GITHUB_RUN_ID ?? null,
  run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  files: manifest.files.map(({ path: file, sha256, git_blob_sha, bytes }) => ({
    path: file,
    sha256,
    git_blob_sha,
    bytes,
  })),
  remote_refs_changed: false,
  production_actions: false,
  raw_output_retained: false,
};
writeFileSync(
  "tmp/raw-capture-full-validation/overlay-receipt.json",
  JSON.stringify(receipt, null, 2) + "\n",
);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    "candidate_commit=" +
      virtualCommit +
      "\n" +
      "candidate_tree=" +
      candidateTree +
      "\n" +
      "canonical_base=" +
      BASE_COMMIT +
      "\n" +
      "manifest_sha256=" +
      expectedManifest +
      "\n",
  );
}
console.log(
  JSON.stringify({
    status: receipt.status,
    payload_version: manifest.payload_version,
    files: pending.length,
    manifest_sha256: expectedManifest,
    remote_refs_changed: false,
  }),
);
