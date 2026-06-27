import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildRpcEndpointArtifact,
  buildEndpointResourceArtifact,
  buildEndpointPoolArtifact,
  buildEndpointIncidentArtifact,
} from "../scripts/lib/endpoint-artifacts.mjs";

const GENERATED_AT = "2026-06-25T00:00:00.000Z";
const CONTRACT = "test-contract";

// --- buildRpcEndpointArtifact -----------------------------------------------

function rpcSurface(overrides = {}) {
  return {
    id: "s",
    netuid: 0,
    subnet_slug: "root",
    subnet_name: "Root",
    kind: "subtensor-rpc",
    url: "https://rpc.example.com",
    provider: "prov",
    authority: "official",
    auth_required: false,
    public_safe: true,
    source_urls: [],
    ...overrides,
  };
}

describe("buildRpcEndpointArtifact", () => {
  test("empty surfaces produce an empty, well-formed artifact", () => {
    const artifact = buildRpcEndpointArtifact({
      surfaces: [],
      generatedAt: GENERATED_AT,
      contractVersion: CONTRACT,
      source: "unit",
    });
    assert.equal(artifact.schema_version, 1);
    assert.equal(artifact.contract_version, CONTRACT);
    assert.equal(artifact.generated_at, GENERATED_AT);
    assert.equal(artifact.source, "unit");
    assert.deepEqual(artifact.endpoints, []);
    assert.equal(artifact.summary.endpoint_count, 0);
    assert.equal(artifact.summary.archive_supported_count, 0);
  });

  test("keeps only base-layer RPC/WSS kinds and folds in probe health", () => {
    const artifact = buildRpcEndpointArtifact({
      surfaces: [
        rpcSurface({ id: "s3", kind: "subnet-api", provider: "zeta" }), // excluded
        rpcSurface({
          id: "s2",
          kind: "subtensor-wss",
          provider: "beta",
          probe: { method: "rpc_methods" },
        }),
        rpcSurface({ id: "s1", kind: "subtensor-rpc", provider: "alpha" }),
      ],
      healthSurfaces: [
        {
          surface_id: "s1",
          status: "ok",
          classification: "live",
          verified_at: GENERATED_AT,
          archive_support: true,
          latest_block: 100,
          methods_supported: { a: true },
          rpc_method_count: 5,
          latency_ms: 50,
          method_tested: "system_health",
          last_ok: GENERATED_AT,
        },
      ],
      generatedAt: GENERATED_AT,
      contractVersion: CONTRACT,
      source: "unit",
    });

    // subnet-api filtered out; remaining two sorted by provider (alpha, beta).
    assert.deepEqual(
      artifact.endpoints.map((endpoint) => endpoint.id),
      ["s1", "s2"],
    );

    const s1 = artifact.endpoints[0];
    assert.equal(s1.status, "ok");
    assert.equal(s1.classification, "live");
    assert.equal(s1.archive_support, true);
    assert.equal(s1.latest_block, 100);
    assert.equal(s1.observed_at, GENERATED_AT);
    assert.equal(s1.health_source, "probe-derived");
    assert.equal(s1.health_stale, false);
    assert.equal(s1.method_tested, "system_health");
    assert.equal(s1.error, null);

    // No probe health for s2 → unknown + missing-probe fallbacks.
    const s2 = artifact.endpoints[1];
    assert.equal(s2.status, "unknown");
    assert.equal(s2.classification, "unknown");
    assert.equal(s2.latency_ms, null);
    assert.equal(s2.observed_at, null);
    assert.equal(s2.health_source, "missing-probe");
    assert.equal(s2.health_stale, true);
    assert.equal(s2.archive_support, null);
    assert.equal(s2.method_tested, "rpc_methods"); // falls back to probe.method

    assert.equal(artifact.summary.endpoint_count, 2);
    assert.deepEqual(artifact.summary.by_kind, {
      "subtensor-rpc": 1,
      "subtensor-wss": 1,
    });
    assert.deepEqual(artifact.summary.by_provider, { alpha: 1, beta: 1 });
    assert.deepEqual(artifact.summary.by_status, { ok: 1, unknown: 1 });
    assert.equal(artifact.summary.archive_supported_count, 1);
  });
});

