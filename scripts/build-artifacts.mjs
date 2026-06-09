import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildEndpointResourceArtifact,
  buildEndpointPoolArtifact,
  buildEndpointIncidentArtifact,
  buildTimestamp,
  buildRpcEndpointArtifact,
  flattenSurfaces,
  hashJson,
  listJsonFilesRecursive,
  loadCandidates,
  loadNativeSnapshot,
  loadProviders,
  loadSubnets,
  loadVerification,
  nativeDisplayName,
  nativeNameQuality,
  normalizePublicUrl,
  readJson,
  redactCredentialedUrls,
  repoRoot,
  sha256Hex,
  slugify,
  writeJson,
} from "./lib.mjs";
import {
  CONTRACT_VERSION,
  buildApiIndexArtifact,
  buildContractsArtifact,
} from "../src/contracts.mjs";
import {
  evaluateArtifactBudgets,
  summarizeArtifactBudgets,
} from "./artifact-budgets.mjs";
import { buildCanonicalOpenApiArtifact } from "./openapi-components.mjs";
import {
  R2_STAGING_RELATIVE_ROOT,
  artifactStorageTierForRelativePath,
} from "../src/artifact-storage.mjs";

const providers = await loadProviders();
const overlays = await loadSubnets();
const candidates = await loadCandidates();
const candidateDiscovery = await readOptionalJson(
  path.join(repoRoot, "registry/candidates/generated/public-sources.json"),
);
const verification = redactCredentialedUrls(
  await loadVerification({ preferDetailed: false }),
);
const detailedVerification = redactCredentialedUrls(await loadVerification());
const adapterSnapshots = await loadAdapterSnapshots();
const reviewDecisions = await loadReviewDecisions();
const nativeSnapshot = await loadNativeSnapshot();
const overlayByNetuid = new Map(
  overlays.map((overlay) => [overlay.netuid, overlay]),
);
const chainSubnets = nativeSnapshot.subnets;
const candidatesByNetuid = groupByNetuid(candidates);
const mergedSubnets = chainSubnets.map((nativeSubnet) =>
  mergeSubnet(
    nativeSubnet,
    overlayByNetuid.get(nativeSubnet.netuid),
    candidatesByNetuid.get(nativeSubnet.netuid)?.length || 0,
  ),
);
const activeOverlayNetuids = new Set(
  chainSubnets.map((subnet) => subnet.netuid),
);
const activeOverlays = overlays.filter((overlay) =>
  activeOverlayNetuids.has(overlay.netuid),
);
const surfaces = flattenSurfaces(activeOverlays);
const outputRoot = path.join(repoRoot, "public/metagraph");
const r2OutputRoot = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT);
const generatedAt = buildTimestamp();
const contractVersion = CONTRACT_VERSION;
const fullVerification = buildFullVerificationArtifact(detailedVerification, {
  contractVersion,
  generatedAt,
});
const fullVerificationByCandidate = new Map(
  (fullVerification.results || []).map((result) => [
    result.candidate_id,
    result,
  ]),
);
const canonicalVerificationByCandidate = new Map(
  (verification.results || []).map((result) => [result.candidate_id, result]),
);
const previousArtifactDigests = await collectArtifactDigests({
  includeR2Root: false,
  publicRoot: outputRoot,
  r2Root: r2OutputRoot,
});
const previousSubnetsArtifact = await readOptionalJson(
  path.join(outputRoot, "subnets.json"),
);
const previousFreshnessArtifact = await readOptionalJson(
  path.join(outputRoot, "freshness.json"),
);
const previousCoverageArtifact = await readOptionalJson(
  path.join(outputRoot, "coverage.json"),
);
const previousHealthArtifact = await loadPreviousHealthArtifact();
const previousSchemaDriftArtifact = await readOptionalJson(
  path.join(outputRoot, "schema-drift.json"),
);
const previousSchemaIndexArtifact = await readOptionalJson(
  path.join(outputRoot, "schemas/index.json"),
);

await fs.rm(r2OutputRoot, { recursive: true, force: true });

const subnetIndex = mergedSubnets.map((subnet) => ({
  block: subnet.block,
  candidate_count: subnet.candidate_count,
  categories: subnet.categories,
  coverage_level: subnet.coverage_level,
  curation_level: subnet.curation.level,
  dashboard_url: subnet.dashboard_url,
  docs_url: subnet.docs_url,
  gap_count: subnet.gaps.missing_kinds.length,
  mechanism_count: subnet.mechanism_count,
  name: subnet.name,
  native_name: subnet.native_name,
  native_name_quality: subnet.native_name_quality,
  netuid: subnet.netuid,
  participant_count: subnet.participant_count,
  probed_surface_count: subnet.probed_surface_count,
  registered_at_block: subnet.registered_at_block,
  slug: subnet.slug,
  source_repo: subnet.source_repo,
  status: subnet.status,
  subnet_type: subnet.subnet_type,
  surface_count: subnet.surface_count,
  symbol: subnet.symbol,
  tempo: subnet.tempo,
  website_url: subnet.website_url,
}));

const metagraphLatest = {
  schema_version: 1,
  generated_at: generatedAt,
  network: nativeSnapshot.network,
  source: nativeSnapshot.source,
  captured_at: nativeSnapshot.captured_at,
  notes:
    "Native Bittensor chain data is canonical for active subnet existence. Curated overlays add public interface metadata where verified.",
  subnets: subnetIndex,
};

const healthArtifacts = buildHealthArtifacts(
  buildSurfaceHealthRows({
    surfaces: surfaces.filter(
      (surface) => surface.probe?.enabled && surface.public_safe,
    ),
    previousHealthArtifact,
  }),
  mergedSubnets,
  {
    generatedAt,
    notes: previousHealthArtifact
      ? "Health rows preserve matching live probe results from the local probe-result cache. Run npm run probes:smoke with METAGRAPH_WRITE_PROBE_RESULTS=1 to refresh observed status."
      : "Run npm run probes:smoke with METAGRAPH_WRITE_PROBE_RESULTS=1 to replace unknown build-time health with live probe results.",
    probeFinishedAt: previousHealthArtifact?.probe_finished_at || null,
    probeStartedAt: previousHealthArtifact?.probe_started_at || null,
    source: previousHealthArtifact ? "live-smoke-probe" : "artifact-build",
  },
);
const rpcEndpoints = buildRpcEndpointArtifact({
  surfaces,
  healthSurfaces: healthArtifacts.latest.surfaces,
  generatedAt,
  contractVersion,
  source: "artifact-build",
});
const endpointResources = buildEndpointResourceArtifact({
  surfaces,
  healthSurfaces: healthArtifacts.latest.surfaces,
  generatedAt,
  contractVersion,
  source: "artifact-build",
});
const endpointIncidents = buildEndpointIncidentArtifact({
  endpointArtifact: endpointResources,
  generatedAt,
  contractVersion,
});
const curationReview = buildCurationReview(
  mergedSubnets,
  surfaces,
  candidates,
  verification,
  reviewDecisions,
);
const schemaDriftArtifact =
  reusableSchemaDriftArtifact(surfaces, previousSchemaDriftArtifact) ||
  buildSchemaDriftPlaceholder(surfaces);
const schemaIndexArtifact =
  reusableSchemaIndexArtifact(surfaces, previousSchemaIndexArtifact) ||
  buildSchemaIndexPlaceholder();
const contracts = buildContractsArtifact(generatedAt);
const openApi = await buildCanonicalOpenApiArtifact(generatedAt);

const overlayBySlug = new Map(
  activeOverlays.map((subnet) => [subnet.slug, subnet]),
);
const adapterSlugs = new Set([
  ...activeOverlays
    .filter((subnet) => subnet.extensions)
    .map((subnet) => subnet.slug),
  ...adapterSnapshots.keys(),
]);
const adapterArtifacts = Object.fromEntries(
  [...adapterSlugs]
    .sort()
    .map((slug) => {
      const subnet = overlayBySlug.get(slug);
      if (!subnet) {
        return null;
      }
      const snapshot = adapterSnapshots.get(slug) || null;
      return [
        slug,
        {
          schema_version: 1,
          generated_at: generatedAt,
          netuid: subnet.netuid,
          subnet: subnet.name,
          slug: subnet.slug,
          extensions:
            subnet.extensions ||
            (snapshot?.adapter_kind
              ? {
                  generic_adapter: {
                    enabled: true,
                    kind: snapshot.adapter_kind,
                  },
                }
              : {}),
          snapshot,
        },
      ];
    })
    .filter(Boolean),
);

const coverage = {
  schema_version: 1,
  generated_at: generatedAt,
  network: nativeSnapshot.network,
  native_snapshot_captured_at: nativeSnapshot.captured_at,
  source: {
    native: nativeSnapshot.source,
    overlays: "registry/subnets",
    candidates: "registry/candidates",
  },
  chain_subnet_count: chainSubnets.length,
  root_subnet_count: mergedSubnets.filter(
    (subnet) => subnet.subnet_type === "root",
  ).length,
  application_subnet_count: mergedSubnets.filter(
    (subnet) => subnet.subnet_type === "application",
  ).length,
  curated_overlay_count: activeOverlays.length,
  native_only_count: mergedSubnets.filter(
    (subnet) => subnet.coverage_level === "native-only",
  ).length,
  manifested_count: mergedSubnets.filter(
    (subnet) => subnet.coverage_level === "manifested",
  ).length,
  probed_count: mergedSubnets.filter(
    (subnet) => subnet.coverage_level === "probed",
  ).length,
  surface_count: surfaces.length,
  probed_surface_count: surfaces.filter((surface) => surface.probe?.enabled)
    .length,
  candidate_count: candidates.length,
  candidate_subnet_count: candidatesByNetuid.size,
  curation_level_counts: countBy(
    mergedSubnets,
    (subnet) => subnet.curation.level,
  ),
  native_only_with_candidates: mergedSubnets.filter(
    (subnet) =>
      subnet.coverage_level === "native-only" && subnet.candidate_count > 0,
  ).length,
  native_only_without_candidates: mergedSubnets.filter(
    (subnet) =>
      subnet.coverage_level === "native-only" && subnet.candidate_count === 0,
  ).length,
};

const candidateIndex = candidates.map((candidate) => ({
  ...candidate,
  verification:
    fullVerificationByCandidate.get(candidate.id) ||
    fullVerificationResultOrNull(candidate.verification),
  subnet_name:
    nativeSnapshot.subnets.find((subnet) => subnet.netuid === candidate.netuid)
      ?.name || null,
}));
const canonicalCandidateIndex = candidates.map((candidate) => ({
  ...candidate,
  verification:
    canonicalVerificationByCandidate.get(candidate.id) ||
    fullVerificationResultOrNull(candidate.verification),
  subnet_name:
    nativeSnapshot.subnets.find((subnet) => subnet.netuid === candidate.netuid)
      ?.name || null,
}));

const profileArtifacts = buildSubnetProfileArtifacts({
  candidates: canonicalCandidateIndex,
  endpoints: endpointResources.endpoints,
  nativeIdentitiesByNetuid: new Map(
    chainSubnets.map((subnet) => [
      subnet.netuid,
      subnet.chain_identity || null,
    ]),
  ),
  subnets: mergedSubnets,
  surfaces,
});
const enrichmentArtifacts = buildEnrichmentQueueArtifacts({
  candidates: canonicalCandidateIndex,
  curationReview,
  profiles: profileArtifacts.profiles,
  reviewProfiles: profileArtifacts.reviewProfiles,
  subnets: activeOverlays,
  verification,
});
const enrichmentQueue = enrichmentArtifacts.queueArtifact;

const reviewQueue = candidateIndex.filter((candidate) =>
  ["schema-valid", "maintainer-review", "stale"].includes(candidate.state),
);

const curationIndex = mergedSubnets.map((subnet) => ({
  candidate_count: subnet.candidate_count,
  coverage_level: subnet.coverage_level,
  curation: subnet.curation,
  gap_count: subnet.gaps.missing_kinds.length,
  gaps: subnet.gaps,
  name: subnet.name,
  netuid: subnet.netuid,
  slug: subnet.slug,
  surface_count: subnet.surface_count,
}));

const gapsIndex = mergedSubnets.map((subnet) => ({
  coverage_level: subnet.coverage_level,
  curation_level: subnet.curation.level,
  gaps: subnet.gaps,
  name: subnet.name,
  netuid: subnet.netuid,
  slug: subnet.slug,
}));

await writeJson(artifactFile("providers.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  providers,
});
await fs.rm(r2ArtifactDir("providers"), {
  recursive: true,
  force: true,
});
for (const provider of providers) {
  const providerEndpoints = endpointResources.endpoints.filter(
    (endpoint) => endpoint.provider === provider.id,
  );
  await writeJson(artifactFile(`providers/${provider.id}.json`), {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    provider,
    endpoint_summary: endpointSummary(providerEndpoints),
  });
}

await writeJson(artifactFile("subnets.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  network: nativeSnapshot.network,
  source: nativeSnapshot.source,
  native_snapshot_captured_at: nativeSnapshot.captured_at,
  subnets: subnetIndex,
});

await fs.rm(r2ArtifactDir("subnets"), { recursive: true, force: true });
await fs.rm(r2ArtifactDir("profiles"), { recursive: true, force: true });
for (const subnet of mergedSubnets) {
  const subnetCandidates = candidatesByNetuid.get(subnet.netuid) || [];
  const subnetSurfaces = surfaces.filter(
    (surface) => surface.netuid === subnet.netuid,
  );
  const subnetEndpoints = endpointResources.endpoints.filter(
    (endpoint) => endpoint.netuid === subnet.netuid,
  );
  await writeJson(artifactFile(`subnets/${subnet.netuid}.json`), {
    schema_version: 1,
    generated_at: generatedAt,
    subnet,
    candidate_surfaces: subnetCandidates,
    candidates: subnetCandidates,
    endpoints: subnetEndpoints,
    gaps: subnet.gaps,
    surfaces: subnetSurfaces,
    verified_surfaces: subnetSurfaces,
  });
  await writeJson(artifactFile(`profiles/${subnet.netuid}.json`), {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    profile: profileArtifacts.byNetuid.get(subnet.netuid),
    subnet,
    candidate_surfaces: candidateIndex.filter(
      (candidate) => candidate.netuid === subnet.netuid,
    ),
    endpoints: subnetEndpoints,
    gaps: subnet.gaps,
    surfaces: subnetSurfaces,
  });
}

await writeJson(artifactFile("profiles.json"), {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  notes:
    "Public-safe subnet profiles derived from native chain data, curated overlays, verified surfaces, candidates, and explicit gaps.",
  summary: profileArtifacts.summary,
  profiles: profileArtifacts.profiles,
});

await writeJson(artifactFile("surfaces.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  notes:
    "Curated and verified public interface surfaces only. Native-only subnet stubs do not invent surfaces.",
  surfaces,
});
await fs.rm(r2ArtifactDir("surfaces"), {
  recursive: true,
  force: true,
});
for (const subnet of mergedSubnets) {
  await writeJson(artifactFile(`surfaces/${subnet.netuid}.json`), {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    netuid: subnet.netuid,
    slug: subnet.slug,
    name: subnet.name,
    surfaces: surfaces.filter((surface) => surface.netuid === subnet.netuid),
  });
}

await writeJson(artifactFile("candidates.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  notes:
    "Unverified candidate surfaces from public source discovery and community intake. Candidates are not verified registry surfaces.",
  candidates: candidateIndex,
});
await fs.rm(r2ArtifactDir("candidates"), {
  recursive: true,
  force: true,
});
for (const subnet of mergedSubnets) {
  await writeJson(artifactFile(`candidates/${subnet.netuid}.json`), {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    netuid: subnet.netuid,
    slug: subnet.slug,
    name: subnet.name,
    candidates: candidateIndex.filter(
      (candidate) => candidate.netuid === subnet.netuid,
    ),
  });
}

