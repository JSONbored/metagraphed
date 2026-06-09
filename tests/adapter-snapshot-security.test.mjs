import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { fetchJson } from "../scripts/snapshot-adapters.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("adapter snapshot fetch redirect safety", () => {
  test("blocks redirects from public OpenAPI URLs to private addresses", async () => {
    const fetchCalls = [];
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ init, url: String(url) });
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/openapi.json" },
      });
    };

    const result = await fetchJson("http://1.1.1.1/openapi.json");

    assert.equal(result.ok, false);
    assert.equal(result.status, "unsafe");
    assert.equal(result.private_redirect_blocked, true);
    assert.equal(result.error, "redirect target is unsafe");
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].init.redirect, "manual");
  });

  test("follows safe redirects while keeping redirects manual", async () => {
    const fetchCalls = [];
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ init, url: String(url) });
      if (fetchCalls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://1.0.0.1/openapi.json" },
        });
      }
      return Response.json({ openapi: "3.1.0", info: { title: "public" } });
    };

    const result = await fetchJson("http://1.1.1.1/openapi.json");

    assert.equal(result.ok, true);
    assert.equal(result.status, "captured");
    assert.equal(result.body.info.title, "public");
    assert.deepEqual(
      fetchCalls.map((call) => call.url),
      ["http://1.1.1.1/openapi.json", "http://1.0.0.1/openapi.json"],
    );
    assert.equal(
      fetchCalls.every((call) => call.init.redirect === "manual"),
      true,
    );
  });
});
