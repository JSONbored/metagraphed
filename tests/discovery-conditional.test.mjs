// Discovery endpoints must answer conditional GETs with the shared
// ifNoneMatchSatisfied() semantics (RFC 9110 §13.1.2): an If-None-Match list
// or the `*` wildcard yields 304, not a fresh 200 body. Regression for the
// strict `===` comparison these handlers used previously.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { agentToolsResponse } from "../workers/request-handlers/discovery.mjs";

const req = (headers) =>
  new Request("https://api.metagraph.sh/agent-tools/openai.json", { headers });

describe("discovery conditional requests", () => {
  test("agent tool specs honor If-None-Match lists and the * wildcard", async () => {
    const full = await agentToolsResponse(req({}), {}, "openai");
    assert.equal(full.status, 200);
    const etag = full.headers.get("etag");
    assert.ok(etag, "response advertises an etag");

    // Exact echo -> 304 (unchanged behavior).
    const exact = await agentToolsResponse(
      req({ "if-none-match": etag }),
      {},
      "openai",
    );
    assert.equal(exact.status, 304);

    // ETag list that includes the current tag -> 304 (was 200 before the fix).
    const list = await agentToolsResponse(
      req({ "if-none-match": `"stale", ${etag}` }),
      {},
      "openai",
    );
    assert.equal(list.status, 304);

    // Wildcard -> 304 (was 200 before the fix).
    const wild = await agentToolsResponse(
      req({ "if-none-match": "*" }),
      {},
      "openai",
    );
    assert.equal(wild.status, 304);

    // A non-matching validator still gets the full 200 body.
    const miss = await agentToolsResponse(
      req({ "if-none-match": `"nope"` }),
      {},
      "openai",
    );
    assert.equal(miss.status, 200);
  });
});
