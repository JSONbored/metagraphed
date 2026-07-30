// The live-computed/file-backed split for the public artifact catalog. Every
// entry that is computed per request from D1/KV/Postgres/RPC carries
// `computed: true` (the COMPUTED_LIVE options object in src/contracts.ts), and
// scripts/validate-schemas.ts derives its skip set from that flag via
// isComputedArtifact() instead of restating the same ~130 ids as a second
// hand-maintained Set.
//
// A flag is only as good as what checks it, so this pins it against two sources
// it cannot itself move: the independent storage tiering in
// src/artifact-storage.ts, and the files actually committed under
// public/metagraph. Sibling of tests/artifact-tiering-explicit.test.ts, which
// pins the tiering itself against the same catalog.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { PUBLIC_ARTIFACTS, isComputedArtifact } from "../src/contracts.ts";
import {
  ARTIFACT_STORAGE_TIERS,
  artifactRelativePath,
  artifactStorageTierForPath,
} from "../src/artifact-storage.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const computedEntries = PUBLIC_ARTIFACTS.filter((entry) => entry.computed);
const fileBackedEntries = PUBLIC_ARTIFACTS.filter((entry) => !entry.computed);

// Templated paths (/metagraph/subnets/{netuid}.json and friends) resolve to a
// whole directory of files rather than one, so the on-disk assertions below are
// scoped to the concrete single-file entries.
function isTemplated(artifactPath: string) {
  return artifactPath.includes("{");
}

function committedFilePath(artifactPath: string) {
  return path.join(
    repoRoot,
    "public/metagraph",
    artifactRelativePath(artifactPath),
  );
}

describe("live-computed artifacts are derived, not restated", () => {
  test("isComputedArtifact agrees with the catalog entries it is derived from", () => {
    for (const entry of PUBLIC_ARTIFACTS) {
      assert.equal(
        isComputedArtifact(entry.id),
        entry.computed,
        `isComputedArtifact("${entry.id}") disagrees with its own catalog entry`,
      );
    }
    // Both branches of the predicate are real cases, and an id that names no
    // artifact at all is not computed -- the stale-orphan state the old
    // standalone Set could silently reach after a rename.
    assert.ok(computedEntries.length > 0);
    assert.ok(fileBackedEntries.length > 0);
    assert.equal(isComputedArtifact("not-a-real-artifact-id"), false);
  });

  // Cross-check against a declaration this flag does not control: a route with
  // no file cannot be served from the committed (`git`) or committed-and-
  // mirrored (`dual`) tiers, both of which mean "these bytes are in the repo".
  test("every computed artifact tiers as r2, never git or dual", () => {
    const miscommitted = computedEntries
      .filter(
        (entry) =>
          artifactStorageTierForPath(entry.path) !== ARTIFACT_STORAGE_TIERS.r2,
      )
      .map(
        (entry) =>
          `${entry.id} (${entry.path}) -> ${artifactStorageTierForPath(entry.path)}`,
      );
    assert.deepEqual(
      miscommitted,
      [],
      `These artifacts are marked computed but tier as a committed artifact in ` +
        `src/artifact-storage.ts — one of the two declarations is wrong:\n  ` +
        `${miscommitted.join("\n  ")}`,
    );
  });

  // Reality, both directions, for the concrete single-file entries: a committed
  // artifact must be on disk and must not claim to be computed; a computed one
  // must have no committed file pretending otherwise.
  test("the flag agrees with what is actually committed under public/metagraph", () => {
    const committedEntries = fileBackedEntries.filter(
      (entry) =>
        !isTemplated(entry.path) &&
        artifactStorageTierForPath(entry.path) === ARTIFACT_STORAGE_TIERS.dual,
    );
    const concreteComputedEntries = computedEntries.filter(
      (entry) => !isTemplated(entry.path),
    );
    // Neither on-disk check may go vacuous: if a refactor ever empties one of
    // these populations, the assertion below would pass over nothing at all.
    assert.ok(committedEntries.length > 0);
    assert.ok(concreteComputedEntries.length > 0);

    const missing = committedEntries
      .filter((entry) => !existsSync(committedFilePath(entry.path)))
      .map((entry) => `${entry.id} (${entry.path})`);
    assert.deepEqual(
      missing,
      [],
      `These artifacts are file-backed and committed (dual tier) but have no ` +
        `file under public/metagraph:\n  ${missing.join("\n  ")}`,
    );

    const committedButComputed = concreteComputedEntries
      .filter((entry) => existsSync(committedFilePath(entry.path)))
      .map((entry) => `${entry.id} (${entry.path})`);
    assert.deepEqual(
      committedButComputed,
      [],
      `These artifacts are marked computed but a real file is committed for ` +
        `them under public/metagraph:\n  ${committedButComputed.join("\n  ")}`,
    );
  });
});