await writeJson(artifactFile("review-queue.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  notes:
    "Candidate surfaces that need maintainer review before promotion into curated subnet overlays.",
  count: reviewQueue.length,
  candidates: reviewQueue,
});

await writeJson(artifactFile("curation.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  notes: "Curation status for every active Finney subnet.",
  curation: curationIndex,
});

await writeJson(artifactFile("gaps.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  notes:
    "Missing or unsupported public interface facets by subnet. Missing facets are not invented.",
  gaps: gapsIndex,
});

await writeJson(artifactFile("verification/latest.json"), fullVerification);
await fs.rm(r2ArtifactDir("verification/subnets"), {
  recursive: true,
  force: true,
});
for (const subnet of mergedSubnets) {
  const results = (fullVerification.results || []).filter(
    (result) => result.netuid === subnet.netuid,
  );
  await writeJson(artifactFile(`verification/subnets/${subnet.netuid}.json`), {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: fullVerification.generated_at,
    candidate_count: results.length,
    netuid: subnet.netuid,
    slug: subnet.slug,
    name: subnet.name,
    summary: {
      by_classification: countBy(
        results,
        (result) => result.classification || "unknown",
      ),
      by_kind: countBy(results, (result) => result.kind || "unknown"),
      by_provider: countBy(results, (result) => result.provider || "unknown"),
    },
    results,
  });
}

await writeJson(artifactFile("metagraph/latest.json"), metagraphLatest);
await fs.rm(r2ArtifactDir("health/subnets"), {
  recursive: true,
  force: true,
});
await fs.rm(r2ArtifactDir("health/badges"), {
  recursive: true,
  force: true,
});
await writeJson(artifactFile("health/latest.json"), healthArtifacts.latest);
await writeJson(artifactFile("health/summary.json"), healthArtifacts.summary);
const healthHistoryDate = (
  healthArtifacts.latest.probe_finished_at || generatedAt
).slice(0, 10);
await writeJson(
  artifactFile(`health/history/${healthHistoryDate}.json`),
  buildHealthHistoryArtifact(healthArtifacts.latest, healthHistoryDate),
);
await writeJson(artifactFile("rpc-endpoints.json"), rpcEndpoints);
await writeJson(artifactFile("endpoints.json"), endpointResources);
await fs.rm(r2ArtifactDir("endpoints"), {
  recursive: true,
  force: true,
});
for (const subnet of mergedSubnets) {
  const subnetEndpoints = endpointResources.endpoints.filter(
    (endpoint) => endpoint.netuid === subnet.netuid,
  );
  await writeJson(artifactFile(`endpoints/${subnet.netuid}.json`), {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    netuid: subnet.netuid,
    slug: subnet.slug,
    name: subnet.name,
    summary: endpointSummary(subnetEndpoints),
    endpoints: subnetEndpoints,
  });
}
for (const provider of providers) {
  const providerEndpoints = endpointResources.endpoints.filter(
    (endpoint) => endpoint.provider === provider.id,
  );
  await writeJson(artifactFile(`providers/${provider.id}/endpoints.json`), {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    provider: {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      authority: provider.authority,
    },
    summary: endpointSummary(providerEndpoints),
    endpoints: providerEndpoints,
  });
}
for (const [netuid, subnetHealth] of healthArtifacts.subnets) {
  await writeJson(artifactFile(`health/subnets/${netuid}.json`), subnetHealth);
}
for (const [netuid, badge] of healthArtifacts.badges) {
  await writeJson(artifactFile(`health/badges/${netuid}.json`), badge);
}
await writeJson(artifactFile("coverage.json"), coverage);
await writeJson(artifactFile("contracts.json"), contracts);
await writeJson(
  artifactFile("api-index.json"),
  buildApiIndexArtifact(generatedAt, contracts),
);
await writeJson(artifactFile("openapi.json"), openApi);
await writeJson(
  artifactFile("search.json"),
  buildSearchIndex(
    mergedSubnets,
    surfaces,
    providers,
    profileArtifacts.byNetuid,
  ),
);
await writeJson(
  artifactFile("freshness.json"),
  buildFreshnessArtifact({
    adapterSnapshots,
    candidateDiscovery,
    generatedAt,
    healthArtifacts,
    nativeSnapshot,
    previousFreshness: previousFreshnessArtifact,
    schemaDrift: schemaDriftArtifact,
    verification,
  }),
);
await writeJson(
  artifactFile("source-health.json"),
  buildSourceHealthArtifact({
    candidates,
    endpointResources,
    providers,
    rpcEndpoints,
    verification,
  }),
);
await writeJson(
  artifactFile("evidence-ledger.json"),
  buildEvidenceLedger({
    candidates,
    generatedAt,
    subnets: mergedSubnets,
    surfaces,
  }),
);
await writeJson(
  artifactFile("rpc/pools.json"),
  buildEndpointPoolArtifact({
    generatedAt,
    contractVersion,
    rpcArtifact: rpcEndpoints,
  }),
);
await writeJson(
  artifactFile("endpoint-pools.json"),
  buildEndpointPoolArtifact({
    generatedAt,
    contractVersion,
    endpointArtifact: endpointResources,
  }),
);
await writeJson(artifactFile("endpoint-incidents.json"), endpointIncidents);
await writeJson(
  artifactFile("source-snapshots.json"),
  await buildSourceSnapshots({
    adapterSnapshots,
    candidates,
    generatedAt,
    nativeSnapshot,
    overlays: activeOverlays,
    providers,
    reviewDecisions,
    verification,
  }),
);
await writeJson(artifactFile("schema-drift.json"), schemaDriftArtifact);
await fs.rm(r2ArtifactDir("schemas"), { recursive: true, force: true });
await writeJson(artifactFile("schemas/index.json"), schemaIndexArtifact);
for (const entry of schemaIndexArtifact.schemas || []) {
  const relativePath = schemaDetailArtifactPath(entry);
  if (!relativePath || !entry.snapshot || typeof entry.snapshot !== "object") {
    continue;
  }
  await writeJson(artifactFile(relativePath), entry.snapshot);
}
await writeJson(artifactFile("review/curation.json"), curationReview);
await writeJson(artifactFile("review/gap-priorities.json"), {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  priorities: curationReview.gap_priorities,
});
await writeJson(artifactFile("review/profile-completeness.json"), {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  profiles: profileArtifacts.reviewProfiles,
  summary: profileArtifacts.reviewSummary,
});
await writeJson(artifactFile("review/adapter-candidates.json"), {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  summary: adapterCandidateSummary(curationReview.adapter_candidates),
  candidates: curationReview.adapter_candidates,
});
await writeJson(artifactFile("review/enrichment-queue.json"), enrichmentQueue);
await writeJson(
  artifactFile("review/enrichment-evidence.json"),
  enrichmentArtifacts.evidenceArtifact,
);
await writeJson(
  artifactFile("review/enrichment-targets.json"),
  enrichmentArtifacts.targetArtifact,
);
await writeJson(artifactFile("review/maintainer-decisions.json"), {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  decisions: reviewDecisions.decisions || [],
  notes:
    "Public-safe maintainer curation decisions only. No secrets, wallets, PATs, private dashboards, or validator-local state.",
});

for (const [slug, artifact] of Object.entries(adapterArtifacts)) {
  await writeJson(artifactFile(`adapters/${slug}.json`), artifact);
}

const currentArtifactDigests = await collectArtifactDigests({
  includeR2Root: false,
  publicRoot: outputRoot,
  r2Root: r2OutputRoot,
});
await writeJson(
  artifactFile("changelog.json"),
  buildChangelog({
    currentArtifacts: currentArtifactDigests,
    currentCoverage: coverage,
    currentSubnets: { subnets: subnetIndex },
    generatedAt,
    previousArtifacts: previousArtifactDigests,
    previousCoverage: previousCoverageArtifact,
    previousSubnets: previousSubnetsArtifact,
  }),
);

const artifactSizesBeforeR2 = await collectArtifactSizes({
  publicRoot: outputRoot,
  r2Root: r2OutputRoot,
});
await writeJson(
  artifactFile("r2-manifest.json"),
  buildR2Manifest({
    artifactSizes: artifactSizesBeforeR2,
    generatedAt,
  }),
);

const artifactSizes = await collectArtifactSizes({
  publicRoot: outputRoot,
  r2Root: r2OutputRoot,
});
const reviewArtifactSizes = artifactSizes.filter(
  (artifact) => artifact.storage_tier !== "r2",
);
const artifactBudgets = evaluateArtifactBudgets(artifactSizes);
await writeJson(artifactFile("build-summary.json"), {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  adapter_count: Object.keys(adapterArtifacts).length,
  artifact_count: reviewArtifactSizes.length,
  artifact_size_bytes: reviewArtifactSizes.reduce(
    (sum, artifact) => sum + artifact.size_bytes,
    0,
  ),
  full_artifact_count: artifactSizes.length,
  full_artifact_size_bytes: artifactSizes.reduce(
    (sum, artifact) => sum + artifact.size_bytes,
    0,
  ),
  storage_tier_counts: countByStorageTier(artifactSizes),
  storage_tier_size_bytes: sumBytesByStorageTier(artifactSizes),
  artifacts: reviewArtifactSizes.slice(0, 250),
  artifact_budget_summary: summarizeArtifactBudgets(artifactBudgets),
  artifact_budgets: artifactBudgets
    .filter((budget) => budget.status !== "ok")
    .sort(
      (a, b) => b.size_bytes - a.size_bytes || a.path.localeCompare(b.path),
    ),
  candidate_count: candidates.length,
  coverage,
  endpoint_count: endpointResources.endpoints.length,
  profile_count: profileArtifacts.profiles.length,
  provider_count: providers.length,
  subnet_count: mergedSubnets.length,
  surface_count: surfaces.length,
  public_contract: {
    version: contractVersion,
    url: "/metagraph/contracts.json",
  },
});

console.log(
  `Built ${mergedSubnets.length} subnet(s), ${surfaces.length} surface(s), and ${providers.length} provider(s).`,
);

function mergeSubnet(nativeSubnet, overlay, candidateCount) {
  const surfaceCount = overlay?.surfaces?.length || 0;
  const probedSurfaceCount =
    overlay?.surfaces?.filter((surface) => surface.probe?.enabled).length || 0;
  const coverageLevel =
    surfaceCount === 0
      ? "native-only"
      : probedSurfaceCount > 0
        ? "probed"
        : "manifested";
  const slug = overlay?.slug || `sn-${nativeSubnet.netuid}`;
  const nameQuality = nativeNameQuality(nativeSubnet);
  const nativeName =
    typeof nativeSubnet.raw_name === "string"
      ? nativeSubnet.raw_name
      : nativeSubnet.name || null;
  const displayName =
    overlay?.name ||
    nativeDisplayName(nativeSubnet, `Subnet ${nativeSubnet.netuid}`);
  const nativeSlug =
    nameQuality === "chain" && nativeName
      ? slugify(nativeName)
      : nativeSubnet.netuid === 0
        ? "root"
        : `sn-${nativeSubnet.netuid}`;

  return {
    block: nativeSubnet.block,
    candidate_count: candidateCount,
    categories:
      overlay?.categories ||
      (nativeSubnet.netuid === 0 ? ["root", "system"] : ["native-only"]),
    coverage_level: coverageLevel,
    curation_level:
      overlay?.curation?.level || (overlay ? "candidate-discovered" : "native"),
    dashboard_url: overlay?.dashboard_url || null,
    docs_url: overlay?.docs_url || null,
    gaps: buildGaps(overlay?.surfaces || [], overlay),
    mechanism_count: nativeSubnet.mechanism_count,
    name: displayName,
    native_name: nativeName,
    native_name_quality: nameQuality,
    native_slug: nativeSlug,
    netuid: nativeSubnet.netuid,
    notes: overlay?.notes || null,
    participant_count: nativeSubnet.participant_count,
    probed_surface_count: probedSurfaceCount,
    provenance: {
      existence: {
        authority: "native-chain",
        captured_at: nativeSnapshot.captured_at,
        method: nativeSnapshot.source.method,
        network: nativeSnapshot.network,
        source_kind: nativeSnapshot.source.kind,
      },
      identity: {
        display_name_source: overlay?.name
          ? "curated-overlay"
          : nameQuality === "chain"
            ? "native-chain"
            : "fallback",
        native_name_quality: nameQuality,
      },
      interface_metadata: overlay
        ? overlay.curation?.level || "curated-overlay"
        : "none",
    },
    registered_at_block: nativeSubnet.registered_at_block,
    slug,
    source_repo: overlay?.source_repo || null,
    status: nativeSubnet.status,
    subnet_type: nativeSubnet.subnet_type,
    surface_count: surfaceCount,
    symbol: nativeSubnet.symbol,
    tempo: nativeSubnet.tempo,
    website_url: overlay?.website_url || null,
    curation: overlay?.curation || {
      level: overlay ? "candidate-discovered" : "native",
      review_state: "unreviewed",
      reviewed_at: null,
      verified_at: null,
      source_count: 0,
      gap_notes: [],
    },
    links: overlay?.links || [],
  };
}

function buildGaps(surfaces, overlay) {
  const kinds = new Set(surfaces.map((surface) => surface.kind));
  if (overlay?.docs_url) {
    kinds.add("docs");
  }
  if (overlay?.source_repo) {
    kinds.add("source-repo");
  }
  if (overlay?.website_url) {
    kinds.add("website");
  }
  if (overlay?.dashboard_url) {
    kinds.add("dashboard");
  }
  const expectedKinds = [
    "docs",
    "source-repo",
    "website",
    "dashboard",
    "openapi",
    "subnet-api",
    "sse",
    "data-artifact",
  ];
  const missingKinds = expectedKinds.filter((kind) => !kinds.has(kind));
  return {
    missing_kinds: missingKinds,
    supported_kinds: [...kinds].sort(),
    gap_notes: overlay?.curation?.gap_notes || [],
  };
}

function countBy(items, keyOrFn) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        const key =
          typeof keyOrFn === "function" ? keyOrFn(item) : item[keyOrFn];
        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function endpointSummary(endpoints) {
  return {
    endpoint_count: endpoints.length,
    monitored_count: endpoints.filter(
      (endpoint) => endpoint.monitoring_status === "monitored",
    ).length,
    pool_eligible_count: endpoints.filter((endpoint) => endpoint.pool_eligible)
      .length,
    by_kind: countBy(endpoints, "kind"),
    by_layer: countBy(endpoints, "layer"),
    by_publication_state: countBy(endpoints, "publication_state"),
    by_status: countBy(endpoints, "status"),
  };
}

