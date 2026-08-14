// #11179: the paid-depth seam -- tier gates DEPTH, never visibility.
//
// The contract this pins, in the order it matters:
//   1. every tool stays LISTED and CALLABLE at every tier; only depth refuses
//   2. a free call inside the free depth is never touched
//   3. a free call past it gets a structured `payment_required` carrying the
//      tier it needs and where to get one -- an agent relays that upward,
//      which is what makes the refusal a sales channel rather than a wall
//   4. a paid call past it goes through
//
// An UNRECOGNISED tier must not clear a boundary: the alternative turns a typo
// in an account record into free access to every paid depth.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  FREE_HISTORY_WINDOW_DAYS,
  MCP_TIER_RANK,
  MCP_UPGRADE_URL,
  paymentRequiredToolError,
  requireTierForDepth,
  tierClears,
} from "../src/mcp-tier-gate.ts";
import { handleMcpRequest, MCP_CORE_TOOL_NAMES } from "../src/mcp-server.ts";
import { mockEnv, type Row } from "./row-type.ts";

const guard = (tier: string, requested: number | null) =>
  requireTierForDepth({
    tier,
    requiredTier: "paid",
    boundary: "history_window_days",
    requested,
    limit: FREE_HISTORY_WINDOW_DAYS,
  });

describe("tierClears", () => {
  test("ranks anonymous below every issued tier", () => {
    assert.equal(MCP_TIER_RANK[0], "anonymous");
    assert.equal(tierClears("anonymous", "free"), false);
    assert.equal(tierClears("free", "free"), true);
    assert.equal(tierClears("paid", "community"), true);
    assert.equal(tierClears("community", "paid"), false);
  });

  test("an unrecognised tier clears NOTHING", () => {
    // A tier string this build does not know is not evidence of entitlement.
    for (const unknown of ["", "enterprise", "__proto__", "constructor", null])
      assert.equal(tierClears(unknown, "free"), false, String(unknown));
  });
});

describe("the depth guard", () => {
  test("a request inside the free depth passes at any tier", () => {
    for (const tier of ["anonymous", "free", "paid"]) {
      assert.doesNotThrow(() => guard(tier, FREE_HISTORY_WINDOW_DAYS));
      assert.doesNotThrow(() => guard(tier, 7));
    }
  });

  test("a free caller past the depth is refused, with both sides named", () => {
    const error = (() => {
      try {
        guard("anonymous", 365);
        return null;
      } catch (thrown) {
        return thrown as Row;
      }
    })();
    assert.ok(error, "365 days must not pass at the anonymous tier");
    assert.equal(error.code, "payment_required");
    assert.equal(error.toolError, true);
    const payment = error.payment as Row;
    assert.equal(payment.required_tier, "paid");
    assert.equal(payment.tier, "anonymous");
    assert.equal(payment.boundary, "history_window_days");
    assert.equal(payment.limit, FREE_HISTORY_WINDOW_DAYS);
    assert.equal(payment.requested, 365);
    assert.equal(payment.upgrade_url, MCP_UPGRADE_URL);
    // The prose must carry the upgrade path too: a client that only renders
    // `message` still shows its human something actionable.
    assert.match(String(error.message), new RegExp(MCP_UPGRADE_URL));
  });

  test("an UNBOUNDED window crosses every finite ceiling", () => {
    // `all` parses to days: null. Treating null as "no request" would have
    // made the deepest possible read the one thing that passed free.
    assert.throws(() => guard("free", null), /payment_required|paid tier/);
    assert.doesNotThrow(() => guard("paid", null));
  });

  test("a paid caller passes the same depth that refuses a free one", () => {
    assert.throws(() => guard("community", 365));
    assert.doesNotThrow(() => guard("paid", 365));
  });
});

describe("the refusal shape is x402-ready", () => {
  test("payment is a block, not flattened onto the error", () => {
    const error = paymentRequiredToolError({
      tier: "free",
      requiredTier: "paid",
      boundary: "history_window_days",
    });
    assert.equal(error.code, "payment_required");
    // Exactly the members declared today; a challenge later joins THIS block
    // rather than introducing a second error vocabulary.
    assert.deepEqual(Object.keys(error.payment).sort(), [
      "boundary",
      "required_tier",
      "tier",
      "upgrade_url",
    ]);
  });
});

/** One real MCP tools/call through the dispatcher, anonymous (no key). */
async function callEconomicsTrends(window: string) {
  const res = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_economics_trends", arguments: { window } },
      }),
    }),
    mockEnv(),
  );
  const text = await res.text();
  const json = text.startsWith("event:")
    ? JSON.parse(text.slice(text.indexOf("data:") + 5).trim())
    : JSON.parse(text);
  return (json.result ?? json) as Row;
}

describe("the boundary, through a real dispatch", () => {
  test("an anonymous 1y call is refused with the structured payment block", async () => {
    const result = await callEconomicsTrends("1y");
    assert.equal(result.isError, true);
    const error = (result.structuredContent as Row).error as Row;
    assert.equal(error.code, "payment_required");
    const payment = error.payment as Row;
    assert.equal(payment.required_tier, "paid");
    assert.equal(payment.boundary, "history_window_days");
    assert.equal(payment.upgrade_url, MCP_UPGRADE_URL);
  });

  test("the same anonymous caller gets 30d without a refusal", async () => {
    // The free depth is a real product: the tool answers (or fails on the
    // hermetic env's missing data tier) -- what it must NOT do is demand
    // payment.
    const result = await callEconomicsTrends("30d");
    const error = (result.structuredContent as Row | undefined)?.error as
      Row | undefined;
    assert.notEqual(
      error?.code,
      "payment_required",
      "a 30-day window must never be gated",
    );
  });
});

describe("depth is gated; visibility is not", () => {
  test("the gated tool is still listed to an anonymous caller", async () => {
    const res = await handleMcpRequest(
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
      mockEnv(),
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    const json = text.startsWith("event:")
      ? JSON.parse(text.slice(text.indexOf("data:") + 5).trim())
      : JSON.parse(text);
    const names = ((json.result as Row).tools as Row[]).map((tool) =>
      String(tool.name),
    );
    assert.ok(
      names.includes("get_economics_trends"),
      "a gated tool that disappears is a tool nobody upgrades for",
    );
    // And the free-tier economics entry point stays in the curated core set.
    assert.ok(MCP_CORE_TOOL_NAMES.includes("get_economics"));
  });
});
