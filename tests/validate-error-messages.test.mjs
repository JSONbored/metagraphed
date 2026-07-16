// Regression coverage for the enum-mismatch message clarity fix: both
// scripts/validate-surface.mjs and scripts/validate-schemas.mjs previously
// surfaced ajv's bare "must be equal to one of the allowed values" for an
// invalid `kind`, with no indication of what those values actually are.
// Both scripts now append the allowed-values list (and the offending value)
// to enum-keyword error messages.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("validate-surface.mjs enum error messages", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("lists the allowed kind values and the offending value on an invalid kind", async () => {
    const [sourceFile] = await listJsonFiles(
      path.join(repoRoot, "registry/subnets"),
    );
    const document = JSON.parse(readFileSync(sourceFile, "utf8"));
    assert.ok(
      Array.isArray(document.surfaces) && document.surfaces.length > 0,
      "fixture subnet file must have at least one surface",
    );
    document.surfaces[0].kind = "totally-invalid-kind";

    tempDir = mkdtempSync(`${tmpdir()}/metagraphed-validate-surface-`);
    const fixturePath = path.join(tempDir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify(document, null, 2));

    const { status, output } = runNode([
      "scripts/validate-surface.mjs",
      fixturePath,
    ]);

    assert.equal(status, 1);
    assert.match(output, /must be equal to one of the allowed values/);
    // The allowed-values list must actually be present, not just the bare
    // ajv message — this is the behavior being fixed.
    assert.match(output, /subnet-api/);
    assert.match(output, /data-artifact/);
    assert.match(output, /got "totally-invalid-kind"/);
  });
});

describe("validate-schemas.mjs enum error messages", () => {
  // Run ajv against an in-memory mutated clone — never write into
  // registry/subnets (that races parallel full-registry validators such as
  // validate-surface-duplicate-url).
  async function validateMutatedSubnet(mutate) {
    const subnetFiles = await listJsonFiles(
      path.join(repoRoot, "registry/subnets"),
    );
    let document;
    for (const file of subnetFiles) {
      const candidate = await readJson(file);
      document = structuredClone(candidate);
      if (mutate(document)) break;
      document = undefined;
    }
    assert.ok(document, "mutate() must select a suitable subnet fixture");

    const Ajv2020 = (await import("ajv/dist/2020.js")).default;
    const addFormats = (await import("ajv-formats")).default;
    const { formatAjvEnumErrorMessage } =
      await import("../scripts/lib/ajv-enum-error.mjs");
    const schema = await readJson(
      path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const ok = validate(document);
    assert.equal(ok, false);
    const messages = (validate.errors || []).map((error) =>
      formatAjvEnumErrorMessage(error, document),
    );
    return messages.join("\n");
  }

  test("lists the allowed kind values and the offending value on an invalid kind", async () => {
    const output = await validateMutatedSubnet((document) => {
      if (!Array.isArray(document.surfaces) || document.surfaces.length === 0) {
        return false;
      }
      document.surfaces[0].kind = "totally-invalid-kind";
      return true;
    });
    assert.match(output, /must be equal to one of the allowed values/);
    assert.match(output, /subnet-api/);
    assert.match(output, /data-artifact/);
    assert.match(output, /got "totally-invalid-kind"/);
  });

  // #5171: partnership.tier is a deliberately closed enum (just "pilot" today)
  // — a subnet claiming any other tier must be rejected the same way an
  // invalid surface kind is, with the allowed-values list surfaced.
  test("lists the allowed partnership.tier values and the offending value on an invalid tier", async () => {
    const output = await validateMutatedSubnet((document) => {
      if (!document.partnership) return false;
      document.partnership.tier = "sponsor";
      return true;
    });
    assert.match(output, /must be equal to one of the allowed values/);
    assert.match(output, /pilot/);
    assert.match(output, /got "sponsor"/);
  });
});