function buildSubnetProfileArtifacts({
  subnets,
  surfaces,
  endpoints,
  candidates,
  nativeIdentitiesByNetuid = new Map(),
}) {
  const surfacesByNetuid = groupByNetuid(surfaces);
  const endpointsByNetuid = groupByNetuid(endpoints);
  const candidatesByNetuid = groupByNetuid(candidates);
  const profiles = subnets
    .map((subnet) =>
      buildSubnetProfile({
        candidates: candidatesByNetuid.get(subnet.netuid) || [],
        endpoints: endpointsByNetuid.get(subnet.netuid) || [],
        nativeIdentity: nativeIdentitiesByNetuid.get(subnet.netuid) || null,
        subnet,
        surfaces: surfacesByNetuid.get(subnet.netuid) || [],
      }),
    )
    .sort((a, b) => a.netuid - b.netuid);
  const reviewProfiles = profiles
    .map((profile) => ({
      candidate_count: profile.candidate_count,
      completeness_score: profile.completeness_score,
      confidence: profile.confidence,
      curation_level: profile.curation_level,
      gap_reasons: profile.completeness.gap_reasons,
      missing_critical_count: profile.missing_critical_count,
      identity_level: profile.identity_level,
      identity_evidence: profile.identity_evidence,
      identity_promotion_kind_count:
        profile.identity_evidence.needs_promotion_kinds.length,
      identity_promotion_kinds: profile.identity_evidence.needs_promotion_kinds,
      identity_surface_count: profile.identity_surface_count,
      live_identity_candidate_kind_count:
        profile.identity_evidence.live_candidate_identity_kinds.length,
      missing_operational: profile.completeness.missing_operational,
      missing_required: profile.completeness.missing_required,
      missing_identity: profile.missing_identity,
      name: profile.name,
      native_name_quality: profile.native_name_quality,
      native_identity_signal_count:
        profile.identity_evidence.native_identity_count,
      netuid: profile.netuid,
      operational_interface_count: profile.operational_interface_count,
      priority_score:
        100 -
        profile.completeness_score +
        profile.missing_critical_count * 5 +
        Math.min(profile.candidate_count, 25),
      profile_level: profile.profile_level,
      review_state: profile.review_state,
      slug: profile.slug,
      source_count: profile.provenance.interface_source_count,
      stale_identity_candidate_kind_count:
        profile.identity_evidence.stale_candidate_identity_kinds.length,
      suggested_next_action: profileSuggestedNextAction(profile),
      supported_interface_kinds: profile.supported_interface_kinds,
    }))
    .sort(
      (a, b) =>
        b.priority_score - a.priority_score ||
        a.completeness_score - b.completeness_score ||
        a.netuid - b.netuid,
    );

  return {
    byNetuid: new Map(profiles.map((profile) => [profile.netuid, profile])),
    profiles,
    reviewProfiles,
    reviewSummary: {
      profile_count: profiles.length,
      needs_identity_count: profiles.filter(
        (profile) => profile.completeness.missing_required.length > 0,
      ).length,
      needs_operational_count: profiles.filter(
        (profile) => profile.operational_interface_count === 0,
      ).length,
      average_completeness_score: averageScore(profiles),
      by_profile_level: countBy(profiles, "profile_level"),
      by_identity_level: countBy(profiles, "identity_level"),
      by_confidence: countBy(profiles, "confidence"),
      native_identity_count: profiles.filter(
        (profile) => profile.native_identity,
      ).length,
      identity_promotion_candidate_count: profiles.filter(
        (profile) => profile.identity_evidence.needs_promotion_kinds.length > 0,
      ).length,
      native_identity_unpromoted_count: profiles.filter(
        (profile) =>
          profile.identity_evidence.native_identity_count > 0 &&
          profile.identity_evidence.needs_promotion_kinds.length > 0,
      ).length,
      critical_gap_counts: countGapReasons(reviewProfiles),
    },
    summary: {
      profile_count: profiles.length,
      average_completeness_score: averageScore(profiles),
      by_profile_level: countBy(profiles, "profile_level"),
      by_identity_level: countBy(profiles, "identity_level"),
      by_confidence: countBy(profiles, "confidence"),
      native_identity_count: profiles.filter(
        (profile) => profile.native_identity,
      ).length,
      identity_promotion_candidate_count: profiles.filter(
        (profile) => profile.identity_evidence.needs_promotion_kinds.length > 0,
      ).length,
      native_identity_unpromoted_count: profiles.filter(
        (profile) =>
          profile.identity_evidence.native_identity_count > 0 &&
          profile.identity_evidence.needs_promotion_kinds.length > 0,
      ).length,
    },
  };
}

function buildEnrichmentQueueArtifacts({
  candidates,
  curationReview,
  profiles,
  reviewProfiles,
  subnets,
  verification,
}) {
  const verificationByCandidate = new Map(
    (verification.results || []).map((result) => [result.candidate_id, result]),
  );
  const reviewProfileByNetuid = new Map(
    reviewProfiles.map((profile) => [profile.netuid, profile]),
  );
  const gapPriorityByNetuid = new Map(
    (curationReview.gap_priorities || []).map((priority) => [
      priority.netuid,
      priority,
    ]),
  );
  const adapterCandidateByNetuid = new Map(
    (curationReview.adapter_candidates || []).map((candidate) => [
      candidate.netuid,
      candidate,
    ]),
  );
  const excludedCandidateIdsByNetuid = new Map(
    subnets.map((subnet) => [
      subnet.netuid,
      new Set(subnet.baseline_excluded_surface_ids || []),
    ]),
  );
  const candidatesByNetuid = groupByNetuid(candidates);

  const fullQueue = profiles
    .map((profile) =>
      enrichmentQueueEntry({
        adapterCandidate: adapterCandidateByNetuid.get(profile.netuid),
        gapPriority: gapPriorityByNetuid.get(profile.netuid),
        profile,
        reviewProfile: reviewProfileByNetuid.get(profile.netuid),
        subnetCandidates: enrichmentCandidatesForSubnet({
          excludedIds: excludedCandidateIdsByNetuid.get(profile.netuid),
          subnetCandidates: candidatesByNetuid.get(profile.netuid) || [],
        }),
        verificationByCandidate,
      }),
    )
    .sort(
      (a, b) =>
        b.priority_score - a.priority_score ||
        a.lane.localeCompare(b.lane) ||
        a.netuid - b.netuid,
    );
  const queue = fullQueue.map(compactEnrichmentQueueEntry);
  const evidenceEntries = fullQueue.map(enrichmentEvidenceEntry);

  const queueArtifact = {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    notes:
      "Prioritized enrichment queue derived from public-safe profile gaps, candidate counts, review state, adapter potential, and probe-derived endpoint incidents. It is contributor guidance, not a contribution API.",
    summary: {
      subnet_count: profiles.length,
      queue_count: queue.length,
      direct_submission_count: queue.filter(
        (entry) => entry.lane === "direct-submission",
      ).length,
      maintainer_review_count: queue.filter(
        (entry) => entry.lane === "maintainer-review",
      ).length,
      adapter_candidate_count: queue.filter(
        (entry) => entry.lane === "adapter-candidate",
      ).length,
      monitoring_followup_count: queue.filter(
        (entry) => entry.lane === "monitoring-followup",
      ).length,
      baseline_monitoring_count: queue.filter(
        (entry) => entry.lane === "baseline-monitoring",
      ).length,
      manual_review_required_count: queue.filter(
        (entry) => entry.manual_review_required,
      ).length,
      lane_counts: countBy(queue, "lane"),
      identity_level_counts: countBy(queue, "identity_level"),
      evidence_action_counts: countBy(queue, "evidence_action"),
      top_direct_submission_kinds: countDirectSubmissionKinds(queue),
    },
    queue,
  };
  const evidenceArtifact = {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    notes:
      "Detailed candidate evidence by missing or contributor-target surface kind. This is contributor guidance and maintainer review context; it does not create registry truth or observed health.",
    entries: evidenceEntries,
    summary: {
      subnet_count: evidenceEntries.length,
      entry_count: evidenceEntries.length,
      evidence_action_counts: countBy(evidenceEntries, "evidence_action"),
      stale_candidate_count: evidenceEntries.reduce(
        (sum, entry) =>
          sum + entry.candidate_evidence_summary.stale_or_failed_count,
        0,
      ),
      unverified_candidate_count: evidenceEntries.reduce(
        (sum, entry) => sum + entry.candidate_evidence_summary.unverified_count,
        0,
      ),
    },
  };
  const targetArtifact = buildEnrichmentTargetsArtifact({
    evidenceEntries,
    queue,
  });
  return { evidenceArtifact, queueArtifact, targetArtifact };
}

function enrichmentCandidatesForSubnet({ excludedIds, subnetCandidates }) {
  if (!excludedIds || excludedIds.size === 0) {
    return subnetCandidates;
  }
  return subnetCandidates.filter((candidate) => !excludedIds.has(candidate.id));
}

function buildEnrichmentTargetsArtifact({ evidenceEntries, queue }) {
  const evidenceByNetuid = new Map(
    evidenceEntries.map((entry) => [entry.netuid, entry]),
  );
  const targets = queue
    .flatMap((entry) =>
      enrichmentTargetsForEntry({
        entry,
        evidenceEntry: evidenceByNetuid.get(entry.netuid),
      }),
    )
    .sort(
      (a, b) =>
        b.priority_score - a.priority_score ||
        a.target_type.localeCompare(b.target_type) ||
        String(a.kind || "").localeCompare(String(b.kind || "")) ||
        a.netuid - b.netuid,
    );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    notes:
      "Contributor-oriented enrichment target pack derived from the queue and evidence artifacts. It provides public-safe submission guidance only; observed health and registry truth remain probe/generated artifacts.",
    summary: {
      target_count: targets.length,
      subnet_count: new Set(targets.map((target) => target.netuid)).size,
      auto_review_candidate_count: targets.filter(
        (target) => target.auto_review_candidate,
      ).length,
      manual_review_required_count: targets.filter(
        (target) => target.manual_review_required,
      ).length,
      new_evidence_count: targets.filter(
        (target) => target.evidence_action === "submit-new-evidence",
      ).length,
      stale_replacement_count: targets.filter(
        (target) => target.evidence_action === "replace-stale-evidence",
      ).length,
      by_evidence_action: countBy(targets, "evidence_action"),
      by_kind: countBy(
        targets.filter((target) => target.kind),
        "kind",
      ),
      by_lane: countBy(targets, "lane"),
      by_target_type: countBy(targets, "target_type"),
    },
    groups: enrichmentTargetGroups(targets),
    targets,
  };
}

function enrichmentTargetsForEntry({ entry, evidenceEntry }) {
  if (entry.lane === "direct-submission") {
    return entry.direct_submission_kinds.map((kind) =>
      surfaceCandidateTarget({ entry, evidenceEntry, kind }),
    );
  }
  if (entry.lane === "adapter-candidate") {
    return [
      nonSurfaceEnrichmentTarget({ entry, targetType: "adapter-review" }),
    ];
  }
  if (entry.lane === "maintainer-review") {
    return [
      nonSurfaceEnrichmentTarget({
        entry,
        targetType: "maintainer-review",
      }),
    ];
  }
  return [
    nonSurfaceEnrichmentTarget({
      entry,
      targetType: "monitoring-followup",
    }),
  ];
}

function surfaceCandidateTarget({ entry, evidenceEntry, kind }) {
  const candidateEvidence = evidenceEntry?.candidate_evidence_by_kind?.[
    kind
  ] || {
    candidate_count: 0,
    classifications: {},
    live_or_redirected_count: 0,
    reviewable_count: 0,
    sample_candidate_ids: [],
    stale_or_failed_count: 0,
    unverified_count: 0,
  };
  const evidenceAction = surfaceEvidenceAction(candidateEvidence);
  const action = surfaceTargetAction(evidenceAction);
  return {
    auto_review_candidate: !entry.manual_review_required,
    candidate_command: candidateCommandTemplate(entry.netuid, kind),
    candidate_evidence: candidateEvidence,
    contribution_prompt: contributionPromptForKind(kind, evidenceAction),
    evidence_action: evidenceAction,
    identity_level: entry.identity_level,
    kind,
    lane: entry.lane,
    manual_review_required: entry.manual_review_required,
    missing_kinds: entry.missing_kinds,
    name: entry.name,
    netuid: entry.netuid,
    priority_score: entry.priority_score,
    profile_level: entry.profile_level,
    queue_context: enrichmentTargetQueueContext(entry),
    reason_codes: entry.reason_codes,
    recommended_action: entry.recommended_action,
    sample_live_candidate_ids: entry.sample_live_candidate_ids,
    sample_stale_candidate_ids: entry.sample_stale_candidate_ids,
    sample_target_candidate_ids: entry.sample_target_candidate_ids,
    slug: entry.slug,
    source_requirements: sourceRequirementsForKind(kind),
    source_urls: entry.source_urls.slice(0, 3),
    submission_route: "direct-candidate-pr",
    target_id: enrichmentTargetId(entry, "surface-candidate", kind),
    target_type: "surface-candidate",
    target_action: action,
  };
}

function surfaceEvidenceAction(candidateEvidence) {
  if (!candidateEvidence || candidateEvidence.candidate_count === 0) {
    return "submit-new-evidence";
  }
  if (candidateEvidence.live_or_redirected_count > 0) {
    return "review-existing-evidence";
  }
  if (candidateEvidence.stale_or_failed_count > 0) {
    return "replace-stale-evidence";
  }
  return "verify-existing-evidence";
}

function nonSurfaceEnrichmentTarget({ entry, targetType }) {
  const routeByType = {
    "adapter-review": "adapter-request",
    "maintainer-review": "maintainer-review",
    "monitoring-followup": "status-report",
  };
  return {
    auto_review_candidate: false,
    candidate_command: null,
    candidate_evidence: null,
    contribution_prompt: contributionPromptForTargetType(targetType),
    evidence_action: entry.evidence_action,
    identity_level: entry.identity_level,
    kind: null,
    lane: entry.lane,
    manual_review_required: true,
    missing_kinds: entry.missing_kinds,
    name: entry.name,
    netuid: entry.netuid,
    priority_score: entry.priority_score,
    profile_level: entry.profile_level,
    queue_context: enrichmentTargetQueueContext(entry),
    reason_codes: entry.reason_codes,
    recommended_action: entry.recommended_action,
    sample_live_candidate_ids: entry.sample_live_candidate_ids,
    sample_stale_candidate_ids: entry.sample_stale_candidate_ids,
    sample_target_candidate_ids: entry.sample_target_candidate_ids,
    slug: entry.slug,
    source_requirements: sourceRequirementsForTargetType(targetType),
    source_urls: entry.source_urls.slice(0, 3),
    submission_route: routeByType[targetType],
    target_id: enrichmentTargetId(entry, targetType, null),
    target_type: targetType,
    target_action: targetType,
  };
}

function enrichmentTargetQueueContext(entry) {
  return {
    adapter_score: entry.adapter_score,
    candidate_count: entry.candidate_count,
    completeness_score: entry.completeness_score,
    curation_level: entry.curation_level,
    direct_submission_kind_count: entry.direct_submission_kinds.length,
    endpoint_count: entry.endpoint_count,
    identity_surface_count: entry.identity_surface_count,
    operational_interface_count: entry.operational_interface_count,
    profile_level: entry.profile_level,
    review_state: entry.review_state,
    source_url_count: entry.source_urls.length,
    stale_candidate_count: entry.stale_candidate_count,
    surface_count: entry.surface_count,
    verified_candidate_count: entry.verified_candidate_count,
  };
}

function enrichmentTargetGroups(targets) {
  return [...groupBy(targets, "target_type").entries()]
    .flatMap(([targetType, rows]) => {
      const byKind = groupBy(rows, (row) => row.kind || targetType);
      return [...byKind.entries()].map(([kind, kindRows]) => ({
        auto_review_candidate_count: kindRows.filter(
          (target) => target.auto_review_candidate,
        ).length,
        kind: kind === targetType ? null : kind,
        manual_review_required_count: kindRows.filter(
          (target) => target.manual_review_required,
        ).length,
        target_count: kindRows.length,
        target_ids: kindRows.map((target) => target.target_id).slice(0, 20),
        target_type: targetType,
        top_netuids: kindRows
          .slice()
          .sort(
            (a, b) =>
              b.priority_score - a.priority_score || a.netuid - b.netuid,
          )
          .slice(0, 10)
          .map((target) => target.netuid),
      }));
    })
    .sort(
      (a, b) =>
        a.target_type.localeCompare(b.target_type) ||
        String(a.kind || "").localeCompare(String(b.kind || "")),
    );
}

