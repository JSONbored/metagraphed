import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildTimestamp,
  flattenSurfaces,
  loadCandidates,
  loadNativeSnapshot,
  loadProviders,
  loadSubnets,
  repoRoot,
  slugify,
  writeJson
} from "./lib.mjs";

const providers = await loadProviders();
const overlays = await loadSubnets();
const candidates = await loadCandidates();
const nativeSnapshot = await loadNativeSnapshot();
const overlayByNetuid = new Map(overlays.map((overlay) => [overlay.netuid, overlay]));
const chainSubnets = nativeSnapshot.subnets;
const candidatesByNetuid = groupByNetuid(candidates);
const mergedSubnets = chainSubnets.map((nativeSubnet) =>
  mergeSubnet(nativeSubnet, overlayByNetuid.get(nativeSubnet.netuid), candidatesByNetuid.get(nativeSubnet.netuid)?.length || 0)
);
const activeOverlayNetuids = new Set(chainSubnets.map((subnet) => subnet.netuid));
const activeOverlays = overlays.filter((overlay) => activeOverlayNetuids.has(overlay.netuid));
const surfaces = flattenSurfaces(activeOverlays);
const outputRoot = path.join(repoRoot, "public/metagraph");
const generatedAt = buildTimestamp();

const subnetIndex = mergedSubnets.map((subnet) => ({
  block: subnet.block,
  candidate_count: subnet.candidate_count,
  categories: subnet.categories,
  coverage_level: subnet.coverage_level,
  dashboard_url: subnet.dashboard_url,
  docs_url: subnet.docs_url,
  mechanism_count: subnet.mechanism_count,
  name: subnet.name,
  native_name: subnet.native_name,
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
  tempo: subnet.tempo
}));

const metagraphLatest = {
  schema_version: 1,
  generated_at: generatedAt,
  network: nativeSnapshot.network,
  source: nativeSnapshot.source,
  captured_at: nativeSnapshot.captured_at,
  notes: "Native Bittensor chain data is canonical for active subnet existence. Curated overlays add public interface metadata where verified.",
  subnets: subnetIndex
};

const healthLatest = {
  schema_version: 1,
  generated_at: generatedAt,
  source: "artifact-build",
  notes: "Run npm run probes:smoke with METAGRAPH_WRITE_PROBE_RESULTS=1 to write live probe results. Health artifacts include curated surfaces only.",
  surfaces: surfaces.map((surface) => ({
    auth_required: surface.auth_required,
    kind: surface.kind,
    method_tested: surface.probe?.method || "not-configured",
    provider: surface.provider,
    public_safe: surface.public_safe,
    status: "unknown",
    subnet_name: surface.subnet_name,
    subnet_slug: surface.subnet_slug,
    surface_id: surface.id,
    url: surface.url,
    verified_at: null
  }))
};

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
        extensions: subnet.extensions
      }
    ])
);

const coverage = {
  schema_version: 1,
  generated_at: generatedAt,
  network: nativeSnapshot.network,
  native_snapshot_captured_at: nativeSnapshot.captured_at,
  source: {
    native: nativeSnapshot.source,
    overlays: "registry/subnets",
    candidates: "registry/candidates"
  },
  chain_subnet_count: chainSubnets.length,
  root_subnet_count: mergedSubnets.filter((subnet) => subnet.subnet_type === "root").length,
  application_subnet_count: mergedSubnets.filter((subnet) => subnet.subnet_type === "application").length,
  curated_overlay_count: activeOverlays.length,
  native_only_count: mergedSubnets.filter((subnet) => subnet.coverage_level === "native-only").length,
  manifested_count: mergedSubnets.filter((subnet) => subnet.coverage_level === "manifested").length,
  probed_count: mergedSubnets.filter((subnet) => subnet.coverage_level === "probed").length,
  surface_count: surfaces.length,
  probed_surface_count: surfaces.filter((surface) => surface.probe?.enabled).length,
  candidate_count: candidates.length,
  candidate_subnet_count: candidatesByNetuid.size,
  native_only_with_candidates: mergedSubnets.filter(
    (subnet) => subnet.coverage_level === "native-only" && subnet.candidate_count > 0
  ).length,
  native_only_without_candidates: mergedSubnets.filter(
    (subnet) => subnet.coverage_level === "native-only" && subnet.candidate_count === 0
  ).length
};

