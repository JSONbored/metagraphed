import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { artifactFilePath, readJson, stableStringify } from "./lib.ts";

type Row = Record<string, unknown>;

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

interface MissingArtifact {
  relativePath: string;
  filePath: string;
}

export class MissingEndpointArtifactsError extends Error {
  missing: MissingArtifact[];

  constructor(missing: MissingArtifact[]) {
    const formattedPaths = missing
      .map(({ relativePath, filePath }) => `- ${relativePath} (${filePath})`)
      .join("\n");
    super(
      [
        "Endpoint operations brief artifacts are missing.",
        "Run `npm run artifacts:prepare-local` to build local R2 staging, or `npm run r2:download -- --prefix=latest/` when R2 credentials are available, then retry `npm run endpoint:brief`.",
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

export async function loadEndpointOpsSnapshot({
  limit = 10,
}: { limit?: number } = {}): Promise<Row> {
  await assertEndpointArtifactsAvailable(REQUIRED_ENDPOINT_ARTIFACTS);

  const [endpoints, endpointPools, rpcPools, incidents, rpcEndpoints] =
    await Promise.all(REQUIRED_ENDPOINT_ARTIFACTS.map(readArtifact));

  const rpcEndpointsSummary = rpcEndpoints.summary as Row | undefined;
  const disabledProxyContract = endpointPools.disabled_proxy_contract as
    Row | undefined;
  const eligibilityPolicy = endpointPools.eligibility_policy as Row | undefined;

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
    endpoint_summary: normalizeEndpointSummary(
      (endpoints.summary as Row) || {},
    ),
    rpc_summary: {
      endpoint_count: rpcEndpointsSummary?.endpoint_count ?? 0,
      ok_count: (rpcEndpointsSummary?.by_status as Row | undefined)?.ok ?? 0,
      archive_supported_count:
        rpcEndpointsSummary?.archive_supported_count ?? 0,
      providers: Object.keys(
        (rpcEndpointsSummary?.by_provider as Row) || {},
      ).sort(),
    },
    pools: ((endpointPools.pools as Row[]) || [])
      .slice(0, limit)
      .map(poolBriefRow),
    rpc_pools: ((rpcPools.pools as Row[]) || [])
      .slice(0, limit)
      .map(poolBriefRow),
    provider_scores: ((endpointPools.provider_scores as Row[]) || [])
      .slice(0, limit)
      .map(providerScoreBriefRow),
    active_incidents: ((incidents.incidents as Row[]) || [])
      .filter((incident) => incident.state === "active")
      .slice(0, limit)
      .map(incidentBriefRow),
    incident_summary: incidents.summary || {},
    disabled_proxy_contract: {
      enabled: disabledProxyContract?.enabled === true,
      feature_flag: disabledProxyContract?.feature_flag || null,
      allowed_methods: disabledProxyContract?.allowed_methods || [],
      denied_method_patterns:
        disabledProxyContract?.denied_method_patterns || [],
      rate_limit_required: disabledProxyContract?.rate_limit_required === true,
      waf_required: disabledProxyContract?.waf_required === true,
    },
    policy: {
      eligibility_source: eligibilityPolicy?.source || "probe-derived",
      eligible_layers: eligibilityPolicy?.eligible_layers || [],
      health_is_user_mutable:
        eligibilityPolicy?.user_reports_can_change_health === true,
      notes: eligibilityPolicy?.notes || null,
    },
  };
}

export function renderEndpointOpsBrief(snapshot: Row): string {
  const endpointSummary = snapshot.endpoint_summary as Row;
  const rpcSummary = snapshot.rpc_summary as Row;
  const disabledProxyContract = snapshot.disabled_proxy_contract as Row;
  const lines = [
    "# Metagraphed Endpoint Operations Brief",
    "",
    "Use this brief to audit monitored endpoint resources, advisory pools, provider scores, and probe-derived incidents. It is generated from existing endpoint artifacts and does not create new registry data.",
    "",
    "## Coverage",
    "",
    `- Endpoint resources: ${endpointSummary.endpoint_count}`,
    `- Monitored endpoints: ${endpointSummary.monitored_count}`,
    `- Pool-eligible endpoints: ${endpointSummary.pool_eligible_count}`,
    `- Statuses: ${formatCounts(endpointSummary.by_status as Row)}`,
    `- Layers: ${formatCounts(endpointSummary.by_layer as Row)}`,
    `- Publication states: ${formatCounts(endpointSummary.by_publication_state as Row)}`,
    "",
    "## Root RPC/WSS/Archive",
    "",
    `- Base-layer RPC/WSS endpoints: ${rpcSummary.endpoint_count}`,
    `- OK endpoints: ${rpcSummary.ok_count}`,
    `- Archive-capable endpoints: ${rpcSummary.archive_supported_count}`,
    `- Providers: ${(rpcSummary.providers as string[]).join(", ") || "none"}`,
    "",
    "## Advisory Endpoint Pools",
    "",
    "Pools are sorted by current operational score. They are advisory only; the public RPC proxy remains disabled in v1.",
    "",
    ...numberedRows(
      snapshot.pools as Row[],
      (pool) =>
        `${pool.id} (${pool.kind}) - ${pool.eligible_count}/${pool.endpoint_count} eligible; best ${pool.best_endpoint_id || "none"}; top: ${(pool.top_endpoints as string[]).join(", ") || "none"}`,
    ),
    "",
    "## Provider Scores",
    "",
    ...numberedRows(
      snapshot.provider_scores as Row[],
      (provider) =>
        `${provider.provider} - score ${provider.average_score}; ok ${provider.ok_count}/${provider.endpoint_count}; pool eligible ${provider.pool_eligible_count}`,
    ),
    "",
    "## Active Incidents",
    "",
    ...numberedRows(
      snapshot.active_incidents as Row[],
      (incident) =>
        `SN${incident.netuid} ${incident.subnet_name} ${incident.kind} - ${incident.status}/${incident.reason}; provider ${incident.provider}; endpoint ${incident.endpoint_id}`,
    ),
    "",
    "## Proxy Contract",
    "",
    `- Enabled: ${disabledProxyContract.enabled}`,
    `- Feature flag: ${disabledProxyContract.feature_flag || "none"}`,
    `- Allowed methods: ${(disabledProxyContract.allowed_methods as string[]).join(", ") || "none"}`,
    `- Denied method patterns: ${(disabledProxyContract.denied_method_patterns as string[]).join(", ") || "none"}`,
    `- WAF required: ${disabledProxyContract.waf_required}`,
    `- Rate limit required: ${disabledProxyContract.rate_limit_required}`,
    "",
    "Health, latency, latest block, incidents, and pool eligibility are probe-derived only. Contributor reports can trigger review or re-probes, but they cannot set observed health.",
  ];

  return `${lines.join("\n")}\n`;
}

function normalizeEndpointSummary(summary: Row): Row {
  return {
    endpoint_count: summary.endpoint_count ?? 0,
    monitored_count: summary.monitored_count ?? 0,
    pool_eligible_count: summary.pool_eligible_count ?? 0,
    by_status: sortedRecord((summary.by_status as Row) || {}),
    by_layer: sortedRecord((summary.by_layer as Row) || {}),
    by_publication_state: sortedRecord(
      (summary.by_publication_state as Row) || {},
    ),
    by_kind: sortedRecord((summary.by_kind as Row) || {}),
    by_provider: sortedRecord((summary.by_provider as Row) || {}),
  };
}

function poolBriefRow(pool: Row): Row {
  const endpoints = (pool.endpoints as Row[]) || [];
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

function providerScoreBriefRow(provider: Row): Row {
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

function incidentBriefRow(incident: Row): Row {
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

function formatCounts(counts: Row | null | undefined): string {
  const entries = Object.entries(counts || {});
  if (entries.length === 0) {
    return "none";
  }
  return entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function numberedRows(rows: Row[], formatter: (row: Row) => string): string[] {
  if (rows.length === 0) {
    return ["No rows available."];
  }
  return rows.map((row, index) => `${index + 1}. ${formatter(row)}`);
}

function sortedRecord(record: Row): Row {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function firstRealTimestamp(values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" &&
      value.length > 0 &&
      value !== "1970-01-01T00:00:00.000Z",
  );
}

export async function missingEndpointArtifactDetails(
  relativePaths: string[],
): Promise<MissingArtifact[]> {
  const missing: MissingArtifact[] = [];

  for (const relativePath of relativePaths) {
    const filePath = artifactFilePath(relativePath);
    try {
      await access(filePath, fsConstants.R_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw error;
      }
      missing.push({ relativePath, filePath });
    }
  }

  return missing;
}

async function assertEndpointArtifactsAvailable(
  relativePaths: string[],
): Promise<void> {
  const missing = await missingEndpointArtifactDetails(relativePaths);
  if (missing.length > 0) {
    throw new MissingEndpointArtifactsError(missing);
  }
}

async function readArtifact(relativePath: string): Promise<Row> {
  return readJson(artifactFilePath(relativePath));
}

function valueAfter(flag: string): string | null {
  const values = process.argv.slice(2);
  const index = values.indexOf(flag);
  return index === -1 ? null : values[index + 1];
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isCliEntrypoint(): boolean {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;
}
