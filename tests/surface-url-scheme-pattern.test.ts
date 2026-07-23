// #5582: Surface.url / Surface.schema_url (and the candidate-surface url) were
// declared with `format: uri` only, which ajv-formats accepts for any RFC-3986
// scheme (javascript:, ftp:, mailto:, data:). scripts/validate.ts's isValidUrl
// already restricts these to http/https/ws/wss at runtime, so this closed the
// gap between the schema's documented contract and that enforcement. Unlike the
// Provider fix (#5553, http(s)-only), a Surface may legitimately point at a
// WebSocket RPC endpoint, so the pattern must also allow ws(s)://.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { readJson, repoRoot } from "../scripts/lib.ts";

const SCHEME_PATTERN = "^(?:[Hh][Tt][Tt][Pp][Ss]?|[Ww][Ss][Ss]?)://";

// candidate-surface.schema.json is self-contained (no $refs), so it validates
// standalone with ajv — the same shape as tests/provider-url-http-pattern.test.mjs.
const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;
const ajv = new Ajv2020({
  strict: false,
  validateFormats: true,
  allErrors: true,
});
addFormats(ajv);
const candidateSchema = await readJson(
  path.join(repoRoot, "schemas/candidate-surface.schema.json"),
);
const validateCandidate = ajv.compile(candidateSchema);

const GOOD_CANDIDATE = {
  schema_version: 1,
  id: "sn-1-example-api",
  netuid: 1,
  state: "verified",
  name: "Example API",
  kind: "subnet-api",
  url: "https://api.example.com",
  source_url: "https://github.com/example/repo",
  provider: "example",
  auth_required: false,
  public_safe: true,
};

describe("candidate-surface url scheme pattern (#5582)", () => {
  test("the known-good candidate fixture is valid", () => {
    assert.equal(
      validateCandidate(GOOD_CANDIDATE),
      true,
      JSON.stringify(validateCandidate.errors),
    );
  });

  for (const scheme of [
    "https://api.example.com",
    "http://api.example.com",
    "wss://rpc.example.com",
    "ws://rpc.example.com",
  ]) {
    test(`accepts a ${scheme.split(":")[0]}:// url`, () => {
      const good = { ...GOOD_CANDIDATE, url: scheme };
      assert.equal(
        validateCandidate(good),
        true,
        JSON.stringify(validateCandidate.errors),
      );
    });
  }

  for (const bad of [
    "mailto:ops@example.com",
    "ftp://files.example.com",
    "javascript:alert(1)",
    "data:text/plain,hi",
  ]) {
    test(`rejects a non-http/ws url (${bad.split(":")[0]}:)`, () => {
      const doc = { ...GOOD_CANDIDATE, url: bad };
      assert.equal(validateCandidate(doc), false);
    });
  }
});

describe("Surface component url/schema_url carry the http/ws scheme pattern (#5582)", () => {
  test("Surface.url and Surface.schema_url declare the http/ws pattern", async () => {
    const surfaces = await readJson(
      path.join(repoRoot, "schemas/components/04-surfaces.schema.json"),
    );
    const surface = surfaces.components?.schemas?.Surface?.properties;
    assert.ok(surface, "04-surfaces must define a Surface schema");
    assert.equal(surface.url?.pattern, SCHEME_PATTERN);
    assert.equal(surface.schema_url?.pattern, SCHEME_PATTERN);
  });
});
