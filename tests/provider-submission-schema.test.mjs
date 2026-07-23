// #5476: provider-submission.schema.json documents the direct-provider-profile
// intake shape with real constraints (submitted_by / submitted_by_url patterns,
// additionalProperties:false at both levels, a nested provider that must satisfy
// provider.schema.json) but was never compiled/validated against anything — only
// validate-intake.mjs's weaker presence-only checks touched the fixture. These
// tests exercise the schema directly: the shipped example fixture must pass, and
// each class of violation the schema newly catches must fail.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readJson, repoRoot } from "../scripts/lib.ts";

const ajv = new Ajv2020({
  strict: false,
  validateFormats: true,
  allErrors: true,
});
addFormats(ajv);
for (const rel of [
  "schemas/components/01-enums.schema.json",
  "schemas/provider.schema.json",
  "schemas/provider-submission.schema.json",
]) {
  ajv.addSchema(await readJson(path.join(repoRoot, rel)));
}
const validate = ajv.getSchema(
  "https://metagraph.sh/schemas/provider-submission.schema.json",
);
const GOOD = await readJson(
  path.join(repoRoot, "docs/examples/submissions/direct-provider-profile.json"),
);

describe("provider-submission.schema.json enforcement (#5476)", () => {
  test("the shipped direct-provider-profile example fixture is valid", () => {
    assert.equal(validate(GOOD), true, JSON.stringify(validate.errors));
  });

  test("rejects an invalid submitted_by pattern (underscore)", () => {
    const bad = structuredClone(GOOD);
    bad.submission.submitted_by = "bad_underscore";
    assert.equal(validate(bad), false);
  });

  test("rejects a submitted_by_url that isn't a github.com/<user> URL", () => {
    const bad = structuredClone(GOOD);
    bad.submission.submitted_by_url = "https://gitlab.com/someone";
    assert.equal(validate(bad), false);
  });

  test("rejects an unknown extra top-level property (additionalProperties:false)", () => {
    const bad = structuredClone(GOOD);
    bad.stray = "nope";
    assert.equal(validate(bad), false);
  });

  test("rejects a non-URI provider.website_url", () => {
    const bad = structuredClone(GOOD);
    bad.provider.website_url = "not a url";
    assert.equal(validate(bad), false);
  });

  test("rejects an unknown provider.kind (not in the ProviderKind enum)", () => {
    const bad = structuredClone(GOOD);
    bad.provider.kind = "not-a-real-kind";
    assert.equal(validate(bad), false);
  });
});
