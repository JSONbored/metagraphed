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

// candidate-surface.schema.json is self-contained (no $refs), so it validates
// standalone with ajv — the same shape as tests/provider-url-http-pattern.test.ts.
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
  // Surface is a Zod-owned OpenAPI component since types-epic B (#7860) --
  // schemas/components/04-surfaces.schema.json no longer defines it (see
  // .claude/skills/metagraphed/reference.md's Zod-owned-components note), so
  // the published contract (public/metagraph/openapi.json) is the
  // authoritative place to read it now. Compares REGEX BEHAVIOR, not the
  // exact `pattern` string: a JS RegExp literal's `.source` always
  // backslash-escapes `/` (src/openapi-sample.ts's valueForPattern has the
  // full explanation), so the emitted pattern is a differently-escaped but
  // functionally identical string to the original hand-typed one -- this
  // test's real guarantee is "the pattern still accepts http/ws, rejects
  // other schemes", which a string-equality check doesn't actually need.
  test("Surface.url and Surface.schema_url declare the http/ws pattern", async () => {
    const openapi = await readJson(
      path.join(repoRoot, "public/metagraph/openapi.json"),
    );
    const surface = openapi.components?.schemas?.Surface?.properties;
    assert.ok(surface, "openapi.json must define a Surface component");
    for (const field of ["url", "schema_url"] as const) {
      const pattern = surface[field]?.pattern;
      assert.ok(pattern, `Surface.${field} must declare a pattern`);
      const re = new RegExp(pattern);
      assert.equal(re.test("https://example.com"), true, field);
      assert.equal(re.test("wss://example.com"), true, field);
      assert.equal(re.test("ftp://example.com"), false, field);
      assert.equal(re.test("javascript:alert(1)"), false, field);
    }
  });
});
