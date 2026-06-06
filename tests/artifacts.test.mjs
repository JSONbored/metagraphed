import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vitest";
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

test("public artifacts are internally consistent", () => {
  const native = JSON.parse(
    readFileSync("registry/native/finney-subnets.json", "utf8"),
  );
  const subnets = JSON.parse(
    readFileSync("public/metagraph/subnets.json", "utf8"),
  );
  const surfaces = JSON.parse(
    readFileSync("public/metagraph/surfaces.json", "utf8"),
  );
  const candidates = JSON.parse(
    readFileSync("public/metagraph/candidates.json", "utf8"),
  );
  const curation = JSON.parse(
    readFileSync("public/metagraph/curation.json", "utf8"),
  );
  const gaps = JSON.parse(readFileSync("public/metagraph/gaps.json", "utf8"));
  const reviewQueue = JSON.parse(
    readFileSync("public/metagraph/review-queue.json", "utf8"),
  );
  const verification = JSON.parse(
    readFileSync("public/metagraph/verification/latest.json", "utf8"),
  );
  const health = JSON.parse(
    readFileSync("public/metagraph/health/latest.json", "utf8"),
  );
  const healthSummary = JSON.parse(
    readFileSync("public/metagraph/health/summary.json", "utf8"),
  );
  const healthHistory = JSON.parse(
    readFileSync("public/metagraph/health/history/2026-06-06.json", "utf8"),
  );
  const rpcEndpoints = JSON.parse(
    readFileSync("public/metagraph/rpc-endpoints.json", "utf8"),
  );
  const coverage = JSON.parse(
    readFileSync("public/metagraph/coverage.json", "utf8"),
  );
  const contracts = JSON.parse(
    readFileSync("public/metagraph/contracts.json", "utf8"),
  );
  const apiIndex = JSON.parse(
    readFileSync("public/metagraph/api-index.json", "utf8"),
  );
  const changelog = JSON.parse(
    readFileSync("public/metagraph/changelog.json", "utf8"),
  );
  const search = JSON.parse(
    readFileSync("public/metagraph/search.json", "utf8"),
  );
  const freshness = JSON.parse(
    readFileSync("public/metagraph/freshness.json", "utf8"),
  );
  const sourceHealth = JSON.parse(
    readFileSync("public/metagraph/source-health.json", "utf8"),
  );
  const sourceSnapshots = JSON.parse(
    readFileSync("public/metagraph/source-snapshots.json", "utf8"),
  );
  const evidenceLedger = JSON.parse(
    readFileSync("public/metagraph/evidence-ledger.json", "utf8"),
  );
  const endpointPools = JSON.parse(
    readFileSync("public/metagraph/rpc/pools.json", "utf8"),
  );
  const r2Manifest = JSON.parse(
    readFileSync("public/metagraph/r2-manifest.json", "utf8"),
  );
  const schemaDrift = JSON.parse(
    readFileSync("public/metagraph/schema-drift.json", "utf8"),
  );
  const schemaIndex = JSON.parse(
    readFileSync("public/metagraph/schemas/index.json", "utf8"),
  );
  const reviewCuration = JSON.parse(
    readFileSync("public/metagraph/review/curation.json", "utf8"),
  );
  const gapPriorities = JSON.parse(
    readFileSync("public/metagraph/review/gap-priorities.json", "utf8"),
  );
  const adapterCandidates = JSON.parse(
    readFileSync("public/metagraph/review/adapter-candidates.json", "utf8"),
  );
  const reviewDecisions = JSON.parse(
    readFileSync("public/metagraph/review/maintainer-decisions.json", "utf8"),
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
      existsSync(`public/metagraph/subnets/${subnet.netuid}.json`),
      true,
    );
    assert.equal(
      existsSync(`public/metagraph/health/subnets/${subnet.netuid}.json`),
      true,
    );
    assert.equal(
      existsSync(`public/metagraph/health/badges/${subnet.netuid}.json`),
      true,
    );
  }
});

test("Worker API serves public artifact envelopes", async () => {
  const env = {
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        const path = `public${url.pathname}`;
        if (!existsSync(path)) {
          return new Response("not found", { status: 404 });
        }
        return new Response(readFileSync(path), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    },
  };

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
