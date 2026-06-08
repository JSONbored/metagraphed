import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { test } from "vitest";
import {
  artifactDirectoryPath,
  artifactFilePath,
  createLocalArtifactEnv,
  publicMetagraphRoot,
  r2StagingRoot,
} from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

const SUPPORT_ARTIFACT_PATHS = [
  "public/metagraph/build-summary.json",
  "public/metagraph/changelog.json",
  "public/metagraph/r2-manifest.json",
];

function runNode(script) {
  execFileSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });
}

test("registry validates", () => {
  runNode("scripts/validate.mjs");
});

test("registry validation rejects registry-observed surfaces without verification evidence", () => {
  const overlayPath = "registry/subnets/test-tampered-sn-1.json";
  const tampered = tamperedOverlayFixture("sn-1-unverified-registry-observed");

  tampered.surfaces.push({
    id: "sn-1-unverified-registry-observed",
    name: "Unverified registry-observed surface",
    kind: "website",
    url: "https://example.invalid/unverified-registry-observed",
    provider: "taomarketcap",
    auth_required: false,
    authority: "registry-observed",
    public_safe: true,
    source_urls: ["https://example.invalid/source"],
  });

  let failure;
  try {
    writeFileSync(overlayPath, `${JSON.stringify(tampered, null, 2)}\n`);
    runNode("scripts/validate.mjs");
  } catch (error) {
    failure = error;
  } finally {
    rmSync(overlayPath, { force: true });
  }

  assert(
    failure,
    "expected validation to reject a registry-observed surface without verification evidence",
  );
  assert.match(
    `${failure.stdout || ""}\n${failure.stderr || ""}`,
    /registry-observed surface requires verification evidence/,
  );
});

test("registry validation rejects registry-observed surfaces with only inline verification", () => {
  const overlayPath = "registry/subnets/test-tampered-sn-1.json";
  const tampered = tamperedOverlayFixture("sn-1-forged-inline-verification");

  tampered.surfaces.push({
    id: "sn-1-forged-inline-verification",
    name: "Forged inline verification surface",
    kind: "website",
    url: "https://example.invalid/forged-inline-verification",
    provider: "taomarketcap",
    auth_required: false,
    authority: "registry-observed",
    public_safe: true,
    source_urls: ["https://example.invalid/source"],
    verification: {
      classification: "live",
      verified_at: "2999-01-01T00:00:00.000Z",
    },
  });

  let failure;
  try {
    writeFileSync(overlayPath, `${JSON.stringify(tampered, null, 2)}\n`);
    runNode("scripts/validate.mjs");
  } catch (error) {
    failure = error;
  } finally {
    rmSync(overlayPath, { force: true });
  }

  assert(
    failure,
    "expected validation to reject forged inline verification without ledger evidence",
  );
  assert.match(
    `${failure.stdout || ""}\n${failure.stderr || ""}`,
    /registry-observed surface requires verification evidence/,
  );
});

function tamperedOverlayFixture(slug) {
  return {
    categories: ["test"],
    curation: {
      gap_notes: [],
      level: "machine-verified",
      review_state: "maintainer-reviewed",
      reviewed_at: "2026-06-07T00:00:00.000Z",
      source_count: 1,
      verified_at: null,
    },
    links: [],
    name: `Tampered ${slug}`,
    netuid: 1,
    notes: "Temporary validation fixture.",
    schema_version: 1,
    slug,
    status: "active",
    surfaces: [],
  };
}

test("registry validation rejects tampered per-subnet artifacts", () => {
  const artifactPath = artifactFilePath("subnets/0.json");
  const original = readFileSync(artifactPath, "utf8");
  const tampered = JSON.parse(original);
  tampered.phishing_url = "https://example.invalid/phish";

  let failure;
  try {
    writeFileSync(artifactPath, `${JSON.stringify(tampered, null, 2)}\n`);
    runNode("scripts/validate.mjs");
  } catch (error) {
    failure = error;
  } finally {
    writeFileSync(artifactPath, original);
  }

  assert(failure, "expected validation to reject tampered subnet artifact");
  assert.match(
    `${failure.stdout || ""}\n${failure.stderr || ""}`,
    /per-subnet detail artifact is not reproducible from registry inputs/,
  );
});

