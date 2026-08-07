// `include_summary` on get_subnet_economics (#9874).
//
// The block is network-wide, so a caller sweeping 129 subnets receives the
// identical object 129 times -- ~19% of each response, measured against
// production on 2026-08-07 (1,658 bytes total, 315 of them summary).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

// The economics blob this tool reads, with the network-wide `summary` the
// parameter under test drops. Served through the same readArtifact dep the
// production loader calls, so the opt-out is exercised on the real path.
const ECONOMICS = {
  captured_at: "2026-08-07T15:00:00.000Z",
  summary: {
    subnet_count: 129,
    with_economics_count: 129,
    total_stake_alpha: 12345.6,
    total_validators: 8100,
    total_miners: 21000,
    registration_open_count: 111,
  },
  subnets: [
    {
      netuid: 1,
      validator_count: 64,
      miner_count: 192,
      registration_open: true,
      alpha_price: 0.0325,
      emission_share: 0.041,
    },
  ],
};

function deps(artifacts: Row = { "/metagraph/economics.json": ECONOMICS }) {
  return {
    readArtifact(_env: unknown, path: string) {
      return Promise.resolve(
        Object.hasOwn(artifacts, path)
          ? {
              ok: true,
              data: artifacts[path],
              source: "test",
              storage_tier: "git",
            }
          : {
              ok: false,
              status: 404,
              code: "artifact_not_found",
              message: path,
            },
      );
    },
    readHealthKv() {
      return Promise.resolve(null);
    },
  };
}

async function callTool(args: Row, artifacts?: Row) {
  const res = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_subnet_economics", arguments: args },
      }),
    }),
    {} as never,
    deps(artifacts) as never,
  );
  const body = (await res.json()) as Row;
  return {
    data: (body.result as Row)?.structuredContent as Row,
    text: String(
      (((body.result as Row)?.content ?? []) as Row[])[0]?.text ?? "",
    ),
  };
}

describe("get_subnet_economics include_summary (#9874)", () => {
  test("omitted keeps the summary, so no existing caller changes", async () => {
    const { data } = await callTool({ netuid: 1 });
    assert.ok(Object.hasOwn(data, "summary"));
    assert.equal(data.netuid, 1);
    // Every sibling field is asserted BY NAME, not by comparing two calls to
    // each other: writing this change I dropped `captured_at` from the
    // loader, and a same-vs-same comparison passes happily when a field is
    // missing from both sides.
    assert.equal(data.captured_at, "2026-08-07T15:00:00.000Z");
    assert.equal(data.source, "r2-fallback");
    assert.equal((data.economics as Row).emission_share, 0.041);
  });

  test("true is the same as omitted", async () => {
    const [omitted, explicit] = await Promise.all([
      callTool({ netuid: 1 }),
      callTool({ netuid: 1, include_summary: true }),
    ]);
    assert.deepEqual(omitted.data, explicit.data);
  });

  test("false nulls the summary and leaves everything else alone", async () => {
    const [withSummary, without] = await Promise.all([
      callTool({ netuid: 1 }),
      callTool({ netuid: 1, include_summary: false }),
    ]);
    assert.equal(without.data.summary, null);
    // The opt-out drops the summary and NOTHING else.
    assert.equal(without.data.captured_at, "2026-08-07T15:00:00.000Z");
    assert.equal((without.data.economics as Row).emission_share, 0.041);
    // Null rather than absent: a caller reading `summary` gets the same value
    // the no-blob case already produced, instead of having to branch on
    // whether the key exists.
    assert.equal(Object.hasOwn(without.data, "summary"), true);
    assert.deepEqual(
      { ...without.data, summary: undefined },
      { ...withSummary.data, summary: undefined },
    );
  });

  test("a non-boolean is rejected rather than coerced", async () => {
    // "false" the string is the mistake worth catching: coercing it would
    // silently include the block the caller asked to drop.
    const { text } = await callTool({ netuid: 1, include_summary: "false" });
    assert.match(text, /invalid_params/);
  });

  test("the parameter is published with an example a sweep would copy", async () => {
    const def = listToolDefinitions().find(
      (tool) => (tool as Row).name === "get_subnet_economics",
    ) as Row;
    const input = def.inputSchema as Row;
    const param = (input.properties as Row).include_summary as Row;
    assert.equal(param.type, "boolean");
    // The example is `false`, because `true` is the default and an example
    // showing the default teaches nothing.
    assert.deepEqual(param.examples, [false]);
    assert.equal(
      (input.required as string[]).includes("include_summary"),
      false,
    );
    assert.match(String(def.description), /include_summary/);
  });
});
