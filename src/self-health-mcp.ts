// Self-health loader for MCP parity on GET /api/v1/self-health (#8422).
// Serves the baked /metagraph/self-health.json artifact (metagraphed's OWN
// uptime verdict plus each component's trailing-90-day daily ratios), the same
// meta-artifact family as build/changelog/contracts.

import { z } from "zod";
import type { StorageReadResult } from "../workers/storage.ts";
import {
  GetSelfHealthInputSchema,
  GetSelfHealthOutputSchema,
} from "../schemas-src/mcp-tools/meta-artifacts-2.ts";

export const SELF_HEALTH_ARTIFACT = "/metagraph/self-health.json";

export interface SelfHealthToolError extends Error {
  toolError: true;
  code: string;
}

export function selfHealthToolError(
  code: string,
  message: string,
): SelfHealthToolError {
  const error = new Error(message) as SelfHealthToolError;
  error.toolError = true;
  error.code = code;
  return error;
}

export async function loadSelfHealth(
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
  const result = await read(ctx.env, SELF_HEALTH_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw selfHealthToolError(
        "not_found",
        "The self-health verdict is unavailable in this environment.",
      );
    }
    throw selfHealthToolError(
      code,
      `Could not load ${SELF_HEALTH_ARTIFACT} (${code}).`,
    );
  }
  return result.data;
}

export const GET_SELF_HEALTH_INSTRUCTIONS =
  "Use get_self_health to fetch metagraphed's own uptime verdict (api/site/" +
  "publish component health with trailing-90-day daily ratios; mirrors " +
  "GET /api/v1/self-health), ";

export const GET_SELF_HEALTH_MCP_TOOL = {
  name: "get_self_health",
  title: "Get self-health verdict",
  description:
    "Fetch metagraphed's OWN uptime verdict: the api/site/publish component " +
    "views with their latest probe state and trailing-90-day daily uptime " +
    "ratios, plus the rolled-up operational/degraded/outage verdict. Scoped " +
    "strictly to our own surfaces -- never third-party subnet health (that is " +
    "get_health). Mirrors GET /api/v1/self-health.",
  inputSchema: z.toJSONSchema(GetSelfHealthInputSchema, {
    target: "draft-2020-12",
  }),
};

export const GET_SELF_HEALTH_OUTPUT_SCHEMA = z.toJSONSchema(
  GetSelfHealthOutputSchema,
  {
    target: "draft-2020-12",
  },
);
