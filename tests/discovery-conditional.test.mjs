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

  test("badge SVG prefers the LIVE cron status over the static artifact", async () => {
    // A fresh live snapshot must win: the badge shows the live status word and
    // its mapped shields color, and caches at the standard (longer) max-age.
    // readHealthKv reads the parsed object from METAGRAPH_CONTROL.get(...,json).
    const url = "https://api.metagraph.sh/metagraph/health/badges/7.svg";
    const env = {
      METAGRAPH_CONTROL: {
        get: async () => ({ subnets: [{ netuid: 7, status: "degraded" }] }),
      },
    };
    const res = await handleBadgeSvgRequest(
      new Request(url),
      env,
      new URL(url),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /image\/svg\+xml/);
    // The live status word + its mapped shields color (degraded → yellow #dfb317)
    // reach the rendered SVG, and the available path caches at standard max-age.
    const svg = await res.text();
    assert.match(svg, /SN7/);
    assert.match(svg, /degraded/);
    assert.match(svg, /#dfb317/); // BADGE_STATUS_COLOR.degraded → yellow
    assert.match(res.headers.get("cache-control"), /max-age=300/);
  });

  test("badge SVG maps an UNKNOWN live status to the neutral lightgrey color", async () => {
    // A live status word not in BADGE_STATUS_COLOR must fall back to lightgrey,
    // never render an undefined fill (the `|| "lightgrey"` guard).
    const url = "https://api.metagraph.sh/metagraph/health/badges/7.svg";
    const env = {
      METAGRAPH_CONTROL: {
        get: async () => ({ subnets: [{ netuid: 7, status: "weird" }] }),
      },
    };
    const res = await handleBadgeSvgRequest(
      new Request(url),
      env,
      new URL(url),
    );
    assert.equal(res.status, 200);
    const svg = await res.text();
    assert.match(svg, /weird/);
    assert.match(svg, /#9f9f9f/); // lightgrey fallback, not undefined
  });

  test("badge SVG falls back to 'unavailable' when neither live nor static exists", async () => {
    // No live KV + no static artifact → the graceful neutral badge, cached at the
    // short max-age so a not-yet-published subnet badge recovers quickly.
    const url = "https://api.metagraph.sh/metagraph/health/badges/4242.svg";
    const res = await handleBadgeSvgRequest(new Request(url), {}, new URL(url));
    assert.equal(res.status, 200);
    const svg = await res.text();
    assert.match(svg, /SN4242/);
    assert.match(svg, /unavailable/);
    assert.match(res.headers.get("cache-control"), /max-age=60/);
  });

  test("badge SVG HEAD returns the headers + etag with no body", async () => {
    const url = "https://api.metagraph.sh/metagraph/health/badges/7.svg";
    const res = await handleBadgeSvgRequest(
      new Request(url, { method: "HEAD" }),
      {},
      new URL(url),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /image\/svg\+xml/);
    assert.ok(res.headers.get("etag"));
    assert.equal(await res.text(), "", "HEAD carries no body");
  });

  test("agent-tools serves the anthropic + index kinds (kind dispatch)", async () => {
    const anthropic = await agentToolsResponse(
      new Request("https://api.metagraph.sh/agent-tools/anthropic.json"),
      {},
      "anthropic",
    );
    assert.equal(anthropic.status, 200);
    const aBody = await anthropic.json();
    // Anthropic tool specs are a bare array of { name, description, input_schema }
    // (snake_case), unlike OpenAI's { type:"function", function:{...} }.
    assert.ok(Array.isArray(aBody));
    assert.ok(aBody[0].input_schema);
    assert.equal(typeof aBody[0].name, "string");

    const index = await agentToolsResponse(
      new Request("https://api.metagraph.sh/agent-tools/index.json"),
      {},
      "index",
    );
    assert.equal(index.status, 200);
    const iBody = await index.json();
    assert.ok(iBody.specs, "the index advertises the spec urls");
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

  test("MCP server card HEAD returns headers + etag with no body", async () => {
    // Card is now worker-computed; ASSETS binding is not required.
    const res = await mcpServerCardResponse(
      new Request("https://api.metagraph.sh/.well-known/mcp/server-card.json", {
        method: "HEAD",
      }),
      {},
    );
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("etag"));
    assert.equal(await res.text(), "");
  });

  test("agent-tools HEAD returns headers + etag with no body", async () => {
    const res = await agentToolsResponse(
      new Request("https://api.metagraph.sh/agent-tools/openai.json", {
        method: "HEAD",
      }),
      {},
      "openai",
    );
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("etag"));
    assert.equal(await res.text(), "");
  });

  test("MCP server card honors If-None-Match lists and the * wildcard", async () => {
    // Card is now worker-computed; ASSETS binding is not required.
    await assertConditional((headers) =>
      mcpServerCardResponse(
        new Request(
          "https://api.metagraph.sh/.well-known/mcp/server-card.json",
          { headers },
        ),
        {},
      ),
    );
  });
});
