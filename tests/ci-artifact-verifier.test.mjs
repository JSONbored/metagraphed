import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  buildDeployOwnedMismatchMessage,
  canonicalArtifactJson,
  canonicalJson,
  isSubmittedPublicArtifactPath,
  partitionMismatches,
} from "../scripts/ci-verify-submitted-artifacts.ts";

test("submitted artifact verifier includes force-added public datasets", () => {
  assert.equal(
    isSubmittedPublicArtifactPath("public/datasets/providers.csv"),
    true,
  );
  assert.equal(
    isSubmittedPublicArtifactPath("public/metagraph/types.d.ts"),
    true,
  );
  assert.equal(
    isSubmittedPublicArtifactPath("registry/providers/x.json"),
    false,
  );
});

test("artifact canonical JSON ignores object key order", () => {
  assert.equal(
    canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("artifact canonical JSON preserves semantic array order", () => {
  assert.notEqual(
    canonicalJson({ rows: [{ netuid: 0 }, { netuid: 1 }, { netuid: 2 }] }),
    canonicalJson({ rows: [{ netuid: 2 }, { netuid: 1 }, { netuid: 0 }] }),
  );
});

test("artifact canonical JSON preserves __proto__ data properties", () => {
  const withProtoKey = JSON.parse('{"x":1,"__proto__":{"polluted":true}}');

  assert.notEqual(canonicalJson(withProtoKey), canonicalJson({ x: 1 }));
  assert.equal(
    canonicalJson(withProtoKey),
    '{"__proto__":{"polluted":true},"x":1}',
  );
});

test("R2 manifest comparison ignores only R2 aggregate byte drift", () => {
  const committed = {
    artifact_count: 1,
    artifact_size_bytes: 10,
    full_artifact_count: 3,
    full_artifact_size_bytes: 30,
    artifacts: [{ path: "/metagraph/types.d.ts", size_bytes: 10 }],
    storage_tier_size_bytes: { dual: 10, r2: 20 },
  };
  const rebuilt = {
    ...committed,
    full_artifact_size_bytes: 31,
    storage_tier_size_bytes: { dual: 10, r2: 21 },
  };
  assert.equal(
    canonicalArtifactJson("public/metagraph/r2-manifest.json", committed),
    canonicalArtifactJson("public/metagraph/r2-manifest.json", rebuilt),
  );
  assert.notEqual(
    canonicalArtifactJson("public/metagraph/coverage.json", committed),
    canonicalArtifactJson("public/metagraph/coverage.json", rebuilt),
  );
  assert.notEqual(
    canonicalArtifactJson("public/metagraph/r2-manifest.json", committed),
    canonicalArtifactJson("public/metagraph/r2-manifest.json", {
      ...rebuilt,
      storage_tier_size_bytes: { dual: 11, r2: 21 },
    }),
  );
});

test("partitionMismatches routes deploy-owned artifacts to their own bucket, from real PR #2667 data", () => {
  // PR #2667's actual failure: a count-field drift (registry growth between
  // the contributor's build and CI's, not tolerated by canonicalArtifactJson)
  // produced this exact mismatch entry, alongside an unrelated genuine
  // mismatch to make sure the two buckets don't cross-contaminate.
  const mismatches = [
    "public/metagraph/r2-manifest.json (content differs from a fresh build)",
    "public/metagraph/schemas/index.json (content differs from a fresh build)",
    "public/metagraph/coverage.json (content differs from a fresh build)",
  ];
  const { deployOwned, other } = partitionMismatches(mismatches);
  assert.deepEqual(deployOwned, [
    "public/metagraph/r2-manifest.json (content differs from a fresh build)",
    "public/metagraph/schemas/index.json (content differs from a fresh build)",
  ]);
  assert.deepEqual(other, [
    "public/metagraph/coverage.json (content differs from a fresh build)",
  ]);
});

test("partitionMismatches puts everything in `other` when nothing is deploy-owned", () => {
  const mismatches = [
    "public/metagraph/openapi.json (content differs from a fresh build)",
  ];
  const { deployOwned, other } = partitionMismatches(mismatches);
  assert.deepEqual(deployOwned, []);
  assert.deepEqual(other, mismatches);
});

test("buildDeployOwnedMismatchMessage recommends upstream/main on a fork checkout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wj-deploy-owned-msg-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync(
    "git",
    [
      "remote",
      "add",
      "origin",
      "https://github.com/contributor/metagraphed.git",
    ],
    { cwd: dir },
  );
  execFileSync(
    "git",
    [
      "remote",
      "add",
      "upstream",
      "https://github.com/JSONbored/metagraphed.git",
    ],
    { cwd: dir },
  );
  const message = buildDeployOwnedMismatchMessage(
    ["public/metagraph/r2-manifest.json (content differs from a fresh build)"],
    dir,
  );
  assert.match(message, /git checkout upstream\/main --/);
  assert.doesNotMatch(message, /git checkout origin\/main --/);
});

test("buildDeployOwnedMismatchMessage falls back to origin/main on a direct clone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wj-deploy-owned-msg-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/JSONbored/metagraphed.git"],
    { cwd: dir },
  );
  const message = buildDeployOwnedMismatchMessage(
    [
      "public/metagraph/schemas/index.json (content differs from a fresh build)",
    ],
    dir,
  );
  assert.match(message, /git checkout origin\/main --/);
});

test("R2 manifest comparison rejects invalid ignored byte totals", () => {
  const rebuilt = {
    artifact_count: 1,
    artifact_size_bytes: 10,
    full_artifact_count: 3,
    full_artifact_size_bytes: 30,
    artifacts: [{ path: "/metagraph/types.d.ts", size_bytes: 10 }],
    storage_tier_size_bytes: { dual: 10, r2: 20 },
  };
  const committed = {
    ...rebuilt,
    full_artifact_size_bytes: "30",
    storage_tier_size_bytes: { dual: 10, r2: { bytes: 20 } },
  };

  assert.notEqual(
    canonicalArtifactJson("public/metagraph/r2-manifest.json", committed),
    canonicalArtifactJson("public/metagraph/r2-manifest.json", rebuilt),
  );
});
