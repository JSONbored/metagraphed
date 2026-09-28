import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { mcpProbeRequest } from "../scripts/mcp-probe-request.ts";
import { mcpProbeName } from "../src/mcp-server.ts";
import { mockEnv } from "./row-type.ts";

const endpoint = "https://api.metagraph.sh/mcp";
const token = "qualification-test-token";

describe("manual MCP qualification attribution", () => {
  for (const probe of [
    "mcp-conformance",
    "operation-latency",
    "cross-surface-values",
    "adversarial-surface",
  ] as const) {
    test(`${probe} is recognized by the production verifier`, () => {
      const options = mcpProbeRequest(endpoint, probe, token);
      const request = new Request(endpoint, options);
      assert.equal(
        mcpProbeName(request, mockEnv({ MCP_PROBE_TOKEN: token })),
        probe,
      );
      assert.match(request.headers.get("user-agent")!, /^metagraphed-/);
      assert.equal(request.headers.get("mcp-protocol-version"), "2025-11-25");
      assert.equal(options.redirect, "error");
      assert.equal(
        mcpProbeName(request, mockEnv({ MCP_PROBE_TOKEN: "different" })),
        undefined,
      );
    });
  }

  test("missing production proof fails before a request can be made", () => {
    for (const proof of ["", "   "]) {
      assert.throws(
        () => mcpProbeRequest(endpoint, "operation-latency", proof),
        /MCP_PROBE_TOKEN is required/,
      );
    }
    assert.throws(
      () =>
        mcpProbeRequest(
          "https://user:password@api.metagraph.sh/mcp",
          "mcp-conformance",
          token,
        ),
      /must not contain credentials/,
    );
  });

  test("endpoint overrides never receive production credentials", () => {
    for (const target of [
      "http://localhost:8787/mcp",
      "https://example.com/mcp",
      "https://api.metagraph.sh.example.com/mcp",
      "http://api.metagraph.sh/mcp",
      "https://api.metagraph.sh:444/mcp",
    ]) {
      const options = mcpProbeRequest(target, "operation-latency", token);
      const headers = new Headers(options.headers);
      assert.equal(headers.has("x-metagraph-probe-token"), false);
      assert.equal(headers.has("x-metagraph-probe"), false);
      assert.equal(headers.has("authorization"), false);
      assert.equal(options.redirect, "error");
    }
  });
});
