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
const verification = redactCredentialedUrls(await loadVerification());
const adapterSnapshots = await loadAdapterSnapshots();
const reviewDecisions = await loadReviewDecisions();
const nativeSnapshot = await loadNativeSnapshot();
const overlayByNetuid = new Map(
  overlays.map((overlay) => [overlay.netuid, overlay]),
);
const chainSubnets = nativeSnapshot.subnets;
const candidatesByNetuid = groupByNetuid(candidates);
const verificationByCandidate = new Map(
  (verification.results || []).map((result) => [result.candidate_id, result]),
);
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
const previousR2ManifestArtifact = await readOptionalJson(
  path.join(outputRoot, "r2-manifest.json"),
);
const previousArtifactDigests = await collectArtifactDigests({
  includeR2Root: false,
  previousManifest: previousR2ManifestArtifact,
  publicRoot: outputRoot,
  r2Root: r2OutputRoot,
});
const previousSubnetsArtifact = await readOptionalJson(
  path.join(outputRoot, "subnets.json"),
);
const previousCoverageArtifact = await readOptionalJson(
  path.join(outputRoot, "coverage.json"),
);
const previousHealthArtifact = await loadPreviousHealthArtifact();

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
const schemaDriftPlaceholder = buildSchemaDriftPlaceholder(surfaces);
const contracts = buildContractsArtifact(generatedAt);
const openApi = await buildCanonicalOpenApiArtifact(generatedAt);

const adapterArtifacts = Object.fromEntries(
  activeOverlays
    .filter((subnet) => subnet.extensions)
    .map((subnet) => [
      subnet.slug,
      {
        schema_version: 1,
        generated_at: generatedAt,
        netuid: subnet.netuid,
        subnet: subnet.name,
        slug: subnet.slug,
        extensions: subnet.extensions,
        snapshot: adapterSnapshots.get(subnet.slug) || null,
      },
    ]),
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
    verificationByCandidate.get(candidate.id) || candidate.verification || null,
  subnet_name:
    nativeSnapshot.subnets.find((subnet) => subnet.netuid === candidate.netuid)
      ?.name || null,
}));

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
}

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

await writeJson(artifactFile("verification/latest.json"), {
  ...verification,
  generated_at: verification.generated_at || generatedAt,
});
await fs.rm(r2ArtifactDir("verification/subnets"), {
  recursive: true,
  force: true,
});
for (const subnet of mergedSubnets) {
  const results = (verification.results || []).filter(
    (result) => result.netuid === subnet.netuid,
  );
  await writeJson(artifactFile(`verification/subnets/${subnet.netuid}.json`), {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: verification.generated_at || generatedAt,
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
  buildSearchIndex(mergedSubnets, surfaces, providers),
);
await writeJson(
  artifactFile("freshness.json"),
  buildFreshnessArtifact({
    adapterSnapshots,
    generatedAt,
    healthArtifacts,
    nativeSnapshot,
    schemaDrift: schemaDriftPlaceholder,
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
await writeJson(artifactFile("schema-drift.json"), schemaDriftPlaceholder);
await writeJson(artifactFile("schemas/index.json"), {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  source: "artifact-build",
  notes:
    "Run npm run schemas:snapshot to capture machine-readable OpenAPI/Swagger schema snapshots.",
  schemas: [],
});
await writeJson(artifactFile("review/curation.json"), curationReview);
await writeJson(artifactFile("review/gap-priorities.json"), {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  priorities: curationReview.gap_priorities,
});
await writeJson(artifactFile("review/adapter-candidates.json"), {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  candidates: curationReview.adapter_candidates,
});
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
const artifactBudgets = evaluateArtifactBudgets(artifactSizes);
await writeJson(artifactFile("build-summary.json"), {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  adapter_count: Object.keys(adapterArtifacts).length,
  artifact_count: artifactSizes.length,
  artifact_size_bytes: artifactSizes.reduce(
    (sum, artifact) => sum + artifact.size_bytes,
    0,
  ),
  artifacts: artifactSizes.slice(0, 250),
  artifact_budget_summary: summarizeArtifactBudgets(artifactBudgets),
  artifact_budgets: artifactBudgets
    .filter((budget) => budget.status !== "ok")
    .sort(
      (a, b) => b.size_bytes - a.size_bytes || a.path.localeCompare(b.path),
    ),
  candidate_count: candidates.length,
  coverage,
  endpoint_count: endpointResources.endpoints.length,
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

function groupByNetuid(items) {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.netuid) || [];
    group.push(item);
    groups.set(item.netuid, group);
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
      const operationalKinds = subnetSurfaces.filter((surface) =>
        ["openapi", "subnet-api", "sse", "data-artifact"].includes(
          surface.kind,
        ),
      );
      return {
        netuid: subnet.netuid,
        slug: subnet.slug,
        name: subnet.name,
        curation_level: subnet.curation.level,
        operational_surface_count: operationalKinds.length,
        operational_kinds: [
          ...new Set(operationalKinds.map((surface) => surface.kind)),
        ].sort(),
        candidate_api_count: (
          candidatesByNetuid.get(subnet.netuid) || []
        ).filter((candidate) =>
          ["openapi", "subnet-api", "sse", "data-artifact"].includes(
            candidate.kind,
          ),
        ).length,
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

function buildSearchIndex(subnets, surfacesForIndex, providerList) {
  const documents = [
    ...subnets.map((subnet) => ({
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
      ]),
    })),
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
  generatedAt: timestamp,
  healthArtifacts: health,
  nativeSnapshot: native,
  schemaDrift,
  verification: verificationArtifact,
}) {
  const adapterRows = [...snapshots.values()].map((snapshot) => ({
    generated_at: snapshot.generated_at,
    slug: snapshot.slug,
    status: snapshot.status,
  }));
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: timestamp,
    summary: {
      adapter_count: adapterRows.length,
      health_surface_count: health.latest.surfaces.length,
      native_snapshot_captured_at: native.captured_at,
      openapi_surface_count:
        schemaDrift.openapi_surface_count ||
        schemaDrift.summary?.surface_count ||
        0,
      verification_generated_at: verificationArtifact.generated_at || null,
    },
    sources: [
      freshnessSource(
        "native-subnets",
        native.captured_at,
        "registry/native/finney-subnets.json",
      ),
      freshnessSource(
        "candidate-verification",
        verificationArtifact.generated_at || null,
        "registry/verification/latest.json",
      ),
      freshnessSource(
        "surface-health",
        health.latest.generated_at,
        "public/metagraph/health/latest.json",
      ),
      freshnessSource(
        "schema-drift",
        schemaDrift.generated_at,
        "public/metagraph/schema-drift.json",
      ),
      ...adapterRows.map((row) =>
        freshnessSource(
          `adapter:${row.slug}`,
          row.generated_at,
          `registry/adapters/latest/${row.slug}.json`,
          row.status,
        ),
      ),
    ].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function freshnessSource(id, timestamp, pathValue, status = "captured") {
  return {
    id,
    path: pathValue,
    status,
    timestamp,
    stale_after_hours: id === "native-subnets" ? 24 : 12,
  };
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
      "registry/verification/latest.json",
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
