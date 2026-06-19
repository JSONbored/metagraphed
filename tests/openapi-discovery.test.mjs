// Unit tests for the OpenAPI auto-discovery core (#1004): the pure spec
// validator and the path-sweep orchestrator that the discover-candidates script
// drives with a real safe-fetch. Both live in scripts/lib.mjs so the probing
// logic is exercised here with mocked fetchers (no network).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  OPENAPI_PROBE_PATHS,
  isOpenApiDocument,
  probeOpenApiSpec,
} from "../scripts/lib.mjs";

describe("isOpenApiDocument", () => {
  test("accepts a minimal OpenAPI 3.x document", () => {
    assert.equal(
      isOpenApiDocument({
        openapi: "3.1.0",
        info: { title: "x", version: "1" },
        paths: {},
      }),
      true,
    );
  });

  test("accepts a legacy Swagger 2.0 document", () => {
    assert.equal(
      isOpenApiDocument({
        swagger: "2.0",
        info: { title: "x", version: "1" },
        paths: { "/a": {} },
      }),
      true,
    );
  });

  test("rejects non-objects and arrays", () => {
    for (const value of [
      null,
      undefined,
      42,
      "openapi",
      [],
      [{ openapi: "3.0.0" }],
    ]) {
      assert.equal(isOpenApiDocument(value), false);
    }
  });

  test("rejects an absent, wrong, or non-string version marker", () => {
    assert.equal(isOpenApiDocument({ info: {}, paths: {} }), false);
    assert.equal(
      isOpenApiDocument({ openapi: "1.0", info: {}, paths: {} }),
      false,
    );
    assert.equal(isOpenApiDocument({ openapi: 3, info: {}, paths: {} }), false);
    assert.equal(
      isOpenApiDocument({ swagger: "abc", info: {}, paths: {} }),
      false,
    );
  });

  test("rejects when info or paths is missing or not a plain object", () => {
    assert.equal(isOpenApiDocument({ openapi: "3.0.0", paths: {} }), false);
    assert.equal(isOpenApiDocument({ openapi: "3.0.0", info: {} }), false);
    assert.equal(
      isOpenApiDocument({ openapi: "3.0.0", info: {}, paths: [] }),
      false,
    );
    assert.equal(
      isOpenApiDocument({ openapi: "3.0.0", info: null, paths: {} }),
      false,
    );
  });
});

describe("probeOpenApiSpec", () => {
  const spec = {
    openapi: "3.0.0",
    info: { title: "t", version: "1" },
    paths: {},
  };

  test("returns the first path that yields a valid spec and stops there", async () => {
    const seen = [];
    const fetcher = async (url) => {
      seen.push(url);
      return url.endsWith("/api/openapi.json") ? spec : null;
    };
    const result = await probeOpenApiSpec(
      "https://api.example.com",
      OPENAPI_PROBE_PATHS,
      fetcher,
    );
    assert.ok(result);
    assert.equal(result.url, "https://api.example.com/api/openapi.json");
    assert.deepEqual(result.document, spec);
    // Short-circuits on the hit — never probes the paths after it.
    assert.equal(seen.at(-1), "https://api.example.com/api/openapi.json");
    assert.ok(!seen.includes("https://api.example.com/v1/openapi.json"));
  });

  test("returns null when no path yields a valid spec", async () => {
    const fetcher = async () => ({ not: "a spec" });
    const result = await probeOpenApiSpec(
      "https://example.com",
      OPENAPI_PROBE_PATHS,
      fetcher,
    );
    assert.equal(result, null);
  });

  test("treats a throwing fetcher as a miss for that path", async () => {
    const fetcher = async (url) => {
      if (url === "https://example.com/openapi.json") {
        throw new Error("boom");
      }
      return url.endsWith("/swagger.json")
        ? { swagger: "2.0", info: {}, paths: {} }
        : null;
    };
    const result = await probeOpenApiSpec(
      "https://example.com",
      OPENAPI_PROBE_PATHS,
      fetcher,
    );
    assert.ok(result);
    assert.equal(result.url, "https://example.com/swagger.json");
  });

  test("returns null for an unparseable origin without fetching", async () => {
    let called = false;
    const fetcher = async () => {
      called = true;
      return spec;
    };
    const result = await probeOpenApiSpec(
      "not a url",
      OPENAPI_PROBE_PATHS,
      fetcher,
    );
    assert.equal(result, null);
    assert.equal(called, false);
  });

  test("joins each path against the origin", async () => {
    const urls = [];
    const fetcher = async (url) => {
      urls.push(url);
      return null;
    };
    await probeOpenApiSpec("https://example.com", ["/openapi.json"], fetcher);
    assert.deepEqual(urls, ["https://example.com/openapi.json"]);
  });
});

describe("OPENAPI_PROBE_PATHS", () => {
  test("covers the conventional OpenAPI/Swagger spec locations", () => {
    for (const probePath of [
      "/openapi.json",
      "/swagger.json",
      "/swagger/v1/swagger.json",
      "/docs/openapi.json",
      "/api/openapi.json",
      "/api/v1/openapi.json",
      "/v1/openapi.json",
      "/.well-known/openapi.json",
    ]) {
      assert.ok(
        OPENAPI_PROBE_PATHS.includes(probePath),
        `missing probe path ${probePath}`,
      );
    }
  });

  test("is frozen so the probe set cannot be mutated at runtime", () => {
    assert.ok(Object.isFrozen(OPENAPI_PROBE_PATHS));
  });
});
