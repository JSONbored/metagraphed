// Regression coverage for #5476: schemas/provider-submission.schema.json was
// never compiled/enforced anywhere — validate-intake.mjs's
// checkExampleProviderSubmission() only did hand-rolled presence checks, so a
// direct-provider-profile.json example violating the real schema (bad
// submitted_by pattern, a stray top-level property, etc.) silently passed.
// validate-intake.mjs now compiles provider-submission.schema.json with ajv
// and validates the example fixture against it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { repoRoot } from "../scripts/lib.mjs";

const fixturePath = path.join(
  repoRoot,
  "docs/examples/submissions/direct-provider-profile.json",
);

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

describe("validate-intake.mjs: provider-submission schema enforcement", () => {
  let originalContents;

  afterEach(() => {
    if (originalContents !== undefined) {
      writeFileSync(fixturePath, originalContents);
      originalContents = undefined;
    }
  });

  test("passes on the unmodified example fixture", () => {
    const { status, output } = runNode(["scripts/validate-intake.mjs"]);
    assert.equal(status, 0, output);
  });

  test("fails when submitted_by violates the schema's pattern", () => {
    originalContents = readFileSync(fixturePath, "utf8");
    const document = JSON.parse(originalContents);
    document.submission.submitted_by = "bad user!";
    writeFileSync(fixturePath, JSON.stringify(document, null, 2));

    const { status, output } = runNode(["scripts/validate-intake.mjs"]);

    assert.equal(status, 1);
    assert.match(output, /submission\/submitted_by/);
    assert.match(output, /must match pattern/);
  });

  test("fails on a stray unknown top-level property", () => {
    originalContents = readFileSync(fixturePath, "utf8");
    const document = JSON.parse(originalContents);
    document.unexpected_field = "nope";
    writeFileSync(fixturePath, JSON.stringify(document, null, 2));

    const { status, output } = runNode(["scripts/validate-intake.mjs"]);

    assert.equal(status, 1);
    assert.match(output, /must NOT have additional properties/);
  });

  test("fails when provider.website_url is not a valid URI", () => {
    originalContents = readFileSync(fixturePath, "utf8");
    const document = JSON.parse(originalContents);
    document.provider.website_url = "not-a-url";
    writeFileSync(fixturePath, JSON.stringify(document, null, 2));

    const { status, output } = runNode(["scripts/validate-intake.mjs"]);

    assert.equal(status, 1);
    assert.match(output, /provider\/website_url/);
  });

  test("fails when provider.authority is outside the submission-narrowed set despite being schema-valid", () => {
    originalContents = readFileSync(fixturePath, "utf8");
    const document = JSON.parse(originalContents);
    // "official" is a valid value in provider.schema.json's full Authority
    // enum, but direct-provider-profile submissions are deliberately
    // narrowed to community/provider-claimed only.
    document.provider.authority = "official";
    writeFileSync(fixturePath, JSON.stringify(document, null, 2));

    const { status, output } = runNode(["scripts/validate-intake.mjs"]);

    assert.equal(status, 1);
    assert.match(output, /authority must be community or provider-claimed/);
  });
});
