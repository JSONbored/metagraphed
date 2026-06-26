// Endpoint artifact derivation, extracted verbatim from scripts/lib.mjs (#510
// maintainability decomposition). These build the RPC-endpoint, endpoint-resource,
// endpoint-pool, and endpoint-incident artifacts from curated surfaces + probe
// health. Pure + side-effect free: every function takes plain objects and returns
// plain objects, with no module state and no I/O, so the output is byte-identical
// to the in-lib.mjs originals. Re-exported from scripts/lib.mjs so existing
// importers keep their import paths unchanged.
//
// The only cross-module dependency is `surfaceStableKey` (a hoisted function
// export of scripts/lib.mjs). lib.mjs re-exports this module, so the two form an
// ES-module cycle — safe here because the import is consumed only at call time
// (inside buildEndpointResourceArtifact), never during module evaluation.
import { evidenceSourceUrls, surfaceStableKey } from "../lib.mjs";

export function buildRpcEndpointArtifact({
  surfaces,
  healthSurfaces = [],
  generatedAt,
  contractVersion,
  source,
}) {
  const healthBySurface = new Map(
    healthSurfaces.map((surface) => [surface.surface_id, surface]),
  );
  const endpoints = surfaces
    .filter((surface) =>
      ["subtensor-rpc", "subtensor-wss"].includes(surface.kind),
    )
    .map((surface) => {
      const health = healthBySurface.get(surface.id) || {};
      const healthMeta = endpointHealthMetadata({
        health,
        monitored: true,
      });
      return {
        id: surface.id,
        netuid: surface.netuid,
        subnet_slug: surface.subnet_slug,
        subnet_name: surface.subnet_name,
        chain: "bittensor",
        network: "finney",
        kind: surface.kind,
        url: surface.url,
        provider: surface.provider,
        authority: surface.authority,
        auth_required: surface.auth_required,
        public_safe: surface.public_safe,
        archive_support: health.archive_support ?? null,
        latest_block: health.latest_block ?? null,
        methods_supported: health.methods_supported || null,
        rpc_method_count: health.rpc_method_count ?? null,
        method_tested: health.method_tested || surface.probe?.method || null,
        status: health.status || "unknown",
        classification: health.classification || "unknown",
        latency_ms: health.latency_ms ?? null,
        observed_at: healthMeta.observed_at,
        health_source: healthMeta.health_source,
        health_stale: healthMeta.health_stale,
        last_ok: healthMeta.last_ok,
        last_checked: healthMeta.last_checked,
        error: health.error || null,
        rate_limit_notes: surface.rate_limit_notes || null,
        source_urls: evidenceSourceUrls(surface),
      };
    })
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source,
    notes:
      "Bittensor base-layer RPC endpoints only. These are chain-level surfaces, not subnet application APIs.",
    summary: {
      endpoint_count: endpoints.length,
      by_kind: countRecord(endpoints, (endpoint) => endpoint.kind),
      by_provider: countRecord(endpoints, (endpoint) => endpoint.provider),
      by_status: countRecord(endpoints, (endpoint) => endpoint.status),
      archive_supported_count: endpoints.filter(
        (endpoint) => endpoint.archive_support === true,
      ).length,
    },
    endpoints,
  };
}

