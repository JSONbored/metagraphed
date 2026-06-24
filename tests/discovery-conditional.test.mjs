// Discovery endpoints must answer conditional GETs with the shared
// ifNoneMatchSatisfied() semantics (RFC 9110 §13.1.2): an If-None-Match list
// or the `*` wildcard yields 304, not a fresh 200 body. Regression for the
// strict `===` comparison these handlers used previously.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  agentToolsResponse,
  apiCatalogResponse,
  handleBadgeSvgRequest,
  mcpServerCardResponse,
} from "../workers/request-handlers/discovery.mjs";

// Re-run a handler with each conditional variant and assert the 304/200 outcome.
// `call(headers)` returns the handler's Response for the given request headers.
async function assertConditional(call) {
  const full = await call({});
  assert.equal(full.status, 200);
  const etag = full.headers.get("etag");
  assert.ok(etag, "response advertises an etag");

  // Exact echo -> 304 (unchanged behavior).
  assert.equal((await call({ "if-none-match": etag })).status, 304);
  // ETag list that includes the current tag -> 304 (was 200 before the fix).
  assert.equal(
    (await call({ "if-none-match": `"stale", ${etag}` })).status,
    304,
  );
  // Wildcard -> 304 (was 200 before the fix).
  assert.equal((await call({ "if-none-match": "*" })).status, 304);
  // A non-matching validator still gets the full 200 body.
  assert.equal((await call({ "if-none-match": `"nope"` })).status, 200);
}

describe("discovery conditional requests", () => {
  test("agent tool specs honor If-None-Match lists and the * wildcard", async () => {
    await assertConditional((headers) =>
      agentToolsResponse(
        new Request("https://api.metagraph.sh/agent-tools/openai.json", {
          headers,
        }),
        {},
        "openai",
      ),
    );
  });

  test("badge SVG honors If-None-Match lists and the * wildcard", async () => {
    // An empty env makes readArtifact/readHealthKv miss, so the handler renders
    // the graceful fallback badge — which still sets an etag + conditional path.
    const url = "https://api.metagraph.sh/metagraph/health/badges/7.svg";
    await assertConditional((headers) =>
      handleBadgeSvgRequest(new Request(url, { headers }), {}, new URL(url)),
    );
  });

  test("badge SVG rejects non-GET/HEAD methods with 405 and an Allow header", async () => {
    const url = "https://api.metagraph.sh/metagraph/health/badges/7.svg";
    const res = await handleBadgeSvgRequest(
      new Request(url, { method: "POST" }),
      {},
      new URL(url),
    );
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
    const body = await res.json();
    assert.equal(body.error.code, "method_not_allowed");
  });

  test("api catalog HEAD returns the discovery headers with no body", async () => {
    const url = "https://api.metagraph.sh/.well-known/api-catalog";
    const res = apiCatalogResponse(new Request(url, { method: "HEAD" }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/linkset+json");
    // HEAD never carries a body, but the discovery Link header is still present.
    assert.ok(res.headers.get("link"));
    assert.equal(await res.text(), "");
  });

  test("api catalog GET returns the RFC 9264 linkset body", async () => {
    const url = "https://api.metagraph.sh/.well-known/api-catalog";
    const res = apiCatalogResponse(new Request(url, { method: "GET" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.linkset));
    assert.ok(body.linkset[0]["service-desc"]);
  });

  test("MCP server card returns 404 when the static asset is unavailable", async () => {
    // ASSETS missing the card -> the handler degrades to a 404 not_found.
    const url = "https://api.metagraph.sh/.well-known/mcp/server-card.json";
    const envMiss = {
      ASSETS: {
        fetch: async () => new Response("not found", { status: 404 }),
      },
    };
    const res = await mcpServerCardResponse(
      new Request(url, { method: "GET" }),
      envMiss,
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "not_found");

    // No ASSETS binding at all -> same 404 path (asset === null).
    const resNoBinding = await mcpServerCardResponse(
      new Request(url, { method: "GET" }),
      {},
    );
    assert.equal(resNoBinding.status, 404);
  });

  test("MCP server card honors If-None-Match lists and the * wildcard", async () => {
    const card = {
      serverInfo: { name: "metagraphed", version: "1" },
      endpoint: "https://api.metagraph.sh/mcp",
    };
    const env = {
      ASSETS: {
        fetch: async () =>
          new Response(JSON.stringify(card), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    };
    await assertConditional((headers) =>
      mcpServerCardResponse(
        new Request(
          "https://api.metagraph.sh/.well-known/mcp/server-card.json",
          { headers },
        ),
        env,
      ),
    );
  });
});
