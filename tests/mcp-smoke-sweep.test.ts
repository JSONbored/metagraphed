import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildFixtures,
  buildToolArguments,
  classifyCall,
  findFirstRowArray,
  flagRows,
  formatFlags,
  isRateLimited,
  mapWithConcurrency,
  parseMcpPayload,
  resolveFixture,
} from "../scripts/mcp-smoke-sweep.ts";

// Minimal stand-ins for the live `tools/list` entries -- only `name` and
// `inputSchema.required` drive argument building.
function tool(name: string, required?: string[]) {
  return { name, inputSchema: required ? { required } : {} };
}

describe("resolveFixture", () => {
  const fixtures = {
    slug: "404-gen",
    "get_adapter.slug": "allways",
    nullable: null,
  };

  test("prefers a per-tool override over the bare field", () => {
    assert.deepEqual(resolveFixture("get_adapter", "slug", fixtures), {
      found: true,
      value: "allways",
    });
    assert.deepEqual(resolveFixture("get_provider_detail", "slug", fixtures), {
      found: true,
      value: "404-gen",
    });
  });

  test("reports a miss rather than returning undefined", () => {
    assert.deepEqual(resolveFixture("call_rpc", "method", fixtures), {
      found: false,
    });
  });

  test("a fixture defined as null is found, not treated as missing", () => {
    // `found` must key off key presence, not value truthiness -- otherwise a
    // deliberate null/0/"" fixture would silently downgrade its tool to
    // UNTESTED.
    assert.deepEqual(resolveFixture("any_tool", "nullable", fixtures), {
      found: true,
      value: null,
    });
  });
});

describe("buildToolArguments", () => {
  const fixtures = { netuid: 64, ss58: "5EYC", "get_adapter.slug": "allways" };

  test("builds arguments from the tool's own required list", () => {
    assert.deepEqual(
      buildToolArguments(tool("get_subnet", ["netuid"]), fixtures),
      {
        status: "ready",
        args: { netuid: 64 },
      },
    );
  });

  test("sends only required fields, so optional defaults stay exercised", () => {
    const built = buildToolArguments(tool("get_account", ["ss58"]), fixtures);
    assert.equal(built.status, "ready");
    assert.deepEqual(Object.keys(built.status === "ready" ? built.args : {}), [
      "ss58",
    ]);
  });

  test("a tool with no required fields is callable with empty arguments", () => {
    assert.deepEqual(buildToolArguments(tool("list_subnets"), fixtures), {
      status: "ready",
      args: {},
    });
  });

  test("an unfixtured required field reports UNTESTED, never a silent skip", () => {
    // This is what stops coverage rotting: a tool added later with a required
    // field the map lacks has to surface in the summary.
    assert.deepEqual(
      buildToolArguments(tool("call_rpc", ["method", "netuid"]), fixtures),
      { status: "untested", missing: ["method"] },
    );
  });

  test("collects every missing field, not just the first", () => {
    assert.deepEqual(
      buildToolArguments(tool("decode_evm_call", ["to", "input"]), fixtures),
      { status: "untested", missing: ["to", "input"] },
    );
  });
});

describe("buildFixtures", () => {
  test("derives the health-history date one day back from now", () => {
    // Anchored a day back because the current day's snapshot may not have
    // landed yet.
    const fixtures = buildFixtures(new Date("2026-08-05T03:41:50.942Z"));
    assert.equal(fixtures.date, "2026-08-04");
  });

  test("covers the required fields of the tools it is expected to sweep", () => {
    const fixtures = buildFixtures();
    for (const [name, required] of [
      ["get_subnet", ["netuid"]],
      ["get_account", ["ss58"]],
      ["get_block", ["ref"]],
      ["compare_validators", ["hotkeys"]],
      ["get_feed", ["kind"]],
      ["run_saved_query", ["query_id"]],
      ["get_api_schema", ["surface_id"]],
    ] as const) {
      assert.equal(
        buildToolArguments(tool(name, [...required]), fixtures).status,
        "ready",
        name,
      );
    }
  });

  test("withholds fixtures for credential-writing and unsafe inputs", () => {
    const fixtures = buildFixtures();
    for (const [name, field] of [
      ["store_surface_credential", "credential"],
      ["get_alert_trigger", "owner_token"],
      ["call_rpc", "method"],
      ["get_webhook_subscription", "id"],
    ] as const) {
      const built = buildToolArguments(tool(name, [field]), fixtures);
      // Assert the shape that proves the sweep actually reached a verdict --
      // a bare "not ready" would also pass on a builder that returned nothing.
      assert.deepEqual(built, { status: "untested", missing: [field] }, name);
    }
  });
});