export function buildEndpointResourceArtifact({
  surfaces,
  healthSurfaces = [],
  generatedAt,
  contractVersion,
  source,
}) {
  const healthBySurface = new Map(
    healthSurfaces.map((surface) => [surface.surface_id, surface]),
  );
  const endpoints = surfaces.map((surface) => {
    const surfaceKey = surface.key || surfaceStableKey(surface);
    const health = healthBySurface.get(surface.id) || {};
    const monitored = surface.probe?.enabled === true && surface.public_safe;
    const healthMeta = endpointHealthMetadata({
      health,
      monitored,
    });
    const scoreBreakdown = endpointScoreBreakdown({
      ...surface,
      ...health,
      status: health.status || "unknown",
    });
    const poolEligibility = endpointPoolEligibility({
      ...surface,
      status: health.status || "unknown",
    });

    return {
      id: `endpoint-${surfaceKey}`,
      surface_id: surface.id,
      surface_key: surfaceKey,
      netuid: surface.netuid,
      subnet_slug: surface.subnet_slug,
      subnet_name: surface.subnet_name,
      chain: "bittensor",
      network: "finney",
      layer: endpointLayer(surface.kind),
      kind: surface.kind,
      url: surface.url,
      provider: surface.provider,
      operator: surface.provider,
      authority: surface.authority,
      auth_required: surface.auth_required,
      public_safe: surface.public_safe,
      monitoring_policy: endpointMonitoringPolicy(surface),
      monitoring_status: monitored ? "monitored" : "not_monitored",
      publication_state: endpointPublicationState({
        monitored,
        poolEligible: poolEligibility.eligible,
        surface,
      }),
      pool_eligible: poolEligibility.eligible,
      pool_eligibility_reasons: poolEligibility.reasons,
      archive_support: health.archive_support ?? null,
      latest_block: health.latest_block ?? null,
      method_support: health.methods_supported || null,
      rpc_method_count: health.rpc_method_count ?? null,
      method_tested: health.method_tested || surface.probe?.method || null,
      status: monitored ? health.status || "unknown" : "unknown",
      classification: monitored
        ? health.classification || "unknown"
        : "unknown",
      latency_ms: monitored ? (health.latency_ms ?? null) : null,
      observed_at: healthMeta.observed_at,
      health_source: healthMeta.health_source,
      health_stale: healthMeta.health_stale,
      score: scoreBreakdown.score,
      score_reasons: scoreBreakdown.reasons,
      last_ok: healthMeta.last_ok,
      last_checked: healthMeta.last_checked,
      error: monitored ? health.error || null : null,
      rate_limit_notes: surface.rate_limit_notes || null,
      source_urls: evidenceSourceUrls(surface),
    };
  });

  endpoints.sort(
    (a, b) =>
      a.netuid - b.netuid ||
      a.layer.localeCompare(b.layer) ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source,
    notes: [
      "Endpoint resources are normalized from curated public surfaces.",
      "Observed health, latency, and pool eligibility are probe-derived only.",
      "Subnet application APIs are heterogeneous and are not proxied in v1.",
    ],
    summary: {
      endpoint_count: endpoints.length,
      monitored_count: endpoints.filter(
        (endpoint) => endpoint.monitoring_status === "monitored",
      ).length,
      pool_eligible_count: endpoints.filter(
        (endpoint) => endpoint.pool_eligible,
      ).length,
      by_kind: countRecord(endpoints, (endpoint) => endpoint.kind),
      by_layer: countRecord(endpoints, (endpoint) => endpoint.layer),
      by_provider: countRecord(endpoints, (endpoint) => endpoint.provider),
      by_publication_state: countRecord(
        endpoints,
        (endpoint) => endpoint.publication_state,
      ),
      by_status: countRecord(endpoints, (endpoint) => endpoint.status),
    },
    endpoints,
  };
}

