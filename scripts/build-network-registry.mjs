// Builds a native-only registry for a non-default Bittensor network (testnet,
// local) from its native chain snapshot. Unlike mainnet (finney), these networks
// have no curated overlays/surfaces/health/candidates — only on-chain identity —
// so this is a deliberately light build: a subnets index, per-subnet native
// detail, and coverage, written to the R2 staging tree under metagraph/{prefix}/…
// (R2-only, never committed; see artifact-storage NETWORK_KEY_PREFIXES). The
// Worker's /api/v1/{network}/… + /metagraph/{network}/… routing (Phase 1) serves
// exactly these keys.
//
// Kept decoupled from the mainnet build (scripts/build-artifacts.mjs) on purpose:
// testnet's 505 sparse subnets shouldn't ripple through the curated-overlay /
// surface / health / candidate machinery, and the schema validator catches any
// projection drift between the two.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { CONTRACT_VERSION } from "../src/contracts.mjs";
import {
  artifactOutputPath,
  backfilledIdentityUrl,
  buildTimestamp,
  cleanDescription,
  nativeDisplayName,
  nativeNameQuality,
  readJson,
  repoRoot,
  slugify,
  subnetLifecycle,
  writeJson,
} from "./lib.mjs";

// Non-default networks whose committed native snapshot, when present, is built
// into an R2-only registry under metagraph/{prefix}/…. mainnet (finney) is built
// by the main build-artifacts pipeline, not here.
export const NETWORK_REGISTRIES = [
  {
    prefix: "testnet",
    snapshotPath: "registry/native/test-subnets.json",
  },
];

const SCHEMA_VERSION = 1;
// Mirrors buildGaps' expected-kinds list in build-artifacts.mjs.
const EXPECTED_GAP_KINDS = [
  "docs",
  "source-repo",
  "website",
  "dashboard",
  "openapi",
  "subnet-api",
  "sse",
  "data-artifact",
];

function nativeSlug(subnet) {
  const quality = nativeNameQuality(subnet);
  const nativeName =
    typeof subnet.raw_name === "string" ? subnet.raw_name : subnet.name || null;
  if (quality === "chain" && nativeName) {
    return slugify(nativeName);
  }
  return subnet.netuid === 0 ? "root" : `sn-${subnet.netuid}`;
}

// Native-only equivalent of mergeSubnet(nativeSubnet, undefined): no overlay, so
// surfaces/candidates/curation are empty and identity comes purely from chain.
function buildNativeSubnet(nativeSubnet, snapshot) {
  const nameQuality = nativeNameQuality(nativeSubnet);
  const nativeName =
    typeof nativeSubnet.raw_name === "string"
      ? nativeSubnet.raw_name
      : nativeSubnet.name || null;
  const sourceRepo = backfilledIdentityUrl(
    null,
    nativeSubnet.chain_identity?.github_repo,
  );
  const websiteUrl = backfilledIdentityUrl(
    null,
    nativeSubnet.chain_identity?.subnet_url,
  );
  const supportedKinds = new Set();
  if (sourceRepo) supportedKinds.add("source-repo");
  if (websiteUrl) supportedKinds.add("website");

  return {
    block: nativeSubnet.block,
    candidate_count: 0,
    categories: nativeSubnet.netuid === 0 ? ["root", "system"] : ["native-only"],
    coverage_level: "native-only",
    curation_level: "native",
    dashboard_url: null,
    description: cleanDescription(nativeSubnet.chain_identity?.description) || null,
    docs_url: null,
    gaps: {
      missing_kinds: EXPECTED_GAP_KINDS.filter((kind) => !supportedKinds.has(kind)),
      supported_kinds: [...supportedKinds].sort(),
      gap_notes: [],
    },
    mechanism_count: nativeSubnet.mechanism_count,
    name: nativeDisplayName(nativeSubnet, `Subnet ${nativeSubnet.netuid}`),
    native_name: nativeName,
    native_name_quality: nameQuality,
    native_slug: nativeSlug(nativeSubnet),
    netuid: nativeSubnet.netuid,
    notes: null,
    participant_count: nativeSubnet.participant_count,
    probed_surface_count: 0,
    provenance: {
      existence: {
        authority: "native-chain",
        captured_at: snapshot.captured_at,
        method: snapshot.source.method,
        network: snapshot.network,
        source_kind: snapshot.source.kind,
      },
      identity: {
        display_name_source:
          nameQuality === "chain" ? "native-chain" : "fallback",
        native_name_quality: nameQuality,
      },
      interface_metadata: "none",
    },
    lifecycle: subnetLifecycle(nativeSubnet),
    logo_url: backfilledIdentityUrl(null, nativeSubnet.chain_identity?.logo_url),
    registered_at_block: nativeSubnet.registered_at_block,
    slug: `sn-${nativeSubnet.netuid}`,
    source_repo: sourceRepo,
    status: nativeSubnet.status,
    subnet_type: nativeSubnet.subnet_type,
    surface_count: 0,
    symbol: nativeSubnet.symbol,
    tempo: nativeSubnet.tempo,
    website_url: websiteUrl,
    curation: {
      level: "native",
      review_state: "unreviewed",
      reviewed_at: null,
      verified_at: null,
      source_count: 0,
      gap_notes: [],
    },
    links: [],
  };
}

