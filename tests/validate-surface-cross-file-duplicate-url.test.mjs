// Regression coverage for #6328: validate-surface.mjs now fails when two
// different subnets register the identical per-subnet endpoint URL — the
// cross-file counterpart of the within-file duplicate check (#5737). The live
// instance: SN48 Quantum Compute and SN63 Enigma both pointed a subnet-api
// "health" surface at their operator's shared corporate-site liveness route.
// Mirrors validate-surface-duplicate-url.test.mjs's subprocess-fixture pattern.
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

function surface(id, kind, url) {
  return {
    id,
    kind,
    name: `Fixture ${id}`,
    url,
    provider: "academia",
    authority: "community",
    auth_required: false,
    public_safe: true,
    review: { state: "community-submitted" },
  };
}

describe("validate-surface.mjs cross-file duplicate-endpoint check", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function writeFixtures(...documents) {
    tempDir = mkdtempSync(`${tmpdir()}/metagraphed-validate-surface-xfile-`);
    return documents.map((doc) => {
      const document = {
        schema_version: 1,
        slug: `fixture-${doc.netuid}`,
        name: `Fixture Subnet ${doc.netuid}`,
        status: "active",
        categories: [],
        links: [],
        ...doc,
      };
      const fixturePath = path.join(tempDir, `fixture-${doc.netuid}.json`);
      writeFileSync(fixturePath, JSON.stringify(document, null, 2));
      return fixturePath;
    });
  }

  test("fails when two subnets register the identical subnet-api endpoint", () => {
    const fixturePaths = writeFixtures(
      {
        netuid: 998,
        surfaces: [
          surface(
            "fixture-998-health",
            "subnet-api",
            "https://api.fixture.example/health",
          ),
        ],
      },
      {
        netuid: 999,
        surfaces: [
          surface(
            "fixture-999-health",
            "subnet-api",
            "https://api.fixture.example/health",
          ),
        ],
      },
    );

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...fixturePaths,
    ]);

    assert.equal(status, 1);
    assert.match(
      output,
      /registered as a per-subnet endpoint by 2 different subnets/,
    );
    assert.match(output, /SN998 fixture-998-health/);
    assert.match(output, /SN999 fixture-999-health/);
  });

  test("catches the duplicate even when only a trailing slash differs", () => {
    const fixturePaths = writeFixtures(
      {
        netuid: 998,
        surfaces: [
          surface(
            "fixture-998-openapi",
            "openapi",
            "https://api.fixture.example/openapi.json",
          ),
        ],
      },
      {
        netuid: 999,
        surfaces: [
          surface(
            "fixture-999-openapi",
            "openapi",
            "https://api.fixture.example/openapi.json/",
          ),
        ],
      },
    );

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...fixturePaths,
    ]);

    assert.equal(status, 1);
    assert.match(
      output,
      /registered as a per-subnet endpoint by 2 different subnets/,
    );
  });

  test("allows one operator's shared website across two of its subnets", () => {
    // Deliberate: the #6328 data fix keeps www.qbittensorlabs.com registered as
    // a website surface on BOTH SN48 and SN63, because one operator legitimately
    // fronts several subnets from a single corporate site. Only the kinds that
    // answer "where does THIS subnet expose its mechanism" are exclusive.
    const fixturePaths = writeFixtures(
      {
        netuid: 998,
        surfaces: [
          surface(
            "fixture-998-website",
            "website",
            "https://lab.fixture.example/",
          ),
        ],
      },
      {
        netuid: 999,
        surfaces: [
          surface(
            "fixture-999-website",
            "website",
            "https://lab.fixture.example/",
          ),
        ],
      },
    );

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...fixturePaths,
    ]);

    assert.equal(status, 0, output);
  });

  test("passes when each subnet registers its own distinct endpoint", () => {
    const fixturePaths = writeFixtures(
      {
        netuid: 998,
        surfaces: [
          surface(
            "fixture-998-health",
            "subnet-api",
            "https://api-998.fixture.example/health",
          ),
        ],
      },
      {
        netuid: 999,
        surfaces: [
          surface(
            "fixture-999-health",
            "subnet-api",
            "https://api-999.fixture.example/health",
          ),
        ],
      },
    );

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      ...fixturePaths,
    ]);

    assert.equal(status, 0, output);
  });

  test("catches a collision with the registry when only the new file is validated", async () => {
    // The index spans the whole registry, not just the files under validation,
    // so the documented single-file lane (`validate:surface -- <one file>`)
    // still catches an endpoint copied from a subnet the contributor never
    // opened — instead of deferring it to CI, where the gate closes the PR.
    const files = await listJsonFiles(path.join(repoRoot, "registry/subnets"));
    let borrowed;
    for (const file of files) {
      const document = await readJson(file);
      const found = (document.surfaces || []).find(
        (entry) => entry.kind === "subnet-api" && typeof entry.url === "string",
      );
      if (found) {
        borrowed = { url: found.url, netuid: document.netuid };
        break;
      }
    }
    assert.ok(borrowed, "registry should contain at least one subnet-api URL");
    assert.notEqual(borrowed.netuid, 999);

    const [fixturePath] = writeFixtures({
      netuid: 999,
      surfaces: [surface("fixture-999-borrowed", "subnet-api", borrowed.url)],
    });

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    assert.equal(status, 1);
    assert.match(
      output,
      /registered as a per-subnet endpoint by 2 different subnets/,
    );
    assert.match(output, /fixture-999-borrowed/);
  });

  test("the full registry has no cross-file endpoint collisions", () => {
    // Sanity-check the check against real data: after the #6328 data fix,
    // running with no file args (validates every subnet file) must be clean.
    const { status, output } = runNode(["scripts/validate-surface.mjs"]);
    assert.equal(status, 0, output);
  });
});
