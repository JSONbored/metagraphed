import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  GET_NETWORK_HEALTH_MCP_TOOL,
  GET_NETWORK_HEALTH_OUTPUT_SCHEMA,
  loadGlobalOperationalHealth,
  unknownGlobalHealth,
} from "../src/global-operational-health.mjs";

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

  test("MCP tool metadata and outputSchema compile", () => {
    assert.equal(GET_NETWORK_HEALTH_MCP_TOOL.name, "get_network_health");
    assert.deepEqual(
      Object.keys(GET_NETWORK_HEALTH_MCP_TOOL.inputSchema.properties),
      [],
    );
    assert.ok(new Ajv2020().compile(GET_NETWORK_HEALTH_OUTPUT_SCHEMA));
  });
});