export function buildEndpointPoolArtifact({
  generatedAt,
  contractVersion,
  rpcArtifact = null,
  endpointArtifact = null,
  // Static, non-default-network base-layer RPC endpoints (e.g. testnet). These
  // are NOT probe-derived: they carry static pool_eligible/score so /rpc/v1/{net}
  // can route immediately, with the proxy's in-isolate breaker + failover handling
  // liveness. Shape matches the mapped `endpoints` below (see test-base-endpoints).
  testnetEndpoints = [],
}) {
  const sourceArtifact = endpointArtifact || rpcArtifact || { endpoints: [] };
  const endpoints = (sourceArtifact.endpoints || []).map((endpoint) => {
    const scoreBreakdown = endpointScoreBreakdown(endpoint);
    const poolEligibility = endpointPoolEligibility(endpoint);
    return {
      ...endpoint,
      score: scoreBreakdown.score,
      score_reasons: endpoint.score_reasons || scoreBreakdown.reasons,
      pool_eligible: poolEligibility.eligible,
      pool_eligibility_reasons:
        endpoint.pool_eligibility_reasons || poolEligibility.reasons,
      unsafe_methods_blocked: true,
    };
  });

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: endpointArtifact
      ? "endpoint-resource-probes"
      : "rpc-endpoint-probes",
    notes: [
      "Endpoint pools are advisory only in v1.",
      "Future proxy/load-balancer routes must block write and unsafe RPC methods by default.",
      "Only Bittensor base-layer RPC/WSS endpoints are pool candidates in v1.",
    ],
    disabled_proxy_contract: {
      enabled: false,
      allowed_methods: [
        "chain_getHeader",
        "chain_getBlockHash",
        "system_health",
        "rpc_methods",
      ],
      denied_method_patterns: [
        "author_",
        "state_call",
        "sudo_",
        "payment_",
        "contracts_",
      ],
      feature_flag: "METAGRAPH_ENABLE_RPC_PROXY",
      rate_limit_required: true,
      waf_required: true,
    },
    eligibility_policy: {
      source: "probe-derived",
      eligible_layers: ["bittensor-base"],
      required_status: "ok",
      requires_public_safe: true,
      requires_no_auth: true,
      user_reports_can_change_health: false,
      notes:
        "Pool eligibility is derived from monitored endpoint state only. Contributor reports can trigger review or re-probes, but cannot set health or uptime.",
    },
    provider_scores: endpointProviderScores(endpoints),
    pools: [
      endpointPool("finney-rpc", "subtensor-rpc", endpoints),
      endpointPool("finney-wss", "subtensor-wss", endpoints),
      endpointPool(
        "finney-archive",
        "archive",
        endpoints.filter((endpoint) => endpoint.archive_support === true),
      ),
      // Testnet base-layer pools (registry/native/test-base-endpoints.json).
      // test-rpc is the proxy target (/rpc/v1/test); test-wss is reference-only
      // (the HTTP proxy can't proxy WSS), parity with finney-wss. Each appended
      // only when that kind is configured, so no empty pools.
      ...(testnetEndpoints.some((endpoint) => endpoint.kind === "subtensor-rpc")
        ? [endpointPool("test-rpc", "subtensor-rpc", testnetEndpoints)]
        : []),
      ...(testnetEndpoints.some((endpoint) => endpoint.kind === "subtensor-wss")
        ? [endpointPool("test-wss", "subtensor-wss", testnetEndpoints)]
        : []),
    ],
  };
}

function endpointPool(id, kind, endpoints) {
  const poolEndpoints = endpoints
    .filter((endpoint) => kind === "archive" || endpoint.kind === kind)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.latency_ms ?? 999999) - (b.latency_ms ?? 999999) ||
        a.id.localeCompare(b.id),
    );
  return {
    id,
    kind,
    endpoint_count: poolEndpoints.length,
    eligible_count: poolEndpoints.filter((endpoint) => endpoint.pool_eligible)
      .length,
    best_endpoint_id:
      poolEndpoints.find((endpoint) => endpoint.pool_eligible)?.id || null,
    endpoints: poolEndpoints.map((endpoint) => ({
      archive_support: endpoint.archive_support,
      id: endpoint.id,
      surface_id: endpoint.surface_id,
      surface_key: endpoint.surface_key,
      kind: endpoint.kind,
      layer: endpoint.layer || endpointLayer(endpoint.kind),
      health_source: endpoint.health_source || "missing-probe",
      health_stale: endpoint.health_stale ?? endpoint.status !== "ok",
      latency_ms: endpoint.latency_ms,
      latest_block: endpoint.latest_block,
      observed_at: endpoint.observed_at || endpoint.last_checked || null,
      pool_eligible: endpoint.pool_eligible,
      provider: endpoint.provider,
      score: endpoint.score,
      score_reasons: endpoint.score_reasons || [],
      status: endpoint.status,
      url: endpoint.url,
      last_ok: endpoint.last_ok || null,
      pool_eligibility_reasons: endpoint.pool_eligibility_reasons || [],
    })),
  };
}

// Only callable infrastructure (RPC/WSS + the agent-callable surface kinds) can
// have a meaningful "down" incident. Docs / dashboards / websites / repos are
// reference links, not endpoints — a website that returns HTML probes as
// "unsupported" and must NOT be reported as an incident.
const CALLABLE_ENDPOINT_KINDS = new Set([
  "subtensor-rpc",
  "subtensor-wss",
  "subnet-api",
  "openapi",
  "sse",
  "data-artifact",
]);

