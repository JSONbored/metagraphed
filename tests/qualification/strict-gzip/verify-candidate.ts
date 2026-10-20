import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_COMMIT = "6b8422966b1411dff6d7c486f4e9a549acecc761";
export const PRIMITIVE_COMMIT = "1c4518f8b4b6837f8978222bcab83c7a41ec9f7d";
export const WRANGLER_BIN_SOURCE = {
  repository: "cloudflare/workers-sdk",
  commit: "87fd28ce586693e50aa17d410f121394c5fef24c",
  path: "packages/wrangler/bin/wrangler.js",
  gitBlob: "774ecc2ce6ecdd77cfb3555d4af0daf825e4c66d",
  sha256: "780661a508810f3b65786895b1ca9aacbc4f55d329ae6b8c1e49ec8433569f77",
} as const;
export const PRIMITIVE_SHA256 =
  "5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec";
export const FOCUSED_TESTS = [
  "tests/sync-batch-compress.test.ts",
  "tests/sync-batch-decoded-limits.test.ts",
  "tests/sync-batch-strict-reader.test.ts",
  "tests/data-api-sync-queue-consumer.test.ts",
  "tests/sync-dead-letter-store.test.ts",
  "tests/data-api-sync-quarantine-isolate.test.ts",
  "tests/strict-gzip-reader.test.ts",
  "tests/strict-gzip-reader-coordinator.test.ts",
  "tests/strict-gzip-reader-isolate.test.ts",
  "tests/strict-gzip-host-guard.test.ts",
] as const;
interface ExpectedFile {
  path: string;
  baseGitBlob: string | null;
  sha256: string;
}
export interface ExpectedManifest {
  baseCommit: string;
  primitiveCommit: string;
  patchSha256: string;
  files: ExpectedFile[];
}
export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const here = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = realpathSync(path.resolve(here, "../../.."));

function inside(root: string, relative: string): string {
  assert.ok(relative && !path.isAbsolute(relative));
  assert.ok(!relative.split(/[\\/]/).includes(".."));
  const resolved = path.resolve(root, relative);
  assert.ok(resolved.startsWith(root + path.sep));
  return resolved;
}

function git(base: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", base, ...args], {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    maxBuffer: 32 * 1024 * 1024,
  });
}

