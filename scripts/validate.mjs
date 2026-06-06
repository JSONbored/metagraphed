import { promises as fs } from "node:fs";
import path from "node:path";
import {
  loadCandidates,
  loadNativeSnapshot,
  loadProviders,
  loadSubnets,
  isValidUrl,
  readJson,
  repoRoot
} from "./lib.mjs";

const providerKinds = new Set([
  "subnet-team",
  "infrastructure-provider",
  "data-provider",
  "docs-provider",
  "registry"
]);

const authorities = new Set([
  "official",
  "provider-claimed",
  "community",
  "registry-observed"
]);

const subnetStatuses = new Set(["active", "inactive", "unknown"]);

const surfaceKinds = new Set([
  "subtensor-rpc",
  "subtensor-wss",
  "subnet-api",
  "openapi",
  "sse",
  "website",
  "source-repo",
  "dashboard",
  "repo-registry",
  "docs",
  "data-artifact"
]);

const probeMethods = new Set(["GET", "HEAD"]);
const probeExpectations = new Set(["json", "html", "sse", "any"]);
const coverageLevels = new Set(["native-only", "manifested", "probed"]);
const subnetTypes = new Set(["root", "application"]);
const candidateStates = new Set([
  "schema-invalid",
  "schema-valid",
  "maintainer-review",
  "verified",
  "stale",
  "rejected"
]);

const slugPattern = /^[a-z0-9][a-z0-9-]*$/;

const errors = [];