function enrichmentTargetId(entry, targetType, kind) {
  return [`sn-${entry.netuid}`, targetType, kind || entry.lane]
    .map(slugify)
    .join("-");
}

function candidateCommandTemplate(netuid, kind) {
  return `npm run candidate:new -- --netuid ${netuid} --kind ${kind} --url <public-url> --source-url <public-source-url> --provider <provider-slug> --submitted-by <github-login> --write`;
}

function surfaceTargetAction(evidenceAction) {
  if (evidenceAction === "replace-stale-evidence") {
    return "replace-stale-candidate";
  }
  if (evidenceAction === "verify-existing-evidence") {
    return "verify-existing-candidate";
  }
  if (evidenceAction === "review-existing-evidence") {
    return "review-existing-candidate";
  }
  return "submit-new-candidate";
}

function contributionPromptForKind(kind, evidenceAction) {
  const verb =
    evidenceAction === "replace-stale-evidence"
      ? "Replace stale or failed"
      : evidenceAction === "review-existing-evidence"
        ? "Confirm and submit"
        : "Submit";
  return `${verb} official public ${kind} evidence for this subnet. Use one candidate per PR and include a public source URL that proves provenance.`;
}

function contributionPromptForTargetType(targetType) {
  if (targetType === "adapter-review") {
    return "Review whether the existing public API/schema/data surfaces justify a subnet-specific adapter. Adapter requests route to manual review.";
  }
  if (targetType === "maintainer-review") {
    return "Review existing machine-verified surfaces and promote only source-backed public interfaces.";
  }
  return "Review probe-derived status or request a re-probe. Contributor reports never set observed health directly.";
}

function sourceRequirementsForKind(kind) {
  if (["website", "docs", "source-repo"].includes(kind)) {
    return [
      "Prefer an official project/team source.",
      "The source URL must be public and show the subnet/project relationship.",
      "Do not submit Discord-only claims, private dashboards, wallet paths, PATs, or validator internals.",
    ];
  }
  if (["openapi", "subnet-api", "sse", "data-artifact"].includes(kind)) {
    return [
      "The URL must be public-safe and read-only.",
      "The source URL must document or link the interface.",
      "Do not submit authenticated, write-capable, wallet, PAT, or validator-private flows.",
    ];
  }
  return [
    "The URL and source URL must both be public.",
    "The source URL must explain ownership or relevance.",
    "Do not submit secrets, private URLs, wallet paths, or validator internals.",
  ];
}

function sourceRequirementsForTargetType(targetType) {
  if (targetType === "adapter-review") {
    return [
      "Existing public API/schema/data evidence should be stable enough to normalize.",
      "Adapter work requires maintainer review before publication.",
    ];
  }
  if (targetType === "maintainer-review") {
    return [
      "Use public provenance to confirm or reject existing machine-verified surfaces.",
      "Promotion decisions must stay public-safe and source-backed.",
    ];
  }
  return [
    "Use status reports to trigger review or re-probes only.",
    "Observed uptime, latency, and incidents remain probe-derived.",
  ];
}

function compactEnrichmentQueueEntry(entry) {
  const { candidate_evidence_by_kind: evidenceByKind, ...compact } = entry;
  return {
    ...compact,
    candidate_evidence_summary: summarizeCandidateEvidence(evidenceByKind),
  };
}

function enrichmentEvidenceEntry(entry) {
  return {
    candidate_evidence_by_kind: entry.candidate_evidence_by_kind,
    candidate_evidence_summary: summarizeCandidateEvidence(
      entry.candidate_evidence_by_kind,
    ),
    direct_submission_kinds: entry.direct_submission_kinds,
    evidence_action: entry.evidence_action,
    lane: entry.lane,
    missing_kinds: entry.missing_kinds,
    name: entry.name,
    netuid: entry.netuid,
    priority_score: entry.priority_score,
    slug: entry.slug,
  };
}

function summarizeCandidateEvidence(evidenceByKind) {
  const entries = Object.entries(evidenceByKind || {});
  const summary = {
    candidate_count: 0,
    kinds_with_candidates: [],
    live_kinds: [],
    live_or_redirected_count: 0,
    reviewable_count: 0,
    stale_kinds: [],
    stale_or_failed_count: 0,
    unverified_count: 0,
    unverified_kinds: [],
  };

  for (const [kind, evidence] of entries) {
    summary.candidate_count += evidence.candidate_count || 0;
    summary.live_or_redirected_count += evidence.live_or_redirected_count || 0;
    summary.reviewable_count += evidence.reviewable_count || 0;
    summary.stale_or_failed_count += evidence.stale_or_failed_count || 0;
    summary.unverified_count += evidence.unverified_count || 0;
    if ((evidence.candidate_count || 0) > 0) {
      summary.kinds_with_candidates.push(kind);
    }
    if ((evidence.live_or_redirected_count || 0) > 0) {
      summary.live_kinds.push(kind);
    }
    if ((evidence.stale_or_failed_count || 0) > 0) {
      summary.stale_kinds.push(kind);
    }
    if ((evidence.unverified_count || 0) > 0) {
      summary.unverified_kinds.push(kind);
    }
  }

  summary.kinds_with_candidates.sort();
  summary.live_kinds.sort();
  summary.stale_kinds.sort();
  summary.unverified_kinds.sort();
  return summary;
}

function enrichmentQueueEntry({
  adapterCandidate,
  gapPriority,
  profile,
  reviewProfile,
  subnetCandidates,
  verificationByCandidate,
}) {
  const missingRequired = profile.completeness.missing_required || [];
  const missingOperational = profile.completeness.missing_operational || [];
  const missingKinds = [
    ...new Set([
      ...(gapPriority?.missing_kinds || []),
      ...missingRequired,
      ...missingOperational,
    ]),
  ].sort();
  const directSubmissionKinds = directSubmissionKindsForProfile(profile);
  const candidateEvidenceByKind = candidateEvidenceByKindForQueue({
    directSubmissionKinds,
    missingKinds,
    subnetCandidates,
    verificationByCandidate,
  });
  const lane = enrichmentLane({
    adapterCandidate,
    directSubmissionKinds,
    profile,
  });
  const evidenceAction = enrichmentEvidenceAction({
    candidateEvidenceByKind,
    directSubmissionKinds,
    lane,
  });
  const manualReviewRequired = [
    "maintainer-review",
    "adapter-candidate",
  ].includes(lane);
  const adapterScore = adapterCandidate?.priority_score || 0;
  const priorityScore =
    (reviewProfile?.priority_score || 100 - profile.completeness_score) +
    Math.floor((gapPriority?.priority_score || 0) / 2) +
    Math.floor(adapterScore / 2);

  return {
    adapter_score: adapterScore,
    candidate_evidence_by_kind: candidateEvidenceByKind,
    candidate_count: profile.candidate_count,
    completeness_score: profile.completeness_score,
    contribution_hint: enrichmentContributionHint(lane, directSubmissionKinds),
    curation_level: profile.curation_level,
    direct_submission_kinds: directSubmissionKinds,
    endpoint_count: profile.endpoint_count,
    evidence_action: evidenceAction,
    identity_level: profile.identity_level,
    identity_surface_count: profile.identity_surface_count,
    lane,
    manual_review_required: manualReviewRequired,
    missing_identity: profile.missing_identity,
    missing_kinds: missingKinds,
    name: profile.name,
    netuid: profile.netuid,
    operational_interface_count: profile.operational_interface_count,
    priority_score: priorityScore,
    profile_level: profile.profile_level,
    reason_codes: enrichmentReasonCodes({
      adapterCandidate,
      directSubmissionKinds,
      profile,
    }),
    recommended_action: enrichmentRecommendedAction({
      adapterCandidate,
      directSubmissionKinds,
      lane,
      profile,
      reviewProfile,
    }),
    review_state: profile.review_state,
    sample_candidate_ids: subnetCandidates
      .map((candidate) => candidate.id)
      .filter(Boolean)
      .sort()
      .slice(0, 5),
    sample_live_candidate_ids: sampleCandidateIdsForQueue({
      candidateClasses: ["live", "redirected"],
      directSubmissionKinds,
      missingKinds,
      subnetCandidates,
      verificationByCandidate,
    }),
    sample_stale_candidate_ids: sampleCandidateIdsForQueue({
      candidateClasses: [
        "content-mismatch",
        "dead",
        "timeout",
        "unsafe",
        "unsupported",
      ],
      directSubmissionKinds,
      missingKinds,
      subnetCandidates,
      verificationByCandidate,
    }),
    sample_target_candidate_ids: sampleCandidateIdsForQueue({
      directSubmissionKinds,
      missingKinds,
      subnetCandidates,
      verificationByCandidate,
    }),
    slug: profile.slug,
    source_urls: (profile.provenance.source_urls || []).slice(0, 8),
    stale_candidate_count: staleCandidateCount(candidateEvidenceByKind),
    surface_count: profile.surface_count,
    verified_candidate_count: gapPriority?.verified_candidate_count || 0,
  };
}

function candidateEvidenceByKindForQueue({
  directSubmissionKinds,
  missingKinds,
  subnetCandidates,
  verificationByCandidate,
}) {
  const relevantKinds = [
    ...new Set([...missingKinds, ...directSubmissionKinds]),
  ].sort();
  const candidatesByKind = groupBy(
    subnetCandidates.filter((candidate) =>
      relevantKinds.includes(candidate.kind),
    ),
    "kind",
  );

  return Object.fromEntries(
    relevantKinds.map((kind) => {
      const kindCandidates = candidatesByKind.get(kind) || [];
      const classifications = countBy(
        kindCandidates.map((candidate) => ({
          classification:
            verificationByCandidate.get(candidate.id)?.classification ||
            candidate.verification?.classification ||
            candidate.state ||
            "unknown",
        })),
        "classification",
      );
      const liveCount =
        (classifications.live || 0) + (classifications.redirected || 0);
      const unverifiedCount =
        (classifications["schema-valid"] || 0) +
        (classifications["maintainer-review"] || 0) +
        (classifications.verified || 0) +
        (classifications.unknown || 0);
      const deadCount =
        (classifications.dead || 0) +
        (classifications.timeout || 0) +
        (classifications.unsafe || 0) +
        (classifications.unsupported || 0) +
        (classifications["content-mismatch"] || 0);
      const reviewableCount = kindCandidates.filter((candidate) =>
        ["schema-valid", "maintainer-review", "verified"].includes(
          candidate.state,
        ),
      ).length;
      return [
        kind,
        {
          candidate_count: kindCandidates.length,
          classifications,
          live_or_redirected_count: liveCount,
          reviewable_count: reviewableCount,
          stale_or_failed_count: deadCount,
          unverified_count: unverifiedCount,
          sample_candidate_ids: kindCandidates
            .map((candidate) => candidate.id)
            .filter(Boolean)
            .sort()
            .slice(0, 3),
        },
      ];
    }),
  );
}

function sampleCandidateIdsForQueue({
  candidateClasses = null,
  directSubmissionKinds,
  missingKinds,
  subnetCandidates,
  verificationByCandidate,
}) {
  const relevantKinds = new Set(
    directSubmissionKinds.length > 0 ? directSubmissionKinds : missingKinds,
  );
  const classSet = candidateClasses ? new Set(candidateClasses) : null;
  return subnetCandidates
    .filter((candidate) => relevantKinds.has(candidate.kind))
    .filter((candidate) => {
      if (!classSet) {
        return true;
      }
      return classSet.has(
        candidateQueueClassification(candidate, verificationByCandidate),
      );
    })
    .sort(
      (a, b) =>
        candidateQueuePriority(a, verificationByCandidate) -
          candidateQueuePriority(b, verificationByCandidate) ||
        a.kind.localeCompare(b.kind) ||
        String(a.id || "").localeCompare(String(b.id || "")),
    )
    .map((candidate) => candidate.id)
    .filter(Boolean)
    .slice(0, 5);
}

function candidateQueueClassification(candidate, verificationByCandidate) {
  return (
    verificationByCandidate.get(candidate.id)?.classification ||
    candidate.verification?.classification ||
    candidate.state ||
    "unknown"
  );
}

function candidateQueuePriority(candidate, verificationByCandidate) {
  const classification = candidateQueueClassification(
    candidate,
    verificationByCandidate,
  );
  const weights = {
    live: 0,
    redirected: 1,
    verified: 2,
    "maintainer-review": 3,
    "schema-valid": 4,
    unknown: 5,
    "auth-required": 6,
    "rate-limited": 7,
    timeout: 8,
    "content-mismatch": 9,
    unsupported: 10,
    dead: 11,
    unsafe: 12,
    rejected: 13,
  };
  return weights[classification] ?? 20;
}

function enrichmentEvidenceAction({
  candidateEvidenceByKind,
  directSubmissionKinds,
  lane,
}) {
  if (["adapter-candidate", "maintainer-review"].includes(lane)) {
    return "maintainer-review-existing-evidence";
  }
  if (lane !== "direct-submission") {
    return "monitor";
  }

  const targetEvidence = directSubmissionKinds.map(
    (kind) => candidateEvidenceByKind[kind],
  );
  if (
    targetEvidence.some(
      (evidence) =>
        evidence &&
        evidence.candidate_count > 0 &&
        evidence.live_or_redirected_count === 0,
    )
  ) {
    if (
      targetEvidence.some(
        (evidence) => evidence && evidence.stale_or_failed_count > 0,
      )
    ) {
      return "replace-stale-evidence";
    }
    return "verify-existing-evidence";
  }
  if (
    targetEvidence.some(
      (evidence) => evidence && evidence.live_or_redirected_count > 0,
    )
  ) {
    return "review-existing-evidence";
  }
  return "submit-new-evidence";
}

function staleCandidateCount(candidateEvidenceByKind) {
  return Object.values(candidateEvidenceByKind).reduce(
    (sum, evidence) => sum + (evidence.stale_or_failed_count || 0),
    0,
  );
}

function directSubmissionKindsForProfile(profile) {
  const missingRequired = new Set(profile.completeness.missing_required || []);
  const identityTargets = ["docs", "website", "source-repo"].filter((kind) =>
    missingRequired.has(kind),
  );
  if (identityTargets.length > 0) {
    return identityTargets;
  }

  const missingOperational = new Set(
    profile.completeness.missing_operational || [],
  );
  const hasOperationalEvidence = profile.operational_interface_count > 0;
  const operationalTargets = ["openapi", "subnet-api", "data-artifact"].filter(
    (kind) => missingOperational.has(kind),
  );
  if (!hasOperationalEvidence) {
    return operationalTargets;
  }

  const hasApiLikeEvidence = profile.operational_interface_kinds.some((kind) =>
    ["openapi", "subnet-api"].includes(kind),
  );
  if (!hasApiLikeEvidence) {
    return operationalTargets.filter((kind) =>
      ["openapi", "subnet-api"].includes(kind),
    );
  }

  return [];
}

function enrichmentLane({ adapterCandidate, directSubmissionKinds, profile }) {
  if (directSubmissionKinds.length > 0) {
    return "direct-submission";
  }
  if (
    profile.review_state !== "maintainer-reviewed" &&
    profile.surface_count > 0
  ) {
    return "maintainer-review";
  }
  if (adapterCandidate?.operational_surface_count > 0) {
    return "adapter-candidate";
  }
  return "baseline-monitoring";
}