export function buildEndpointIncidentArtifact({
  endpointArtifact,
  generatedAt,
  contractVersion,
}) {
  const endpoints = endpointArtifact?.endpoints || [];
  const incidents = endpoints
    .filter((endpoint) => CALLABLE_ENDPOINT_KINDS.has(endpoint.kind))
    .filter((endpoint) => endpoint.monitoring_status === "monitored")
    .filter((endpoint) => ["failed", "degraded"].includes(endpoint.status))
    .map((endpoint) => {
      const severity = endpoint.status === "failed" ? "critical" : "warning";
      const reason =
        endpoint.error ||
        endpoint.classification ||
        `${endpoint.status} endpoint probe result`;
      return {
        id: `incident-${endpoint.id}`,
        endpoint_id: endpoint.id,
        surface_id: endpoint.surface_id,
        surface_key: endpoint.surface_key,
        netuid: endpoint.netuid,
        subnet_slug: endpoint.subnet_slug,
        subnet_name: endpoint.subnet_name,
        layer: endpoint.layer,
        kind: endpoint.kind,
        provider: endpoint.provider,
        operator: endpoint.operator,
        status: endpoint.status,
        classification: endpoint.classification,
        observed_at: endpoint.observed_at || endpoint.last_checked || null,
        health_source: endpoint.health_source || "probe-derived",
        health_stale: endpoint.health_stale ?? endpoint.status !== "ok",
        severity,
        state: "active",
        reason,
        detected_at: endpoint.last_checked || generatedAt,
        last_ok: endpoint.last_ok || null,
        last_checked: endpoint.last_checked,
        pool_eligible: false,
        user_reported: false,
        source: "probe-derived",
      };
    })
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        a.netuid - b.netuid ||
        a.kind.localeCompare(b.kind) ||
        a.endpoint_id.localeCompare(b.endpoint_id),
    );

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: "endpoint-resource-probes",
    notes: [
      "Endpoint incidents are generated from observed probe state only.",
      "Contributor reports can create review or re-probe work, but cannot set uptime, latency, health, or pool eligibility.",
      "Resolved incident history is expected to live in R2/D1 once persistent probe history is enabled.",
    ],
    summary: {
      incident_count: incidents.length,
      active_count: incidents.filter((incident) => incident.state === "active")
        .length,
      by_kind: countRecord(incidents, (incident) => incident.kind),
      by_layer: countRecord(incidents, (incident) => incident.layer),
      by_provider: countRecord(incidents, (incident) => incident.provider),
      by_severity: countRecord(incidents, (incident) => incident.severity),
      by_status: countRecord(incidents, (incident) => incident.status),
    },
    incidents,
  };
}

function endpointLayer(kind) {
  if (isBaseLayerEndpoint(kind) || kind === "archive") {
    return "bittensor-base";
  }
  if (
    ["subnet-api", "openapi", "sse", "dashboard", "sdk", "example"].includes(
      kind,
    )
  ) {
    return "subnet-app";
  }
  if (kind === "data-artifact") {
    return "data-provider";
  }
  return "docs-provider";
}

function endpointHealthMetadata({ health, monitored }) {
  if (!monitored) {
    return {
      observed_at: null,
      health_source: "not-monitored",
      health_stale: false,
      last_checked: null,
      last_ok: null,
    };
  }

  const observedAt = health.verified_at || health.last_checked || null;
  const lastOk = health.last_ok || (health.status === "ok" ? observedAt : null);

  return {
    observed_at: observedAt,
    health_source: observedAt ? "probe-derived" : "missing-probe",
    health_stale: observedAt === null,
    last_checked: observedAt,
    last_ok: lastOk,
  };
}

function isBaseLayerEndpoint(kind) {
  return ["subtensor-rpc", "subtensor-wss"].includes(kind);
}

function endpointMonitoringPolicy(surface) {
  if (!surface.probe) {
    return {
      enabled: false,
      method: null,
      expect: null,
      source: "not-configured",
    };
  }
  return {
    enabled: surface.probe.enabled === true,
    method: surface.probe.method || null,
    expect: surface.probe.expect || null,
    timeout_ms: surface.probe.timeout_ms || null,
    source: "surface-probe-config",
  };
}

