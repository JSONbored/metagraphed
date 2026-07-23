// #5553: logo_url and social.* on the Provider schema carry an explicit
// http(s)-only `pattern` on top of `format: uri`, but the sibling URL fields
// website_url / docs_url / github_url / team_url / contact_url only had
// `format: uri` — which ajv-formats accepts for any RFC-3986 scheme
// (mailto:, ftp:, javascript:). scripts/validate.mjs's assertPublicHttpUrl
// already enforces http(s) uniformly across all nine fields at the mandatory
// gate, so this only closed a gap between the schema's own documented
// guarantee and that enforced behavior. These tests exercise the schema
// directly: a known-good provider passes, and a non-http(s) value in each of
// the five newly-patterned fields fails ajv validation.
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
]) {
  ajv.addSchema(await readJson(path.join(repoRoot, rel)));
}
const validate = ajv.getSchema(
  "https://metagraph.sh/schemas/provider.schema.json",
);
const submission = await readJson(
  path.join(repoRoot, "docs/examples/submissions/direct-provider-profile.json"),
);
const GOOD = submission.provider;

const PATTERNED_URL_FIELDS = [
  "website_url",
  "docs_url",
  "github_url",
  "team_url",
  "contact_url",
];

describe("Provider URL fields enforce http(s)-only (#5553)", () => {
  test("the known-good provider fixture is valid", () => {
    assert.equal(validate(GOOD), true, JSON.stringify(validate.errors));
  });

  for (const field of PATTERNED_URL_FIELDS) {
    test(`rejects a non-http(s) ${field} (mailto:)`, () => {
      const bad = { ...GOOD, [field]: "mailto:foo@example.com" };
      assert.equal(validate(bad), false);
    });

    test(`accepts an https ${field}`, () => {
      const good = { ...GOOD, [field]: "https://example.com/ok" };
      assert.equal(validate(good), true, JSON.stringify(validate.errors));
    });
  }
});
