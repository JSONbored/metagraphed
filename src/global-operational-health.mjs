// Global operational health loader for REST + MCP parity on GET /api/v1/health.
// Live-only: KV health:current → Postgres tier (D1 fully eliminated,
// 2026-07-17), with an explicit unknown payload when the live store is cold
// (never a stale baked fallback).

import { buildGlobalHealth, resolveLiveHealth } from "./health-serving.mjs";

export function unknownGlobalHealth(contractVersionValue) {
  return {
    schema_version: 1,
    contract_version: contractVersionValue,
    source: "unavailable",
    scope: "operational",
    operational_observed_at: null,
    health_source: "unavailable",
    global: {
      surface_count: 0,
      status_counts: { ok: 0, degraded: 0, failed: 0, unknown: 0 },
    },
    subnets: [],
  };
}

export async function loadGlobalOperationalHealth(
  { env, readHealthKv },
  { contractVersion } = {},
) {
  const contractVersionValue =
    typeof contractVersion === "function"
      ? contractVersion(env)
      : contractVersion;
  const liveSnapshot = await resolveLiveHealth({ readHealthKv, env });
  const liveData = liveSnapshot
    ? buildGlobalHealth(liveSnapshot, {
        contract_version: contractVersionValue,
      })
    : null;
  return liveData || unknownGlobalHealth(contractVersionValue);
}

export const GET_NETWORK_HEALTH_INSTRUCTIONS =
  "get_network_health the live global operational rollup " +
  "(per-subnet surface status + global counts), ";

export const GET_NETWORK_HEALTH_MCP_TOOL = {
  name: "get_network_health",
  title: "Get global operational health",
  description:
    "Fetch the live global operational health rollup: global surface counts " +
    "by status (ok/degraded/failed/unknown) and per-subnet operational status " +
    "from the ~15-minute health prober (KV health:current → D1 surface_status). " +
    "Use it for a network-wide health snapshot before drilling into " +
    "get_subnet_health or get_health_trends. Mirrors GET /api/v1/health.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };

export const GET_NETWORK_HEALTH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "scope", "global", "subnets"],
  properties: {
    schema_version: { type: "integer" },
    contract_version: { type: ["integer", "string", "null"] },
    generated_at: NULLABLE_STRING,
    source: NULLABLE_STRING,
    health_source: NULLABLE_STRING,
    scope: { type: "string" },
    operational_observed_at: NULLABLE_STRING,
    global: { type: "object" },
    subnets: { type: "array", items: { type: "object" } },
  },
};
