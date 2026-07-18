// Regression coverage for #6328: validate-surface.mjs now also fails when two
// DIFFERENT netuids register the identical URL — the cross-file counterpart of
// the within-file check (#5737). SN48 (Quantum Compute) and SN63 (Enigma) both
// registered https://www.qbittensorlabs.com/api/health as their own subnet-api,
// which the per-file check could never see. Mirrors that suite's
// subprocess-fixture pattern.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { listJsonFiles, readJson, repoRoot } from "../scripts/lib.mjs";

function runNode(args) {
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, output: stdout };
  } catch (err) {
    return {
      status: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

function surface(id, url, kind = "subnet-api") {
  return {
    id,
    kind,
    name: id,
    url,
    provider: "academia",
    authority: "community",
    auth_required: false,
    public_safe: true,
    review: { state: "community-submitted" },
  };
}

describe("validate-surface.mjs cross-file duplicate-URL check (#6328)", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  // Two separate subnet files, each a valid document on its own -- the bug is
  // only visible when both are in the same run.
  function writeTwoFixtures(netuidA, surfacesA, netuidB, surfacesB) {
    tempDir = mkdtempSync(`${tmpdir()}/metagraphed-validate-surface-xfile-`);
    const write = (netuid, slug, surfaces) => {
      const document = {
        schema_version: 1,
        netuid,
        slug,
        name: `Fixture Subnet ${netuid}`,
        status: "active",
        categories: [],
        links: [],
        surfaces,
      };
      const file = path.join(tempDir, `${slug}.json`);
      writeFileSync(file, JSON.stringify(document, null, 2));
      return file;
    };
    return [
      write(netuidA, "fixture-a", surfacesA),
      write(netuidB, "fixture-b", surfacesB),
    ];
  }

  test("fails when two different netuids register the identical URL", () => {
    const files = writeTwoFixtures(
      998,
      [surface("fixture-a-health", "https://api.fixture.example/health")],
      999,
      [surface("fixture-b-health", "https://api.fixture.example/health")],
    );

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...files,
    ]);

    assert.equal(status, 1);
    assert.match(output, /https:\/\/api\.fixture\.example\/health/);
    assert.match(output, /2 different netuids/);
    // The message must name both claimants so the fix is obvious.
    assert.match(output, /fixture-a-health/);
    assert.match(output, /fixture-b-health/);
    assert.match(output, /998/);
    assert.match(output, /999/);
  });

  test("normalizes before comparing: a trailing-slash-only difference still fails", () => {
    const files = writeTwoFixtures(
      998,
      [surface("fixture-a-api", "https://api.fixture.example/status")],
      999,
      [surface("fixture-b-api", "https://api.fixture.example/status/")],
    );

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...files,
    ]);

    assert.equal(status, 1);
    assert.match(output, /2 different netuids/);
  });

  test("a URL on the shared-operator allowlist is accepted across netuids", () => {
    // qBittensor Labs genuinely runs SN48 and SN63, so its corporate site is
    // each subnet's real website -- the one shape that must NOT be an error.
    const files = writeTwoFixtures(
      998,
      [surface("fixture-a-site", "https://www.qbittensorlabs.com/", "website")],
      999,
      [surface("fixture-b-site", "https://www.qbittensorlabs.com/", "website")],
    );

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...files,
    ]);

    assert.equal(status, 0, output);
    assert.match(output, /Surface validation passed/);
  });

  test("the same netuid across a re-run is not a cross-file duplicate", () => {
    // Only DISTINCT netuids conflict; one subnet's own file is the within-file
    // check's job, not this one's.
    const files = writeTwoFixtures(
      999,
      [surface("fixture-a-api", "https://api.fixture.example/one")],
      999,
      [surface("fixture-b-api", "https://api.fixture.example/one")],
    );

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...files,
    ]);

    assert.equal(status, 0, output);
  });

  test("a single-file run never reports a cross-file duplicate", () => {
    // `validate:surface -- registry/subnets/x.json` can only see one document,
    // so it must not guess about what another netuid claims.
    const files = writeTwoFixtures(
      998,
      [surface("fixture-a-health", "https://api.fixture.example/health")],
      999,
      [surface("fixture-b-health", "https://api.fixture.example/health")],
    );

    const { status } = runNode(["scripts/validate-surface.mjs", files[0]]);

    assert.equal(status, 0);
  });

  test("SN48 and SN63 no longer both claim the qBittensor health endpoint", async () => {
    // The concrete data fix: the shared corporate website stays on both (the
    // operator runs both subnets), but the health endpoint is SN63's only --
    // SN48 is accessed through Open Quantum, per its own docs surface.
    const enigma = await readJson(
      path.join(repoRoot, "registry/subnets/enigma.json"),
    );
    const quantum = await readJson(
      path.join(repoRoot, "registry/subnets/quantum-compute.json"),
    );
    const urls = (document) => (document.surfaces || []).map((s) => s.url);
    const HEALTH = "https://www.qbittensorlabs.com/api/health";
    assert.ok(urls(enigma).includes(HEALTH));
    assert.ok(!urls(quantum).includes(HEALTH));
    // The website is legitimately shared and must survive the dedupe.
    assert.ok(urls(enigma).includes("https://www.qbittensorlabs.com/"));
    assert.ok(urls(quantum).includes("https://www.qbittensorlabs.com/"));
  });

  test("the whole registry is free of cross-file duplicate URLs", async () => {
    const files = await listJsonFiles(path.join(repoRoot, "registry/subnets"));
    assert.ok(files.length > 1);
    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...files,
    ]);
    assert.equal(status, 0, output);
  });
});