// --- buildEndpointResourceArtifact ------------------------------------------

describe("buildEndpointResourceArtifact", () => {
  test("normalizes layers, monitoring policy, and publication state per surface", () => {
    const surfaces = [
      // r5 (netuid 8): openapi, probe disabled → not monitored, verified.
      {
        id: "r5",
        netuid: 8,
        kind: "openapi",
        url: "https://api.example.com/openapi.json",
        provider: "e",
        authority: "community",
        auth_required: false,
        public_safe: true,
        probe: { enabled: false },
      },
      // r1 (netuid 0): base-layer rpc, monitored, pool-eligible.
      {
        id: "r1",
        key: "rpc-key-1",
        netuid: 0,
        kind: "subtensor-rpc",
        url: "https://rpc.example.com",
        provider: "a",
        authority: "official",
        auth_required: false,
        public_safe: true,
        probe: {
          enabled: true,
          method: "JSON-RPC",
          expect: "200",
          timeout_ms: 5000,
        },
      },
      // r3 (netuid 6): data-artifact, public_safe false → disabled, not monitored.
      {
        id: "r3",
        netuid: 6,
        kind: "data-artifact",
        url: "https://data.example.com/x.json",
        provider: "c",
        authority: "community",
        auth_required: false,
        public_safe: false,
        probe: { enabled: true },
      },
      // r2 (netuid 5): subnet-api, monitored but not base-layer → monitored state.
      {
        id: "r2",
        netuid: 5,
        kind: "subnet-api",
        url: "https://api.example.com/v1",
        provider: "b",
        authority: "community",
        auth_required: false,
        public_safe: true,
        probe: { enabled: true, method: "GET" },
      },
      // r4 (netuid 7): docs, no probe → not-configured policy, verified.
      {
        id: "r4",
        netuid: 7,
        kind: "docs",
        url: "https://docs.example.com",
        provider: "d",
        authority: "community",
        auth_required: false,
        public_safe: true,
      },
    ];
    const artifact = buildEndpointResourceArtifact({
      surfaces,
      healthSurfaces: [
        {
          surface_id: "r1",
          status: "ok",
          classification: "live",
          verified_at: GENERATED_AT,
          archive_support: true,
          latest_block: 100,
          methods_supported: { a: true, b: true },
          rpc_method_count: 7,
          latency_ms: 50,
        },
        {
          surface_id: "r2",
          status: "ok",
          classification: "live",
          verified_at: GENERATED_AT,
          methods_supported: ["m1", "m2", "m3"],
          latency_ms: 10,
        },
      ],
      generatedAt: GENERATED_AT,
      contractVersion: CONTRACT,
      source: "unit",
    });

    // Sorted by netuid ascending.
    assert.deepEqual(
      artifact.endpoints.map((endpoint) => endpoint.surface_id),
      ["r1", "r2", "r3", "r4", "r5"],
    );

    const byId = new Map(
      artifact.endpoints.map((endpoint) => [endpoint.surface_id, endpoint]),
    );

    const r1 = byId.get("r1");
    assert.equal(r1.id, "endpoint-rpc-key-1"); // surface.key wins over surfaceStableKey
    assert.equal(r1.layer, "bittensor-base");
    assert.equal(r1.monitoring_status, "monitored");
    assert.equal(r1.publication_state, "pool-eligible");
    assert.equal(r1.pool_eligible, true);
    assert.deepEqual(r1.pool_eligibility_reasons, ["eligible"]);
    assert.equal(r1.status, "ok");
    assert.equal(r1.health_source, "probe-derived");
    assert.equal(r1.monitoring_policy.enabled, true);
    assert.equal(r1.monitoring_policy.method, "JSON-RPC");
    assert.equal(r1.monitoring_policy.source, "surface-probe-config");
    // Object method-support path: ok 50 + archive 15 + block 10 + methods 10 + latency 19.
    assert.equal(r1.score, 104);

    const r2 = byId.get("r2");
    assert.equal(r2.layer, "subnet-app");
    assert.equal(r2.monitoring_status, "monitored");
    assert.equal(r2.publication_state, "monitored");
    assert.equal(r2.pool_eligible, false);
    assert.ok(r2.pool_eligibility_reasons.includes("not-bittensor-base-layer"));
    // Array method-support path: ok 50 + methods 15 + latency 20.
    assert.equal(r2.score, 85);

    const r3 = byId.get("r3");
    assert.equal(r3.layer, "data-provider");
    assert.equal(r3.monitoring_status, "not_monitored");
    assert.equal(r3.publication_state, "disabled");
    assert.equal(r3.status, "unknown");
    assert.equal(r3.classification, "unknown");
    assert.equal(r3.health_source, "not-monitored");
    assert.equal(r3.health_stale, false);

    const r4 = byId.get("r4");
    assert.equal(r4.layer, "docs-provider");
    assert.equal(r4.publication_state, "verified");
    assert.equal(r4.monitoring_policy.enabled, false);
    assert.equal(r4.monitoring_policy.source, "not-configured");

    const r5 = byId.get("r5");
    assert.equal(r5.layer, "subnet-app");
    assert.equal(r5.publication_state, "verified");
    assert.equal(r5.monitoring_policy.enabled, false);
    assert.equal(r5.monitoring_policy.source, "surface-probe-config");
    assert.ok(r5.id.startsWith("endpoint-srf-")); // no key → surfaceStableKey

    assert.equal(artifact.summary.endpoint_count, 5);
    assert.equal(artifact.summary.monitored_count, 2);
    assert.equal(artifact.summary.pool_eligible_count, 1);
  });
});