function blobOfFile(file: string): string {
  const stat = lstatSync(file);
  assert.ok(
    stat.isFile() || stat.isSymbolicLink(),
    `Not a source file: ${file}`,
  );
  const bytes = stat.isSymbolicLink()
    ? Buffer.from(readlinkSync(file))
    : readFileSync(file);
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

export function verifyCandidate(
  candidateDirectory: string,
  baseDirectory: string,
  afterRun = false,
): { root: string; base: string; manifest: ExpectedManifest } {
  assert.ok(path.isAbsolute(candidateDirectory), "Candidate must be absolute");
  assert.ok(path.isAbsolute(baseDirectory), "Base must be absolute");
  const root = realpathSync(candidateDirectory);
  const base = realpathSync(baseDirectory);
  assert.notEqual(root, base, "Candidate must be a separate directory");
  assert.ok(!root.startsWith(base + path.sep));
  assert.notEqual(root, harnessRoot, "Do not test the production checkout");
  assert.ok(!root.startsWith(harnessRoot + path.sep));
  const manifest = JSON.parse(
    readFileSync(path.join(here, "expected-hashes.json"), "utf8"),
  ) as ExpectedManifest;
  assert.equal(manifest.baseCommit, BASE_COMMIT);
  assert.equal(manifest.primitiveCommit, PRIMITIVE_COMMIT);
  assert.match(manifest.patchSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    sha256(readFileSync(path.join(here, "integration.patch"))),
    manifest.patchSha256,
    "Patch identity changed",
  );
  // Local read-only Git operation; no fetch, credential helper, or remote call.
  const baseHead = git(base, ["rev-parse", "HEAD"]).toString().trim();
  assert.equal(baseHead, BASE_COMMIT, "Base checkout is not the pinned commit");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  const seen = new Set<string>();
  for (const file of manifest.files) {
    assert.equal(typeof file.path, "string");
    assert.ok(!seen.has(file.path), `Duplicate hash path: ${file.path}`);
    seen.add(file.path);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    const target = inside(root, file.path);
    assert.ok(realpathSync(target).startsWith(root + path.sep));
    assert.equal(
      sha256(readFileSync(target)),
      file.sha256,
      `Candidate identity changed: ${file.path}`,
    );
    if (file.baseGitBlob !== null) {
      assert.match(file.baseGitBlob, /^[0-9a-f]{40}$/);
      assert.equal(
        blobOfFile(inside(base, file.path)),
        file.baseGitBlob,
        `Base blob changed: ${file.path}`,
      );
    }
  }
  for (const required of [
    "src/strict-gzip-reader.ts",
    "src/sync-batch-compress.ts",
    "workers/data-api.ts",
    "wrangler.data.jsonc",
    "package.json",
    "package-lock.json",
    ...FOCUSED_TESTS,
  ])
    assert.ok(
      seen.has(required),
      `Required source identity missing: ${required}`,
    );
  assert.equal(
    sha256(readFileSync(path.join(root, "src/strict-gzip-reader.ts"))),
    PRIMITIVE_SHA256,
    "Reviewed primitive identity changed",
  );
  // Exact patch path allowlist: supplemental unchanged manifest entries cannot
  // authorize unrelated changes. Binary/rename/delete patches are not needed.
  const patchStats = git(base, [
    "apply",
    "--numstat",
    "-z",
    path.join(here, "integration.patch"),
  ]).toString();
  const patchPaths = new Set<string>();
  for (const entry of patchStats.split("\0").filter(Boolean)) {
    const match = /^(\d+)\t(\d+)\t(.+)$/.exec(entry);
    assert.ok(match, "Unsupported binary/rename patch shape");
    const changed = match[3]!;
    inside(root, changed);
    assert.ok(seen.has(changed), `Unlisted patch path: ${changed}`);
    assert.ok(!patchPaths.has(changed), `Duplicate patch path: ${changed}`);
    patchPaths.add(changed);
  }
  const expectedChanges = new Set(
    manifest.files
      .filter(
        (file) =>
          file.baseGitBlob === null ||
          sha256(readFileSync(inside(base, file.path))) !== file.sha256,
      )
      .map((file) => file.path),
  );
  assert.deepEqual([...patchPaths].sort(), [...expectedChanges].sort());
  const baseline = new Map<string, { mode: string; blob: string }>();
  for (const entry of git(base, ["ls-tree", "-r", "-z", BASE_COMMIT])
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const match = /^([0-7]+) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    assert.ok(match, "Unsupported baseline entry (for example, submodule)");
    const relative = match[3]!;
    baseline.set(relative, { mode: match[1]!, blob: match[2]! });
    const target = inside(root, relative);
    const stat = lstatSync(target);
    if (match[1] === "120000") {
      assert.ok(stat.isSymbolicLink(), `Baseline symlink changed: ${relative}`);
    } else {
      assert.ok(stat.isFile(), `Baseline file changed shape: ${relative}`);
      assert.equal(
        Boolean(stat.mode & 0o111),
        match[1] === "100755",
        `Baseline execute mode changed: ${relative}`,
      );
    }
    if (!patchPaths.has(relative))
      assert.equal(
        blobOfFile(target),
        match[2],
        `Unlisted source change: ${relative}`,
      );
  }
  // Do not follow links. Only the installed dependency tree is excluded before
  // execution; known temporary runtime directories may appear afterward.
  const ignored = new Set([
    "node_modules",
    ...(afterRun ? [".wrangler", ".mf", ".miniflare"] : []),
  ]);
  function inspectDirectory(directory: string, prefix = ""): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && ignored.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) inspectDirectory(target, relative);
      else {
        assert.ok(
          baseline.has(relative) || patchPaths.has(relative),
          `Extra unlisted candidate file: ${relative}`,
        );
        if (!baseline.has(relative)) {
          assert.ok(
            entry.isFile(),
            `Added source must be a regular file: ${relative}`,
          );
          assert.equal(
            lstatSync(target).mode & 0o111,
            0,
            `Unexpected executable: ${relative}`,
          );
        }
      }
    }
  }
  inspectDirectory(root);
  return { root, base, manifest };
}
