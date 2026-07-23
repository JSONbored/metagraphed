// #6327: subnet-manifest.schema.json is the schema scripts/validate-surface.ts
// (the fast contributor-facing pre-push gate) actually ajv.compile()s, but its
// surface url/schema_url and top-level identity URLs were `format: uri` only —
// which ajv-formats accepts for ANY scheme (javascript:, mailto:, ftp:, data:).
// #5618 added the http/ws scheme pattern to the sibling Surface + candidate
// schemas but never this one, so `npm run validate:surface` passed a subnet file
// carrying a javascript: URL. Mirrors tests/surface-url-scheme-pattern.test.mjs.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { readJson, repoRoot } from "../scripts/lib.ts";

const SURFACE_PATTERN = "^(?:[Hh][Tt][Tt][Pp][Ss]?|[Ww][Ss][Ss]?)://";
const IDENTITY_PATTERN = "^[Hh][Tt][Tt][Pp][Ss]?://";

// subnet-manifest.schema.json is self-contained (no $refs), so it compiles
// standalone with ajv — the exact setup scripts/validate-surface.ts uses.
const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;
const ajv = new Ajv2020({
  strict: false,
  validateFormats: true,
  allErrors: true,
});
addFormats(ajv);
const manifestSchema = await readJson(
  path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
);
const validate = ajv.compile(manifestSchema);

const GOOD_MANIFEST = {
  schema_version: 1,
  netuid: 1,
  name: "Example Subnet",
  slug: "example-subnet",
  status: "active",
  categories: ["compute"],
  surfaces: [
    {
      id: "sn-1-example-api",
      name: "Example API",
      kind: "subnet-api",
      url: "https://api.example.com",
      provider: "example",
      auth_required: false,
      authority: "provider-claimed",
      public_safe: true,
    },
  ],
};

const withSurface = (patch: Record<string, unknown>) => ({
  ...GOOD_MANIFEST,
  surfaces: [{ ...GOOD_MANIFEST.surfaces[0], ...patch }],
});

describe("subnet-manifest surface url scheme pattern (#6327)", () => {
  test("the known-good manifest fixture is valid", () => {
    assert.equal(
      validate(GOOD_MANIFEST),
      true,
      JSON.stringify(validate.errors),
    );
  });

  for (const scheme of [
    "https://api.example.com",
    "http://api.example.com",
    "wss://rpc.example.com",
    "ws://rpc.example.com",
  ]) {
    test(`surface.url accepts a ${scheme.split(":")[0]}:// url`, () => {
      assert.equal(
        validate(withSurface({ url: scheme })),
        true,
        JSON.stringify(validate.errors),
      );
    });
  }

  for (const bad of [
    "mailto:ops@example.com",
    "ftp://files.example.com",
    "javascript:alert(1)",
    "data:text/plain,hi",
  ]) {
    test(`surface.url rejects a non-http/ws url (${bad.split(":")[0]}:)`, () => {
      assert.equal(validate(withSurface({ url: bad })), false);
    });
  }

  test("surface.schema_url rejects a javascript: url", () => {
    assert.equal(
      validate(withSurface({ schema_url: "javascript:alert(1)" })),
      false,
    );
  });
});

describe("subnet-manifest top-level identity URLs are http(s)-only (#6327)", () => {
  for (const field of [
    "docs_url",
    "website_url",
    "source_repo",
    "dashboard_url",
  ]) {
    test(`${field} rejects a non-http(s) url`, () => {
      assert.equal(
        validate({ ...GOOD_MANIFEST, [field]: "javascript:alert(1)" }),
        false,
      );
    });
    test(`${field} accepts an https url`, () => {
      assert.equal(
        validate({ ...GOOD_MANIFEST, [field]: "https://example.com" }),
        true,
        JSON.stringify(validate.errors),
      );
    });
  }
});

describe("subnet-manifest schema declares the scheme patterns (#6327)", () => {
  test("surface url/schema_url + the 4 identity URLs carry the pattern", async () => {
    const schema = await readJson(
      path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
    );
    const surface = schema.$defs?.surface?.properties;
    assert.equal(surface?.url?.pattern, SURFACE_PATTERN);
    assert.equal(surface?.schema_url?.pattern, SURFACE_PATTERN);
    for (const field of [
      "docs_url",
      "website_url",
      "source_repo",
      "dashboard_url",
    ]) {
      assert.equal(schema.properties?.[field]?.pattern, IDENTITY_PATTERN);
    }
  });
});