// --- buildEndpointPoolArtifact ----------------------------------------------

describe("buildEndpointPoolArtifact", () => {
  test("empty source builds three empty finney pools from the rpc lane", () => {
    const artifact = buildEndpointPoolArtifact({
      generatedAt: GENERATED_AT,
      contractVersion: CONTRACT,
    });
    assert.equal(artifact.source, "rpc-endpoint-probes");
    assert.equal(artifact.disabled_proxy_contract.enabled, false);
    assert.equal(artifact.eligibility_policy.source, "probe-derived");
    assert.deepEqual(artifact.provider_scores, []);
    assert.deepEqual(
      artifact.pools.map((pool) => pool.id),
      ["finney-rpc", "finney-wss", "finney-archive"],
    );
    for (const pool of artifact.pools) {
      assert.equal(pool.endpoint_count, 0);
      assert.equal(pool.best_endpoint_id, null);
    }
  });

  test("falls back to the rpc artifact and labels its source", () => {
    const artifact = buildEndpointPoolArtifact({
      generatedAt: GENERATED_AT,
      contractVersion: CONTRACT,
      rpcArtifact: {
        endpoints: [
          {
            id: "endpoint-rpc",
            kind: "subtensor-rpc",
            status: "ok",
            auth_required: false,
            public_safe: true,
            provider: "alpha",
            url: "https://rpc.example.com",
          },
        ],
      },
    });
    assert.equal(artifact.source, "rpc-endpoint-probes");
    // The endpoint flows into the pool — proving the fallback reads rpcArtifact.
    const rpcPool = artifact.pools.find((pool) => pool.id === "finney-rpc");
    assert.equal(rpcPool.endpoint_count, 1);
    assert.equal(rpcPool.best_endpoint_id, "endpoint-rpc");
  });

  test("scores and pools endpoints, appends configured testnet pools", () => {
    const endpointArtifact = {
      endpoints: [
        {
          id: "endpoint-a",
          kind: "subtensor-rpc",
          status: "ok",
          auth_required: false,
          public_safe: true,
          archive_support: true,
          latest_block: 100,
          methods_supported: { a: true, b: true },
          latency_ms: 50,
          provider: "alpha",
          monitoring_status: "monitored",
          url: "https://rpc-a.example.com",
        },
        {
          id: "endpoint-b",
          kind: "subtensor-wss",
          status: "degraded",
          auth_required: true,
          public_safe: true,
          provider: "beta",
          monitoring_status: "monitored",
          url: "wss://wss-b.example.com",
        },
        {
          id: "endpoint-c",
          kind: "subtensor-rpc",
          status: "failed",
          auth_required: false,
          public_safe: true,
          provider: "gamma",
          monitoring_status: "monitored",
          url: "https://rpc-c.example.com",
        },
      ],
    };
    const testnetEndpoints = [
      {
        id: "t-rpc",
        kind: "subtensor-rpc",
        status: "ok",
        pool_eligible: true,
        score: 90,
        provider: "tnet",
        url: "https://test-rpc.example.com",
        latency_ms: 20,
      },
      {
        id: "t-wss",
        kind: "subtensor-wss",
        status: "ok",
        pool_eligible: true,
        score: 80,
        provider: "tnet",
        url: "wss://test-wss.example.com",
        latency_ms: 30,
      },
    ];

    const artifact = buildEndpointPoolArtifact({
      generatedAt: GENERATED_AT,
      contractVersion: CONTRACT,
      endpointArtifact,
      testnetEndpoints,
    });

    assert.equal(artifact.source, "endpoint-resource-probes");
    assert.deepEqual(
      artifact.pools.map((pool) => pool.id),
      ["finney-rpc", "finney-wss", "finney-archive", "test-rpc", "test-wss"],
    );

    const poolsById = new Map(artifact.pools.map((pool) => [pool.id, pool]));
    const rpcPool = poolsById.get("finney-rpc");
    assert.equal(rpcPool.endpoint_count, 2); // endpoint-a + endpoint-c
    assert.equal(rpcPool.eligible_count, 1); // only endpoint-a is ok + no auth
    assert.equal(rpcPool.best_endpoint_id, "endpoint-a");
    // The pool builder recomputes eligibility: ok + no-auth → eligible; failed → not.
    const rpcById = new Map(
      rpcPool.endpoints.map((endpoint) => [endpoint.id, endpoint]),
    );
    assert.equal(rpcById.get("endpoint-a").pool_eligible, true);
    assert.equal(rpcById.get("endpoint-c").pool_eligible, false);

    const wssPool = poolsById.get("finney-wss");
    assert.equal(wssPool.endpoint_count, 1);
    assert.equal(wssPool.eligible_count, 0);
    assert.equal(wssPool.best_endpoint_id, null);

    const archivePool = poolsById.get("finney-archive");
    assert.equal(archivePool.endpoint_count, 1); // only the archive_support endpoint
    assert.equal(archivePool.best_endpoint_id, "endpoint-a");

    assert.equal(poolsById.get("test-rpc").endpoint_count, 1);
    assert.equal(poolsById.get("test-wss").endpoint_count, 1);

    // Provider scores: alpha is fully operational, beta/gamma score 0.
    assert.equal(artifact.provider_scores[0].provider, "alpha");
    assert.equal(artifact.provider_scores[0].operational_score, 90);
    assert.equal(artifact.provider_scores[0].average_score, 104);
    const beta = artifact.provider_scores.find(
      (row) => row.provider === "beta",
    );
    assert.equal(beta.operational_score, 0);
    assert.equal(beta.degraded_count, 1);
    const gamma = artifact.provider_scores.find(
      (row) => row.provider === "gamma",
    );
    assert.equal(gamma.operational_score, 0);
    assert.equal(gamma.failed_count, 1);
  });

  test("omits testnet pools when no testnet endpoint of that kind is configured", () => {
    const artifact = buildEndpointPoolArtifact({
      generatedAt: GENERATED_AT,
      contractVersion: CONTRACT,
      endpointArtifact: { endpoints: [] },
      testnetEndpoints: [
        {
          id: "t-rpc",
          kind: "subtensor-rpc",
          status: "ok",
          pool_eligible: true,
          score: 90,
          provider: "tnet",
          url: "https://test-rpc.example.com",
        },
      ],
    });
    const ids = artifact.pools.map((pool) => pool.id);
    assert.ok(ids.includes("test-rpc"));
    assert.ok(!ids.includes("test-wss"));
  });
});

