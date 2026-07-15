// Coverage for #5739: validate-surface.mjs now makes the reviewed-tier
// verified_at/source_urls convention non-silent. Reviewed-tier
// (maintainer-reviewed / adapter-backed) entries that drop verified_at or a
// surface's source_urls are surfaced as a NON-BLOCKING advisory, EXCEPT the
// acknowledged self-referential exemptions (netuid-0 base-layer overlay and
// partnership.tier "pilot" manifests), which are named instead of flagged.
// Mirrors validate-surface-duplicate-url.test.mjs's subprocess-fixture pattern.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { repoRoot } from "../scripts/lib.mjs";

// spawnSync (not execFileSync) so stderr is captured even on a passing run —
// the non-blocking convention advisory is written to stderr via console.warn.
function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("validate-surface.mjs reviewed-tier convention (#5739)", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function writeFixture(document) {
    tempDir = mkdtempSync(`${tmpdir()}/metagraphed-validate-surface-conv-`);
    const fixturePath = path.join(tempDir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(document, null, 2));
    return fixturePath;
  }

  const base = {
    schema_version: 1,
    netuid: 999,
    slug: "fixture",
    name: "Fixture Subnet",
    status: "active",
    categories: [],
    links: [],
    surfaces: [],
  };

  test("flags (advisory, not failing) a non-exempt reviewed-tier entry with null verified_at", () => {
    const fixturePath = writeFixture({
      ...base,
      curation: {
        level: "maintainer-reviewed",
        review_state: "maintainer-reviewed",
        verified_at: null,
      },
    });

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    // Advisory only — the entry is still valid, so the run must pass.
    assert.equal(status, 0, output);
    assert.match(output, /convention advisory/i);
    assert.match(output, /curation\.verified_at is null/);
  });

  test("flags a non-exempt reviewed-tier surface missing source_urls", () => {
    const fixturePath = writeFixture({
      ...base,
      curation: {
        level: "adapter-backed",
        review_state: "maintainer-reviewed",
        verified_at: "2026-06-06T00:00:00.000Z",
      },
      surfaces: [
        {
          id: "fixture-api",
          kind: "subnet-api",
          name: "Fixture API",
          url: "https://api.fixture.example/v1",
          provider: "academia",
          authority: "community",
          auth_required: false,
          public_safe: true,
          review: { state: "community-submitted" },
        },
      ],
    });

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    assert.equal(status, 0, output);
    assert.match(output, /convention advisory/i);
    assert.match(output, /lack source_urls/);
  });

  test("acknowledges (does not flag) a pilot manifest with the same gap", () => {
    const fixturePath = writeFixture({
      ...base,
      partnership: { tier: "pilot", since: "2026-07-04" },
      curation: {
        level: "adapter-backed",
        review_state: "maintainer-reviewed",
        verified_at: null,
      },
    });

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    assert.equal(status, 0, output);
    assert.match(output, /acknowledged exemption/i);
    assert.match(output, /pilot manifest/);
    assert.doesNotMatch(output, /convention advisory/i);
  });

  test("acknowledges the netuid-0 base-layer overlay as exempt", () => {
    const fixturePath = writeFixture({
      ...base,
      netuid: 0,
      name: "root",
      slug: "root",
      curation: {
        level: "maintainer-reviewed",
        review_state: "maintainer-reviewed",
        verified_at: null,
      },
    });

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    assert.equal(status, 0, output);
    assert.match(output, /base-layer overlay/);
    assert.doesNotMatch(output, /convention advisory/i);
  });

  test("the full registry has no non-exempt convention advisories today", () => {
    // Real-data sanity: the only reviewed-tier deviations in-repo are the
    // three acknowledged exemptions (root + two pilots), so a no-args run is
    // clean of advisories and exits 0.
    const { status, output } = runNode(["scripts/validate-surface.mjs"]);
    assert.equal(status, 0, output);
    assert.match(output, /acknowledged exemption/i);
    assert.doesNotMatch(output, /convention advisory/i);
  });
});
