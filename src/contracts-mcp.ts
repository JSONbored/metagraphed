// Artifact contracts loader for MCP parity on GET /api/v1/contracts.
// Serves the baked /metagraph/contracts.json artifact (public artifact
// contract metadata for registry consumers).

import type { StorageReadResult } from "../workers/storage.ts";

export const CONTRACTS_ARTIFACT = "/metagraph/contracts.json";

export interface ContractsToolError extends Error {
  toolError: true;
  code: string;
}

export function contractsToolError(
  code: string,
  message: string,
): ContractsToolError {
  const error = new Error(message) as ContractsToolError;
  error.toolError = true;
  error.code = code;
  return error;
}

export async function loadContracts(
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
  const result = await read(ctx.env, CONTRACTS_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw contractsToolError(
        "not_found",
        "The artifact contract metadata is unavailable in this environment.",
      );
    }
    throw contractsToolError(
      code,
      `Could not load ${CONTRACTS_ARTIFACT} (${code}).`,
    );
  }
  return result.data;
}

export const GET_CONTRACTS_INSTRUCTIONS =
  "Use get_contracts to fetch the public artifact contract metadata (paths, " +
  "storage tiers, and schema refs; mirrors GET /api/v1/contracts), ";

export const GET_CONTRACTS_MCP_TOOL = {
  name: "get_contracts",
  title: "Get artifact contract metadata",
  description:
    "Fetch the registry's public artifact contract metadata: every baked " +
    "artifact path, storage tier, schema reference, and consumer notes. Use it " +
    "to discover which artifacts exist and how to read them before calling " +
    "get_api_schema or list_schemas. Mirrors GET /api/v1/contracts.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };

export const GET_CONTRACTS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "artifacts"],
  properties: {
    schema_version: { type: "integer" },
    contract_version: NULLABLE_STRING,
    generated_at: NULLABLE_STRING,
    name: NULLABLE_STRING,
    base_path: NULLABLE_STRING,
    primary_domain: NULLABLE_STRING,
    openapi_url: NULLABLE_STRING,
    type_definitions_url: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    artifacts: {
      type: "array",
      items: { type: "object" },
    },
  },
};
