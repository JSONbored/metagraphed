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
  // Global cross-subnet incident ledger, computed live from D1 at
  // /api/v1/incidents — never written as a file.
  /^incidents\.json$/,
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
  /^health\/trends\.json$/,
  /^health\/trends\/(?:\d+|\{netuid\})\.json$/,
  // AI-4 analytics: also computed live from D1, never written as files.
  /^health\/percentiles\/(?:\d+|\{netuid\})\.json$/,
  /^health\/incidents\/(?:\d+|\{netuid\})\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/trajectory\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/uptime\.json$/,
  // Per-UID metagraph (#1303/#1304/#1305): computed live from the neurons D1
  // tier at /api/v1/subnets/{netuid}/metagraph, /neurons/{uid}, /validators —
  // never written as files.
  /^subnets\/(?:\d+|\{netuid\})\/metagraph\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/neurons\/(?:\d+|\{uid\})\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/neurons\/(?:\d+|\{uid\})\/history\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/history\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/validators\.json$/,
  // Account entity tiers (#1347): computed live from account_events + neurons at
  // /api/v1/accounts/{ss58}(/events|/subnets) — never written as files.
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/events\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/subnets\.json$/,
  // Block-explorer tiers (#1345): computed live from the blocks D1 tier at
  // /api/v1/blocks (recent feed) + /api/v1/blocks/{ref} (numeric block_number or
  // 0x block_hash) — never written as files.
  /^blocks\.json$/,
  /^blocks\/(?:\d+|0x[0-9a-fA-F]{64}|\{ref\})\.json$/,
  /^registry\/leaderboards\.json$/,
  // RPC reverse-proxy usage analytics (B3), computed live from D1 telemetry at
  // /api/v1/rpc/usage — never written as a file.
  /^rpc\/usage\.json$/,
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
  // detail. The fixtures.json INDEX is R2-only too: it's only ever populated by
  // the production capture step, so a committed/dual copy is always the empty
  // no-capture build — and dual artifacts serve ASSETS-first, so the populated R2
  // index was never read (the index served fixture_count:0 while the R2 bodies
  // served fine). R2-only makes the index serve from R2 like the bodies.
  /^fixtures\/.+\.json$/,
  /^fixtures\.json$/,
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
  // (build-summary/r2-manifest and subnets/coverage stay dual — they feed
  // ci-verify/publish against a committed baseline.)
  // changelog.json (#1003): a diff-against-self "what changed since last publish"
  // feed. Committing it made bulk seed-refreshes non-reproducible (#998 v2) —
  // its content is a diff of the (live-enriched, non-deterministic) data seeds,
  // so a fresh rebuild never matched the committed copy. Now R2-only: built to
  // dist/, served from R2; its diff baseline is still the committed subnets/
  // coverage seeds (unchanged), and dispatch-webhooks reads it tier-aware.
  /^changelog\.json$/,
  // Agent-facing data indexes moved out of git (#1003, ADR-0006 end state): the
  // capability catalog, the AI-resources index, and the cross-network lineage
  // map. Live-data/registry-derived and served tier-aware from R2; only the
  // reproducible contract (openapi/types/contracts/api-index/schemas-index) and
  // the prober's operational-surfaces list (DUAL — see below) stay committed.
  /^agent-catalog\.json$/,
  /^agent-resources\.json$/,
  /^lineage\.json$/,
  // The live-data seeds (#1003): the chain-snapshot subnet index + the coverage
  // rollup. Non-reproducible (live-enriched), so they drove the bulk-refresh
  // reproducibility wall (#998). Now R2-only; the changelog's "since last
  // publish" diff is computed at publish time against the previous R2 publish
  // (scripts/build-changelog.mjs), not a committed baseline.
  /^subnets\.json$/,
  /^coverage\.json$/,
  /^coverage-depth\.json$/,
  // #1009: per-subnet validator/economic entity. Pure chain-state (stake,
  // emission share, registration cost) that changes every block — republished
  // each sync, never a committed seed.
  /^economics\.json$/,
  // Build STATS digest (#1003): machine-derived counts/sizes/inventory — not
  // infra-critical (nothing requires it committed); served at /api/v1/build from
  // R2. (r2-manifest.json stays committed as publish infrastructure — the
  // upload/kv/verify pipeline reads it like a lockfile.)
  /^build-summary\.json$/,
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
  // Per-subnet completeness scores + gaps (#1010): build-generated, large
  // (350 KB–1 MB), high-churn — R2-only like its review/ siblings above. It was
  // mis-tiered as git (committed) only because it was absent from BOTH pattern
  // lists, so the reproducibility gate treated its rebuild as an unexpected
  // committed change and rejected the refresh (#998 v1). Now R2-only: built to
  // dist/ + served from R2, never committed.
  /^review\/profile-completeness\.json$/,
  /^schema-drift\.json$/,
  /^search\.json$/,
  /^surface-aliases\.json$/,
  /^surfaces\.json$/,
];

// Committed to git (and mirrored to R2): the low-churn, consumer-facing API
// contract plus the small coverage "shop window". These only change when the
// API/schema changes — exactly what belongs in version control.
const DUAL_PATTERNS = [
  /^api-index\.json$/,
  // r2-manifest.json: the publish MANIFEST (what's in R2 + per-artifact hashes),
  // read by the upload/kv/verify pipeline — kept committed as publish
  // infrastructure (like a lockfile). build-summary (build stats) + changelog
  // moved to R2-only (#1003); only the reproducible contract + this manifest
  // remain committed.
  /^r2-manifest\.json$/,
  /^contracts\.json$/,
  /^openapi\.json$/,
  /^schemas\/index\.json$/,
  /^types\.d\.ts$/,
  // The cron prober's own input list. It is deterministic (probe-enabled overlay
  // surfaces, sorted, with a fixed-epoch generated_at), so it is committable like
  // the contract files. #1017 made it R2-only, which created a SPOF: the prober
  // reads it ASSETS-first then R2, but with no committed copy the ASSETS read
  // 404s and the prober depends on the data publish's R2 latest/ surviving — so a
  // publish outage eventually freezes the *live* health tier too. DUAL (committed
  // + R2-mirrored) decouples the prober from the publish: its ASSETS read always
  // succeeds from the deployed bundle. The #1025 freshness gate keeps it current.
  /^operational-surfaces\.json$/,
];

// R2-preferred dual artifacts: now EMPTY. subnets/coverage were the last
// members; they moved to plain R2-only (#1003), so no committed artifact needs
// R2-first serving anymore — the only remaining dual artifacts are the
// reproducible contract, which is correct to serve ASSETS-first. Kept as an
// (empty) extension point and for the exported isR2PreferredDualArtifactPath()
// contract.
const R2_PREFERRED_DUAL_PATTERNS = [];

export function isR2PreferredDualArtifactPath(artifactPath = "") {
  const normalized = artifactRelativePath(artifactPath);
  if (
    artifactStorageTierForRelativePath(normalized) !==
    ARTIFACT_STORAGE_TIERS.dual
  ) {
    return false;
  }
  return R2_PREFERRED_DUAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

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
  if (
    NETWORK_KEY_PREFIXES.some((prefix) => normalized.startsWith(`${prefix}/`))
  ) {
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
