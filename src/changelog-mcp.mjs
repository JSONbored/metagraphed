// Changelog loader for MCP parity on GET /api/v1/changelog.
// Serves the baked /metagraph/changelog.json artifact (publish-time artifact,
// subnet, and coverage diffs).

export const CHANGELOG_ARTIFACT = "/metagraph/changelog.json";

export function changelogToolError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

export async function loadChangelog(ctx, { readArtifact } = {}) {
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, CHANGELOG_ARTIFACT);
  if (!result?.ok) {
    const code = result?.code || "artifact_unavailable";
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
  "get_changelog the latest publish-time registry change summary (artifact, " +
  "subnet, and coverage diffs; mirrors GET /api/v1/changelog), ";

export const GET_CHANGELOG_MCP_TOOL = {
  name: "get_changelog",
  title: "Get registry changelog",
  description:
    "Fetch the latest generated registry changelog: artifact added/modified/removed " +
    "rows, subnet added/removed/renamed events, and coverage deltas since the " +
    "previous publish. Use it to see what changed between registry publishes " +
    "before drilling into registry_summary or list_enrichment_targets. Mirrors " +
    "GET /api/v1/changelog.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };

export const GET_CHANGELOG_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["source", "summary", "artifacts", "subnets"],
  properties: {
    generated_at: NULLABLE_STRING,
    source: NULLABLE_STRING,
    notes: {
      type: ["array", "string", "null"],
      items: { type: "string" },
    },
    summary: { type: "object" },
    artifacts: { type: "object" },
    subnets: { type: "object" },
    coverage_delta: { type: ["object", "null"] },
  },
};