describe("parseMcpPayload", () => {
  test("parses a plain JSON body", () => {
    assert.deepEqual(parseMcpPayload('{"jsonrpc":"2.0","id":1,"result":{}}'), {
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  test("parses the last data: line of an SSE body", () => {
    // Earlier data: lines can be progress notifications; the JSON-RPC response
    // is the final one.
    const sse = [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":7,"result":{"isError":false}}',
      "",
    ].join("\n");
    assert.deepEqual(parseMcpPayload(sse), {
      jsonrpc: "2.0",
      id: 7,
      result: { isError: false },
    });
  });

  test("handles CRLF line endings and ignores non-data SSE fields", () => {
    const sse = 'id: 1\r\nretry: 100\r\ndata: {"result":{"ok":true}}\r\n\r\n';
    assert.deepEqual(parseMcpPayload(sse), { result: { ok: true } });
  });

  test("rejects an empty body and an SSE frame with no data line", () => {
    assert.throws(() => parseMcpPayload("   "), /empty response body/);
    assert.throws(
      () => parseMcpPayload("event: message\nretry: 50\n"),
      /no data: line/,
    );
  });
});

describe("isRateLimited", () => {
  test("recognises the endpoint's throttle refusal", () => {
    // The live wording, verbatim -- a sweep at concurrency 2 turned 34 healthy
    // tools into this, which is why it has to be retried rather than reported.
    assert.equal(
      isRateLimited({
        error: {
          code: -32600,
          message: "Too many MCP requests from this client; slow down.",
        },
      }),
      true,
    );
  });

  test("a genuine -32600 is not mistaken for throttling", () => {
    // -32600 is the generic "invalid request" code, so the message has to carry
    // the decision; matching the code alone would swallow real bad requests.
    assert.equal(
      isRateLimited({ error: { code: -32600, message: "Invalid Request" } }),
      false,
    );
  });

  test("a throttle-shaped message under a different code is not throttling", () => {
    assert.equal(
      isRateLimited({ error: { code: -32602, message: "too many netuids" } }),
      false,
    );
  });

  test("a successful payload is never rate limited", () => {
    assert.equal(isRateLimited({ result: { isError: false } }), false);
    assert.equal(isRateLimited({}), false);
  });
});

describe("classifyCall", () => {
  test("a JSON-RPC envelope error is RPCERR", () => {
    assert.deepEqual(
      classifyCall({ error: { code: -32602, message: "Invalid params" } }),
      { outcome: "rpcerr", code: "-32602", message: "Invalid params" },
    );
  });

  test("a handled tool failure is ERROR carrying the structured error code", () => {
    assert.deepEqual(
      classifyCall({
        result: {
          isError: true,
          structuredContent: {
            error: { code: "auth_required", message: "Auth required." },
          },
        },
      }),
      { outcome: "error", code: "auth_required", message: "Auth required." },
    );
  });

  test("an isError result without a structured code still classifies", () => {
    assert.deepEqual(classifyCall({ result: { isError: true } }), {
      outcome: "error",
      code: "unknown",
      message: "",
    });
  });

  test("a successful call returns the structured content", () => {
    const structured = { subnets: [{ netuid: 1 }] };
    assert.deepEqual(
      classifyCall({
        result: { isError: false, structuredContent: structured },
      }),
      { outcome: "ok", structured },
    );
  });
});

describe("findFirstRowArray", () => {
  test("finds a nested array of objects and reports its path", () => {
    assert.deepEqual(
      findFirstRowArray({ schema_version: 1, data: { blocks: [{ a: 1 }] } }),
      { path: "data.blocks", rows: [{ a: 1 }] },
    );
  });

  test("an incidental empty array never outranks a populated row set", () => {
    // Regression for a live false positive: `[].every(...)` is true, so an
    // empty array of anything looks like an empty row set. Picking `warnings`
    // here reported EMPTY on a tool that returned a full payload.
    assert.deepEqual(
      findFirstRowArray({ warnings: [], subnets: [{ netuid: 1 }] }),
      { path: "subnets", rows: [{ netuid: 1 }] },
    );
  });

  test("a genuinely empty response still reports EMPTY", () => {
    // The non-empty preference must not become "never report EMPTY" -- with no
    // populated row set anywhere, EMPTY is the honest answer.
    assert.deepEqual(findFirstRowArray({ subnets: [], meta: { count: 0 } }), {
      path: "subnets",
      rows: [],
    });
  });

  test("ignores arrays buried below the payload depth", () => {
    // get_adapter's only arrays are schema descriptors at depth 5; treating
    // them as its row set flagged a healthy tool EMPTY. Nothing that deep is
    // even considered, so the tool correctly reports no row array.
    assert.equal(
      findFirstRowArray({
        snapshot: {
          dimensions: {
            crown: { shape: { array_fields: [], object_fields: [{ n: 1 }] } },
          },
        },
      }),
      null,
    );
  });

  test("keeps a row set at the deepest allowed level", () => {
    // `data.boards.healthiest` is a real payload path and must stay in reach --
    // the cap has to exclude metadata without cutting off real rows.
    assert.deepEqual(
      findFirstRowArray({ data: { boards: { healthiest: [{ netuid: 1 }] } } }),
      { path: "data.boards.healthiest", rows: [{ netuid: 1 }] },
    );
  });

  test("prefers the outermost row array over a nested one", () => {
    const found = findFirstRowArray({
      rows: [{ id: 1, children: [{ id: 2 }] }],
    });
    assert.equal(found?.path, "rows");
    assert.equal(found?.rows.length, 1);
  });

  test("skips arrays of scalars and descends past them", () => {
    assert.deepEqual(
      findFirstRowArray({ tags: ["a", "b"], items: [{ id: 1 }] }),
      { path: "items", rows: [{ id: 1 }] },
    );
  });

  test("descends into arrays of arrays", () => {
    assert.deepEqual(findFirstRowArray({ groups: [[{ id: 1 }]] }), {
      path: "groups[0]",
      rows: [{ id: 1 }],
    });
  });

  test("an empty array counts as a row array so EMPTY can be flagged", () => {
    // `[].every(...)` is true, which is deliberate -- an empty result set is
    // one of the three shapes worth flagging.
    assert.deepEqual(findFirstRowArray({ accounts: [] }), {
      path: "accounts",
      rows: [],
    });
  });

  test("returns null when there is no row array at all", () => {
    assert.equal(findFirstRowArray({ count: 3, nested: { ok: true } }), null);
    assert.equal(findFirstRowArray(null), null);
    assert.equal(findFirstRowArray("string"), null);
  });

  test("a bare top-level row array reports the $ path", () => {
    assert.deepEqual(findFirstRowArray([{ id: 1 }]), {
      path: "$",
      rows: [{ id: 1 }],
    });
  });
});

describe("flagRows", () => {
  test("flags an empty result set", () => {
    assert.deepEqual(flagRows([]), [{ kind: "EMPTY" }]);
  });

  test("flags a field that is null on every row", () => {
    const rows = [
      { author: null, n: 1 },
      { author: null, n: 2 },
    ];
    assert.deepEqual(flagRows(rows), [
      { kind: "ALL_NULL", fields: ["author"] },
    ]);
  });

  test("a partially populated field is not ALL_NULL", () => {
    // spec_version null on 2 of 5 is partial population, not an unfillable
    // field -- exactly the distinction that separated the two live findings.
    const rows = [
      { spec_version: null },
      { spec_version: 441 },
      { spec_version: null },
    ];
    assert.deepEqual(flagRows(rows), []);
  });

  test("treats a missing key like a null one across ragged rows", () => {
    assert.deepEqual(flagRows([{ a: 1 }, { a: 1, b: null }]), [
      { kind: "ALL_NULL", fields: ["b"] },
    ]);
  });

  test("flags a uniform field only once there are enough rows", () => {
    const four = Array.from({ length: 4 }, () => ({ netuid: 64 }));
    assert.deepEqual(flagRows(four), []);
    const five = Array.from({ length: 5 }, () => ({ netuid: 64 }));
    assert.deepEqual(flagRows(five), [{ kind: "UNIFORM", fields: ["netuid"] }]);
  });

  test("a varying field is never UNIFORM", () => {
    const rows = Array.from({ length: 5 }, (_unused, i) => ({ netuid: i }));
    assert.deepEqual(flagRows(rows), []);
  });

  test("compares by value, so equal objects are uniform and unequal are not", () => {
    const same = Array.from({ length: 5 }, () => ({ meta: { tier: "d1" } }));
    assert.deepEqual(flagRows(same), [{ kind: "UNIFORM", fields: ["meta"] }]);
    const differing = Array.from({ length: 5 }, (_unused, i) => ({
      meta: { tier: `d${i}` },
    }));
    assert.deepEqual(flagRows(differing), []);
  });

  test("an all-null field is reported once as ALL_NULL, not also as UNIFORM", () => {
    const rows = Array.from({ length: 5 }, () => ({ flow: null, netuid: 64 }));
    assert.deepEqual(flagRows(rows), [
      { kind: "ALL_NULL", fields: ["flow"] },
      { kind: "UNIFORM", fields: ["netuid"] },
    ]);
  });
});

describe("formatFlags", () => {
  test("renders each flag kind for the triage line", () => {
    assert.equal(formatFlags([{ kind: "EMPTY" }]), "EMPTY");
    assert.equal(
      formatFlags([
        { kind: "ALL_NULL", fields: ["net_flow_7d", "net_flow_30d"] },
        { kind: "UNIFORM", fields: ["netuid"] },
      ]),
      "ALL_NULL(net_flow_7d,net_flow_30d) UNIFORM(netuid)",
    );
    assert.equal(formatFlags([]), "");
  });
});

describe("mapWithConcurrency", () => {
  test("preserves input order regardless of completion order", async () => {
    const results = await mapWithConcurrency([30, 0, 10], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    assert.deepEqual(results, [30, 0, 10]);
  });

  test("never exceeds the requested concurrency", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 10 }), 2, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    });
    assert.equal(peak, 2);
  });

  test("handles an empty input list", async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => "unused"), []);
  });
});