function assert(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function validateProvider(provider) {
  assert(provider.schema_version === 1, `${provider.id || "provider"}: schema_version must be 1`);
  assert(slugPattern.test(provider.id || ""), `${provider.id || "provider"}: invalid provider id`);
  assert(Boolean(provider.name), `${provider.id}: name is required`);
  assert(providerKinds.has(provider.kind), `${provider.id}: invalid provider kind`);
  assert(isValidUrl(provider.website_url), `${provider.id}: website_url must be a URL`);
  if (provider.docs_url !== undefined) {
    assert(isValidUrl(provider.docs_url), `${provider.id}: docs_url must be a URL`);
  }
  assert(authorities.has(provider.authority), `${provider.id}: invalid authority`);
}

function validateSubnet(subnet, providerIds, surfaceIds) {
  assert(subnet.schema_version === 1, `${subnet.slug || "subnet"}: schema_version must be 1`);
  assert(Number.isInteger(subnet.netuid) && subnet.netuid >= 0, `${subnet.slug}: netuid must be a non-negative integer`);
  assert(Boolean(subnet.name), `${subnet.slug}: name is required`);
  assert(slugPattern.test(subnet.slug || ""), `${subnet.name || "subnet"}: invalid slug`);
  assert(subnetStatuses.has(subnet.status), `${subnet.slug}: invalid status`);
  assert(Array.isArray(subnet.categories), `${subnet.slug}: categories must be an array`);
  if (subnet.docs_url !== undefined) {
    assert(isValidUrl(subnet.docs_url), `${subnet.slug}: docs_url must be a URL`);
  }
  for (const key of ["source_repo", "dashboard_url"]) {
    if (subnet[key] !== undefined && subnet[key] !== null) {
      assert(isValidUrl(subnet[key]), `${subnet.slug}: ${key} must be a URL or null`);
    }
  }
  assert(Array.isArray(subnet.surfaces), `${subnet.slug}: surfaces must be an array`);

  for (const surface of subnet.surfaces || []) {
    const surfaceKey = `${subnet.slug}:${surface.id || "surface"}`;
    assert(slugPattern.test(surface.id || ""), `${surfaceKey}: invalid surface id`);
    assert(!surfaceIds.has(surface.id), `${surfaceKey}: duplicate global surface id`);
    surfaceIds.add(surface.id);
    assert(Boolean(surface.name), `${surfaceKey}: name is required`);
    assert(surfaceKinds.has(surface.kind), `${surfaceKey}: invalid kind`);
    assert(isValidUrl(surface.url), `${surfaceKey}: url must be a URL`);
    assert(providerIds.has(surface.provider), `${surfaceKey}: unknown provider ${surface.provider}`);
    assert(typeof surface.auth_required === "boolean", `${surfaceKey}: auth_required must be boolean`);
    assert(authorities.has(surface.authority), `${surfaceKey}: invalid authority`);
    assert(typeof surface.public_safe === "boolean", `${surfaceKey}: public_safe must be boolean`);

    if (surface.schema_url !== undefined) {
      assert(isValidUrl(surface.schema_url), `${surfaceKey}: schema_url must be a URL`);
    }

    if (surface.probe !== undefined) {
      assert(typeof surface.probe.enabled === "boolean", `${surfaceKey}: probe.enabled must be boolean`);
      assert(probeMethods.has(surface.probe.method), `${surfaceKey}: invalid probe.method`);
      assert(probeExpectations.has(surface.probe.expect), `${surfaceKey}: invalid probe.expect`);
      if (surface.probe.timeout_ms !== undefined) {
        assert(
          Number.isInteger(surface.probe.timeout_ms) &&
            surface.probe.timeout_ms >= 1000 &&
            surface.probe.timeout_ms <= 30000,
          `${surfaceKey}: probe.timeout_ms must be between 1000 and 30000`
        );
      }
    }
  }
}

function validateNativeSnapshot(snapshot) {
  assert(snapshot.schema_version === 1, "native snapshot: schema_version must be 1");
  assert(snapshot.network === "finney", "native snapshot: network must be finney");
  assert(Boolean(snapshot.captured_at), "native snapshot: captured_at is required");
  assert(snapshot.source?.kind === "bittensor-sdk", "native snapshot: source.kind must be bittensor-sdk");
  assert(Array.isArray(snapshot.subnets), "native snapshot: subnets must be an array");
  assert(snapshot.subnets.length > 0, "native snapshot: subnets must not be empty");

  let previousNetuid = -1;
  const netuids = new Set();
  for (const subnet of snapshot.subnets || []) {
    const key = `native:${subnet.netuid}`;
    assert(Number.isInteger(subnet.netuid) && subnet.netuid >= 0, `${key}: netuid must be a non-negative integer`);
    assert(subnet.netuid > previousNetuid, `${key}: native subnets must be unique and sorted by netuid`);
    previousNetuid = subnet.netuid;
    netuids.add(subnet.netuid);
    assert(Boolean(subnet.name), `${key}: name is required`);
    assert(typeof subnet.symbol === "string", `${key}: symbol must be a string`);
    assert(subnet.status === "active", `${key}: status must be active in v1 snapshot`);
    assert(subnetTypes.has(subnet.subnet_type), `${key}: invalid subnet_type`);
    assert(Number.isInteger(subnet.block) && subnet.block >= 0, `${key}: block must be a non-negative integer`);
    assert(
      Number.isInteger(subnet.participant_count) && subnet.participant_count >= 0,
      `${key}: participant_count must be a non-negative integer`
    );
    assert(Number.isInteger(subnet.tempo) && subnet.tempo >= 0, `${key}: tempo must be a non-negative integer`);
    assert(
      Number.isInteger(subnet.registered_at_block) && subnet.registered_at_block >= 0,
      `${key}: registered_at_block must be a non-negative integer`
    );
    assert(
      Number.isInteger(subnet.mechanism_count) && subnet.mechanism_count >= 1,
      `${key}: mechanism_count must be a positive integer`
    );
  }

  const root = snapshot.subnets.find((subnet) => subnet.netuid === 0);
  assert(root?.subnet_type === "root", "native snapshot: netuid 0 must be labeled root");
  return netuids;
}

function validateCandidate(candidate, nativeNetuids, providerIds) {
  const key = `candidate:${candidate.id || "unknown"}`;
  assert(candidate.schema_version === 1, `${key}: schema_version must be 1`);
  assert(slugPattern.test(candidate.id || ""), `${key}: invalid id`);
  assert(Number.isInteger(candidate.netuid) && candidate.netuid >= 0, `${key}: netuid must be a non-negative integer`);
  assert(nativeNetuids.has(candidate.netuid), `${key}: candidate netuid is not in native snapshot`);
  assert(candidateStates.has(candidate.state), `${key}: invalid state`);
  assert(Boolean(candidate.name), `${key}: name is required`);
  assert(surfaceKinds.has(candidate.kind), `${key}: invalid kind`);
  assert(isValidUrl(candidate.url), `${key}: url must be a URL`);
  assert(isValidUrl(candidate.source_url), `${key}: source_url must be a URL`);
  if (candidate.source_urls !== undefined) {
    assert(Array.isArray(candidate.source_urls), `${key}: source_urls must be an array`);
    for (const sourceUrl of candidate.source_urls || []) {
      assert(isValidUrl(sourceUrl), `${key}: source_urls must contain URLs`);
    }
  }
  if (candidate.source_tier !== undefined) {
    assert(
      ["native-chain", "provider-claimed", "third-party-index", "community-docs"].includes(candidate.source_tier),
      `${key}: invalid source_tier`
    );
  }
  if (candidate.confidence !== undefined) {
    assert(["low", "medium", "high"].includes(candidate.confidence), `${key}: invalid confidence`);
  }
  assert(providerIds.has(candidate.provider), `${key}: unknown provider ${candidate.provider}`);
  assert(typeof candidate.auth_required === "boolean", `${key}: auth_required must be boolean`);
  assert(typeof candidate.public_safe === "boolean", `${key}: public_safe must be boolean`);
}

async function validateGeneratedArtifacts(nativeSnapshot, overlays, candidates) {
  const subnetsArtifact = await readJson(path.join(repoRoot, "public/metagraph/subnets.json"));
  const surfacesArtifact = await readJson(path.join(repoRoot, "public/metagraph/surfaces.json"));
  const candidatesArtifact = await readJson(path.join(repoRoot, "public/metagraph/candidates.json"));
  const reviewQueueArtifact = await readJson(path.join(repoRoot, "public/metagraph/review-queue.json"));
  const coverageArtifact = await readJson(path.join(repoRoot, "public/metagraph/coverage.json"));

  const nativeNetuids = nativeSnapshot.subnets.map((subnet) => subnet.netuid);
  const generatedNetuids = subnetsArtifact.subnets.map((subnet) => subnet.netuid);
  assert(
    JSON.stringify(generatedNetuids) === JSON.stringify(nativeNetuids),
    "generated subnets.json must have count/key parity with native snapshot"
  );

  for (const subnet of subnetsArtifact.subnets) {
    assert(coverageLevels.has(subnet.coverage_level), `generated:${subnet.netuid}: invalid coverage_level`);
    const detailPath = path.join(repoRoot, `public/metagraph/subnets/${subnet.netuid}.json`);
    try {
      await fs.access(detailPath);
    } catch {
      assert(false, `generated:${subnet.netuid}: missing per-subnet detail artifact`);
    }
  }

  const curatedNetuids = new Set(overlays.map((overlay) => overlay.netuid));
  const surfaceNetuids = new Set(surfacesArtifact.surfaces.map((surface) => surface.netuid));
  for (const netuid of surfaceNetuids) {
    assert(curatedNetuids.has(netuid), `generated surfaces: surface exists for non-curated netuid ${netuid}`);
  }

  assert(coverageArtifact.chain_subnet_count === nativeSnapshot.subnets.length, "coverage: chain_subnet_count mismatch");
  assert(coverageArtifact.surface_count === surfacesArtifact.surfaces.length, "coverage: surface_count mismatch");
  assert(coverageArtifact.candidate_count === candidates.length, "coverage: candidate_count mismatch");
  assert(candidatesArtifact.candidates.length === candidates.length, "candidates artifact: count mismatch");
  assert(
    reviewQueueArtifact.count === reviewQueueArtifact.candidates.length,
    "review queue artifact: count must match candidates length"
  );
}

const providers = await loadProviders();
const subnets = await loadSubnets();
const nativeSnapshot = await loadNativeSnapshot();
const candidates = await loadCandidates();
const providerIds = new Set();
const netuids = new Set();
const slugs = new Set();
const surfaceIds = new Set();
const nativeNetuids = validateNativeSnapshot(nativeSnapshot);
const candidateIds = new Set();

for (const provider of providers) {
  validateProvider(provider);
  assert(!providerIds.has(provider.id), `${provider.id}: duplicate provider id`);
  providerIds.add(provider.id);
}

for (const subnet of subnets) {
  assert(!netuids.has(subnet.netuid), `${subnet.slug}: duplicate netuid ${subnet.netuid}`);
  assert(!slugs.has(subnet.slug), `${subnet.slug}: duplicate subnet slug`);
  assert(
    nativeNetuids.has(subnet.netuid) || subnet.extensions?.pending_native === true,
    `${subnet.slug}: curated overlay netuid ${subnet.netuid} is not present in native snapshot`
  );
  netuids.add(subnet.netuid);
  slugs.add(subnet.slug);
  validateSubnet(subnet, providerIds, surfaceIds);
}

for (const candidate of candidates) {
  assert(!candidateIds.has(candidate.id), `${candidate.id}: duplicate candidate id`);
  candidateIds.add(candidate.id);
  validateCandidate(candidate, nativeNetuids, providerIds);
}

await validateGeneratedArtifacts(nativeSnapshot, subnets, candidates);

if (errors.length > 0) {
  console.error(`Validation failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Validated ${nativeSnapshot.subnets.length} native subnet(s), ${subnets.length} curated overlay(s), ${surfaceIds.size} surface(s), ${providers.length} provider(s), and ${candidates.length} candidate(s).`
);
