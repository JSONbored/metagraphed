// Unit tests for the OpenAPI auto-discovery core (#1004): the pure spec
// validator and the path-sweep orchestrator that the discover-candidates script
// drives with a real safe-fetch. Both live in scripts/lib.ts so the probing
// logic is exercised here with mocked fetchers (no network).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  OPENAPI_PROBE_PATHS,
  apiDocsSubdomainOrigins,
  isOpenApiDocument,
  probeOpenApiSpec,
} from "../scripts/lib.ts";

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
    const seen: string[] = [];
    const fetcher = async (url: string) => {
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
    const fetcher = async (url: string) => {
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
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      return null;
    };
    await probeOpenApiSpec("https://example.com", ["/openapi.json"], fetcher);
    assert.deepEqual(urls, ["https://example.com/openapi.json"]);
  });
});

describe("apiDocsSubdomainOrigins (#1004)", () => {
  test("derives api. and docs. origins from a marketing-root domain", () => {
    assert.deepEqual(apiDocsSubdomainOrigins("https://graphite.xyz"), [
      "https://api.graphite.xyz",
      "https://docs.graphite.xyz",
    ]);
  });

  test("strips www. and ignores path/port when deriving", () => {
    assert.deepEqual(apiDocsSubdomainOrigins("https://www.vidaio.io/about"), [
      "https://api.vidaio.io",
      "https://docs.vidaio.io",
    ]);
  });

  test("folds an existing subdomain back to the registrable domain", () => {
    // app.example.com → api.example.com / docs.example.com
    assert.deepEqual(apiDocsSubdomainOrigins("https://app.example.com"), [
      "https://api.example.com",
      "https://docs.example.com",
    ]);
  });

  test("handles a multi-label public suffix (co.uk)", () => {
    assert.deepEqual(apiDocsSubdomainOrigins("https://acme.co.uk"), [
      "https://api.acme.co.uk",
      "https://docs.acme.co.uk",
    ]);
  });

  test("returns [] for multi-tenant platform tenants", () => {
    for (const origin of [
      "https://foo.github.io",
      "https://bar.vercel.app",
      "https://baz.pages.dev",
      "https://qux.workers.dev",
    ]) {
      assert.deepEqual(apiDocsSubdomainOrigins(origin), [], origin);
    }
  });

  test("returns [] for a bare multi-label public suffix with no registrable domain", () => {
    // A host that is *exactly* a multi-label public suffix (co.uk, com.au) has
    // no project-owned registrable domain, so clusterSuffixDomain returns null
    // and no api./docs. origin can be derived.
    for (const origin of [
      "https://co.uk",
      "https://com.au",
      "https://org.nz",
    ]) {
      assert.deepEqual(apiDocsSubdomainOrigins(origin), [], origin);
    }
  });

  test("returns [] for IP literals, bare hosts, and unparseable input", () => {
    for (const origin of [
      "https://127.0.0.1",
      "https://192.168.1.10:8080",
      "https://localhost",
      "not a url",
      "",
    ]) {
      assert.deepEqual(apiDocsSubdomainOrigins(origin), [], origin);
    }
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