function enrichmentReasonCodes({
  adapterCandidate,
  directSubmissionKinds,
  profile,
}) {
  const reasons = [];
  if (profile.profile_level === "directory-only") {
    reasons.push("directory-only-profile");
  }
  for (const kind of directSubmissionKinds) {
    reasons.push(`missing-${kind}`);
  }
  if (profile.review_state !== "maintainer-reviewed") {
    reasons.push("needs-maintainer-review");
  }
  if (adapterCandidate?.operational_surface_count > 0) {
    reasons.push("adapter-candidate");
  }
  return [...new Set(reasons)].sort();
}

function enrichmentContributionHint(lane, directSubmissionKinds) {
  if (lane === "direct-submission") {
    const kinds = directSubmissionKinds.join(", ");
    return `Submit one official public ${kinds || "interface"} candidate with npm run candidate:new.`;
  }
  if (lane === "maintainer-review") {
    return "Maintainer should review current machine-verified surfaces and promote only source-backed entries.";
  }
  if (lane === "adapter-candidate") {
    return "Maintainer should evaluate whether subnet-specific adapter metrics add useful public operational data.";
  }
  if (lane === "monitoring-followup") {
    return "Endpoint status reports can trigger re-probes or review, but observed health remains probe-derived.";
  }
  return "No immediate enrichment action; keep monitoring for drift and new public interfaces.";
}

function enrichmentRecommendedAction({
  adapterCandidate,
  directSubmissionKinds,
  lane,
  profile,
  reviewProfile,
}) {
  if (lane === "direct-submission") {
    if (
      directSubmissionKinds.some((kind) =>
        ["docs", "website", "source-repo"].includes(kind),
      )
    ) {
      return "submit official docs, website, or source repository evidence";
    }
    return "submit public API, OpenAPI, SSE, or data-artifact surfaces if the subnet exposes them";
  }
  if (lane === "maintainer-review") {
    return (
      reviewProfile?.suggested_next_action ||
      "review promoted surfaces and mark maintainer-reviewed where provenance is strong"
    );
  }
  if (lane === "adapter-candidate") {
    const kinds = (adapterCandidate.operational_kinds || []).join(", ");
    return `evaluate adapter support for ${kinds || "operational surfaces"}`;
  }
  if (profile.operational_interface_count > 0) {
    return "profile is baseline-complete; monitor operational surfaces for drift";
  }
  return "profile is baseline-complete; monitor for new public interfaces";
}

