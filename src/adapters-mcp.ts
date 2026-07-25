// Adapter snapshot loader for MCP parity on GET /api/v1/adapters/{slug}.
// Serves the baked /metagraph/adapters/{slug}.json artifact (adapter-backed
// public metrics for one subnet slug).

import { z } from "zod";
import type { StorageReadResult } from "../workers/storage.ts";
import {
  GetAdapterInputSchema,
  GetAdapterOutputSchema,
} from "../schemas-src/mcp-tools/get-adapter.ts";

export const ADAPTER_SLUG_PATTERN = /^[a-z0-9-]+$/;

export function adapterArtifactPath(slug: string): string {
  return `/metagraph/adapters/${slug}.json`;
}

export interface AdapterToolError extends Error {
  toolError: true;
  code: string;
}

export function adapterToolError(
  code: string,
  message: string,
): AdapterToolError {
  const error = new Error(message) as AdapterToolError;
  error.toolError = true;
  error.code = code;
  return error;
}

export function parseAdapterSlug(
  args: Record<string, unknown> | null | undefined,
): string {
  const slug = args?.slug;
  if (typeof slug !== "string" || slug.trim() === "") {
    throw adapterToolError(
      "invalid_params",
      "Argument `slug` must be a non-empty string.",
    );
  }
  const normalized = slug.trim();
  if (!ADAPTER_SLUG_PATTERN.test(normalized)) {
    throw adapterToolError(
      "invalid_params",
      "slug must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens).",
    );
  }
  return normalized;
}

export async function loadAdapter(
  ctx: {
    env: Env;
    readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  },
  args: Record<string, unknown> | null | undefined,
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<unknown> {
  const slug = parseAdapterSlug(args);
  const artifactPath = adapterArtifactPath(slug);
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, artifactPath);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw adapterToolError(
        "not_found",
        `No adapter snapshot exists for slug '${slug}'.`,
      );
    }
    throw adapterToolError(code, `Could not load ${artifactPath} (${code}).`);
  }
  const data = result.data;
  if (!data || typeof data !== "object") {
    throw adapterToolError(
      "not_found",
      `No adapter snapshot exists for slug '${slug}'.`,
    );
  }
  return data;
}

export const GET_ADAPTER_INSTRUCTIONS =
  "Use get_adapter to fetch one adapter-backed public metrics snapshot by slug " +
  "(mirrors GET /api/v1/adapters/{slug}), ";

export const GET_ADAPTER_MCP_TOOL = {
  name: "get_adapter",
  title: "Get adapter snapshot",
  description:
    "Fetch one adapter-backed public metrics snapshot for a subnet slug: the " +
    "captured adapter snapshot, extension metadata, and netuid linkage. Use it " +
    "after list_candidates or get_subnet to inspect how a subnet's public metrics " +
    "are adapter-projected. Mirrors GET /api/v1/adapters/{slug}.",
  inputSchema: z.toJSONSchema(GetAdapterInputSchema, {
    target: "draft-2020-12",
  }),
};

export const GET_ADAPTER_OUTPUT_SCHEMA = z.toJSONSchema(
  GetAdapterOutputSchema,
  {
    target: "draft-2020-12",
  },
);
