// Per-surface fixture loader for GraphQL/REST/MCP parity on
// GET /api/v1/fixtures/{surface_id}. Resolves deprecated surface_id aliases
// the same way get_fixture does, then reads the baked
// /metagraph/fixtures/{id}.json artifact.

import type { StorageReadResult } from "../workers/storage.ts";
import { SURFACE_ALIASES_PATH } from "./surface-aliases.ts";
import { findSurface } from "./surface-verify.ts";

// Same charset gate get_fixture / the REST fixture detail route apply so a
// surface_id cannot escape the fixtures/ R2 namespace.
export const FIXTURE_SURFACE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function fixtureArtifactPath(surfaceId: string): string {
  return `/metagraph/fixtures/${surfaceId}.json`;
}

export interface FixtureMcpError extends Error {
  toolError: true;
  code: string;
}

export function fixtureMcpError(
  code: string,
  message: string,
): FixtureMcpError {
  const error = new Error(message) as FixtureMcpError;
  error.toolError = true;
  error.code = code;
  return error;
}

export function parseFixtureSurfaceId(
  args: Record<string, unknown> | null | undefined,
): string {
  const surfaceId = args?.surface_id;
  if (typeof surfaceId !== "string" || surfaceId.trim() === "") {
    throw fixtureMcpError(
      "invalid_params",
      "Argument `surface_id` must be a non-empty string.",
    );
  }
  const normalized = surfaceId.trim();
  if (!FIXTURE_SURFACE_ID_PATTERN.test(normalized)) {
    throw fixtureMcpError(
      "invalid_params",
      "surface_id contains invalid characters.",
    );
  }
  return normalized;
}

type FixtureCtx = {
  env: Env;
  readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
};

async function readOptional(
  read: (env: Env, path: string) => Promise<StorageReadResult>,
  env: Env,
  path: string,
): Promise<Record<string, unknown> | null> {
  const result = await read(env, path);
  if (!result?.ok || !result.data || typeof result.data !== "object") {
    return null;
  }
  return result.data as Record<string, unknown>;
}

export async function resolveFixtureArtifactId(
  ctx: FixtureCtx,
  surfaceId: string,
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<string> {
  const read = readArtifact ?? ctx.readArtifact;
  const catalog = await readOptional(
    read,
    ctx.env,
    "/metagraph/operational-surfaces.json",
  );
  const surfaces = Array.isArray(catalog?.surfaces)
    ? (catalog.surfaces as Record<string, unknown>[])
    : [];
  let surface = findSurface(surfaces, surfaceId);
  if (!surface) {
    const aliases = await readOptional(read, ctx.env, SURFACE_ALIASES_PATH);
    surface = findSurface(surfaces, surfaceId, aliases);
  }
  const resolved = surface?.surface_id;
  return typeof resolved === "string" && resolved ? resolved : surfaceId;
}

export async function loadFixture(
  ctx: FixtureCtx,
  args: Record<string, unknown> | null | undefined,
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<unknown> {
  const surfaceId = parseFixtureSurfaceId(args);
  const read = readArtifact ?? ctx.readArtifact;
  const artifactId = await resolveFixtureArtifactId(ctx, surfaceId, {
    readArtifact: read,
  });
  const artifactPath = fixtureArtifactPath(artifactId);
  const result = await read(ctx.env, artifactPath);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (
      code === "artifact_not_found" ||
      code === "r2_binding_missing" ||
      code === "artifact_unavailable"
    ) {
      throw fixtureMcpError(
        "not_found",
        "No resource at the requested identifier. Use search_subnets or " +
          "list_subnet_apis to discover valid netuids / surface ids.",
      );
    }
    throw fixtureMcpError(code, `Could not load ${artifactPath} (${code}).`);
  }
  const data = result.data;
  if (!data || typeof data !== "object") {
    throw fixtureMcpError(
      "not_found",
      "No resource at the requested identifier. Use search_subnets or " +
        "list_subnet_apis to discover valid netuids / surface ids.",
    );
  }
  return data;
}
