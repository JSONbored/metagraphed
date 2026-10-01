import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { afterEach, test, vi } from "vitest";
import { mockEnv, type Row } from "./row-type.ts";

const work = vi.hoisted(() => ({ calls: 0, bytes: 0, enabled: true }));
vi.mock("../src/mcp-input-schema.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/mcp-input-schema.ts")>();
  return {
    ...actual,
    stripSentinelIntegerBounds<T>(schema: T): T {
      if (work.enabled) {
        work.calls++;
        const json = JSON.stringify(schema);
        if (json !== undefined) work.bytes += Buffer.byteLength(json);
      }
      return actual.stripSentinelIntegerBounds(schema);
    },
  };
});

const { listToolDefinitions, listPromptDefinitions, MCP_RESOURCE_TEMPLATES } =
  await import("../src/mcp-server.ts");
const { mcpServerCardResponse } =
  await import("../workers/request-handlers/discovery.ts");
const { resetModuleState } = await import("../src/module-state-registry.ts");
const url = "https://api.metagraph.sh/.well-known/mcp/server-card.json";
function reset() {
  resetModuleState();
  work.calls = 0;
  work.bytes = 0;
}
afterEach(() => {
  work.enabled = true;
  reset();
});

async function card(method = "GET", headers: Record<string, string> = {}) {
  const response = await mcpServerCardResponse(
    new Request(url, { method, headers }),
    mockEnv(),
  );
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    text: await response.text(),
  };
}

test("a cold server card counts every primitive without constructing schemas or priming the catalog", async () => {
  reset();
  const first = await card();
  assert.equal(first.status, 200);
  assert.equal(work.calls, 0);
  assert.equal(work.bytes, 0);
  const body = JSON.parse(first.text) as Row;
  const definitions = listToolDefinitions();
  assert.ok(
    work.calls > 0,
    "the card did not populate the normalized tool cache",
  );
  assert.deepEqual(body.primitive_counts, {
    tools: definitions.length,
    prompts: listPromptDefinitions().length,
    resource_templates: MCP_RESOURCE_TEMPLATES.length,
  });
  const baselineWork = { calls: work.calls, bytes: work.bytes };
  assert.deepEqual(
    await card(),
    first,
    "a normalized catalog changes no card field or bytes",
  );
  reset();
  // The prior request path built the full definitions before using their
  // lengths. Retain that real work as the fixture's independent reference.
  listToolDefinitions();
  listPromptDefinitions();
  assert.deepEqual({ calls: work.calls, bytes: work.bytes }, baselineWork);
  assert.deepEqual(
    await card(),
    first,
    "GET bytes, content hash and ETag are preserved",
  );
});

test("cold HEAD and conditional reads avoid catalog work and retain their exact response contract", async () => {
  reset();
  const get = await card();
  for (const [method, headers, status] of [
    ["HEAD", {}, 200],
    ["GET", { "if-none-match": get.headers.etag }, 304],
    ["GET", { "if-none-match": '"old", ' + get.headers.etag }, 304],
    ["GET", { "if-none-match": "*" }, 304],
  ] as const) {
    reset();
    const res = await card(method, headers);
    assert.equal(res.status, status);
    assert.equal(res.text, "");
    assert.equal(res.headers.etag, get.headers.etag);
    assert.equal(work.calls, 0);
  }
});

test("remote fixture quantifies removed cold catalog construction with identical card bytes", async () => {
  reset();
  listToolDefinitions();
  const prior = {
    normalizations: work.calls,
    schema_bytes_visited: work.bytes,
  };
  const expected = await card();
  const samples: { prior_ms: number; optimized_ms: number }[] = [];
  work.enabled = false; // Serialization and operation counters are excluded from timings.
  for (let i = 0; i < 9; i++) {
    const run = async (eager: boolean) => {
      reset();
      const started = performance.now();
      if (eager) {
        listToolDefinitions();
        listPromptDefinitions();
      }
      const response = await card();
      const elapsed = performance.now() - started;
      assert.deepEqual(response, expected);
      return elapsed;
    };
    const prior_ms = await run(true);
    const optimized_ms = await run(false);
    samples.push({ prior_ms, optimized_ms });
  }
  // Timing is evidence, not a flaky elapsed-time CI gate. Operation removal
  // and byte preservation are asserted in the deterministic regressions.
  console.log(
    "MCP_CARD_COUNT_FIXTURE " +
      JSON.stringify({
        runtime: process.version,
        measurement:
          "remote fixtures; cold normalized-catalog cache; not production latency",
        prior,
        optimized: { normalizations: 0, schema_bytes_visited: 0 },
        response_bytes: Buffer.byteLength(expected.text),
        samples,
      }),
  );
});
