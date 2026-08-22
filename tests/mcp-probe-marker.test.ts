// #11565: our own scheduled sweeps must not be counted as product usage.
//
// The nightly MCP conformance run touches all 242 tools and was 4,990 tool
// calls over 30 days -- against ~1,600 calls of real interactive traffic. It
// does not merely add noise: because it touches EVERY tool every night, it
// dominates the per-tool distinct-caller counts that #11179 requires the paid
// boundary to be chosen from.
//
// The marker is VERIFIED rather than self-declared. An unauthenticated
// "do not count me" would let any crawler opt out of the numbers, and a crawler
// that can hide is worse than one that shows up.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  MCP_PROBE_HEADER,
  MCP_PROBE_NAME_MAX_LENGTH,
  MCP_PROBE_TOKEN_HEADER,
  mcpProbeName,
} from "../src/mcp-server.ts";

const TOKEN = "test-probe-token-aaaaaaaaaaaaaaaaaaaa";

function req(headers: Record<string, string> = {}) {
  return new Request("https://api.metagraph.sh/mcp", {
    method: "POST",
    headers,
  });
}

const env = (token?: string) => ({ MCP_PROBE_TOKEN: token }) as unknown as Env;

describe("mcpProbeName", () => {
  test("honours a named probe when the token matches", () => {
    assert.equal(
      mcpProbeName(
        req({
          [MCP_PROBE_HEADER]: "mcp-conformance",
          [MCP_PROBE_TOKEN_HEADER]: TOKEN,
        }),
        env(TOKEN),
      ),
      "mcp-conformance",
    );
  });

  test("a wrong or missing token yields NO probe, so the traffic is counted", () => {
    // The safe direction: the failure mode is our own sweep briefly appearing
    // in the numbers, never a real caller silently vanishing from them.
    const cases: Record<string, string>[] = [
      { [MCP_PROBE_HEADER]: "mcp-conformance" },
      { [MCP_PROBE_HEADER]: "mcp-conformance", [MCP_PROBE_TOKEN_HEADER]: "" },
      {
        [MCP_PROBE_HEADER]: "mcp-conformance",
        [MCP_PROBE_TOKEN_HEADER]: "wrong-token",
      },
      {
        [MCP_PROBE_HEADER]: "mcp-conformance",
        [MCP_PROBE_TOKEN_HEADER]: TOKEN.slice(0, -1),
      },
    ];
    for (const headers of cases) {
      assert.equal(mcpProbeName(req(headers), env(TOKEN)), undefined);
    }
  });

  test("an unprovisioned deployment honours no marker at all", () => {
    // Secret and deploy can land in either order without a window where real
    // traffic is wrongly excluded.
    for (const token of [undefined, ""]) {
      assert.equal(
        mcpProbeName(
          req({
            [MCP_PROBE_HEADER]: "mcp-conformance",
            [MCP_PROBE_TOKEN_HEADER]: TOKEN,
          }),
          env(token),
        ),
        undefined,
        String(token),
      );
    }
    assert.equal(
      mcpProbeName(
        req({
          [MCP_PROBE_HEADER]: "mcp-conformance",
          [MCP_PROBE_TOKEN_HEADER]: TOKEN,
        }),
        undefined,
      ),
      undefined,
    );
  });

  test("a valid token with no name is not a probe", () => {
    const cases: Record<string, string>[] = [
      { [MCP_PROBE_TOKEN_HEADER]: TOKEN },
      { [MCP_PROBE_HEADER]: "   ", [MCP_PROBE_TOKEN_HEADER]: TOKEN },
    ];
    for (const headers of cases) {
      assert.equal(mcpProbeName(req(headers), env(TOKEN)), undefined);
    }
  });

  test("the name is bounded, so the header cannot become a payload", () => {
    const long = "x".repeat(MCP_PROBE_NAME_MAX_LENGTH * 4);
    const name = mcpProbeName(
      req({ [MCP_PROBE_HEADER]: long, [MCP_PROBE_TOKEN_HEADER]: TOKEN }),
      env(TOKEN),
    );
    assert.equal(name?.length, MCP_PROBE_NAME_MAX_LENGTH);
  });

  test("a third party's conformance checker is NOT treated as ours", () => {
    // `flowstacks-mcp-conformance` is real, observed in production, and is
    // someone else's checker -- its calls are genuine usage. This is why the
    // marker is a token we issue and not a user-agent pattern: matching on the
    // string "conformance" would have filtered their traffic out of our
    // numbers alongside our own.
    assert.equal(
      mcpProbeName(
        req({
          "user-agent": "flowstacks-mcp-conformance/1",
          [MCP_PROBE_HEADER]: "mcp-conformance",
        }),
        env(TOKEN),
      ),
      undefined,
    );
  });
});
