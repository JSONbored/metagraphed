import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  GET_NETWORK_HEALTH_INSTRUCTIONS,
  GET_NETWORK_HEALTH_MCP_TOOL,
  GET_NETWORK_HEALTH_OUTPUT_SCHEMA,
  loadGlobalOperationalHealth,
  unknownGlobalHealth,
} from "../src/global-operational-health.mjs";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../src/mcp-server.mjs";

const FRESH_RUN = new Date(Date.now() - 60_000).toISOString();

const LIVE_KV = {
  generated_at: "2026-06-11T00:00:00.000Z",
  last_run_at: FRESH_RUN,
  health_source: "live-cron-prober",
  summary: {
    surface_count: 58,
    status_counts: { ok: 57, degraded: 1, failed: 0, unknown: 0 },
  },
  subnets: [{ netuid: 0, status: "ok", surface_count: 2, ok_count: 2 }],
};

function readHealthKv(_env, key) {
  if (key === "health:current") return Promise.resolve(LIVE_KV);
  return Promise.resolve(null);
}

describe("global-operational-health", () => {
  test("unknownGlobalHealth is schema-stable when the live store is cold", () => {
    const out = unknownGlobalHealth(42);
    assert.equal(out.scope, "operational");
    assert.equal(out.health_source, "unavailable");
    assert.equal(out.global.surface_count, 0);
    assert.deepEqual(out.subnets, []);
    assert.equal(out.contract_version, 42);
  });

  test("loadGlobalOperationalHealth builds the live global rollup from KV", async () => {
    const out = await loadGlobalOperationalHealth(
      { env: {}, readHealthKv },
      { contractVersion: () => 99 },
    );
    assert.equal(out.scope, "operational");
    assert.equal(out.health_source, "live-cron-prober");
    assert.equal(out.operational_observed_at, FRESH_RUN);
    assert.equal(out.global.surface_count, 58);
    assert.equal(out.subnets[0].netuid, 0);
    assert.equal(out.contract_version, 99);
  });

  test("loadGlobalOperationalHealth returns unknown when KV is cold", async () => {
    const out = await loadGlobalOperationalHealth(
      { env: {}, readHealthKv: async () => null },
      { contractVersion: () => 1 },
    );
    assert.equal(out.health_source, "unavailable");
    assert.equal(out.global.surface_count, 0);
  });

  test("accepts a static contractVersion without calling it as a function", async () => {
    const out = await loadGlobalOperationalHealth(
      { env: {}, readHealthKv: async () => null },
      { contractVersion: 77 },
    );
    assert.equal(out.contract_version, 77);
    assert.equal(out.health_source, "unavailable");
  });

  test("falls back to unknown when live KV lacks a summary block", async () => {
    const out = await loadGlobalOperationalHealth(
      {
        env: {},
        readHealthKv: async (_env, key) =>
          key === "health:current"
            ? { generated_at: "2026-06-11T00:00:00.000Z" }
            : null,
      },
      { contractVersion: () => 5 },
    );
    assert.equal(out.health_source, "unavailable");
    assert.equal(out.contract_version, 5);
  });

  // The "forwards an explicit db binding instead of env.METAGRAPH_HEALTH_DB"
  // regression test that used to live here asserted loadGlobalOperationalHealth
  // forwarded a `db` option through to resolveLiveHealth. D1 is fully
  // eliminated now: loadGlobalOperationalHealth({env, readHealthKv}, ...)
  // destructures only env/readHealthKv (no `db`), and calls
  // resolveLiveHealth({readHealthKv, env}) with no db forwarded at all --
  // src/health-serving.mjs's resolveLiveHealth no longer takes a `db` param
  // either. There is no db-forwarding behavior left to test, so the test was
  // deleted rather than converted.

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(GET_NETWORK_HEALTH_MCP_TOOL.name, "get_network_health");
    assert.match(GET_NETWORK_HEALTH_INSTRUCTIONS, /get_network_health/);
    assert.deepEqual(
      Object.keys(GET_NETWORK_HEALTH_MCP_TOOL.inputSchema.properties),
      [],
    );
    assert.ok(
      new Ajv2020({ strict: false }).compile(GET_NETWORK_HEALTH_OUTPUT_SCHEMA),
    );
  });

  test("MCP server exports wire get_network_health", () => {
    assert.match(MCP_INSTRUCTIONS, /get_network_health/);
    const tool = MCP_TOOLS.find((t) => t.name === "get_network_health");
    assert.ok(tool?.handler);
    assert.equal(tool.title, GET_NETWORK_HEALTH_MCP_TOOL.title);
  });
});
