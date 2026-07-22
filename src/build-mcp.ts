// Build summary loader for MCP parity on GET /api/v1/build.
// Serves the baked /metagraph/build-summary.json artifact (artifact inventory,
// counts, and publish metadata).

import type { StorageReadResult } from "../workers/storage.ts";

export const BUILD_SUMMARY_ARTIFACT = "/metagraph/build-summary.json";

export interface BuildToolError extends Error {
  toolError: true;
  code: string;
}

export function buildToolError(code: string, message: string): BuildToolError {
  const error = new Error(message) as BuildToolError;
  error.toolError = true;
  error.code = code;
  return error;
}

export async function loadBuildSummary(
  ctx: {
    env: Env;
    readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  },
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<unknown> {
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, BUILD_SUMMARY_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw buildToolError(
        "not_found",
        "The registry build summary is unavailable in this environment.",
      );
    }
    throw buildToolError(
      code,
      `Could not load ${BUILD_SUMMARY_ARTIFACT} (${code}).`,
    );
  }
  return result.data;
}

export const GET_BUILD_INSTRUCTIONS =
  "Use get_build to fetch the generated build summary (artifact inventory, " +
  "counts, and publish metadata; mirrors GET /api/v1/build), ";

export const GET_BUILD_MCP_TOOL = {
  name: "get_build",
  title: "Get build summary",
  description:
    "Fetch the generated build summary: artifact inventory counts and sizes, " +
    "subnet/provider/surface totals, coverage rollup, and publish metadata. " +
    "Use it to inspect the latest registry publish footprint before drilling " +
    "into get_changelog or get_freshness. Mirrors GET /api/v1/build.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };

export const GET_BUILD_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "artifact_count"],
  properties: {
    schema_version: { type: "integer" },
    contract_version: NULLABLE_STRING,
    generated_at: NULLABLE_STRING,
    published_at: NULLABLE_STRING,
    adapter_count: { type: ["integer", "null"] },
    artifact_count: { type: "integer" },
    artifact_size_bytes: { type: ["integer", "null"] },
    subnet_count: { type: ["integer", "null"] },
    surface_count: { type: ["integer", "null"] },
    provider_count: { type: ["integer", "null"] },
    artifacts: {
      type: ["array", "null"],
      items: { type: "object" },
    },
    coverage: { type: ["object", "null"] },
    artifact_budget_summary: { type: ["object", "null"] },
  },
};