// Projection identical to the mainnet subnetIndex map in build-artifacts.mjs.
function buildIndexEntry(subnet) {
  return {
    block: subnet.block,
    candidate_count: subnet.candidate_count,
    categories: subnet.categories,
    coverage_level: subnet.coverage_level,
    curation_level: subnet.curation.level,
    dashboard_url: subnet.dashboard_url,
    description: subnet.description,
    docs_url: subnet.docs_url,
    gap_count: subnet.gaps.missing_kinds.length,
    lifecycle: subnet.lifecycle,
    logo_url: subnet.logo_url,
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
  };
}

function buildCoverage(subnets, snapshot, generatedAt) {
  const rootCount = subnets.filter((s) => s.subnet_type === "root").length;
  return {
    schema_version: SCHEMA_VERSION,
    contract_version: CONTRACT_VERSION,
    generated_at: generatedAt,
    network: snapshot.network,
    // Coverage.source mirrors the mainnet shape ({candidates, native, overlays});
    // testnet has neither a candidate-discovery lane nor curated overlays.
    source: {
      candidates: "none (native-only)",
      native: snapshot.source,
      overlays: "none (native-only)",
    },
    native_snapshot_captured_at: snapshot.captured_at,
    chain_subnet_count: subnets.length,
    application_subnet_count: subnets.length - rootCount,
    root_subnet_count: rootCount,
    candidate_subnet_count: 0,
    candidate_count: 0,
    curated_overlay_count: 0,
    curation_level_counts: { native: subnets.length },
    manifested_count: 0,
    probed_count: 0,
    probed_surface_count: 0,
    surface_count: 0,
    native_only_count: subnets.length,
    native_only_with_candidates: 0,
    native_only_without_candidates: subnets.length,
    notes:
      "Native-only registry: chain existence + on-chain identity. This network has no curated overlays, verified surfaces, or operational health.",
  };
}

// Builds + writes the network registry. Returns the per-artifact write summary.
export async function buildNetworkRegistry({ prefix, snapshotPath }) {
  const snapshot = await readJson(snapshotPath);
  const generatedAt = buildTimestamp();
  const subnets = snapshot.subnets
    .map((nativeSubnet) => buildNativeSubnet(nativeSubnet, snapshot))
    .sort((a, b) => a.netuid - b.netuid);

  const indexPath = artifactOutputPath(`${prefix}/subnets.json`);
  await writeJson(indexPath, {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    network: snapshot.network,
    source: snapshot.source,
    native_snapshot_captured_at: snapshot.captured_at,
    subnets: subnets.map(buildIndexEntry),
  });

  const detailDir = path.dirname(artifactOutputPath(`${prefix}/subnets/0.json`));
  await fs.rm(detailDir, { recursive: true, force: true });
  await fs.mkdir(detailDir, { recursive: true });
  for (const subnet of subnets) {
    await writeJson(artifactOutputPath(`${prefix}/subnets/${subnet.netuid}.json`), {
      schema_version: SCHEMA_VERSION,
      generated_at: generatedAt,
      subnet,
      candidate_surfaces: [],
      candidates: [],
      endpoints: [],
      gaps: subnet.gaps,
      surfaces: [],
      verified_surfaces: [],
    });
  }

  await writeJson(
    artifactOutputPath(`${prefix}/coverage.json`),
    buildCoverage(subnets, snapshot, generatedAt),
  );

  return {
    network: snapshot.network,
    prefix,
    subnet_count: subnets.length,
    captured_at: snapshot.captured_at,
  };
}

// CLI: build every configured network whose committed native snapshot exists.
// Must run AFTER build-artifacts (which wipes the R2 staging root) and BEFORE
// r2-manifest (so the manifest/upload picks the network registries up). A missing
// snapshot is a skip-with-warning, never a hard failure — testnet data is
// best-effort and must never block the mainnet publish.
if (import.meta.url === `file://${process.argv[1]}`) {
  const summaries = [];
  for (const net of NETWORK_REGISTRIES) {
    const snapshotPath = path.join(repoRoot, net.snapshotPath);
    if (!existsSync(snapshotPath)) {
      console.warn(
        `::warning::no native snapshot for ${net.prefix} (${net.snapshotPath}); skipping`,
      );
      continue;
    }
    summaries.push(
      await buildNetworkRegistry({ prefix: net.prefix, snapshotPath }),
    );
  }
  console.log(JSON.stringify({ network_registries: summaries }));
}