const candidateIndex = candidates.map((candidate) => ({
  ...candidate,
  subnet_name: nativeSnapshot.subnets.find((subnet) => subnet.netuid === candidate.netuid)?.name || null
}));

const reviewQueue = candidateIndex.filter((candidate) =>
  ["schema-valid", "maintainer-review", "stale"].includes(candidate.state)
);

await writeJson(path.join(outputRoot, "providers.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  providers
});

await writeJson(path.join(outputRoot, "subnets.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  network: nativeSnapshot.network,
  source: nativeSnapshot.source,
  native_snapshot_captured_at: nativeSnapshot.captured_at,
  subnets: subnetIndex
});

await fs.rm(path.join(outputRoot, "subnets"), { recursive: true, force: true });
for (const subnet of mergedSubnets) {
  const subnetCandidates = candidatesByNetuid.get(subnet.netuid) || [];
  await writeJson(path.join(outputRoot, `subnets/${subnet.netuid}.json`), {
    schema_version: 1,
    generated_at: generatedAt,
    subnet,
    candidates: subnetCandidates,
    surfaces: surfaces.filter((surface) => surface.netuid === subnet.netuid)
  });
}

await writeJson(path.join(outputRoot, "surfaces.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  notes: "Curated and verified public interface surfaces only. Native-only subnet stubs do not invent surfaces.",
  surfaces
});

await writeJson(path.join(outputRoot, "candidates.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  notes: "Unverified candidate surfaces from public source discovery and community intake. Candidates are not verified registry surfaces.",
  candidates: candidateIndex
});

await writeJson(path.join(outputRoot, "review-queue.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  notes: "Candidate surfaces that need maintainer review before promotion into curated subnet overlays.",
  count: reviewQueue.length,
  candidates: reviewQueue
});

await writeJson(path.join(outputRoot, "metagraph/latest.json"), metagraphLatest);
await writeJson(path.join(outputRoot, "health/latest.json"), healthLatest);
await writeJson(path.join(outputRoot, "coverage.json"), coverage);

for (const [slug, artifact] of Object.entries(adapterArtifacts)) {
  await writeJson(path.join(outputRoot, `adapters/${slug}.json`), artifact);
}

await writeJson(path.join(outputRoot, "build-summary.json"), {
  schema_version: 1,
  generated_at: generatedAt,
  adapter_count: Object.keys(adapterArtifacts).length,
  candidate_count: candidates.length,
  coverage,
  provider_count: providers.length,
  subnet_count: mergedSubnets.length,
  surface_count: surfaces.length
});

console.log(`Built ${mergedSubnets.length} subnet(s), ${surfaces.length} surface(s), and ${providers.length} provider(s).`);

function mergeSubnet(nativeSubnet, overlay, candidateCount) {
  const surfaceCount = overlay?.surfaces?.length || 0;
  const probedSurfaceCount = overlay?.surfaces?.filter((surface) => surface.probe?.enabled).length || 0;
  const coverageLevel = surfaceCount === 0 ? "native-only" : probedSurfaceCount > 0 ? "probed" : "manifested";
  const slug = overlay?.slug || `sn-${nativeSubnet.netuid}`;

  return {
    block: nativeSubnet.block,
    candidate_count: candidateCount,
    categories: overlay?.categories || (nativeSubnet.netuid === 0 ? ["root", "system"] : ["native-only"]),
    coverage_level: coverageLevel,
    dashboard_url: overlay?.dashboard_url || null,
    docs_url: overlay?.docs_url || null,
    mechanism_count: nativeSubnet.mechanism_count,
    name: overlay?.name || nativeSubnet.name || `Subnet ${nativeSubnet.netuid}`,
    native_name: nativeSubnet.name || null,
    native_slug: slugify(nativeSubnet.name || `subnet-${nativeSubnet.netuid}`),
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
        source_kind: nativeSnapshot.source.kind
      },
      interface_metadata: overlay ? "curated-overlay" : "none"
    },
    registered_at_block: nativeSubnet.registered_at_block,
    slug,
    source_repo: overlay?.source_repo || null,
    status: nativeSubnet.status,
    subnet_type: nativeSubnet.subnet_type,
    surface_count: surfaceCount,
    symbol: nativeSubnet.symbol,
    tempo: nativeSubnet.tempo
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
