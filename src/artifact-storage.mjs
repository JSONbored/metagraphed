export const ARTIFACT_STORAGE_TIERS = {
  dual: "dual",
  git: "git",
  r2: "r2",
};

export const R2_STAGING_RELATIVE_ROOT = "dist/metagraph-r2/metagraph";

const R2_ONLY_PATTERNS = [
  /^adapters\/[^/]+\.json$/,
  /^candidates\.json$/,
  /^candidates\/(?:\d+|\{netuid\})\.json$/,
  /^endpoint-incidents\.json$/,
  /^endpoint-pools\.json$/,
  /^endpoints\.json$/,
  /^endpoints\/(?:\d+|\{netuid\})\.json$/,
  /^health\/badges\/(?:\d+|\{netuid\})\.json$/,
  /^health\/history\/(?:\d{4}-\d{2}-\d{2}|\{date\})\.json$/,
  /^health\/latest\.json$/,
  /^health\/summary\.json$/,
  /^health\/subnets\/(?:\d+|\{netuid\})\.json$/,
  /^metagraph\/latest\.json$/,
  /^profiles\/(?:\d+|\{netuid\})\.json$/,
  /^providers\/[^/]+\.json$/,
  /^providers\/[^/]+\/endpoints\.json$/,
  /^review-queue\.json$/,
  /^review\/enrichment-evidence\.json$/,
  /^review\/enrichment-targets\.json$/,
  /^rpc\/pools\.json$/,
  /^rpc-endpoints\.json$/,
  /^schemas\/(?!index\.json$).+\.json$/,
  /^source-health\.json$/,
  /^source-snapshots\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\.json$/,
  /^surfaces\/(?:\d+|\{netuid\})\.json$/,
  /^verification\/latest\.json$/,
  /^verification\/subnets\/(?:\d+|\{netuid\})\.json$/,
];

const DUAL_PATTERNS = [
  /^api-index\.json$/,
  /^build-summary\.json$/,
  /^changelog\.json$/,
  /^contracts\.json$/,
  /^coverage\.json$/,
  /^curation\.json$/,
  /^evidence-ledger\.json$/,
  /^freshness\.json$/,
  /^gaps\.json$/,
  /^openapi\.json$/,
  /^profiles\.json$/,
  /^providers\.json$/,
  /^r2-manifest\.json$/,
  /^review\/adapter-candidates\.json$/,
  /^review\/curation\.json$/,
  /^review\/enrichment-queue\.json$/,
  /^review\/gap-priorities\.json$/,
  /^review\/maintainer-decisions\.json$/,
  /^schema-drift\.json$/,
  /^schemas\/index\.json$/,
  /^search\.json$/,
  /^subnets\.json$/,
  /^surfaces\.json$/,
  /^types\.d\.ts$/,
];

export function artifactRelativePath(artifactPath = "") {
  const value = String(artifactPath);
  const normalized = value.replace(/^\/+/, "");
  if (value.startsWith("/") && normalized.startsWith("metagraph/")) {
    return normalized.replace(/^metagraph\//, "");
  }
  return normalized;
}

export function isGeneratedPublicArtifactRelativePath(relativePath = "") {
  const normalized = artifactRelativePath(relativePath);
  return DUAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function artifactStorageTierForRelativePath(relativePath = "") {
  const normalized = artifactRelativePath(relativePath);
  if (R2_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return ARTIFACT_STORAGE_TIERS.r2;
  }
  if (isGeneratedPublicArtifactRelativePath(normalized)) {
    return ARTIFACT_STORAGE_TIERS.dual;
  }
  return ARTIFACT_STORAGE_TIERS.git;
}

export function artifactStorageTierForPath(artifactPath = "") {
  return artifactStorageTierForRelativePath(artifactRelativePath(artifactPath));
}

export function schemaDetailArtifactRelativePath(artifactPath = "") {
  const relativePath = artifactRelativePath(artifactPath);
  if (!relativePath || relativePath === "schemas/index.json") {
    return null;
  }
  if (!relativePath.startsWith("schemas/") || !relativePath.endsWith(".json")) {
    return null;
  }
  if (relativePath.includes("\\")) {
    return null;
  }
  const segments = relativePath.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return relativePath;
}

export function isR2OnlyArtifactPath(artifactPath = "") {
  return artifactStorageTierForPath(artifactPath) === ARTIFACT_STORAGE_TIERS.r2;
}
