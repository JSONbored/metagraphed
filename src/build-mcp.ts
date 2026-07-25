// Build summary loader for MCP parity on GET /api/v1/build.
// Serves the baked /metagraph/build-summary.json artifact (artifact inventory,
// counts, and publish metadata).

import { z } from "zod";
import type { StorageReadResult } from "../workers/storage.ts";
import {
  GetBuildInputSchema,
  GetBuildOutputSchema,
} from "../schemas-src/mcp-tools/meta-artifacts-2.ts";

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
  inputSchema: z.toJSONSchema(GetBuildInputSchema, {
    target: "draft-2020-12",
  }),
};

export const GET_BUILD_OUTPUT_SCHEMA = z.toJSONSchema(GetBuildOutputSchema, {
  target: "draft-2020-12",
});