test("artifact build ignores forged committed health observations by default", () => {
  const artifactPath = artifactFilePath("health/latest.json");
  const cachePath = ".cache/metagraphed/health/latest.json";
  const original = readFileSync(artifactPath, "utf8");
  const originalCache = existsSync(cachePath)
    ? readFileSync(cachePath, "utf8")
    : null;
  const supportArtifacts = snapshotSupportArtifacts();
  rmSync(cachePath, { force: true });
  const tampered = JSON.parse(original);
  const target = tampered.surfaces.find(
    (surface) => surface.public_safe === true,
  );
  assert(target, "expected a public-safe health row to tamper");

  tampered.source = "live-smoke-probe";
  tampered.generated_at = "2999-01-01T00:00:00.000Z";
  target.status = "ok";
  target.classification = "live";
  target.last_checked = "2999-01-01T00:00:00.000Z";
  target.last_ok = "2999-01-01T00:00:00.000Z";
  target.verified_at = "2999-01-01T00:00:00.000Z";
  target.latency_ms = 7;
  target.status_code = 200;
  target.method_results = { forged_probe: { status: "ok" } };

  try {
    writeFileSync(artifactPath, `${JSON.stringify(tampered, null, 2)}\n`);
    execFileSync(process.execPath, ["scripts/build-artifacts.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
      },
      stdio: "pipe",
    });

    const rebuilt = JSON.parse(readFileSync(artifactPath, "utf8"));
    const rebuiltTarget = rebuilt.surfaces.find(
      (surface) => surface.surface_id === target.surface_id,
    );
    assert.equal(rebuilt.source, "artifact-build");
    assert.equal(rebuiltTarget.status, "unknown");
    assert.equal(rebuiltTarget.classification, "unknown");
    assert.equal(rebuiltTarget.last_checked, null);
    assert.equal(rebuiltTarget.latency_ms, null);
    assert.equal(rebuiltTarget.status_code, undefined);
    assert.equal(rebuilt.summary.status_counts.ok || 0, 0);
  } finally {
    writeFileSync(artifactPath, original);
    if (originalCache === null) {
      rmSync(cachePath, { force: true });
    } else {
      writeFileSync(cachePath, originalCache);
    }
    execFileSync(process.execPath, ["scripts/build-artifacts.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
      },
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/generate-types.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/generate-client.mjs", "--write"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/r2-manifest.mjs", "--write"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    restoreSupportArtifacts(supportArtifacts);
  }
}, 30_000);

test("artifact build does not preserve forged endpoint index health", () => {
  const endpointsPath = artifactFilePath("endpoints.json");
  const cachePath = ".cache/metagraphed/health/latest.json";
  const original = readFileSync(endpointsPath, "utf8");
  const originalCache = existsSync(cachePath)
    ? readFileSync(cachePath, "utf8")
    : null;
  const supportArtifacts = snapshotSupportArtifacts();
  rmSync(cachePath, { force: true });
  const tampered = JSON.parse(original);
  const target = tampered.endpoints.find(
    (endpoint) => endpoint.public_safe === true,
  );
  assert(target, "expected a public-safe endpoint row to tamper");

  target.health_source = "probe-derived";
  target.monitoring_status = "monitored";
  target.status = "ok";
  target.classification = "live";
  target.last_checked = "2999-01-01T00:00:00.000Z";
  target.last_ok = "2999-01-01T00:00:00.000Z";
  target.observed_at = "2999-01-01T00:00:00.000Z";
  target.latency_ms = 7;
  target.latest_block = 4242424242;
  target.archive_support = true;

  try {
    writeFileSync(endpointsPath, `${JSON.stringify(tampered, null, 2)}\n`);
    execFileSync(process.execPath, ["scripts/build-artifacts.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, METAGRAPH_PRESERVE_PROBE_HEALTH: "1" },
      stdio: "pipe",
    });

    const rebuilt = JSON.parse(readFileSync(endpointsPath, "utf8"));
    const rebuiltTarget = rebuilt.endpoints.find(
      (endpoint) => endpoint.surface_id === target.surface_id,
    );
    assert.equal(rebuiltTarget.status, "unknown");
    assert.equal(rebuiltTarget.classification, "unknown");
    assert.equal(rebuiltTarget.last_checked, null);
    assert.equal(rebuiltTarget.latency_ms, null);
    assert.equal(rebuiltTarget.latest_block, null);
    assert.equal(rebuiltTarget.archive_support, null);
    assert.equal(rebuiltTarget.health_source, "missing-probe");
  } finally {
    writeFileSync(endpointsPath, original);
    if (originalCache === null) {
      rmSync(cachePath, { force: true });
    } else {
      writeFileSync(cachePath, originalCache);
    }
    execFileSync(process.execPath, ["scripts/build-artifacts.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
      },
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/generate-types.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/generate-client.mjs", "--write"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/r2-manifest.mjs", "--write"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: "pipe",
    });
    restoreSupportArtifacts(supportArtifacts);
  }
}, 30_000);

