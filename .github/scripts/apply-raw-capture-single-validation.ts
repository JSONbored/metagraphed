import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

async function main() {
  const fixture = ".github/fixtures/raw-capture-single-validation/";
  const base = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
  const digest = (value: Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
  const git = (args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  interface File {
    path: string;
    payload: string;
    sha256: string;
    bytes: number;
    expected_base_blob_sha?: string | null;
  }
  interface Variant {
    id: string;
    single_validation: boolean;
    number_layer: boolean;
    overrides: Record<string, Omit<File, "path">>;
  }
  const manifestBytes = readFileSync(fixture + "manifest.json");
  assert.ok(manifestBytes.length < 131_072);
  assert.equal(digest(manifestBytes), process.env.COMPARISON_MANIFEST_SHA256);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    base_commit: string;
    base_trees: Record<string, string>;
    carrier_files: string[];
    q8_files: File[];
    variants: Variant[];
    numeric_tests: File;
    v3_alias_tests: File;
    helper_pins: { path: string; bytes: number; sha256: string }[];
  };
  assert.deepEqual(
    manifest.helper_pins.map((item) => item.path),
    [
      ".github/scripts/apply-raw-capture-single-validation.ts",
      ".github/scripts/qualify-raw-capture-single-validation.ts",
      ".github/vitest.raw-single-validation.config.ts",
    ],
  );
  for (const item of manifest.helper_pins) {
    const actual = readFileSync(item.path);
    assert.equal(actual.length, item.bytes);
    assert.equal(digest(actual), item.sha256);
  }
  assert.equal(manifest.helper_pins.length, 3);
  const ids = ["q8", "q8-number", "v3", "v3-number"];
  assert.deepEqual(
    manifest.variants.map((item) => item.id),
    ids,
  );
  const variant = manifest.variants.find((item) => item.id === process.argv[2]);
  assert.ok(variant);
  assert.equal(manifest.base_commit, base);
  assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
  const head = git(["rev-parse", "HEAD"]);
  assert.equal(head, process.env.GITHUB_SHA);
  git(["merge-base", "--is-ancestor", base, head]);
  for (const [directory, tree] of Object.entries(manifest.base_trees)) {
    assert.ok(["src", "tests", "workers"].includes(directory));
    assert.equal(git(["rev-parse", head + ":" + directory]), tree);
    assert.equal(git(["rev-parse", base + ":" + directory]), tree);
  }
  assert.equal(Object.keys(manifest.base_trees).length, 3);
  assert.ok(
    manifest.carrier_files.every(
      (item) => item.startsWith(".github/") && !item.includes(".."),
    ),
  );
  assert.equal(
    new Set(manifest.carrier_files).size,
    manifest.carrier_files.length,
  );
  assert.deepEqual(
    git(["diff", "--name-only", base + "..." + head])
      .split("\n")
      .filter(Boolean)
      .sort(),
    [...manifest.carrier_files].sort(),
  );
  const paths = [
    "src/raw-capture-d1.ts",
    "src/raw-chain-capture.ts",
    "src/raw-capture-retry-intent.ts",
    "src/raw-capture-retry-store.ts",
    "tests/raw-capture-d1.test.ts",
    "tests/raw-chain-capture.test.ts",
    "tests/raw-capture-retry-intent.test.ts",
    "tests/raw-capture-retry-d1.test.ts",
    "tests/raw-capture-cron-wiring.test.ts",
  ];
  assert.deepEqual(
    manifest.q8_files.map((item) => item.path),
    paths,
  );
  const payload = (item: Omit<File, "path">) => {
    assert.ok(
      item.payload.startsWith(fixture) &&
        !item.payload.includes("..") &&
        item.payload.endsWith(".payload"),
    );
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(
      Number.isSafeInteger(item.bytes) &&
        item.bytes > 0 &&
        item.bytes < 256 * 1024,
    );
    const data = readFileSync(item.payload);
    assert.equal(data.length, item.bytes);
    assert.equal(digest(data), item.sha256);
    return data;
  };
  // Validate every layer and all canonical destinations before the first write.
  for (const layer of manifest.variants)
    for (const [destination, item] of Object.entries(layer.overrides)) {
      assert.ok(
        [
          "src/raw-capture-retry-intent.ts",
          "src/raw-capture-retry-store.ts",
        ].includes(destination),
      );
      payload(item);
    }
  const selected = manifest.q8_files.map((item) => {
    payload(item);
    if (item.expected_base_blob_sha === null)
      assert.equal(existsSync(item.path), false);
    else {
      assert.match(item.expected_base_blob_sha ?? "", /^[a-f0-9]{40}$/);
      assert.equal(
        git(["rev-parse", base + ":" + item.path]),
        item.expected_base_blob_sha,
      );
      const actual = readFileSync(item.path);
      assert.equal(
        createHash("sha1")
          .update("blob " + actual.length + "\0")
          .update(actual)
          .digest("hex"),
        item.expected_base_blob_sha,
      );
    }
    const selection = variant.overrides[item.path] ?? item;
    return {
      path: item.path,
      data: payload(selection),
      sha256: selection.sha256,
    };
  });
  for (const item of [
    manifest.numeric_tests,
    ...(variant.single_validation ? [manifest.v3_alias_tests] : []),
  ]) {
    assert.ok(
      [
        "tests/raw-capture-number-equivalence.test.ts",
        "tests/raw-capture-single-validation.test.ts",
      ].includes(item.path),
    );
    assert.equal(existsSync(item.path), false);
    selected.push({
      path: item.path,
      data: payload(item),
      sha256: item.sha256,
    });
  }
  assert.ok(
    selected.reduce((sum, item) => sum + item.data.length, 0) < 1024 * 1024,
  );
  for (const item of selected) {
    mkdirSync(path.dirname(item.path), { recursive: true });
    writeFileSync(item.path, item.data);
    assert.equal(digest(readFileSync(item.path)), item.sha256);
  }
  git(["add", "--", ...selected.map((item) => item.path)]);
  const receipt = {
    status: "runner_only_overlay_applied",
    variant: variant.id,
    source_head: head,
    canonical_base: base,
    manifest_sha256: digest(manifestBytes),
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    runner_index_tree: git(["write-tree"]),
    files: selected.map((item) => ({
      path: item.path,
      bytes: item.data.length,
      sha256: item.sha256,
    })),
    canonical_git_runtime_changed: false,
    remote_refs_changed: false,
    production_actions: false,
  };
  assert.equal(git(["rev-parse", "HEAD"]), head);
  mkdirSync("tmp/raw-capture-single-validation", { recursive: true });
  writeFileSync(
    "tmp/raw-capture-single-validation/applied.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: receipt.status,
      variant: variant.id,
      files: selected.length,
    }),
  );
}
await main().catch(() => {
  console.error(
    JSON.stringify({
      status: "failed",
      phase: "overlay",
      raw_output_retained: false,
    }),
  );
  process.exitCode = 1;
});
