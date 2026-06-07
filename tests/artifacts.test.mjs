import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { artifactFilePath, createLocalArtifactEnv } from "../scripts/lib.mjs";
import { handleRequest } from "../workers/api.mjs";

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
  const healthHistory = readArtifact("health/history/2026-06-06.json");
  const rpcEndpoints = readArtifact("rpc-endpoints.json");
  const endpoints = readArtifact("endpoints.json");
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
  const adapterCandidates = readArtifact("review/adapter-candidates.json");
  const reviewDecisions = readArtifact("review/maintainer-decisions.json");

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
  assert.equal(healthHistory.date, "2026-06-06");
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
  assert.equal(verification.results.length, candidates.candidates.length);
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
  assert.equal(Array.isArray(adapterCandidates.candidates), true);
  assert.equal(Array.isArray(reviewDecisions.decisions), true);
  assert.equal(coverage.probed_count, native.subnets.length);
  assert.equal(
    surfaces.surfaces.filter(
      (surface) =>
        surface.authority === "registry-observed" && !surface.verification,
    ).length,
    0,
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
  assert.equal(summary.skipped_control_artifact_count, 2);
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
