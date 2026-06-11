import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  stripUrls,
  cleanDescription,
  subnetLifecycle,
  extractAuth,
} from "../scripts/lib.mjs";

describe("stripUrls", () => {
  test("removes http(s) URLs, emails, and bare domains", () => {
    assert.equal(stripUrls("see https://example.com/x now"), "see now");
    assert.equal(stripUrls("ping me@foo.io please"), "ping please");
    assert.equal(stripUrls("join discord.gg/abc today"), "join today");
    assert.equal(stripUrls("hello lium.io world"), "hello world");
  });
  test("collapses whitespace and tolerates non-strings", () => {
    assert.equal(stripUrls("  a   b  "), "a b");
    assert.equal(stripUrls(null), "");
    assert.equal(stripUrls(42), "");
  });
});

describe("cleanDescription", () => {
  test("returns null for empty/short/non-string", () => {
    assert.equal(cleanDescription(""), null);
    assert.equal(cleanDescription("a"), null);
    assert.equal(cleanDescription(null), null);
    assert.equal(cleanDescription("https://only-a-url.com"), null);
  });
  test("normalizes real descriptions", () => {
    assert.equal(
      cleanDescription("  Autonomous   software   development  "),
      "Autonomous software development",
    );
    assert.equal(
      cleanDescription("Inference network — see https://x.io for docs"),
      "Inference network — see for docs",
    );
  });
});

describe("subnetLifecycle", () => {
  const withName = (name, description = "") => ({
    chain_identity: { subnet_name: name, description },
  });
  test("detects deprecated / parked / pending from the chain identity", () => {
    assert.equal(subnetLifecycle(withName("deprecated")), "deprecated");
    assert.equal(subnetLifecycle(withName("Parked")), "parked");
    assert.equal(subnetLifecycle(withName("Pending")), "pending");
  });
  test("reads the description field too", () => {
    assert.equal(
      subnetLifecycle(withName("Foo", "this subnet is deprecated")),
      "deprecated",
    );
  });
  test("defaults to active for live subnets and missing identity", () => {
    assert.equal(
      subnetLifecycle(withName("Gittensor", "autonomous dev")),
      "active",
    );
    assert.equal(subnetLifecycle({}), "active");
    assert.equal(subnetLifecycle(null), "active");
  });
});

describe("extractAuth", () => {
  test("flags auth from OpenAPI 3 securitySchemes", () => {
    assert.deepEqual(
      extractAuth({
        components: { securitySchemes: { ApiKeyHeader: { type: "apiKey" } } },
      }),
      { auth_required: true, auth_schemes: ["apiKey"] },
    );
  });
  test("flags auth from Swagger 2 securityDefinitions", () => {
    assert.deepEqual(
      extractAuth({ securityDefinitions: { oauth: { type: "oauth2" } } }),
      { auth_required: true, auth_schemes: ["oauth2"] },
    );
  });
  test("dedupes + sorts scheme types", () => {
    const out = extractAuth({
      components: {
        securitySchemes: {
          a: { type: "http" },
          b: { type: "apiKey" },
          c: { type: "http" },
        },
      },
    });
    assert.deepEqual(out.auth_schemes, ["apiKey", "http"]);
  });
  test("no schemes => no auth required", () => {
    assert.deepEqual(extractAuth({ paths: {} }), {
      auth_required: false,
      auth_schemes: [],
    });
    assert.deepEqual(extractAuth(null), {
      auth_required: false,
      auth_schemes: [],
    });
  });
});
