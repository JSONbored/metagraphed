// Registry coverage loader for MCP parity on GET /api/v1/coverage.
// Serves the baked /metagraph/coverage.json artifact (surface counts,
// completeness aggregate, domain breakdown).
import type { StorageReadResult } from "../workers/storage.ts";

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
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };

export const GET_COVERAGE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["surface_count", "completeness"],
  properties: {
    generated_at: NULLABLE_STRING,
    surface_count: { type: "integer" },
    official_surface_count: { type: "integer" },
    first_party_subnet_count: { type: "integer" },
    chain_subnet_count: { type: "integer" },
    candidate_count: { type: "integer" },
    probed_count: { type: "integer" },
    domain_coverage: { type: "object" },
    completeness: { type: "object" },
    subnets_without_official_surface: { type: "integer" },
  },
};