function countDirectSubmissionKinds(queue) {
  return Object.fromEntries(
    Object.entries(
      queue.reduce((accumulator, entry) => {
        for (const kind of entry.direct_submission_kinds || []) {
          accumulator[kind] = (accumulator[kind] || 0) + 1;
        }
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function countGapReasons(profiles) {
  return Object.fromEntries(
    Object.entries(
      profiles.reduce((accumulator, profile) => {
        for (const reason of profile.gap_reasons || []) {
          accumulator[reason] = (accumulator[reason] || 0) + 1;
        }
        return accumulator;
      }, {}),
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildSubnetProfile({
  subnet,
  surfaces,
  endpoints,
  candidates,
  nativeIdentity,
}) {
  const archiveSupported = surfaces.some(surfaceHasArchiveSupport);
  const supportedKinds = [
    ...new Set([
      ...(subnet.gaps.supported_kinds || []),
      ...(archiveSupported ? ["archive"] : []),
    ]),
  ].sort();
  const operationalKinds = supportedKinds.filter((kind) =>
    operationalKindsForSubnetType(subnet.subnet_type).includes(kind),
  );
  const primaryLinks = {
    website_url: subnet.website_url || firstSurfaceUrl(surfaces, "website"),
    docs_url: subnet.docs_url || firstSurfaceUrl(surfaces, "docs"),
    source_repo: subnet.source_repo || firstSurfaceUrl(surfaces, "source-repo"),
    dashboard_url:
      subnet.dashboard_url || firstSurfaceUrl(surfaces, "dashboard"),
  };
  const completeness = subnetProfileCompleteness({
    curationLevel: subnet.curation.level,
    primaryLinks,
    subnetType: subnet.subnet_type,
    supportedKinds,
  });
  const sourceUrls = profileSourceUrls({ primaryLinks, surfaces });
  const confidence = profileConfidence(subnet.curation);
  const nativeIdentityInfo = nativeIdentitySummary(nativeIdentity);
  const identityEvidence = profileIdentityEvidence({
    candidates,
    nativeIdentity: nativeIdentityInfo,
    primaryLinks,
  });

  const profile = {
    netuid: subnet.netuid,
    slug: subnet.slug,
    name: subnet.name,
    native_name: subnet.native_name,
    native_name_quality: subnet.native_name_quality,
    native_identity: nativeIdentityInfo,
    subnet_type: subnet.subnet_type,
    status: subnet.status,
    symbol: subnet.symbol,
    project_name: subnet.name,
    team: null,
    categories: subnet.categories || [],
    primary_links: primaryLinks,
    primary_app_surface: surfaceSummary(primaryAppSurface(surfaces)),
    supported_interface_kinds: supportedKinds,
    operational_interface_kinds: operationalKinds,
    surface_count: surfaces.length,
    endpoint_count: endpoints.length,
    monitored_endpoint_count: endpoints.filter(
      (endpoint) => endpoint.monitoring_status === "monitored",
    ).length,
    candidate_count: candidates.length,
    identity_evidence: identityEvidence,
    interface_count: supportedKinds.length,
    operational_interface_count: operationalKinds.length,
    completeness,
    provenance: {
      identity_source:
        subnet.provenance?.identity?.display_name_source || "unknown",
      interface_source_count: sourceUrls.length,
      review_state: subnet.curation.review_state,
      curation_level: subnet.curation.level,
      reviewed_at: subnet.curation.reviewed_at || null,
      source_urls: sourceUrls,
    },
    curation_level: subnet.curation.level,
    review_state: subnet.curation.review_state,
    confidence,
    profile_level: completeness.profile_level,
    identity_level: completeness.identity_level,
    identity_surface_count: completeness.identity_surface_count,
    completeness_score: completeness.score,
    missing_required: completeness.missing_required,
    missing_identity: completeness.missing_identity,
    missing_operational: completeness.missing_operational,
    missing_critical_count: completeness.missing_critical_count,
    gap_reasons: completeness.gap_reasons,
  };
  return {
    ...profile,
    suggested_submission_kinds: directSubmissionKindsForProfile(profile),
  };
}

function nativeIdentitySummary(identity) {
  if (!identity || typeof identity !== "object") {
    return null;
  }

  return {
    source: identity.source || "SubtensorModule.SubnetIdentitiesV3",
    subnet_name: cleanProfileText(identity.subnet_name),
    description: cleanProfileText(identity.description),
    additional: cleanProfileText(identity.additional),
    website_url: normalizePublicUrl(identity.subnet_url),
    github_url: normalizePublicUrl(identity.github_repo),
    discord_url: normalizePublicUrl(identity.discord),
    logo_url: normalizePublicUrl(identity.logo_url),
    contact_present: Boolean(identity.contact_present),
  };
}

function profileIdentityEvidence({ candidates, nativeIdentity, primaryLinks }) {
  const identityKinds = ["docs", "source-repo", "website"];
  const curatedIdentityKinds = identityKinds
    .filter((kind) => primaryLinkForKind(primaryLinks, kind))
    .sort();
  const nativeIdentityKinds = [
    ...(nativeIdentity?.github_url ? ["source-repo"] : []),
    ...(nativeIdentity?.website_url ? ["website"] : []),
  ].sort();
  const identityCandidates = candidates.filter((candidate) =>
    identityKinds.includes(candidate.kind),
  );
  const liveCandidateIdentityKinds = candidateIdentityKindsByClassification(
    identityCandidates,
    ["live", "redirected"],
  );
  const staleCandidateIdentityKinds = candidateIdentityKindsByClassification(
    identityCandidates,
    ["content-mismatch", "dead", "timeout", "unsafe", "unsupported"],
  );
  const unverifiedCandidateIdentityKinds =
    candidateIdentityKindsByClassification(identityCandidates, [
      "auth-required",
      "maintainer-review",
      "rate-limited",
      "schema-valid",
      "transient",
      "unknown",
      "verified",
    ]);
  const needsPromotionKinds = liveCandidateIdentityKinds.filter(
    (kind) => !curatedIdentityKinds.includes(kind),
  );

  return {
    candidate_identity_count: identityCandidates.length,
    curated_identity_count: curatedIdentityKinds.length,
    curated_identity_kinds: curatedIdentityKinds,
    live_candidate_identity_kinds: liveCandidateIdentityKinds,
    native_contact_present: Boolean(nativeIdentity?.contact_present),
    native_description_present: Boolean(nativeIdentity?.description),
    native_identity_count: nativeIdentityKinds.length,
    native_identity_kinds: nativeIdentityKinds,
    needs_promotion_kinds: needsPromotionKinds,
    stale_candidate_identity_kinds: staleCandidateIdentityKinds,
    unverified_candidate_identity_kinds: unverifiedCandidateIdentityKinds,
  };
}

function candidateIdentityKindsByClassification(candidates, classifications) {
  const classificationSet = new Set(classifications);
  return [
    ...new Set(
      candidates
        .filter((candidate) =>
          classificationSet.has(candidateIdentityClassification(candidate)),
        )
        .map((candidate) => candidate.kind),
    ),
  ].sort();
}

function candidateIdentityClassification(candidate) {
  return candidate.verification?.classification || candidate.state || "unknown";
}

function primaryLinkForKind(primaryLinks, kind) {
  const fieldByKind = {
    docs: "docs_url",
    "source-repo": "source_repo",
    website: "website_url",
  };
  return primaryLinks[fieldByKind[kind]] || null;
}

function cleanProfileText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const clean = value.trim();
  return clean || null;
}

function subnetProfileCompleteness({
  curationLevel,
  primaryLinks,
  subnetType,
  supportedKinds,
}) {
  const kindSet = new Set(supportedKinds);
  const identityEntries = [
    ["docs", primaryLinks.docs_url || kindSet.has("docs")],
    ["source-repo", primaryLinks.source_repo || kindSet.has("source-repo")],
    ["website", primaryLinks.website_url || kindSet.has("website")],
  ];
  const identitySurfaceCount = identityEntries.filter(
    ([, present]) => present,
  ).length;
  const missingIdentity = identityEntries
    .filter(([, present]) => !present)
    .map(([kind]) => kind);
  const identityLevel =
    identitySurfaceCount === identityEntries.length
      ? "complete"
      : identitySurfaceCount > 0
        ? "partial"
        : primaryLinks.dashboard_url || kindSet.has("dashboard")
          ? "directory"
          : "none";
  const missingRecommended = [
    ["docs", primaryLinks.docs_url || kindSet.has("docs")],
  ]
    .filter(([, present]) => !present)
    .map(([kind]) => kind);
  const missingRequired = [
    ["source-repo", primaryLinks.source_repo || kindSet.has("source-repo")],
    ["website", primaryLinks.website_url || kindSet.has("website")],
  ]
    .filter(([, present]) => !present)
    .map(([kind]) => kind);
  const operationalKinds = operationalKindsForSubnetType(subnetType);
  const missingOperational = operationalKinds.filter(
    (kind) => !kindSet.has(kind),
  );
  const operationalCount = operationalKinds.length - missingOperational.length;
  const operationalScore =
    subnetType === "root"
      ? (kindSet.has("subtensor-rpc") ? 20 : 0) +
        (kindSet.has("subtensor-wss") ? 15 : 0) +
        (kindSet.has("archive") ? 10 : 0)
      : (kindSet.has("openapi") ? 15 : 0) +
        (kindSet.has("subnet-api") ? 15 : 0) +
        (kindSet.has("sse") ? 7 : 0) +
        (kindSet.has("data-artifact") ? 8 : 0);
  const score = Math.min(
    100,
    (primaryLinks.docs_url || kindSet.has("docs") ? 15 : 0) +
      (primaryLinks.source_repo || kindSet.has("source-repo") ? 15 : 0) +
      (primaryLinks.website_url || kindSet.has("website") ? 15 : 0) +
      (primaryLinks.dashboard_url || kindSet.has("dashboard") ? 5 : 0) +
      operationalScore +
      (curationLevel === "maintainer-reviewed" ? 5 : 0) +
      (curationLevel === "adapter-backed" ? 10 : 0),
  );
  const profileLevel =
    curationLevel === "adapter-backed"
      ? "adapter-backed"
      : operationalCount > 0
        ? "operational"
        : missingRequired.length === 0
          ? "identity-complete"
          : identitySurfaceCount > 0
            ? "identity-partial"
            : "directory-only";
  const gapReasons = [
    ...missingRequired.map((kind) => `missing-${kind}`),
    ...missingRecommended.map((kind) => `missing-${kind}`),
    ...missingOperational.map((kind) => `missing-${kind}`),
  ];

  return {
    score,
    profile_level: profileLevel,
    identity_level: identityLevel,
    identity_surface_count: identitySurfaceCount,
    confidence:
      curationLevel === "adapter-backed" ||
      curationLevel === "maintainer-reviewed"
        ? "high"
        : curationLevel === "machine-verified"
          ? "medium"
          : "low",
    missing_identity: missingIdentity,
    missing_required: missingRequired,
    missing_operational: missingOperational,
    missing_critical_count: missingRequired.length + missingOperational.length,
    gap_reasons: gapReasons,
  };
}

function operationalKindsForSubnetType(subnetType) {
  if (subnetType === "root") {
    return ["subtensor-rpc", "subtensor-wss", "archive"];
  }
  return ["openapi", "subnet-api", "sse", "data-artifact"];
}

function surfaceHasArchiveSupport(surface) {
  if (surface.kind === "archive") {
    return true;
  }
  if (!["subtensor-rpc", "subtensor-wss"].includes(surface.kind)) {
    return false;
  }
  return /archive/i.test(
    [surface.id, surface.name, surface.rate_limit_notes]
      .filter(Boolean)
      .join(" "),
  );
}

function profileConfidence(curation) {
  if (
    curation.review_state === "maintainer-reviewed" ||
    curation.level === "adapter-backed"
  ) {
    return "high";
  }
  if (curation.level === "machine-verified") {
    return "medium";
  }
  return "low";
}

function primaryAppSurface(surfaces) {
  const priority = [
    "subnet-api",
    "openapi",
    "sse",
    "data-artifact",
    "repo-registry",
    "website",
    "docs",
    "dashboard",
  ];
  return (
    [...surfaces].sort(
      (a, b) =>
        priorityRank(priority, a.kind) - priorityRank(priority, b.kind) ||
        a.id.localeCompare(b.id),
    )[0] || null
  );
}

function priorityRank(priority, value) {
  const index = priority.indexOf(value);
  return index === -1 ? 999 : index;
}

function surfaceSummary(surface) {
  if (!surface) {
    return null;
  }
  return {
    id: surface.id,
    kind: surface.kind,
    name: surface.name,
    provider: surface.provider,
    url: surface.url,
  };
}

function firstSurfaceUrl(surfaces, kind) {
  return surfaces.find((surface) => surface.kind === kind)?.url || null;
}

function profileSourceUrls({ primaryLinks, surfaces }) {
  const urls = new Set(Object.values(primaryLinks).filter(Boolean).sort());
  for (const surface of surfaces) {
    for (const url of surface.source_urls || []) {
      urls.add(url);
    }
  }
  return [...urls].sort();
}

function profileSuggestedNextAction(profile) {
  if (profile.completeness.missing_required.length > 0) {
    return "submit official docs, website, or source repository evidence";
  }
  if (profile.completeness.missing_operational.length > 0) {
    return "submit public API, OpenAPI, SSE, or data-artifact surfaces if the subnet exposes them";
  }
  if (profile.review_state !== "maintainer-reviewed") {
    return "request maintainer review for promoted machine-verified surfaces";
  }
  if (profile.operational_interface_count > 0) {
    return "evaluate whether a subnet-specific adapter would add useful public metrics";
  }
  return "profile is baseline-complete; monitor for drift";
}

function averageScore(profiles) {
  if (profiles.length === 0) {
    return 0;
  }
  return Math.round(
    profiles.reduce((sum, profile) => sum + profile.completeness_score, 0) /
      profiles.length,
  );
}

function groupByNetuid(items) {
  return groupBy(items, "netuid");
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const groupKey = typeof key === "function" ? key(item) : item[key];
    const group = groups.get(groupKey) || [];
    group.push(item);
    groups.set(groupKey, group);
  }
  return groups;
}

async function loadPreviousHealthArtifact() {
  if (process.env.METAGRAPH_PRESERVE_PROBE_HEALTH !== "1") {
    return null;
  }
  const artifact = await readOptionalJson(
    path.join(repoRoot, ".cache/metagraphed/health/latest.json"),
  );
  return artifact?.source === "live-smoke-probe" ? artifact : null;
}

function buildSurfaceHealthRows({ surfaces, previousHealthArtifact }) {
  const previousBySurfaceId = new Map(
    (previousHealthArtifact?.surfaces || []).map((surface) => [
      surface.surface_id,
      surface,
    ]),
  );
  return surfaces.map((surface) =>
    buildSurfaceHealthRow(surface, previousBySurfaceId.get(surface.id)),
  );
}

function buildSurfaceHealthRow(surface, previous) {
  const base = {
    auth_required: surface.auth_required,
    classification: "unknown",
    kind: surface.kind,
    last_checked: null,
    last_ok: null,
    latency_ms: null,
    method_tested: surface.probe?.method || "not-configured",
    netuid: surface.netuid,
    provider: surface.provider,
    public_safe: surface.public_safe,
    status: "unknown",
    subnet_name: surface.subnet_name,
    subnet_slug: surface.subnet_slug,
    surface_id: surface.id,
    url: surface.url,
    uptime_sample_ratio: null,
    verified_at: null,
  };

  if (!isReusableHealthRow(surface, previous)) {
    return base;
  }

  const row = {
    ...base,
    classification: previous.classification || "unknown",
    last_checked: previous.last_checked || previous.verified_at || null,
    last_ok: previous.last_ok || null,
    latency_ms: Number.isFinite(previous.latency_ms)
      ? previous.latency_ms
      : null,
    method_tested: previous.method_tested || base.method_tested,
    status: previous.status || "unknown",
    uptime_sample_ratio: previous.uptime_sample_ratio ?? null,
    verified_at: previous.verified_at || null,
  };
  copyOptional(row, previous, "archive_support", "boolean");
  copyOptional(row, previous, "content_type", "string");
  copyOptional(row, previous, "error", "string");
  copyOptional(row, previous, "error_class", "string");
  copyOptional(row, previous, "latest_block", "number");
  copyOptional(row, previous, "private_redirect_blocked", "boolean");
  copyOptional(row, previous, "redirect_target", "string");
  copyOptional(row, previous, "rpc_method_count", "number");
  copyOptional(row, previous, "status_code", "number");
  if (
    previous.method_results &&
    typeof previous.method_results === "object" &&
    !Array.isArray(previous.method_results)
  ) {
    row.method_results = previous.method_results;
  }
  if (Array.isArray(previous.methods_supported)) {
    row.methods_supported = previous.methods_supported;
  }
  return row;
}

function isReusableHealthRow(surface, previous) {
  return Boolean(
    previous &&
    previous.surface_id === surface.id &&
    previous.netuid === surface.netuid &&
    previous.kind === surface.kind &&
    previous.url === surface.url &&
    previous.public_safe === surface.public_safe,
  );
}

function copyOptional(target, source, key, type) {
  if (typeof source[key] === type) {
    target[key] = source[key];
  }
}

function buildHealthArtifacts(surfaceHealth, subnets, options) {
  const byNetuid = groupByNetuid(surfaceHealth);
  const subnetArtifacts = new Map();
  const badgeArtifacts = new Map();
  const summaryRows = [];

  for (const subnet of subnets) {
    const subnetSurfaces = byNetuid.get(subnet.netuid) || [];
    const okCount = subnetSurfaces.filter(
      (surface) => surface.status === "ok",
    ).length;
    const failedCount = subnetSurfaces.filter(
      (surface) => surface.status === "failed",
    ).length;
    const unknownCount = subnetSurfaces.filter(
      (surface) => surface.status === "unknown",
    ).length;
    const degradedCount = subnetSurfaces.filter(
      (surface) => surface.status === "degraded",
    ).length;
    const status = classifySubnetStatus({
      okCount,
      failedCount,
      unknownCount,
      degradedCount,
      surfaceCount: subnetSurfaces.length,
    });
    const summary = {
      netuid: subnet.netuid,
      slug: subnet.slug,
      name: subnet.name,
      status,
      surface_count: subnetSurfaces.length,
      ok_count: okCount,
      failed_count: failedCount,
      degraded_count: degradedCount,
      unknown_count: unknownCount,
      last_checked: latestString(
        subnetSurfaces.map(
          (surface) => surface.verified_at || surface.last_checked,
        ),
      ),
      last_ok: latestString(subnetSurfaces.map((surface) => surface.last_ok)),
      avg_latency_ms: average(
        subnetSurfaces
          .filter((surface) => Number.isFinite(surface.latency_ms))
          .map((surface) => surface.latency_ms),
      ),
    };

    summaryRows.push(summary);
    subnetArtifacts.set(subnet.netuid, {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: options.generatedAt,
      netuid: subnet.netuid,
      slug: subnet.slug,
      name: subnet.name,
      summary,
      surfaces: subnetSurfaces,
    });
    badgeArtifacts.set(subnet.netuid, {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: options.generatedAt,
      netuid: subnet.netuid,
      label: `SN${subnet.netuid}`,
      message: status,
      status,
      color: badgeColor(status),
      surface_count: subnetSurfaces.length,
      ok_count: okCount,
      failed_count: failedCount,
      unknown_count: unknownCount,
    });
  }

  const latest = {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: options.generatedAt,
    observed_at: options.probeFinishedAt || options.observedAt || null,
    source: options.source,
    probe_started_at: options.probeStartedAt,
    probe_finished_at: options.probeFinishedAt,
    notes: options.notes,
    summary: {
      surface_count: surfaceHealth.length,
      status_counts: countBy(surfaceHealth, (surface) => surface.status),
      classification_counts: countBy(
        surfaceHealth,
        (surface) => surface.classification || "unknown",
      ),
    },
    surfaces: surfaceHealth,
  };

  return {
    latest,
    summary: {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: options.generatedAt,
      source: options.source,
      global: latest.summary,
      subnets: summaryRows.sort((a, b) => a.netuid - b.netuid),
    },
    subnets: subnetArtifacts,
    badges: badgeArtifacts,
  };
}

function buildHealthHistoryArtifact(latest, date) {
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: latest.generated_at,
    date,
    probe_started_at: latest.probe_started_at || null,
    probe_finished_at: latest.probe_finished_at || null,
    source: latest.source,
    summary: latest.summary,
    surfaces: latest.surfaces.map((surface) => ({
      classification: surface.classification || "unknown",
      error_class: surface.error_class || null,
      kind: surface.kind,
      last_checked: surface.last_checked || null,
      last_ok: surface.last_ok || null,
      latency_ms: Number.isFinite(surface.latency_ms)
        ? surface.latency_ms
        : null,
      netuid: surface.netuid,
      provider: surface.provider,
      status: surface.status,
      status_code: Number.isInteger(surface.status_code)
        ? surface.status_code
        : null,
      surface_id: surface.surface_id,
      verified_at: surface.verified_at || null,
    })),
  };
}

function buildCurationReview(
  subnets,
  surfaces,
  candidates,
  verificationArtifact,
  reviewDecisionsDocument,
) {
  const surfacesByNetuid = groupByNetuid(surfaces);
  const candidatesByNetuid = groupByNetuid(candidates);
  const verificationByCandidate = new Map(
    (verificationArtifact.results || []).map((result) => [
      result.candidate_id,
      result,
    ]),
  );
  const gapPriorities = subnets
    .map((subnet) => {
      const subnetSurfaces = surfacesByNetuid.get(subnet.netuid) || [];
      const subnetCandidates = candidatesByNetuid.get(subnet.netuid) || [];
      const missingKinds = subnet.gaps.missing_kinds || [];
      const verifiedCandidateCount = subnetCandidates.filter((candidate) =>
        ["live", "redirected"].includes(
          verificationByCandidate.get(candidate.id)?.classification,
        ),
      ).length;
      return {
        netuid: subnet.netuid,
        slug: subnet.slug,
        name: subnet.name,
        curation_level: subnet.curation.level,
        review_state: subnet.curation.review_state,
        surface_count: subnetSurfaces.length,
        candidate_count: subnetCandidates.length,
        verified_candidate_count: verifiedCandidateCount,
        missing_kinds: missingKinds,
        priority_score: reviewPriorityScore(
          subnet,
          subnetSurfaces,
          subnetCandidates,
        ),
        suggested_next_action: suggestedReviewAction(
          subnet,
          subnetSurfaces,
          subnetCandidates,
        ),
      };
    })
    .sort(
      (a, b) =>
        b.priority_score - a.priority_score ||
        b.candidate_count - a.candidate_count ||
        a.netuid - b.netuid,
    );

  const adapterCandidates = subnets
    .map((subnet) => {
      const subnetSurfaces = surfacesByNetuid.get(subnet.netuid) || [];
      const subnetCandidates = candidatesByNetuid.get(subnet.netuid) || [];
      const operationalKinds = subnetSurfaces.filter((surface) =>
        ["openapi", "subnet-api", "sse", "data-artifact"].includes(
          surface.kind,
        ),
      );
      const apiCandidates = subnetCandidates.filter((candidate) =>
        ["openapi", "subnet-api", "sse", "data-artifact"].includes(
          candidate.kind,
        ),
      );
      const operationalSurfaceIds = operationalKinds
        .map((surface) => surface.id)
        .sort();
      const apiCandidateIds = apiCandidates
        .map((candidate) => candidate.id)
        .sort();
      const operationalKindValues = [
        ...new Set(operationalKinds.map((surface) => surface.kind)),
      ].sort();
      return {
        netuid: subnet.netuid,
        slug: subnet.slug,
        name: subnet.name,
        curation_level: subnet.curation.level,
        operational_surface_count: operationalKinds.length,
        operational_kinds: operationalKindValues,
        operational_surface_ids: operationalSurfaceIds.slice(0, 12),
        candidate_api_count: apiCandidates.length,
        candidate_api_kinds: [
          ...new Set(apiCandidates.map((candidate) => candidate.kind)),
        ].sort(),
        candidate_api_ids: apiCandidateIds.slice(0, 12),
        recommended_adapter_kind: recommendedAdapterKind(
          subnet,
          operationalKindValues,
        ),
        reason_codes: adapterCandidateReasonCodes({
          apiCandidates,
          operationalKinds: operationalKindValues,
          subnet,
        }),
        suggested_next_action: adapterCandidateNextAction({
          apiCandidateCount: apiCandidates.length,
          curationLevel: subnet.curation.level,
          operationalKinds: operationalKindValues,
          operationalSurfaceCount: operationalKinds.length,
        }),
        priority_score: operationalKinds.length * 20 + subnet.surface_count,
      };
    })
    .filter(
      (candidate) =>
        candidate.operational_surface_count > 0 ||
        candidate.candidate_api_count > 0,
    )
    .sort((a, b) => b.priority_score - a.priority_score || a.netuid - b.netuid);

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    notes:
      "Backend curation review report. Machine-generated entries still need maintainer review before being treated as hand-curated truth.",
    summary: {
      subnet_count: subnets.length,
      needs_maintainer_review_count: subnets.filter(
        (subnet) => subnet.curation.review_state !== "maintainer-reviewed",
      ).length,
      maintainer_decision_count: reviewDecisionsDocument.decisions?.length || 0,
      adapter_candidate_count: adapterCandidates.length,
      gap_kind_counts: countGapKinds(subnets),
    },
    gap_priorities: gapPriorities,
    adapter_candidates: adapterCandidates,
    review_decisions: reviewDecisionsDocument.decisions || [],
  };
}

function adapterCandidateSummary(candidates) {
  return {
    candidate_count: candidates.length,
    by_curation_level: countBy(candidates, "curation_level"),
    by_recommended_adapter_kind: countBy(
      candidates,
      "recommended_adapter_kind",
    ),
    operational_kind_counts: countArrayValues(candidates, "operational_kinds"),
    candidate_api_kind_counts: countArrayValues(
      candidates,
      "candidate_api_kinds",
    ),
    adapter_backed_count: candidates.filter(
      (candidate) => candidate.curation_level === "adapter-backed",
    ).length,
    openapi_backed_count: candidates.filter((candidate) =>
      candidate.operational_kinds.includes("openapi"),
    ).length,
    sse_backed_count: candidates.filter((candidate) =>
      candidate.operational_kinds.includes("sse"),
    ).length,
    data_artifact_backed_count: candidates.filter((candidate) =>
      candidate.operational_kinds.includes("data-artifact"),
    ).length,
  };
}

function recommendedAdapterKind(subnet, operationalKinds) {
  if (subnet.curation.level === "adapter-backed") {
    return "custom-adapter";
  }
  if (operationalKinds.includes("openapi")) {
    return "generic-openapi-or-custom";
  }
  if (operationalKinds.includes("sse")) {
    return "stream-adapter";
  }
  if (operationalKinds.includes("data-artifact")) {
    return "data-artifact-adapter";
  }
  return "custom-adapter";
}

function adapterCandidateReasonCodes({
  apiCandidates,
  operationalKinds,
  subnet,
}) {
  return [
    ...(subnet.curation.level === "adapter-backed" ? ["existing-adapter"] : []),
    ...operationalKinds.map((kind) => `${kind}-surface`),
    ...(operationalKinds.length > 1 ? ["multiple-operational-kinds"] : []),
    ...(apiCandidates.length > 0 ? ["candidate-api-evidence"] : []),
  ].sort();
}

function adapterCandidateNextAction({
  apiCandidateCount,
  curationLevel,
  operationalKinds,
  operationalSurfaceCount,
}) {
  if (curationLevel === "adapter-backed") {
    return "maintain and deepen existing adapter metrics";
  }
  if (operationalKinds.includes("openapi")) {
    return "snapshot schema shape and consider normalized metrics from stable read-only operations";
  }
  if (operationalKinds.includes("sse")) {
    return "evaluate stream freshness and event-shape metrics";
  }
  if (operationalKinds.includes("data-artifact")) {
    return "evaluate data-artifact freshness and schema normalization";
  }
  if (operationalSurfaceCount > 0 || apiCandidateCount > 0) {
    return "review public-safe API evidence before adding a custom adapter";
  }
  return "collect official operational interface evidence first";
}

function countArrayValues(items, key) {
  const counts = {};
  for (const item of items) {
    for (const value of item[key] || []) {
      counts[value] = (counts[value] || 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildSchemaDriftPlaceholder(surfaces) {
  const openapiSurfaces = surfaces.filter(
    (surface) => surface.kind === "openapi",
  );
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: "artifact-build",
    status: "not-snapshotted",
    notes:
      "Run npm run schemas:snapshot to fetch machine-readable OpenAPI/Swagger JSON and update drift status.",
    openapi_surface_count: openapiSurfaces.length,
    schema_backed_surface_count: openapiSurfaces.filter(
      (surface) => surface.schema_url,
    ).length,
    surfaces: openapiSurfaces.map((surface) => ({
      netuid: surface.netuid,
      subnet_slug: surface.subnet_slug,
      surface_id: surface.id,
      url: surface.url,
      schema_url: surface.schema_url || null,
      drift_status: "not-captured",
      hash: null,
      previous_hash: null,
      error: null,
      status: surface.schema_url
        ? "pending-snapshot"
        : "ui-only-or-undiscovered",
    })),
  };
}

function reusableSchemaDriftArtifact(surfaces, previous) {
  if (
    !previous ||
    previous.source !== "openapi-snapshot" ||
    !schemaSnapshotTimestamp(previous)
  ) {
    return null;
  }
  const currentIds = openApiSurfaceIds(surfaces);
  const previousIds = (previous.surfaces || [])
    .map((surface) => surface.surface_id)
    .sort();
  if (!sameStringSet(currentIds, previousIds)) {
    return null;
  }
  return previous;
}

function reusableSchemaIndexArtifact(surfaces, previous) {
  if (
    !previous ||
    previous.source !== "openapi-snapshot" ||
    !schemaSnapshotTimestamp(previous)
  ) {
    return null;
  }
  const currentIds = openApiSurfaceIds(surfaces);
  const previousIds = (previous.schemas || [])
    .map((schema) => schema.surface_id)
    .sort();
  if (!sameStringSet(currentIds, previousIds)) {
    return null;
  }
  return previous;
}

function buildSchemaIndexPlaceholder() {
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: "artifact-build",
    notes:
      "Run npm run schemas:snapshot to capture machine-readable OpenAPI/Swagger schema snapshots.",
    schemas: [],
  };
}

function openApiSurfaceIds(surfaces) {
  return surfaces
    .filter((surface) => surface.kind === "openapi")
    .map((surface) => surface.id)
    .sort();
}

function sameStringSet(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function buildSearchIndex(
  subnets,
  surfacesForIndex,
  providerList,
  profilesByNetuid = new Map(),
) {
  const documents = [
    ...subnets.map((subnet) => {
      const profile = profilesByNetuid.get(subnet.netuid);
      return {
        id: `subnet:${subnet.netuid}`,
        type: "subnet",
        netuid: subnet.netuid,
        slug: subnet.slug,
        title: subnet.name,
        subtitle: `SN${subnet.netuid} ${subnet.symbol || ""}`.trim(),
        url: `/subnets/${subnet.netuid}`,
        artifact_path: `/metagraph/subnets/${subnet.netuid}.json`,
        tokens: compactTokens([
          subnet.name,
          subnet.slug,
          subnet.symbol,
          subnet.categories?.join(" "),
          nativeIdentityTokenText(profile?.native_identity),
        ]),
      };
    }),
    ...surfacesForIndex.map((surface) => ({
      id: `surface:${surface.id}`,
      type: "surface",
      netuid: surface.netuid,
      slug: surface.subnet_slug,
      title: surface.name,
      subtitle: `${surface.kind} / ${surface.provider}`,
      url: surface.url,
      artifact_path: "/metagraph/surfaces.json",
      tokens: compactTokens([
        surface.name,
        surface.kind,
        surface.provider,
        surface.subnet_name,
        surface.subnet_slug,
      ]),
    })),
    ...providerList.map((provider) => ({
      id: `provider:${provider.id}`,
      type: "provider",
      title: provider.name,
      subtitle: provider.kind,
      url: provider.website_url,
      artifact_path: "/metagraph/providers.json",
      tokens: compactTokens([
        provider.name,
        provider.id,
        provider.kind,
        provider.authority,
      ]),
    })),
  ].sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      String(a.title).localeCompare(String(b.title)) ||
      a.id.localeCompare(b.id),
  );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    document_count: documents.length,
    documents,
  };
}

function nativeIdentityTokenText(identity) {
  if (!identity || typeof identity !== "object") {
    return "";
  }
  return [
    identity.subnet_name,
    identity.description,
    identity.additional,
    identity.website_url,
    identity.github_url,
    identity.discord_url,
    identity.logo_url,
  ]
    .filter(Boolean)
    .join(" ");
}

function compactTokens(values) {
  return [
    ...new Set(
      values
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    ),
  ].sort();
}

function buildFreshnessArtifact({
  adapterSnapshots: snapshots,
  candidateDiscovery,
  generatedAt: timestamp,
  healthArtifacts: health,
  nativeSnapshot: native,
  previousFreshness,
  schemaDrift,
  verification: verificationArtifact,
}) {
  const adapterRows = [...snapshots.values()].map((snapshot) => {
    const capturedAt = latestTimestamp([
      snapshot.generated_at,
      ...Object.values(snapshot.dimensions || {}).map(
        (dimension) => dimension?.captured_at,
      ),
    ]);
    return {
      as_of: capturedAt || snapshot.generated_at || null,
      generated_at: snapshot.generated_at,
      slug: snapshot.slug,
      status: snapshot.status,
    };
  });
  const candidateDiscoveryAsOf =
    nonPlaceholderTimestamp(process.env.METAGRAPH_DISCOVERY_OBSERVED_AT) ||
    nonPlaceholderTimestamp(candidateDiscovery?.observed_at) ||
    nonPlaceholderTimestamp(candidateDiscovery?.discovered_at) ||
    nonPlaceholderTimestamp(candidateDiscovery?.generated_at) ||
    null;
  const verificationAsOf =
    nonPlaceholderTimestamp(verificationArtifact.observed_at) ||
    verificationArtifact.verification_finished_at ||
    nonPlaceholderTimestamp(verificationArtifact.generated_at) ||
    previousFreshness?.sources?.find(
      (source) => source.id === "candidate-verification",
    )?.as_of ||
    previousFreshness?.summary?.verification_as_of ||
    null;
  const healthProbeAsOf =
    health.latest.source === "live-smoke-probe"
      ? health.latest.probe_finished_at ||
        nonPlaceholderTimestamp(health.latest.generated_at) ||
        null
      : null;
  const adapterSnapshotAsOf = latestTimestamp(
    adapterRows.map((row) => row.as_of),
  );
  const schemaSnapshotAsOf = schemaSnapshotTimestamp(schemaDrift);
  const sources = [
    freshnessSource({
      asOf: native.captured_at,
      id: "native-subnets",
      lane: "native-data",
      pathValue: "registry/native/finney-subnets.json",
      requiredForPublish: true,
      staleAfterHours: 24,
      timestampField: "native_data_as_of",
    }),
    freshnessSource({
      asOf: candidateDiscoveryAsOf,
      id: "candidate-discovery",
      lane: "candidate-discovery",
      pathValue: "registry/candidates/generated/public-sources.json",
      requiredForPublish: true,
      staleAfterHours: 24,
      status: candidateDiscoveryAsOf ? "captured" : null,
      timestampField: "candidate_discovery_as_of",
    }),
    freshnessSource({
      asOf: verificationAsOf,
      id: "candidate-verification",
      lane: "candidate-verification",
      pathValue: "registry/verification/promotions.json",
      requiredForPublish: true,
      staleAfterHours: 24,
      timestampField: "verification_as_of",
    }),
    freshnessSource({
      asOf: healthProbeAsOf,
      id: "surface-health",
      lane: "health-probe",
      notes:
        health.latest.source === "live-smoke-probe"
          ? "Observed health is probe-derived."
          : "Run probes with METAGRAPH_WRITE_PROBE_RESULTS=1 before production publish.",
      pathValue: "public/metagraph/health/latest.json",
      requiredForPublish: true,
      staleAfterHours: 6,
      status: health.latest.source === "live-smoke-probe" ? "captured" : null,
      staleBehavior: "block",
      timestampField: "health_probe_as_of",
    }),
    freshnessSource({
      asOf: adapterSnapshotAsOf,
      id: "adapter-snapshots",
      lane: "adapter-snapshot",
      pathValue: "registry/adapters/latest",
      requiredForPublish: true,
      staleAfterHours: 12,
      timestampField: "adapter_snapshot_as_of",
    }),
    freshnessSource({
      asOf: schemaSnapshotAsOf,
      id: "schema-drift",
      lane: "schema-snapshot",
      notes:
        "Schema drift snapshots are warning-only until more subnets publish machine-readable schemas.",
      pathValue: "public/metagraph/schema-drift.json",
      requiredForPublish: false,
      staleAfterHours: 168,
      staleBehavior: "warn",
      timestampField: "schema_snapshot_as_of",
    }),
    ...adapterRows.map((row) =>
      freshnessSource({
        asOf: row.as_of,
        id: `adapter:${row.slug}`,
        lane: "adapter-snapshot",
        pathValue: `registry/adapters/latest/${row.slug}.json`,
        requiredForPublish: false,
        staleAfterHours: 12,
        status: row.status,
        staleBehavior: "warn",
      }),
    ),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const blockingSources = sources.filter(
    (source) => source.stale_behavior === "block",
  );
  const missingBlockingSources = blockingSources.filter(
    (source) => source.status === "missing",
  );
  const warningSources = sources.filter(
    (source) => source.stale_behavior === "warn",
  );
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: timestamp,
    summary: {
      adapter_count: adapterRows.length,
      adapter_snapshot_as_of: adapterSnapshotAsOf,
      blocking_source_count: blockingSources.length,
      candidate_discovery_as_of: candidateDiscoveryAsOf,
      health_surface_count: health.latest.surfaces.length,
      health_probe_as_of: healthProbeAsOf,
      missing_blocking_source_count: missingBlockingSources.length,
      native_snapshot_captured_at: native.captured_at,
      native_data_as_of: native.captured_at,
      openapi_surface_count:
        schemaDrift.openapi_surface_count ||
        schemaDrift.summary?.surface_count ||
        0,
      publish_ready_without_age_check: missingBlockingSources.length === 0,
      schema_snapshot_as_of: schemaSnapshotAsOf,
      stale_window_warnings: sources
        .filter((source) => source.status === "missing")
        .map(
          (source) =>
            `${source.id} has no observed timestamp; ${source.stale_behavior === "block" ? "production publish should block" : "review before relying on this lane"}.`,
        ),
      verification_as_of: verificationAsOf,
      verification_generated_at: verificationArtifact.generated_at || null,
      warning_source_count: warningSources.length,
    },
    sources,
  };
}

function freshnessSource({
  asOf,
  id,
  lane,
  notes = "",
  pathValue,
  requiredForPublish,
  staleAfterHours,
  staleBehavior = requiredForPublish ? "block" : "warn",
  status = null,
  timestampField = null,
}) {
  const timestamp = asOf || null;
  return {
    as_of: timestamp,
    id,
    lane,
    notes,
    path: pathValue,
    required_for_publish: requiredForPublish,
    stale_after_hours: staleAfterHours,
    stale_behavior: staleBehavior,
    status: status || (timestamp ? "captured" : "missing"),
    timestamp,
    timestamp_field: timestampField,
  };
}

function schemaSnapshotTimestamp(value) {
  return (
    nonPlaceholderTimestamp(value?.observed_at) ||
    nonPlaceholderTimestamp(value?.generated_at) ||
    null
  );
}

function nonPlaceholderTimestamp(value) {
  if (!value || value === "1970-01-01T00:00:00.000Z") {
    return null;
  }
  return value;
}

function buildFullVerificationArtifact(
  verificationArtifact,
  { contractVersion, generatedAt },
) {
  const results = (verificationArtifact.results || []).filter(
    isFullVerificationResult,
  );
  return {
    ...verificationArtifact,
    schema_version: verificationArtifact.schema_version || 1,
    contract_version: verificationArtifact.contract_version || contractVersion,
    generated_at: verificationArtifact.generated_at || generatedAt,
    candidate_count: results.length,
    results,
  };
}

function fullVerificationResultOrNull(result) {
  return isFullVerificationResult(result) ? result : null;
}

function isFullVerificationResult(result) {
  return Boolean(
    result &&
    result.candidate_id &&
    result.classification &&
    result.status &&
    result.url &&
    result.verified_at,
  );
}

function latestTimestamp(values) {
  const parsed = values
    .map(nonPlaceholderTimestamp)
    .filter(Boolean)
    .map((value) => {
      const time = Date.parse(value);
      return Number.isFinite(time) ? { time, value } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.time - a.time);
  return parsed[0]?.value || null;
}

function buildSourceHealthArtifact({
  candidates: candidateRows,
  endpointResources: endpointArtifact,
  providers: providerRows,
  rpcEndpoints: rpcArtifact,
  verification: verificationArtifact,
}) {
  const verificationResults = verificationArtifact.results || [];
  const candidatesByProvider = countBy(
    candidateRows,
    (candidate) => candidate.provider || "unknown",
  );
  const verificationByProvider = verificationResults.reduce(
    (accumulator, result) => {
      const candidate = candidateRows.find(
        (row) => row.id === result.candidate_id,
      );
      const provider = candidate?.provider || "unknown";
      const row = accumulator.get(provider) || {
        provider,
        classifications: {},
        result_count: 0,
      };
      row.result_count += 1;
      row.classifications[result.classification || "unknown"] =
        (row.classifications[result.classification || "unknown"] || 0) + 1;
      accumulator.set(provider, row);
      return accumulator;
    },
    new Map(),
  );

  const providers = providerRows
    .map((provider) => {
      const verificationSummary = verificationByProvider.get(provider.id) || {
        classifications: {},
        result_count: 0,
      };
      const rpcCount = (rpcArtifact.endpoints || []).filter(
        (endpoint) => endpoint.provider === provider.id,
      ).length;
      const endpointCount = (endpointArtifact.endpoints || []).filter(
        (endpoint) => endpoint.provider === provider.id,
      ).length;
      return {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        authority: provider.authority,
        candidate_count: candidatesByProvider[provider.id] || 0,
        endpoint_count: endpointCount,
        verification_result_count: verificationSummary.result_count,
        classifications: verificationSummary.classifications,
        rpc_endpoint_count: rpcCount,
        status: sourceStatus(verificationSummary.classifications, rpcCount),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: "generated-provider-and-verification-summary",
    summary: {
      provider_count: providers.length,
      candidate_count: candidateRows.length,
      endpoint_count: endpointArtifact.endpoints?.length || 0,
      verification_result_count: verificationResults.length,
      rpc_endpoint_count: rpcArtifact.endpoints?.length || 0,
      status_counts: countBy(providers, "status"),
    },
    providers,
  };
}

function sourceStatus(classifications, rpcCount) {
  const live = (classifications.live || 0) + (classifications.redirected || 0);
  const degraded =
    (classifications["rate-limited"] || 0) +
    (classifications.transient || 0) +
    (classifications.timeout || 0);
  const dead = (classifications.dead || 0) + (classifications.unsafe || 0);
  if (live > 0 || rpcCount > 0) {
    return degraded > live ? "degraded" : "ok";
  }
  if (degraded > 0) {
    return "degraded";
  }
  if (dead > 0) {
    return "failed";
  }
  return "unknown";
}

function buildEvidenceLedger({
  candidates: candidateRows,
  generatedAt: timestamp,
  subnets,
  surfaces: surfaceRows,
}) {
  const subnetClaims = subnets.map((subnet) => ({
    claim: `SN${subnet.netuid} is an active ${subnet.subnet_type} netuid on Finney.`,
    confidence: "high",
    limits:
      "Native chain state is canonical for active existence only; off-chain interfaces come from overlays and candidates.",
    source_tier: "native-chain",
    source_type: "bittensor-sdk",
    source_url: "registry/native/finney-subnets.json",
    subject: `subnet:${subnet.netuid}`,
    support_summary: `Captured from native snapshot at block ${subnet.block}.`,
    verified_at: timestamp,
  }));

  const surfaceClaims = surfaceRows.map((surface) => ({
    claim: `${surface.name} is a public ${surface.kind} surface for SN${surface.netuid}.`,
    confidence:
      surface.authority === "official"
        ? "high"
        : surface.authority === "registry-observed"
          ? "medium"
          : "medium",
    limits: surface.auth_required
      ? "Surface is public metadata but requires authentication for access."
      : "Surface was recorded as public-safe; availability is tracked by health probes.",
    source_tier:
      surface.authority === "official" ? "provider-claimed" : "community-docs",
    source_type: surface.authority,
    source_url: surface.source_urls?.[0] || surface.url,
    subject: `surface:${surface.id}`,
    support_summary: `Listed in curated overlay for ${surface.subnet_slug}.`,
    verified_at: surface.verification?.verified_at || timestamp,
  }));

  const candidateClaims = candidateRows.slice(0, 250).map((candidate) => ({
    claim: `${candidate.name} is a candidate ${candidate.kind} surface for SN${candidate.netuid}.`,
    confidence: candidate.confidence || "low",
    limits:
      "Candidate records are discovery leads and are not promoted registry truth until verification and maintainer review.",
    source_tier: candidate.source_tier || "community-docs",
    source_type: candidate.source_type || "candidate-discovery",
    source_url: candidate.source_url,
    subject: `candidate:${candidate.id}`,
    support_summary:
      candidate.review_notes || "Discovered from public source metadata.",
    verified_at: candidate.verification?.verified_at || timestamp,
  }));

  const claims = [...subnetClaims, ...surfaceClaims, ...candidateClaims].sort(
    (a, b) => a.subject.localeCompare(b.subject),
  );
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: timestamp,
    notes:
      "Evidence ledger uses public source URLs and generated registry provenance only. Candidate entries are capped to keep the public artifact compact.",
    summary: {
      candidate_claim_count: candidateClaims.length,
      claim_count: claims.length,
      subnet_claim_count: subnetClaims.length,
      surface_claim_count: surfaceClaims.length,
    },
    claims,
  };
}

function buildR2Manifest({ artifactSizes, generatedAt: timestamp }) {
  const version = timestamp.replace(/[:.]/g, "-");
  const artifacts = artifactSizes.map((artifact) => ({
    content_type: "application/json",
    key: `runs/${version}/${artifact.path}`,
    latest_key: `latest/${artifact.path}`,
    path: `/metagraph/${artifact.path}`,
    sha256: artifact.sha256,
    size_bytes: artifact.size_bytes,
    storage_tier: artifact.storage_tier,
  }));
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: timestamp,
    bucket_binding: "METAGRAPH_ARCHIVE",
    bucket_name: "metagraphed-artifacts",
    history_policy: {
      canonical_latest_in_repo: true,
      large_history_in_r2: true,
      source_of_truth: "github-reviewed-artifacts",
      versioned_run_prefix: `runs/${version}/`,
    },
    latest_prefix: "latest/",
    run_prefix: `runs/${version}/`,
    artifact_count: artifacts.length,
    artifact_size_bytes: artifacts.reduce(
      (sum, artifact) => sum + artifact.size_bytes,
      0,
    ),
    artifacts,
  };
}

async function buildSourceSnapshots({
  adapterSnapshots: snapshots,
  candidates: candidateRows,
  generatedAt: timestamp,
  nativeSnapshot: native,
  overlays: subnetOverlays,
  providers: providerRows,
  reviewDecisions: decisions,
  verification: verificationArtifact,
}) {
  const sourceRows = [
    sourceSnapshot(
      "native-subnets",
      "native-chain",
      "registry/native/finney-subnets.json",
      native,
      native.subnets?.length || 0,
      native.captured_at,
    ),
    sourceSnapshot(
      "providers",
      "registry-manifest",
      "registry/providers",
      providerRows,
      providerRows.length,
      timestamp,
    ),
    sourceSnapshot(
      "subnet-overlays",
      "registry-manifest",
      "registry/subnets",
      subnetOverlays,
      subnetOverlays.length,
      timestamp,
    ),
    sourceSnapshot(
      "candidate-surfaces",
      "candidate-discovery",
      "registry/candidates",
      candidateRows,
      candidateRows.length,
      timestamp,
    ),
    sourceSnapshot(
      "candidate-verification",
      "probe-results",
      "registry/verification/promotions.json",
      verificationArtifact,
      verificationArtifact.results?.length || 0,
      verificationArtifact.generated_at || timestamp,
    ),
    sourceSnapshot(
      "maintainer-decisions",
      "review-ledger",
      "registry/reviews/maintainer-reviewed.json",
      decisions,
      decisions.decisions?.length || 0,
      decisions.generated_at || timestamp,
    ),
    ...[...snapshots.entries()].map(([slug, snapshot]) =>
      sourceSnapshot(
        `adapter:${slug}`,
        "adapter-snapshot",
        `registry/adapters/latest/${slug}.json`,
        snapshot,
        Object.keys(snapshot.dimensions || {}).length,
        snapshot.generated_at || timestamp,
      ),
    ),
  ].sort((a, b) => a.id.localeCompare(b.id));

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: timestamp,
    notes:
      "Compact source-input hashes for public artifact reproducibility. These are not raw private snapshots and contain no secrets or credentialed data.",
    summary: {
      source_count: sourceRows.length,
      provider_count: providerRows.length,
      overlay_count: subnetOverlays.length,
      candidate_count: candidateRows.length,
      verification_result_count: verificationArtifact.results?.length || 0,
      adapter_snapshot_count: snapshots.size,
    },
    sources: sourceRows,
  };
}

function sourceSnapshot(id, kind, sourcePath, value, recordCount, capturedAt) {
  return {
    id,
    kind,
    path: sourcePath,
    captured_at: capturedAt || null,
    record_count: recordCount,
    hash: hashJson(value),
  };
}

function buildChangelog({
  currentArtifacts,
  currentCoverage,
  currentSubnets,
  generatedAt: timestamp,
  previousArtifacts,
  previousCoverage,
  previousSubnets,
}) {
  const previousMap = new Map(
    previousArtifacts.map((artifact) => [artifact.path, artifact]),
  );
  const currentMap = new Map(
    currentArtifacts.map((artifact) => [artifact.path, artifact]),
  );
  const addedArtifacts = currentArtifacts.filter(
    (artifact) => !previousMap.has(artifact.path),
  );
  const removedArtifacts = previousArtifacts.filter(
    (artifact) => !currentMap.has(artifact.path),
  );
  const modifiedArtifacts = currentArtifacts.filter((artifact) => {
    const previous = previousMap.get(artifact.path);
    return previous && previous.hash !== artifact.hash;
  });

  const subnetChanges = diffSubnets(
    previousSubnets?.subnets || [],
    currentSubnets.subnets || [],
  );
  const coverageDelta = previousCoverage
    ? {
        candidate_count: delta(
          previousCoverage.candidate_count,
          currentCoverage.candidate_count,
        ),
        curated_overlay_count: delta(
          previousCoverage.curated_overlay_count,
          currentCoverage.curated_overlay_count,
        ),
        native_only_count: delta(
          previousCoverage.native_only_count,
          currentCoverage.native_only_count,
        ),
        provider_count: null,
        surface_count: delta(
          previousCoverage.surface_count,
          currentCoverage.surface_count,
        ),
      }
    : null;

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: timestamp,
    source: "generated-artifact-diff",
    notes: [
      "This changelog compares the latest generated artifacts against the previous checked-in public artifact state before the build.",
      "Long-term historical runs are expected to live in R2 under versioned prefixes.",
    ],
    summary: {
      artifact_added_count: addedArtifacts.length,
      artifact_modified_count: modifiedArtifacts.length,
      artifact_removed_count: removedArtifacts.length,
      netuid_added_count: subnetChanges.added.length,
      netuid_removed_count: subnetChanges.removed.length,
      netuid_renamed_count: subnetChanges.renamed.length,
      coverage_delta: coverageDelta,
    },
    artifacts: {
      added: addedArtifacts.slice(0, 250),
      modified: modifiedArtifacts.slice(0, 250),
      removed: removedArtifacts.slice(0, 250),
    },
    subnets: subnetChanges,
  };
}

function diffSubnets(previousSubnets, currentSubnets) {
  const previousByNetuid = new Map(
    previousSubnets.map((subnet) => [subnet.netuid, subnet]),
  );
  const currentByNetuid = new Map(
    currentSubnets.map((subnet) => [subnet.netuid, subnet]),
  );
  const added = currentSubnets
    .filter((subnet) => !previousByNetuid.has(subnet.netuid))
    .map((subnet) => ({
      netuid: subnet.netuid,
      name: subnet.name,
      slug: subnet.slug,
    }));
  const removed = previousSubnets
    .filter((subnet) => !currentByNetuid.has(subnet.netuid))
    .map((subnet) => ({
      netuid: subnet.netuid,
      name: subnet.name,
      slug: subnet.slug,
    }));
  const renamed = currentSubnets
    .filter(
      (subnet) =>
        previousByNetuid.has(subnet.netuid) &&
        previousByNetuid.get(subnet.netuid).name !== subnet.name,
    )
    .map((subnet) => ({
      netuid: subnet.netuid,
      before: previousByNetuid.get(subnet.netuid).name,
      after: subnet.name,
    }));

  return { added, removed, renamed };
}

function delta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return null;
  }
  return {
    before,
    after,
    delta: after - before,
  };
}

function artifactFile(relativePath) {
  const tier = artifactStorageTierForRelativePath(relativePath);
  return path.join(tier === "r2" ? r2OutputRoot : outputRoot, relativePath);
}

function r2ArtifactDir(relativePath) {
  return path.join(r2OutputRoot, relativePath);
}

function schemaDetailArtifactPath(entry) {
  const relativePath = String(entry.path || "")
    .replace(/^\/+metagraph\//, "")
    .replace(/^\/+/, "");
  if (!relativePath || relativePath === "schemas/index.json") {
    return null;
  }
  return relativePath;
}

async function collectArtifactDigests({
  includeR2Root = true,
  previousManifest,
  publicRoot,
  r2Root,
}) {
  const files = [];
  await collectArtifactFiles(
    { includeR2Root, publicRoot, r2Root },
    async (filePath, root) => {
      if (!filePath.endsWith(".json")) {
        return;
      }
      const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
      if (
        ["build-summary.json", "changelog.json", "r2-manifest.json"].includes(
          relativePath,
        )
      ) {
        return;
      }
      const raw = await fs.readFile(filePath);
      files.push({
        path: relativePath,
        hash: sha256Hex(raw),
      });
    },
  );

  for (const artifact of previousManifest?.artifacts || []) {
    const relativePath = artifact.path?.replace(/^\/metagraph\//, "");
    if (
      artifact.storage_tier !== "r2" ||
      !relativePath ||
      !artifact.sha256 ||
      files.some((file) => file.path === relativePath)
    ) {
      continue;
    }
    files.push({
      path: relativePath,
      hash: artifact.sha256,
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function collectArtifactSizes({ publicRoot, r2Root }) {
  const files = [];
  await collectArtifactFiles({ publicRoot, r2Root }, async (filePath, root) => {
    if (!filePath.endsWith(".json")) {
      return;
    }
    const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
    if (["build-summary.json", "r2-manifest.json"].includes(relativePath)) {
      return;
    }
    const raw = await fs.readFile(filePath);
    const stat = await fs.stat(filePath);
    files.push({
      path: relativePath,
      sha256: sha256Hex(raw),
      size_bytes: stat.size,
      storage_tier: artifactStorageTierForRelativePath(relativePath),
    });
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function countByStorageTier(artifacts) {
  return artifacts.reduce((counts, artifact) => {
    counts[artifact.storage_tier] = (counts[artifact.storage_tier] || 0) + 1;
    return counts;
  }, {});
}

function sumBytesByStorageTier(artifacts) {
  return artifacts.reduce((counts, artifact) => {
    counts[artifact.storage_tier] =
      (counts[artifact.storage_tier] || 0) + artifact.size_bytes;
    return counts;
  }, {});
}

async function collectArtifactFiles(
  { includeR2Root = true, publicRoot, r2Root },
  onFile,
) {
  await walkIfExists(publicRoot, async (filePath) => {
    const relativePath = path
      .relative(publicRoot, filePath)
      .replace(/\\/g, "/");
    if (artifactStorageTierForRelativePath(relativePath) === "r2") {
      return;
    }
    await onFile(filePath, publicRoot);
  });
  if (includeR2Root) {
    await walkIfExists(r2Root, async (filePath) => onFile(filePath, r2Root));
  }
}

async function loadAdapterSnapshots() {
  const files = await listJsonFilesRecursive(
    path.join(repoRoot, "registry/adapters/latest"),
  );
  const snapshots = await Promise.all(files.map(readJson));
  return new Map(snapshots.map((snapshot) => [snapshot.slug, snapshot]));
}

async function loadReviewDecisions() {
  try {
    return await readJson(
      path.join(repoRoot, "registry/reviews/maintainer-reviewed.json"),
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        schema_version: 1,
        generated_at: generatedAt,
        decisions: [],
      };
    }
    throw error;
  }
}

async function walkIfExists(dirPath, onFile) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkIfExists(entryPath, onFile);
    } else if (entry.isFile()) {
      await onFile(entryPath);
    }
  }
}

function reviewPriorityScore(subnet, surfacesForSubnet, candidatesForSubnet) {
  const missingKinds = subnet.gaps.missing_kinds || [];
  const highValueMissing = missingKinds.filter((kind) =>
    ["source-repo", "docs", "website", "openapi", "subnet-api"].includes(kind),
  );
  const adapterBonus =
    surfacesForSubnet.filter((surface) =>
      ["openapi", "subnet-api", "sse", "data-artifact"].includes(surface.kind),
    ).length * 8;
  const machineReviewPenalty =
    subnet.curation.review_state === "maintainer-reviewed" ? -25 : 20;
  return (
    highValueMissing.length * 12 +
    candidatesForSubnet.length +
    adapterBonus +
    machineReviewPenalty
  );
}

function suggestedReviewAction(subnet, surfacesForSubnet, candidatesForSubnet) {
  if (
    subnet.curation.review_state !== "maintainer-reviewed" &&
    surfacesForSubnet.length > 0
  ) {
    return "review promoted surfaces and mark maintainer-reviewed where provenance is strong";
  }
  if (
    (subnet.gaps.missing_kinds || []).includes("source-repo") &&
    candidatesForSubnet.length > 0
  ) {
    return "inspect source-repo/docs candidates for official provenance";
  }
  if (
    surfacesForSubnet.some((surface) =>
      ["openapi", "subnet-api", "sse"].includes(surface.kind),
    )
  ) {
    return "evaluate for subnet-specific adapter";
  }
  return "keep baseline entry and wait for public-source or community intake";
}

function countGapKinds(subnets) {
  return Object.fromEntries(
    Object.entries(
      subnets.reduce((accumulator, subnet) => {
        for (const kind of subnet.gaps.missing_kinds || []) {
          accumulator[kind] = (accumulator[kind] || 0) + 1;
        }
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function classifySubnetStatus({
  okCount,
  failedCount,
  unknownCount,
  degradedCount,
  surfaceCount,
}) {
  if (surfaceCount === 0 || unknownCount === surfaceCount) {
    return "unknown";
  }
  if (failedCount === 0 && degradedCount === 0) {
    return "ok";
  }
  if (okCount > 0 || degradedCount > 0) {
    return "degraded";
  }
  return "failed";
}

function badgeColor(status) {
  return (
    {
      ok: "brightgreen",
      degraded: "yellow",
      failed: "red",
      unknown: "lightgrey",
    }[status] || "lightgrey"
  );
}

function latestString(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function average(values) {
  if (values.length === 0) {
    return null;
  }
  return Math.round(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}
