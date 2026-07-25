// Registry coverage loader for MCP parity on GET /api/v1/coverage.
// Serves the baked /metagraph/coverage.json artifact (surface counts,
// completeness aggregate, domain breakdown).
import { z } from "zod";
import type { StorageReadResult } from "../workers/storage.ts";
import {
  GetCoverageInputSchema,
  GetCoverageOutputSchema,
} from "../schemas-src/mcp-tools/meta-artifacts-2.ts";

export const REGISTRY_COVERAGE_ARTIFACT = "/metagraph/coverage.json";

export interface RegistryCoverageToolError extends Error {
  toolError: true;
  code: string;
}

export function registryCoverageToolError(
  code: string,
  message: string,
): RegistryCoverageToolError {
  const error = new Error(message) as RegistryCoverageToolError;
  error.toolError = true;
  error.code = code;
  return error;
}

export async function loadRegistryCoverage(
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
  const result = await read(ctx.env, REGISTRY_COVERAGE_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw registryCoverageToolError(
        "not_found",
        "No resource at the requested identifier. Use search_subnets or " +
          "list_subnet_apis to discover valid netuids / surface ids.",
      );
    }
    throw registryCoverageToolError(
      code,
      `Could not load ${REGISTRY_COVERAGE_ARTIFACT} (${code}).`,
    );
  }
  return result.data;
}

export const GET_COVERAGE_INSTRUCTIONS =
  "get_coverage the baked registry coverage summary (surface counts, " +
  "completeness aggregate, domain breakdown; mirrors GET /api/v1/coverage), ";

export const GET_COVERAGE_MCP_TOOL = {
  name: "get_coverage",
  title: "Get registry coverage summary",
  description:
    "Fetch the registry-wide coverage rollup: surface counts, official-surface " +
    "coverage, completeness scores, domain breakdown, and candidate/probe counts. " +
    "Use for a fast registry-wide coverage snapshot before drilling into " +
    "list_enrichment_targets (coverage-depth queue) or registry_summary. " +
    "Mirrors GET /api/v1/coverage.",
  inputSchema: z.toJSONSchema(GetCoverageInputSchema, {
    target: "draft-2020-12",
  }),
};

export const GET_COVERAGE_OUTPUT_SCHEMA = z.toJSONSchema(
  GetCoverageOutputSchema,
  {
    target: "draft-2020-12",
  },
);