test("public artifacts are internally consistent", () => {
  const native = JSON.parse(
    readFileSync("registry/native/finney-subnets.json", "utf8"),
  );
  const subnets = readArtifact("subnets.json");
  const surfaces = readArtifact("surfaces.json");
  const candidates = readArtifact("candidates.json");
  const curation = readArtifact("curation.json");
  const gaps = readArtifact("gaps.json");
  const reviewQueue = readArtifact("review-queue.json");
  const verification = readArtifact("verification/latest.json");
  const health = readArtifact("health/latest.json");
  const healthSummary = readArtifact("health/summary.json");
  const latestHealthHistoryDate = latestArtifactDate("health/history");
  const healthHistory = readArtifact(
    `health/history/${latestHealthHistoryDate}.json`,
  );
  const rpcEndpoints = readArtifact("rpc-endpoints.json");
  const endpoints = readArtifact("endpoints.json");
  const profiles = readArtifact("profiles.json");
  const subnetProfile = readArtifact("profiles/7.json");
  const subnetEndpoints = readArtifact("endpoints/7.json");
  const coverage = readArtifact("coverage.json");
  const contracts = readArtifact("contracts.json");
  const apiIndex = readArtifact("api-index.json");
  const changelog = readArtifact("changelog.json");
  const search = readArtifact("search.json");
  const freshness = readArtifact("freshness.json");
  const sourceHealth = readArtifact("source-health.json");
  const sourceSnapshots = readArtifact("source-snapshots.json");
  const evidenceLedger = readArtifact("evidence-ledger.json");
  const endpointPools = readArtifact("endpoint-pools.json");
  const endpointIncidents = readArtifact("endpoint-incidents.json");
  const rpcEndpointPools = readArtifact("rpc/pools.json");
  const providerEndpoints = readArtifact("providers/allways/endpoints.json");
  const r2Manifest = readArtifact("r2-manifest.json");
  const schemaDrift = readArtifact("schema-drift.json");
  const schemaIndex = readArtifact("schemas/index.json");
  const reviewCuration = readArtifact("review/curation.json");
  const gapPriorities = readArtifact("review/gap-priorities.json");
  const profileCompleteness = readArtifact("review/profile-completeness.json");
  const adapterCandidates = readArtifact("review/adapter-candidates.json");
  const genericAdapter = readArtifact("adapters/numinous.json");
  const schemaOnlyGenericAdapter = readArtifact("adapters/sn-46.json");
  const enrichmentQueue = readArtifact("review/enrichment-queue.json");
  const enrichmentEvidence = readArtifact("review/enrichment-evidence.json");
  const enrichmentTargets = readArtifact("review/enrichment-targets.json");
  const reviewDecisions = readArtifact("review/maintainer-decisions.json");
  const generatedCandidateDiscovery = JSON.parse(
    readFileSync("registry/candidates/generated/public-sources.json", "utf8"),
  );

  assert.equal(subnets.subnets.length, native.subnets.length);
  assert.equal(surfaces.surfaces.length, coverage.surface_count);
  assert.equal(
    health.surfaces.length,
    surfaces.surfaces.filter(
      (surface) => surface.probe?.enabled && surface.public_safe,
    ).length,
  );
  assert.equal(
    rpcEndpoints.endpoints.length,
    surfaces.surfaces.filter((surface) =>
      ["subtensor-rpc", "subtensor-wss"].includes(surface.kind),
    ).length,
  );
  assert.equal(
    rpcEndpoints.endpoints.every((endpoint) => endpoint.netuid === 0),
    true,
  );
  assert.equal(endpoints.endpoints.length, surfaces.surfaces.length);
  assert.equal(profiles.profiles.length, native.subnets.length);
  const candidateDiscoverySource = freshness.sources.find(
    (source) => source.id === "candidate-discovery",
  );
  const expectedCandidateDiscoveryAsOf =
    generatedCandidateDiscovery.observed_at ||
    generatedCandidateDiscovery.last_observed_at ||
    (generatedCandidateDiscovery.generated_at &&
    generatedCandidateDiscovery.generated_at !== "1970-01-01T00:00:00.000Z"
      ? generatedCandidateDiscovery.generated_at
      : null);
  assert.equal(
    freshness.summary.candidate_discovery_as_of,
    expectedCandidateDiscoveryAsOf,
  );
  assert.equal(candidateDiscoverySource.as_of, expectedCandidateDiscoveryAsOf);
  assert.equal(
    candidateDiscoverySource.status,
    expectedCandidateDiscoveryAsOf ? "captured" : "missing",
  );
  if (schemaDrift.source === "openapi-snapshot") {
    const schemaSnapshotAsOf =
      schemaDrift.observed_at || schemaDrift.generated_at;
    assert.equal(freshness.summary.schema_snapshot_as_of, schemaSnapshotAsOf);
    assert.equal(
      freshness.sources.find((source) => source.id === "schema-drift")?.as_of,
      schemaSnapshotAsOf,
    );
  }
  assert.equal(
    profiles.profiles.every(
      (profile) =>
        Number.isInteger(profile.completeness_score) &&
        profile.completeness_score >= 0 &&
        profile.completeness_score <= 100 &&
        ["none", "directory", "partial", "complete"].includes(
          profile.identity_level,
        ) &&
        Number.isInteger(profile.identity_surface_count) &&
        profile.identity_surface_count >= 0 &&
        profile.identity_surface_count <= 3 &&
        Array.isArray(profile.missing_identity) &&
        profile.identity_surface_count + profile.missing_identity.length ===
          3 &&
        Array.isArray(profile.missing_required) &&
        Array.isArray(profile.missing_operational) &&
        Array.isArray(profile.gap_reasons) &&
        Array.isArray(profile.suggested_submission_kinds) &&
        profile.gap_reasons.length === profile.completeness.gap_reasons.length,
    ),
    true,
  );
  assert.equal(
    profileCompleteness.profiles.every(
      (profile) =>
        Array.isArray(profile.missing_required) &&
        Array.isArray(profile.missing_identity) &&
        Array.isArray(profile.missing_operational) &&
        Array.isArray(profile.supported_interface_kinds) &&
        ["none", "directory", "partial", "complete"].includes(
          profile.identity_level,
        ) &&
        Number.isInteger(profile.identity_surface_count) &&
        Number.isInteger(profile.source_count) &&
        Number.isInteger(profile.operational_interface_count) &&
        typeof profile.curation_level === "string" &&
        typeof profile.review_state === "string" &&
        ["chain", "placeholder", "empty"].includes(profile.native_name_quality),
    ),
    true,
  );
  assert.equal(subnetProfile.profile.netuid, 7);
  assert.equal(subnetProfile.profile.profile_level, "adapter-backed");
  assert.equal(
    subnetProfile.profile.operational_interface_kinds.includes("subnet-api"),
    true,
  );
  assert.equal(
    endpoints.endpoints.every(
      (endpoint) =>
        endpoint.publication_state === "pool-eligible" ||
        endpoint.publication_state === "monitored" ||
        endpoint.publication_state === "verified" ||
        endpoint.publication_state === "disabled",
    ),
    true,
  );
  assert.equal(
    endpoints.endpoints.filter((endpoint) => endpoint.pool_eligible).length <=
      endpointPools.pools.reduce((sum, pool) => sum + pool.eligible_count, 0),
    true,
  );
  assert.equal(Array.isArray(endpointPools.provider_scores), true);
  assert.equal(
    endpoints.endpoints.every((endpoint) =>
      Array.isArray(endpoint.pool_eligibility_reasons),
    ),
    true,
  );
  assert.equal(
    endpoints.endpoints.every((endpoint) =>
      Array.isArray(endpoint.score_reasons),
    ),
    true,
  );
  assert.equal(
    endpointIncidents.summary.incident_count,
    endpointIncidents.incidents.length,
  );
  assert.equal(
    endpointIncidents.incidents.every(
      (incident) =>
        incident.source === "probe-derived" && !incident.user_reported,
    ),
    true,
  );
  assert.equal(
    subnetEndpoints.endpoints.every((endpoint) => endpoint.netuid === 7),
    true,
  );
  assert.equal(
    providerEndpoints.endpoints.every(
      (endpoint) => endpoint.provider === "allways",
    ),
    true,
  );
  assert.equal(healthSummary.subnets.length, native.subnets.length);
  assert.equal(healthHistory.date, latestHealthHistoryDate);
  assert.equal(healthHistory.surfaces.length, health.surfaces.length);
  assert.equal(
    healthHistory.surfaces.every((surface) => !Object.hasOwn(surface, "url")),
    true,
  );
  assert.equal(coverage.chain_subnet_count, native.subnets.length);
  assert.equal(coverage.curated_overlay_count, native.subnets.length);
  assert.equal(coverage.native_only_count, 0);
  assert.equal(coverage.candidate_count, candidates.candidates.length);
  assert.equal(coverage.candidate_subnet_count, native.subnets.length);
  assert.equal(curation.curation.length, native.subnets.length);
  assert.equal(gaps.gaps.length, native.subnets.length);
  assert.equal(verification.candidate_count, verification.results.length);
  assert.equal(
    verification.results.length <= candidates.candidates.length,
    true,
  );
  const candidateIds = new Set(
    candidates.candidates.map((candidate) => candidate.id),
  );
  assert.equal(
    verification.results.every((result) =>
      candidateIds.has(result.candidate_id),
    ),
    true,
  );
  assert.equal(reviewQueue.count, reviewQueue.candidates.length);
  assert.equal(contracts.primary_domain, "metagraph.sh");
  assert.equal(contracts.status_domain, null);
  assert.equal(
    contracts.artifacts.some(
      (artifact) =>
        artifact.id === "contracts" &&
        artifact.schema_ref === "#/components/schemas/ContractsArtifact",
    ),
    true,
  );
  assert.equal(
    contracts.artifacts.some(
      (artifact) =>
        artifact.id === "health-history" &&
        artifact.schema_ref === "#/components/schemas/HealthHistoryArtifact",
    ),
    true,
  );
  assert.equal(
    contracts.artifacts.some(
      (artifact) =>
        artifact.id === "endpoint-incidents" &&
        artifact.schema_ref ===
          "#/components/schemas/EndpointIncidentsArtifact",
    ),
    true,
  );
  assert.equal(
    new Set(contracts.artifacts.map((artifact) => artifact.id)).size,
    contracts.artifacts.length,
  );
  assert.equal(
    apiIndex.routes.some((route) => route.path === "/api/v1/subnets"),
    true,
  );
  assert.equal(
    apiIndex.routes.some((route) => route.path === "/api/v1/changelog"),
    true,
  );
  assert.equal(
    apiIndex.routes.some((route) => route.path === "/api/v1/source-snapshots"),
    true,
  );
  assert.equal(changelog.source, "generated-artifact-diff");
  assert.equal(search.document_count, search.documents.length);
  assert.equal(
    freshness.summary.native_snapshot_captured_at,
    native.captured_at,
  );
  assert.equal(freshness.summary.native_data_as_of, native.captured_at);
  assert.equal(
    freshness.summary.blocking_source_count,
    freshness.sources.filter((source) => source.stale_behavior === "block")
      .length,
  );
  assert.equal(
    freshness.summary.missing_blocking_source_count,
    freshness.sources.filter(
      (source) =>
        source.stale_behavior === "block" && source.status === "missing",
    ).length,
  );
  for (const source of freshness.sources) {
    assert.equal(source.as_of, source.timestamp);
    assert.equal(typeof source.required_for_publish, "boolean");
    assert.equal(["block", "warn"].includes(source.stale_behavior), true);
  }
  assert.equal(
    freshness.sources.some(
      (source) =>
        source.id === "surface-health" &&
        source.lane === "health-probe" &&
        source.stale_behavior === "block",
    ),
    true,
  );
  assert.equal(sourceHealth.summary.provider_count > 0, true);
  assert.equal(
    sourceSnapshots.summary.source_count,
    sourceSnapshots.sources.length,
  );
  assert.equal(
    sourceSnapshots.sources.some((source) => source.id === "native-subnets"),
    true,
  );
  assert.equal(
    evidenceLedger.summary.claim_count,
    evidenceLedger.claims.length,
  );
  assert.equal(endpointPools.pools.length >= 3, true);
  assert.equal(rpcEndpointPools.pools.length >= 3, true);
  assert.equal(r2Manifest.artifact_count, r2Manifest.artifacts.length);
  assert.equal(
    schemaDrift.openapi_surface_count ?? schemaDrift.summary?.surface_count,
    surfaces.surfaces.filter((surface) => surface.kind === "openapi").length,
  );
  assert.equal(Array.isArray(schemaIndex.schemas), true);
  assert.equal(reviewCuration.summary.subnet_count, native.subnets.length);
  assert.equal(gapPriorities.priorities.length, native.subnets.length);
  assert.equal(profileCompleteness.profiles.length, native.subnets.length);
  assert.equal(enrichmentQueue.summary.subnet_count, native.subnets.length);
  assert.equal(enrichmentQueue.summary.queue_count, native.subnets.length);
  assert.equal(enrichmentQueue.queue.length, native.subnets.length);
  assert.equal(enrichmentEvidence.summary.subnet_count, native.subnets.length);
  assert.equal(enrichmentEvidence.entries.length, native.subnets.length);
  assert.equal(
    enrichmentTargets.summary.target_count,
    enrichmentTargets.targets.length,
  );
  assert.equal(
    enrichmentTargets.groups.reduce(
      (sum, group) => sum + group.target_count,
      0,
    ),
    enrichmentTargets.targets.length,
  );
  assert.equal(
    new Set(enrichmentTargets.targets.map((target) => target.target_id)).size,
    enrichmentTargets.targets.length,
  );
  assert.equal(
    enrichmentTargets.targets.filter(
      (target) => target.target_type === "surface-candidate",
    ).length,
    enrichmentQueue.queue.reduce(
      (sum, entry) => sum + entry.direct_submission_kinds.length,
      0,
    ),
  );
  assert.equal(
    enrichmentTargets.targets.every((target) =>
      target.target_type === "surface-candidate"
        ? target.kind && target.candidate_command?.startsWith("npm run ")
        : target.kind === null && target.candidate_command === null,
    ),
    true,
  );
  assert.equal(
    enrichmentTargets.targets.some(
      (target) =>
        target.target_type === "surface-candidate" &&
        target.kind === "openapi" &&
        target.submission_route === "direct-candidate-pr",
    ),
    true,
  );
  assert.equal(
    enrichmentTargets.targets.some(
      (target) => target.target_type === "adapter-review",
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.some((entry) => entry.lane === "direct-submission"),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.some((entry) => entry.manual_review_required),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.every((entry) =>
      Array.isArray(entry.direct_submission_kinds),
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.every(
      (entry) =>
        entry.candidate_evidence_summary &&
        typeof entry.candidate_evidence_summary === "object",
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.some(
      (entry) => entry.evidence_action === "replace-stale-evidence",
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.every((entry) =>
      Number.isInteger(entry.stale_candidate_count),
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.every(
      (entry) =>
        Array.isArray(entry.sample_live_candidate_ids) &&
        Array.isArray(entry.sample_stale_candidate_ids) &&
        Array.isArray(entry.sample_target_candidate_ids),
    ),
    true,
  );
  assert.equal(
    enrichmentQueue.queue.some(
      (entry) => entry.sample_target_candidate_ids.length > 0,
    ),
    true,
  );
  assert.equal(
    enrichmentEvidence.entries.some(
      (entry) => entry.candidate_evidence_by_kind["source-repo"],
    ),
    true,
  );
  assert.deepEqual(
    Object.fromEntries(
      enrichmentQueue.queue.map((entry) => [
        entry.netuid,
        entry.candidate_evidence_summary,
      ]),
    ),
    Object.fromEntries(
      enrichmentEvidence.entries.map((entry) => [
        entry.netuid,
        entry.candidate_evidence_summary,
      ]),
    ),
  );
  assert.deepEqual(
    profileCompleteness.summary.by_profile_level,
    profileCompleteness.profiles.reduce((counts, profile) => {
      counts[profile.profile_level] = (counts[profile.profile_level] || 0) + 1;
      return counts;
    }, {}),
  );
  assert.deepEqual(
    profiles.summary.by_identity_level,
    profiles.profiles.reduce((counts, profile) => {
      counts[profile.identity_level] =
        (counts[profile.identity_level] || 0) + 1;
      return counts;
    }, {}),
  );
  assert.deepEqual(
    profileCompleteness.summary.by_identity_level,
    profileCompleteness.profiles.reduce((counts, profile) => {
      counts[profile.identity_level] =
        (counts[profile.identity_level] || 0) + 1;
      return counts;
    }, {}),
  );
  assert.deepEqual(
    enrichmentQueue.summary.identity_level_counts,
    enrichmentQueue.queue.reduce((counts, entry) => {
      counts[entry.identity_level] = (counts[entry.identity_level] || 0) + 1;
      return counts;
    }, {}),
  );
  assert.equal(
    Object.values(profileCompleteness.summary.by_profile_level).reduce(
      (sum, count) => sum + count,
      0,
    ),
    native.subnets.length,
  );
  assert.equal(
    profileCompleteness.summary.by_profile_level["adapter-backed"] >= 2,
    true,
  );
  assert.equal(genericAdapter.snapshot.adapter_kind, "generic-openapi");
  assert.equal(
    genericAdapter.extensions.generic_adapter.kind,
    "generic-openapi",
  );
  assert.equal(
    genericAdapter.snapshot.dimensions.openapi_schemas.captured_count > 0,
    true,
  );
  assert.equal(
    genericAdapter.snapshot.dimensions.openapi_schemas.total_operation_count >
      0,
    true,
  );
  assert.equal(schemaOnlyGenericAdapter.snapshot.status, "captured");
  assert.equal(
    schemaOnlyGenericAdapter.snapshot.dimensions.public_api_surfaces
      .surface_count,
    0,
  );
  assert.equal(
    profileCompleteness.summary.by_profile_level["directory-only"] > 0,
    true,
  );
  assert.equal(
    profileCompleteness.summary.by_profile_level.operational > 0,
    true,
  );
  assert.equal(
    profileCompleteness.summary.critical_gap_counts["missing-openapi"] > 0,
    true,
  );
  assert.equal(Array.isArray(adapterCandidates.candidates), true);
  assert.equal(
    adapterCandidates.summary.candidate_count,
    adapterCandidates.candidates.length,
  );
  assert.equal(
    adapterCandidates.candidates.every(
      (candidate) =>
        Array.isArray(candidate.operational_surface_ids) &&
        Array.isArray(candidate.candidate_api_ids) &&
        Array.isArray(candidate.candidate_api_kinds) &&
        Array.isArray(candidate.reason_codes) &&
        typeof candidate.recommended_adapter_kind === "string" &&
        typeof candidate.suggested_next_action === "string",
    ),
    true,
  );
  assert.equal(
    adapterCandidates.candidates.some((candidate) =>
      candidate.reason_codes.includes("openapi-surface"),
    ),
    true,
  );
  assert.equal(adapterCandidates.summary.openapi_backed_count > 0, true);
  assert.equal(Array.isArray(reviewDecisions.decisions), true);
  assert.equal(coverage.probed_count, native.subnets.length);
  const generatedSurfaces = surfaces.surfaces.filter(
    (surface) => surface.authority === "registry-observed",
  );
  assert.equal(generatedSurfaces.length > 0, true);
  assert.equal(
    generatedSurfaces.some((surface) => surface.verification !== undefined),
    false,
  );
  assert.deepEqual(
    subnets.subnets.map((subnet) => subnet.netuid),
    native.subnets.map((subnet) => subnet.netuid),
  );
  assert.equal(
    subnets.subnets.find((subnet) => subnet.netuid === 0).subnet_type,
    "root",
  );
  assert.equal(
    subnets.subnets.find((subnet) => subnet.netuid === 7).coverage_level,
    "probed",
  );
  assert.equal(
    subnets.subnets.find((subnet) => subnet.netuid === 74).coverage_level,
    "probed",
  );

  for (const subnet of native.subnets) {
    assert.equal(
      existsSync(artifactFilePath(`subnets/${subnet.netuid}.json`)),
      true,
    );
    assert.equal(
      existsSync(artifactFilePath(`health/subnets/${subnet.netuid}.json`)),
      true,
    );
    assert.equal(
      existsSync(artifactFilePath(`health/badges/${subnet.netuid}.json`)),
      true,
    );
    assert.equal(
      existsSync(artifactFilePath(`endpoints/${subnet.netuid}.json`)),
      true,
    );
    assert.equal(
      existsSync(artifactFilePath(`profiles/${subnet.netuid}.json`)),
      true,
    );
  }
});

test("R2-only generated artifacts stay out of the public git tree", () => {
  for (const relativePath of [
    "candidates.json",
    "profiles/7.json",
    "review-queue.json",
  ]) {
    assert.equal(
      existsSync(`${publicMetagraphRoot}/${relativePath}`),
      false,
      `${relativePath} should not be committed under public/metagraph`,
    );
    assert.equal(
      existsSync(`${r2StagingRoot}/${relativePath}`),
      true,
      `${relativePath} should be generated into the R2 staging tree`,
    );
  }
});

test("limited R2 upload dry run skips control manifests", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/r2-upload.mjs", "--dry-run"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        METAGRAPH_R2_UPLOAD_LIMIT: "5",
      },
      stdio: "pipe",
    },
  );
  const summary = JSON.parse(output);

  assert.equal(summary.limited_artifact_count, 5);
  assert.equal(summary.control_artifact_count, 0);
  assert.equal(summary.skipped_control_artifact_count, 3);
  assert.equal(summary.planned_object_count, 5);
});

test("Worker API serves public artifact envelopes", async () => {
  const env = createLocalArtifactEnv();

  const response = await handleRequest(
    new Request("https://metagraph.sh/api/v1/subnets/7"),
    env,
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(
    response.headers.get("x-metagraph-contract-version"),
    "2026-06-06.1",
  );
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.subnet.netuid, 7);
});

function readArtifact(relativePath) {
  return JSON.parse(readFileSync(artifactFilePath(relativePath), "utf8"));
}

function latestArtifactDate(relativePath) {
  return readdirSync(artifactDirectoryPath(relativePath))
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .map((file) => file.replace(/\.json$/, ""))
    .sort()
    .at(-1);
}

function snapshotSupportArtifacts() {
  return new Map(
    SUPPORT_ARTIFACT_PATHS.map((filePath) => [
      filePath,
      readFileSync(filePath, "utf8"),
    ]),
  );
}

function restoreSupportArtifacts(snapshot) {
  for (const [filePath, content] of snapshot) {
    writeFileSync(filePath, content);
  }
}
