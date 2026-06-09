import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { artifactFilePath, readJson, stableStringify } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const jsonMode = args.has("--json");
const limit = positiveInt(valueAfter("--limit"), 10);

const REQUIRED_ENDPOINT_ARTIFACTS = [
  "endpoints.json",
  "endpoint-pools.json",
  "rpc/pools.json",
  "endpoint-incidents.json",
  "rpc-endpoints.json",
];

export class MissingEndpointArtifactsError extends Error {
  constructor(missing) {
    const formattedPaths = missing
      .map(({ relativePath, filePath }) => `- ${relativePath} (${filePath})`)
      .join("\n");
    super(
      [
        "Endpoint operations brief artifacts are missing.",
        "Run `npm run artifacts:prepare-local` to build local R2 staging, or `npm run r2:download -- --prefix latest/` when R2 credentials are available, then retry `npm run endpoint:brief`.",
        "Missing artifacts:",
        formattedPaths,
      ].join("\n"),
    );
    this.name = "MissingEndpointArtifactsError";
    this.missing = missing;
  }
}

if (isCliEntrypoint()) {
  try {
    const snapshot = await loadEndpointOpsSnapshot({ limit });

    if (jsonMode) {
      console.log(stableStringify(snapshot));
    } else {
      console.log(renderEndpointOpsBrief(snapshot));
    }
  } catch (error) {
    if (error instanceof MissingEndpointArtifactsError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

export async function loadEndpointOpsSnapshot({ limit = 10 } = {}) {
  await assertEndpointArtifactsAvailable(REQUIRED_ENDPOINT_ARTIFACTS);

  const [endpoints, endpointPools, rpcPools, incidents, rpcEndpoints] =
    await Promise.all(REQUIRED_ENDPOINT_ARTIFACTS.map(readArtifact));

  return {
    schema_version: 1,
    generated_at:
      firstRealTimestamp([
        endpointPools.generated_at,
        incidents.generated_at,
        endpoints.generated_at,
      ]) || "1970-01-01T00:00:00.000Z",
    contract_version:
      endpointPools.contract_version ||
      endpoints.contract_version ||
      rpcPools.contract_version,
    endpoint_summary: normalizeEndpointSummary(endpoints.summary || {}),
    rpc_summary: {
      endpoint_count: rpcEndpoints.summary?.endpoint_count ?? 0,
      ok_count: rpcEndpoints.summary?.by_status?.ok ?? 0,
      archive_supported_count:
        rpcEndpoints.summary?.archive_supported_count ?? 0,
      providers: Object.keys(rpcEndpoints.summary?.by_provider || {}).sort(),
    },
    pools: (endpointPools.pools || []).slice(0, limit).map(poolBriefRow),
    rpc_pools: (rpcPools.pools || []).slice(0, limit).map(poolBriefRow),
    provider_scores: (endpointPools.provider_scores || [])
      .slice(0, limit)
      .map(providerScoreBriefRow),
    active_incidents: (incidents.incidents || [])
      .filter((incident) => incident.state === "active")
      .slice(0, limit)
      .map(incidentBriefRow),
    incident_summary: incidents.summary || {},
    disabled_proxy_contract: {
      enabled: endpointPools.disabled_proxy_contract?.enabled === true,
      feature_flag: endpointPools.disabled_proxy_contract?.feature_flag || null,
      allowed_methods:
        endpointPools.disabled_proxy_contract?.allowed_methods || [],
      denied_method_patterns:
        endpointPools.disabled_proxy_contract?.denied_method_patterns || [],
      rate_limit_required:
        endpointPools.disabled_proxy_contract?.rate_limit_required === true,
      waf_required:
        endpointPools.disabled_proxy_contract?.waf_required === true,
    },
    policy: {
      eligibility_source:
        endpointPools.eligibility_policy?.source || "probe-derived",
      eligible_layers: endpointPools.eligibility_policy?.eligible_layers || [],
      health_is_user_mutable:
        endpointPools.eligibility_policy?.user_reports_can_change_health ===
        true,
      notes: endpointPools.eligibility_policy?.notes || null,
    },
  };
}

export function renderEndpointOpsBrief(snapshot) {
  const lines = [
    "# Metagraphed Endpoint Operations Brief",
    "",
    "Use this brief to audit monitored endpoint resources, advisory pools, provider scores, and probe-derived incidents. It is generated from existing endpoint artifacts and does not create new registry data.",
    "",
    "## Coverage",
    "",
    `- Endpoint resources: ${snapshot.endpoint_summary.endpoint_count}`,
    `- Monitored endpoints: ${snapshot.endpoint_summary.monitored_count}`,
    `- Pool-eligible endpoints: ${snapshot.endpoint_summary.pool_eligible_count}`,
    `- Statuses: ${formatCounts(snapshot.endpoint_summary.by_status)}`,
    `- Layers: ${formatCounts(snapshot.endpoint_summary.by_layer)}`,
    `- Publication states: ${formatCounts(snapshot.endpoint_summary.by_publication_state)}`,
    "",
    "## Root RPC/WSS/Archive",
    "",
    `- Base-layer RPC/WSS endpoints: ${snapshot.rpc_summary.endpoint_count}`,
    `- OK endpoints: ${snapshot.rpc_summary.ok_count}`,
    `- Archive-capable endpoints: ${snapshot.rpc_summary.archive_supported_count}`,
    `- Providers: ${snapshot.rpc_summary.providers.join(", ") || "none"}`,
    "",
    "## Advisory Endpoint Pools",
    "",
    "Pools are sorted by current operational score. They are advisory only; the public RPC proxy remains disabled in v1.",
    "",
    ...numberedRows(
      snapshot.pools,
      (pool) =>
        `${pool.id} (${pool.kind}) - ${pool.eligible_count}/${pool.endpoint_count} eligible; best ${pool.best_endpoint_id || "none"}; top: ${pool.top_endpoints.join(", ") || "none"}`,
    ),
    "",
    "## Provider Scores",
    "",
    ...numberedRows(
      snapshot.provider_scores,
      (provider) =>
        `${provider.provider} - score ${provider.average_score}; ok ${provider.ok_count}/${provider.endpoint_count}; pool eligible ${provider.pool_eligible_count}`,
    ),
    "",
    "## Active Incidents",
    "",
    ...numberedRows(
      snapshot.active_incidents,
      (incident) =>
        `SN${incident.netuid} ${incident.subnet_name} ${incident.kind} - ${incident.status}/${incident.reason}; provider ${incident.provider}; endpoint ${incident.endpoint_id}`,
    ),
    "",
    "## Proxy Contract",
    "",
    `- Enabled: ${snapshot.disabled_proxy_contract.enabled}`,
    `- Feature flag: ${snapshot.disabled_proxy_contract.feature_flag || "none"}`,
    `- Allowed methods: ${snapshot.disabled_proxy_contract.allowed_methods.join(", ") || "none"}`,
    `- Denied method patterns: ${snapshot.disabled_proxy_contract.denied_method_patterns.join(", ") || "none"}`,
    `- WAF required: ${snapshot.disabled_proxy_contract.waf_required}`,
    `- Rate limit required: ${snapshot.disabled_proxy_contract.rate_limit_required}`,
    "",
    "Health, latency, latest block, incidents, and pool eligibility are probe-derived only. Contributor reports can trigger review or re-probes, but they cannot set observed health.",
  ];

  return `${lines.join("\n")}\n`;
}

function normalizeEndpointSummary(summary) {
  return {
    endpoint_count: summary.endpoint_count ?? 0,
    monitored_count: summary.monitored_count ?? 0,
    pool_eligible_count: summary.pool_eligible_count ?? 0,
    by_status: sortedRecord(summary.by_status || {}),
    by_layer: sortedRecord(summary.by_layer || {}),
    by_publication_state: sortedRecord(summary.by_publication_state || {}),
    by_kind: sortedRecord(summary.by_kind || {}),
    by_provider: sortedRecord(summary.by_provider || {}),
  };
}

function poolBriefRow(pool) {
  const endpoints = pool.endpoints || [];
  return {
    id: pool.id,
    kind: pool.kind,
    endpoint_count: pool.endpoint_count ?? endpoints.length,
    eligible_count:
      pool.eligible_count ??
      endpoints.filter((endpoint) => endpoint.pool_eligible === true).length,
    best_endpoint_id: pool.best_endpoint_id || null,
    top_endpoints: endpoints.slice(0, 3).map((endpoint) => {
      const latency =
        typeof endpoint.latency_ms === "number"
          ? `${endpoint.latency_ms}ms`
          : "latency unknown";
      return `${endpoint.provider}/${endpoint.id} (${endpoint.status}, ${latency}, score ${endpoint.score ?? "unknown"})`;
    }),
  };
}

function providerScoreBriefRow(provider) {
  return {
    provider: provider.provider,
    average_score: provider.average_score ?? provider.operational_score ?? 0,
    operational_score: provider.operational_score ?? null,
    endpoint_count: provider.endpoint_count ?? 0,
    monitored_count: provider.monitored_count ?? 0,
    ok_count: provider.ok_count ?? 0,
    degraded_count: provider.degraded_count ?? 0,
    failed_count: provider.failed_count ?? 0,
    pool_eligible_count: provider.pool_eligible_count ?? 0,
  };
}

function incidentBriefRow(incident) {
  return {
    id: incident.id,
    endpoint_id: incident.endpoint_id,
    netuid: incident.netuid,
    subnet_name: incident.subnet_name || "unknown",
    kind: incident.kind,
    status: incident.status,
    reason: incident.reason || incident.classification || "unknown",
    severity: incident.severity,
    provider: incident.provider || incident.operator || "unknown",
    observed_at: incident.observed_at || incident.detected_at || null,
  };
}

function formatCounts(counts) {
  const entries = Object.entries(counts || {});
  if (entries.length === 0) {
    return "none";
  }
  return entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function numberedRows(rows, formatter) {
  if (rows.length === 0) {
    return ["No rows available."];
  }
  return rows.map((row, index) => `${index + 1}. ${formatter(row)}`);
}

function sortedRecord(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function firstRealTimestamp(values) {
  return values.find(
    (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      value !== "1970-01-01T00:00:00.000Z",
  );
}

export async function missingEndpointArtifactDetails(relativePaths) {
  const missing = [];

  for (const relativePath of relativePaths) {
    const filePath = artifactFilePath(relativePath);
    try {
      await access(filePath, fsConstants.R_OK);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      missing.push({ relativePath, filePath });
    }
  }

  return missing;
}

async function assertEndpointArtifactsAvailable(relativePaths) {
  const missing = await missingEndpointArtifactDetails(relativePaths);
  if (missing.length > 0) {
    throw new MissingEndpointArtifactsError(missing);
  }
}

async function readArtifact(relativePath) {
  return readJson(artifactFilePath(relativePath));
}

function valueAfter(flag) {
  const values = process.argv.slice(2);
  const index = values.indexOf(flag);
  return index === -1 ? null : values[index + 1];
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isCliEntrypoint() {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;
}
