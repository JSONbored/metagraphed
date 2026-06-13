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
  /^evidence\/(?:\d+|\{netuid\})\.json$/,
  /^overview\/(?:\d+|\{netuid\})\.json$/,
  /^health\/badges\/(?:\d+|\{netuid\})\.json$/,
  /^health\/history\/(?:\d{4}-\d{2}-\d{2}|\{date\})\.json$/,
  /^health\/latest\.json$/,
  /^health\/summary\.json$/,
  /^health\/subnets\/(?:\d+|\{netuid\})\.json$/,
  // Health trends are computed live from D1 by the Worker, never written as a
  // file. Marked R2-only so the contract maps a schema to the route without the
  // build expecting a committed/staged artifact.
  /^health\/trends\/(?:\d+|\{netuid\})\.json$/,
  // AI-4 analytics: also computed live from D1, never written as files.
  /^health\/percentiles\/(?:\d+|\{netuid\})\.json$/,
  /^health\/incidents\/(?:\d+|\{netuid\})\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/trajectory\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/uptime\.json$/,
  /^registry\/leaderboards\.json$/,
  // Per-subnet agent capability catalog (full service detail) — large, built.
  /^agent-catalog\/(?:\d+|\{netuid\})\.json$/,
  /^metagraph\/latest\.json$/,
  /^profiles\/(?:\d+|\{netuid\})\.json$/,
  /^providers\/[^/]+\.json$/,
  /^providers\/[^/]+\/endpoints\.json$/,
  /^review-queue\.json$/,
  /^review\/enrichment-evidence\.json$/,
  /^review\/enrichment-targets\.json$/,
  /^review\/gaps\/(?:\d+|\{netuid\})\.json$/,
  /^rpc\/pools\.json$/,
  /^rpc-endpoints\.json$/,
  /^schemas\/(?!index\.json$).+\.json$/,
  // Per-surface captured live fixtures (issue #352) — R2-only like the schema
  // detail; the committed fixtures.json index (below) lists what's available.
  /^fixtures\/.+\.json$/,
  /^source-health\.json$/,
  /^source-snapshots\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\.json$/,
  /^surfaces\/(?:\d+|\{netuid\})\.json$/,
  /^verification\/latest\.json$/,
  /^verification\/subnets\/(?:\d+|\{netuid\})\.json$/,
  // High-churn data moved out of git (ADR 0001): derived from committed inputs +
  // live enrichment, built to dist/, served from R2 + edge cache, never
  // committed. ~4.3 MB of per-refresh churn eliminated. Their readers are
  // tier-aware (artifactFilePath / kv-publish) or tolerate a null (sync-summary).
  // (The small digests build-summary/changelog/r2-manifest and subnets/coverage
  // stay dual — they feed the changelog/ci-verify against a committed baseline.)
  /^curation\.json$/,
  /^evidence-ledger\.json$/,
  /^freshness\.json$/,
  /^gaps\.json$/,
  /^profiles\.json$/,
  /^providers\.json$/,
  /^registry-summary\.json$/,
  /^review\/adapter-candidates\.json$/,
  /^review\/curation\.json$/,
  /^review\/enrichment-queue\.json$/,
  /^review\/gap-priorities\.json$/,
  /^review\/maintainer-decisions\.json$/,
  /^schema-drift\.json$/,
  /^search\.json$/,
  /^surfaces\.json$/,
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
  // Operational-surfaces list: low-churn (changes only when the registry gains
  // operational surfaces), read by the Worker cron prober at runtime via ASSETS.
  // Committed + mirrored to R2 like the other small contract digests.
  /^operational-surfaces\.json$/,
  // Compact agent-catalog index (the per-subnet detail is R2-only above). Small,
  // agent-facing; committed + mirrored so it's always available to MCP/agents.
  /^agent-catalog\.json$/,
  /^openapi\.json$/,
  /^schemas\/index\.json$/,
  // subnets.json (124 KB) stays committed: the changelog diffs it against the
  // committed HEAD version to produce the "what changed between publishes" feed.
  /^subnets\.json$/,
  // Cross-network lineage map (issue #353): small (~6 KB), agent-facing, low
  // churn (changes only with chain identities); committed + mirrored like the
  // other small contract digests.
  /^lineage\.json$/,
  // Captured-fixtures index (issue #352): small, agent-facing list of which
  // surfaces have a recorded live sample; the per-surface bodies stay R2-only.
  /^fixtures\.json$/,
  // AI-resources index: the copyable agent + MCP + skill + APIs in one machine
  // index; small, agent-facing, committed + mirrored.
  /^agent-resources\.json$/,
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

// Friendly key segments for the non-default Bittensor networks. Their data lives
// under metagraph/{prefix}/... and is R2-only (never committed) — the mainnet
// (finney) registry stays unprefixed and keeps its existing dual/git/r2 tiers.
export const NETWORK_KEY_PREFIXES = ["testnet", "local"];

export function artifactStorageTierForRelativePath(relativePath = "") {
  const normalized = artifactRelativePath(relativePath);
  // Non-default network artifacts (testnet/…, local/…) are R2-only regardless of
  // what the unprefixed equivalent would be — secondary-network data is large and
  // sparse, so it is never committed to git.
  if (NETWORK_KEY_PREFIXES.some((prefix) => normalized.startsWith(`${prefix}/`))) {
    return ARTIFACT_STORAGE_TIERS.r2;
  }
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
