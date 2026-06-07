export const ARTIFACT_STORAGE_TIERS = {
  dual: "dual",
  git: "git",
  r2: "r2",
};

export const R2_STAGING_RELATIVE_ROOT = "dist/metagraph-r2/metagraph";

const R2_ONLY_PATTERNS = [
  /^adapters\/[^/]+\.json$/,
  /^candidates\/(?:\d+|\{netuid\})\.json$/,
  /^endpoints\/(?:\d+|\{netuid\})\.json$/,
  /^health\/badges\/(?:\d+|\{netuid\})\.json$/,
  /^health\/history\/(?:\d{4}-\d{2}-\d{2}|\{date\})\.json$/,
  /^health\/latest\.json$/,
  /^health\/subnets\/(?:\d+|\{netuid\})\.json$/,
  /^metagraph\/latest\.json$/,
  /^providers\/[^/]+\.json$/,
  /^providers\/[^/]+\/endpoints\.json$/,
  /^schemas\/(?!index\.json$).+\.json$/,
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
  /^endpoint-incidents\.json$/,
  /^endpoint-pools\.json$/,
  /^endpoints\.json$/,
  /^evidence-ledger\.json$/,
  /^freshness\.json$/,
  /^gaps\.json$/,
  /^health\/summary\.json$/,
  /^openapi\.json$/,
  /^providers\.json$/,
  /^r2-manifest\.json$/,
  /^review\/adapter-candidates\.json$/,
  /^review\/curation\.json$/,
  /^review\/gap-priorities\.json$/,
  /^review\/maintainer-decisions\.json$/,
  /^review-queue\.json$/,
  /^rpc\/pools\.json$/,
  /^rpc-endpoints\.json$/,
  /^schema-drift\.json$/,
  /^schemas\/index\.json$/,
  /^search\.json$/,
  /^source-health\.json$/,
  /^subnets\.json$/,
  /^surfaces\.json$/,
  /^types\.d\.ts$/,
];

export function artifactRelativePath(artifactPath = "") {
  return String(artifactPath)
    .replace(/^\/+/, "")
    .replace(/^metagraph\//, "");
}

export function artifactStorageTierForRelativePath(relativePath = "") {
  const normalized = artifactRelativePath(relativePath);
  if (R2_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return ARTIFACT_STORAGE_TIERS.r2;
  }
  if (DUAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return ARTIFACT_STORAGE_TIERS.dual;
  }
  return ARTIFACT_STORAGE_TIERS.git;
}

export function artifactStorageTierForPath(artifactPath = "") {
  return artifactStorageTierForRelativePath(artifactRelativePath(artifactPath));
}

export function isR2OnlyArtifactPath(artifactPath = "") {
  return artifactStorageTierForPath(artifactPath) === ARTIFACT_STORAGE_TIERS.r2;
}
