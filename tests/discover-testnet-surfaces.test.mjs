import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

vi.mock("../scripts/lib.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isUnsafeResolvedUrl: vi.fn(async () => false),
  };
});

const { classify } = await import("../scripts/discover-testnet-surfaces.mjs");

const subnet = {
  netuid: 99,
  name: "Testnet Example",
  url: "https://api.example.test",
};

function jsonResponse(body, contentType = "application/json") {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("classify treats uppercase JSON Content-Type as a callable API hit", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("/openapi.json")) {
        return jsonResponse(
          '{"openapi":"3.0.0","paths":{}}',
          "Application/JSON",
        );
      }
      return new Response("not found", { status: 404 });
    }),
  );

  const result = await classify(subnet);
  assert.equal(result.callable, true);
  assert.equal(result.classification, "openapi");
  assert.equal(result.discovered_url, "https://api.example.test/openapi.json");
});

test("classify treats spaced mixed-case root JSON as maybe-api", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const target = String(url);
      if (target === "https://api.example.test") {
        return jsonResponse(
          '{"status":"ok"}',
          " application/json; charset=utf-8 ",
        );
      }
      return new Response("not found", { status: 404 });
    }),
  );

  const result = await classify(subnet);
  assert.equal(result.callable, false);
  assert.equal(result.classification, "maybe-api");
});