// --- buildEndpointIncidentArtifact ------------------------------------------

describe("buildEndpointIncidentArtifact", () => {
  test("nullish endpoint artifact yields zero incidents", () => {
    const artifact = buildEndpointIncidentArtifact({
      endpointArtifact: null,
      generatedAt: GENERATED_AT,
      contractVersion: CONTRACT,
    });
    assert.deepEqual(artifact.incidents, []);
    assert.equal(artifact.summary.incident_count, 0);
    assert.equal(artifact.summary.active_count, 0);
  });

  test("only monitored, callable, failed/degraded endpoints become incidents", () => {
    const endpointArtifact = {
      endpoints: [
        {
          id: "e1",
          kind: "subtensor-rpc",
          monitoring_status: "monitored",
          status: "failed",
          error: "connection refused",
          classification: "dead",
          netuid: 0,
          subnet_slug: "root",
          subnet_name: "Root",
          layer: "bittensor-base",
          provider: "p",
          operator: "p",
          observed_at: GENERATED_AT,
          last_checked: GENERATED_AT,
          last_ok: null,
        },
        {
          id: "e2",
          kind: "subnet-api",
          monitoring_status: "monitored",
          status: "degraded",
          classification: "content-mismatch",
          netuid: 5,
          layer: "subnet-app",
          provider: "q",
          operator: "q",
        },
        {
          id: "e3",
          kind: "sse",
          monitoring_status: "monitored",
          status: "degraded",
          netuid: 7,
          layer: "subnet-app",
          provider: "r",
          operator: "r",
        },
        // Excluded: not a callable kind.
        {
          id: "e4",
          kind: "website",
          monitoring_status: "monitored",
          status: "failed",
          netuid: 9,
        },
        // Excluded: not monitored.
        {
          id: "e5",
          kind: "subtensor-rpc",
          monitoring_status: "not_monitored",
          status: "failed",
          netuid: 10,
        },
        // Excluded: healthy.
        {
          id: "e6",
          kind: "subtensor-rpc",
          monitoring_status: "monitored",
          status: "ok",
          netuid: 11,
        },
      ],
    };
    const artifact = buildEndpointIncidentArtifact({
      endpointArtifact,
      generatedAt: GENERATED_AT,
      contractVersion: CONTRACT,
    });

    assert.equal(artifact.incidents.length, 3);
    // Critical (failed) sorts ahead of warnings; warnings then sort by netuid.
    assert.deepEqual(
      artifact.incidents.map((incident) => incident.endpoint_id),
      ["e1", "e2", "e3"],
    );

    const inc1 = artifact.incidents[0];
    assert.equal(inc1.id, "incident-e1");
    assert.equal(inc1.severity, "critical");
    assert.equal(inc1.reason, "connection refused"); // error wins
    assert.equal(inc1.state, "active");
    assert.equal(inc1.user_reported, false);
    assert.equal(inc1.pool_eligible, false);

    // No error → falls back to classification.
    const inc2 = artifact.incidents[1];
    assert.equal(inc2.severity, "warning");
    assert.equal(inc2.reason, "content-mismatch");

    // No error and no classification → status sentence.
    const inc3 = artifact.incidents[2];
    assert.equal(inc3.reason, "degraded endpoint probe result");

    assert.equal(artifact.summary.incident_count, 3);
    assert.equal(artifact.summary.active_count, 3);
    assert.deepEqual(artifact.summary.by_severity, {
      critical: 1,
      warning: 2,
    });
    assert.deepEqual(artifact.summary.by_kind, {
      "subnet-api": 1,
      sse: 1,
      "subtensor-rpc": 1,
    });
  });
});
