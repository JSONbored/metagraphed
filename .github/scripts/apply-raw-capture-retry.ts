import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const base = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
const paths = [
  "src/raw-capture-d1.ts", "src/raw-chain-capture.ts",
  "src/raw-capture-retry-intent.ts", "src/raw-capture-retry-store.ts",
  "tests/raw-capture-d1.test.ts", "tests/raw-chain-capture.test.ts",
  "tests/raw-capture-retry-intent.test.ts", "tests/raw-capture-retry-d1.test.ts",
  "tests/raw-capture-cron-wiring.test.ts",
];
const manifestPath = ".github/fixtures/raw-capture-retry/manifest.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  version: number; base_commit: string; scope: string;
  carrier_files: string[];
  baseline: { path: string; sha256: string; bytes: number };
  files: { path: string; payload: string; sha256: string; bytes: number; expected_base_blob_sha: string | null }[];
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
assert.equal(manifest.version, 1);
assert.equal(manifest.base_commit, base);
assert.deepEqual(manifest.files.map((file) => file.path), paths);
assert.equal(manifest.carrier_files.length, 15);
assert.equal(new Set(manifest.carrier_files).size, 15);
assert(manifest.carrier_files.every((path) => path.startsWith(".github/") && !path.includes("..")));
git("merge-base", "--is-ancestor", base, "HEAD");
const changed = git("diff", "--name-only", base + "...HEAD").split("\n").filter(Boolean).sort();
assert.deepEqual(changed, [...manifest.carrier_files].sort());
const head = git("rev-parse", "HEAD");
assert.equal(process.env.GITHUB_SHA, head);
assert.equal(manifest.baseline.path, ".github/fixtures/raw-capture-retry/baseline.test.ts.payload");
const baseline = readFileSync(manifest.baseline.path);
assert.equal(manifest.baseline.sha256, "8315db29336d73c8eba07b12770b1dcf211f40aa1a2a425ba0e8f6c2775a92a8");
assert.equal(baseline.byteLength, manifest.baseline.bytes);
assert.equal(sha256(baseline), manifest.baseline.sha256);
let total = 0;
const verified = manifest.files.map((file) => {
  assert.equal(file.payload, ".github/fixtures/raw-capture-retry/" + file.path + ".payload");
  assert(/^[a-f0-9]{64}$/.test(file.sha256));
  assert(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes < 256 * 1024);
  total += file.bytes;
  const bytes = readFileSync(file.payload);
  assert.equal(bytes.byteLength, file.bytes);
  assert.equal(sha256(bytes), file.sha256);
  if (file.expected_base_blob_sha === null) assert.equal(existsSync(file.path), false);
  else {
    assert(/^[a-f0-9]{40}$/.test(file.expected_base_blob_sha));
    assert.equal(git("rev-parse", base + ":" + file.path), file.expected_base_blob_sha);
    const canonical = readFileSync(file.path);
    const blob = createHash("sha1").update("blob " + canonical.byteLength + "\0").update(canonical).digest("hex");
    assert.equal(blob, file.expected_base_blob_sha);
  }
  return { file, bytes };
});
assert(total < 1024 * 1024);
for (const {file, bytes} of verified) {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, bytes);
  assert.equal(sha256(readFileSync(file.path)), file.sha256);
}
// New runtime files must participate in git-ls-files source validators too.
// This changes only the disposable runner index; HEAD and remote refs stay put.
git("add", "--", ...paths);
const runnerIndexTree = git("write-tree");
assert.equal(git("rev-parse", "HEAD"), head);
mkdirSync("raw-capture-retry-reports", { recursive: true });
const receipt = {
  phase: "runner_only_candidate_applied", source_commit: head, canonical_base: base,
  canonical_git_runtime_changed: false, candidate_files: Object.fromEntries(manifest.files.map((file) => [file.path, file.sha256])),
  runner_index_tree: runnerIndexTree, runner_index_has_candidate: true, remote_refs_changed: false,
  source_payload_bytes: total, production_actions: false, raw_output_retained: false,
};
writeFileSync("raw-capture-retry-reports/applied-receipt.json", JSON.stringify(receipt,null,2)+"\n");
console.log(JSON.stringify(receipt));
