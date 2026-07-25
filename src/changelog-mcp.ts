// Changelog loader for MCP parity on GET /api/v1/changelog.
// Serves the baked /metagraph/changelog.json artifact (publish-time artifact,
// subnet, and coverage diffs).

import { z } from "zod";
import type { StorageReadResult } from "../workers/storage.ts";
import {
  GetChangelogInputSchema,
  GetChangelogOutputSchema,
} from "../schemas-src/mcp-tools/meta-artifacts-2.ts";

export const CHANGELOG_ARTIFACT = "/metagraph/changelog.json";

export interface ChangelogToolError extends Error {
  toolError: true;
  code: string;
}

export function changelogToolError(
  code: string,
  message: string,
): ChangelogToolError {
  const error = new Error(message) as ChangelogToolError;
  error.toolError = true;
  error.code = code;
  return error;
}

export async function loadChangelog(
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
  const result = await read(ctx.env, CHANGELOG_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw changelogToolError(
        "not_found",
        "The registry changelog is unavailable in this environment.",
      );
    }
    throw changelogToolError(
      code,
      `Could not load ${CHANGELOG_ARTIFACT} (${code}).`,
    );
  }
  return result.data;
}

export const GET_CHANGELOG_INSTRUCTIONS =
  "Use get_changelog to fetch the latest publish-time registry change summary " +
  "(artifact, subnet, and coverage diffs; mirrors GET /api/v1/changelog), ";

export const GET_CHANGELOG_MCP_TOOL = {
  name: "get_changelog",
  title: "Get registry changelog",
  description:
    "Fetch the latest generated registry changelog: artifact added/modified/removed " +
    "rows, subnet added/removed/renamed events, and coverage deltas since the " +
    "previous publish. Use it to see what changed between registry publishes " +
    "before drilling into registry_summary or list_enrichment_targets. Mirrors " +
    "GET /api/v1/changelog.",
  inputSchema: z.toJSONSchema(GetChangelogInputSchema, {
    target: "draft-2020-12",
  }),
};

export const GET_CHANGELOG_OUTPUT_SCHEMA = z.toJSONSchema(
  GetChangelogOutputSchema,
  {
    target: "draft-2020-12",
  },
);
