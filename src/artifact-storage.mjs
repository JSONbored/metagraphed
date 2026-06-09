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
  // High-churn data with NO hardcoded public-path readers, moved out of git
  // (ADR 0001): derived from committed inputs + live enrichment, built to dist/,
  // served from R2 + edge cache, never committed. ~3.1 MB of per-refresh churn
  // eliminated. (surfaces/freshness/schema-drift stay dual below — they have
  // hardcoded readers in sync-summary/kv-publish; moving them needs a tier-aware
  // read, a follow-up. Likewise the small digests build-summary/changelog/
  // r2-manifest and subnets/coverage.)
  /^curation\.json$/,
  /^evidence-ledger\.json$/,
  /^gaps\.json$/,
  /^profiles\.json$/,
  /^providers\.json$/,
  /^review\/adapter-candidates\.json$/,
  /^review\/curation\.json$/,
  /^review\/enrichment-queue\.json$/,
  /^review\/gap-priorities\.json$/,
  /^review\/maintainer-decisions\.json$/,
  /^search\.json$/,
];

// Committed to git (and mirrored to R2): the low-churn, consumer-facing API
// contract plus the small coverage "shop window". These only change when the
// API/schema changes — exactly what belongs in version control.
const DUAL_PATTERNS = [
  /^api-index\.json$/,
  // Small digests with hardcoded public-path readers (ci-verify, validate,
  // tests). Kept committed for now (~18 KB total); routing them to R2 is a
  // follow-up. The ~5 MB of high-churn data artifacts are R2-only above.
  /^build-summary\.json$/,
  /^changelog\.json$/,
  /^r2-manifest\.json$/,
  /^contracts\.json$/,
  /^coverage\.json$/,
  // Hardcoded public-path readers keep these dual for now (follow-up to route
  // them to R2 via a tier-aware read): surfaces + freshness (sync-summary.mjs,
  // kv-publish-pointer.mjs), schema-drift (sync-summary.mjs).
  /^freshness\.json$/,
  /^schema-drift\.json$/,
  /^surfaces\.json$/,
  /^openapi\.json$/,
  /^schemas\/index\.json$/,
  // subnets.json (124 KB) stays committed: the changelog diffs it against the
  // committed HEAD version to produce the "what changed between publishes" feed.
  /^subnets\.json$/,
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
