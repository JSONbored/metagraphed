// Global operational health loader for REST + MCP parity on GET /api/v1/health.
// Live-only: KV health:current → Postgres tier (D1 fully eliminated,
// 2026-07-17), with an explicit unknown payload when the live store is cold
// (never a stale baked fallback).
import { emptyStatusCounts } from "./endpoint-score.ts";
import type { HealthStatus } from "../schemas-src/shared.ts";

import { z } from "zod";
import { buildGlobalHealth, resolveLiveHealth } from "./health-serving.ts";
import {
  GetNetworkHealthInputSchema,
  GetNetworkHealthOutputSchema,
} from "../schemas-src/mcp-tools/get-network-health.ts";

export interface UnknownGlobalHealth {
  schema_version: 1;
  contract_version: unknown;
  source: "unavailable";
  scope: "operational";
  operational_observed_at: null;
  health_source: "unavailable";
  global: {
    surface_count: 0;
    status_counts: Record<HealthStatus, number>;
  };
  subnets: [];
}

export function unknownGlobalHealth(
  contractVersionValue: unknown,
): UnknownGlobalHealth {
  return {
    schema_version: 1,
    contract_version: contractVersionValue,
    source: "unavailable",
    scope: "operational",
    operational_observed_at: null,
    health_source: "unavailable",
    global: {
      surface_count: 0,
      status_counts: emptyStatusCounts(),
    },
    subnets: [],
  };
}

export async function loadGlobalOperationalHealth(
  {
    env,
    readHealthKv,
  }: {
    env: Env;
    readHealthKv?: (
      env: Env,
      key: string,
    ) => Promise<Record<string, unknown> | null>;
  },
  {
    contractVersion,
  }: {
    contractVersion?: ((env: Env) => unknown) | unknown;
  } = {},
): Promise<unknown> {
  const contractVersionValue =
    typeof contractVersion === "function"
      ? (contractVersion as (env: Env) => unknown)(env)
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
  inputSchema: z.toJSONSchema(GetNetworkHealthInputSchema, {
    target: "draft-2020-12",
  }),
};

export const GET_NETWORK_HEALTH_OUTPUT_SCHEMA = z.toJSONSchema(
  GetNetworkHealthOutputSchema,
  { target: "draft-2020-12" },
);