function endpointPublicationState({ monitored, poolEligible, surface }) {
  if (surface.public_safe !== true) {
    return "disabled";
  }
  if (poolEligible) {
    return "pool-eligible";
  }
  if (monitored) {
    return "monitored";
  }
  return "verified";
}

function endpointScoreBreakdown(endpoint) {
  let score = 0;
  const reasons = [];
  function add(reason, points) {
    score += points;
    reasons.push({ reason, points });
  }

  if (endpoint.status === "ok") add("status-ok", 50);
  if (endpoint.archive_support === true) add("archive-support", 15);
  if (endpoint.latest_block) add("latest-block-observed", 10);
  const methodSupport = endpoint.methods_supported || endpoint.method_support;
  if (
    methodSupport &&
    typeof methodSupport === "object" &&
    !Array.isArray(methodSupport)
  ) {
    add(
      "method-support",
      Math.min(Object.values(methodSupport).filter(Boolean).length * 5, 20),
    );
  } else if (Array.isArray(methodSupport)) {
    add("method-support", Math.min(methodSupport.length * 5, 20));
  }
  if (Number.isFinite(endpoint.latency_ms))
    add("latency", Math.max(0, 20 - Math.round(endpoint.latency_ms / 100)));
  if (endpoint.auth_required) add("auth-required", -25);
  if (endpoint.status === "degraded") add("status-degraded", -10);
  if (endpoint.status === "failed") add("status-failed", -50);

  return {
    score: Math.max(0, score),
    reasons: reasons.filter((reason) => reason.points !== 0),
  };
}

function endpointPoolEligibility(endpoint) {
  const reasons = [];
  if (!isBaseLayerEndpoint(endpoint.kind)) {
    reasons.push("not-bittensor-base-layer");
  }
  if (endpoint.status !== "ok") {
    reasons.push(`status-${endpoint.status || "unknown"}`);
  }
  if (endpoint.auth_required !== false) {
    reasons.push("auth-required");
  }
  if (endpoint.public_safe !== true) {
    reasons.push("not-public-safe");
  }
  return {
    eligible: reasons.length === 0,
    reasons: reasons.length ? reasons : ["eligible"],
  };
}

function endpointProviderScores(endpoints) {
  const providers = new Map();
  for (const endpoint of endpoints) {
    const provider = endpoint.provider || "unknown";
    const row = providers.get(provider) || {
      provider,
      endpoint_count: 0,
      monitored_count: 0,
      ok_count: 0,
      failed_count: 0,
      degraded_count: 0,
      pool_eligible_count: 0,
      score_total: 0,
    };
    row.endpoint_count += 1;
    if (endpoint.monitoring_status === "monitored") {
      row.monitored_count += 1;
    }
    if (endpoint.status === "ok") row.ok_count += 1;
    if (endpoint.status === "failed") row.failed_count += 1;
    if (endpoint.status === "degraded") row.degraded_count += 1;
    if (endpoint.pool_eligible) row.pool_eligible_count += 1;
    row.score_total += endpoint.score || 0;
    providers.set(provider, row);
  }

  return [...providers.values()]
    .map((row) => {
      const publicRow = { ...row };
      delete publicRow.score_total;
      return {
        ...publicRow,
        average_score: row.endpoint_count
          ? Math.round(row.score_total / row.endpoint_count)
          : 0,
        operational_score:
          row.endpoint_count === 0
            ? 0
            : Math.max(
                0,
                Math.round(
                  (row.ok_count / row.endpoint_count) * 70 +
                    (row.pool_eligible_count / row.endpoint_count) * 20 -
                    (row.failed_count / row.endpoint_count) * 30 -
                    (row.degraded_count / row.endpoint_count) * 10,
                ),
              ),
      };
    })
    .sort(
      (a, b) =>
        b.operational_score - a.operational_score ||
        b.average_score - a.average_score ||
        a.provider.localeCompare(b.provider),
    );
}

function severityRank(severity) {
  return { critical: 3, warning: 2, info: 1 }[severity] || 0;
}

function countRecord(items, keyFn) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        const key = keyFn(item) || "unknown";
        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}
