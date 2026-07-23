import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildEndpointResourceArtifact,
  buildEndpointIncidentArtifact,
  buildEndpointPoolArtifact,
  buildRpcEndpointArtifact,
  buildTimestamp,
  flattenSurfaces,
  artifactDirectoryPath,
  artifactOutputPath,
  loadProviders,
  isUnsafeResolvedUrl,
  loadSubnets,
  repoRoot,
  safeFetch,
  writeJson,
} from "./lib.mjs";
import {
  mapLimit,
  nodeWebSocketConnector,
  probeSurface as coreProbeSurface,
  rollupSubnetStatus,
  type ProbeSurface,
} from "../src/health-probe-core.ts";
import { CONTRACT_VERSION } from "../src/contracts.mjs";

type Row = Record<string, unknown>;

// buildRpcEndpointArtifact/buildEndpointResourceArtifact's untyped .mjs default
// param (healthSurfaces = []) locks TS's cross-file inference to never[], and
// buildEndpointPoolArtifact's (rpcArtifact = null, endpointArtifact = null)
// locks to null | undefined; cast until Phase 4 Batch 7 converts
// scripts/lib/endpoint-artifacts.mjs.
const typedBuildRpcEndpointArtifact = buildRpcEndpointArtifact as unknown as (
  options: Row,
) => Row;
const typedBuildEndpointResourceArtifact =
  buildEndpointResourceArtifact as unknown as (options: Row) => Row;
const typedBuildEndpointPoolArtifact = buildEndpointPoolArtifact as unknown as (
  options: Row,
) => Row;

const contractVersion = CONTRACT_VERSION;
const subnets: Row[] = await loadSubnets();
const providers: Row[] = await loadProviders();
const allSurfaces: Row[] = flattenSurfaces(subnets);
const surfaces = allSurfaces.filter(
  (surface) =>
    (surface.probe as Row | undefined)?.enabled && surface.public_safe,
);
const startedAt = Date.now();
const priorHistory = await loadPriorHistory();

// Probe primitives now live in the isomorphic core (src/health-probe-core.ts),
// shared with the Worker cron prober. The Node build injects the DNS-aware SSRF
// guard + the global-WebSocket connector; this thin wrapper layers the daily
// history-derived fields (last_ok, uptime_sample_ratio) the build artifacts need.
interface SafeFetchResult {
  ok: boolean;
  response?: Response;
  status?: number;
  url?: string;
  unsafe?: boolean;
  error?: string;
}

// safeFetch's untyped .mjs default params (headers = null, signal = null) lock
// TS's cross-file inference to null | undefined; cast until Phase 4 Batch 7
// converts scripts/lib.mjs.
const typedSafeFetch = safeFetch as (
  url: string | URL | Request,
  options?: {
    headers?: HeadersInit;
    method?: string;
    signal?: AbortSignal | null;
  },
) => Promise<SafeFetchResult>;

const probeOptions = {
  isUnsafeUrl: isUnsafeResolvedUrl,
  fetchImpl: async (
    url: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const result = await typedSafeFetch(url, {
      headers: init.headers,
      method: init.method || "GET",
      signal: init.signal as AbortSignal | null | undefined,
    });
    if (!result.response) {
      throw new Error(
        result.unsafe ? "unsafe URL" : result.error || "fetch failed",
      );
    }
    return result.response;
  },
  connect: nodeWebSocketConnector(),
};

async function probeSurface(surface: Row): Promise<Row> {
  const base = await coreProbeSurface(
    surface as unknown as ProbeSurface,
    probeOptions,
  );
  const history: Row[] = priorHistory.get(surface.id as string) || [];
  const lastOk =
    base.status === "ok"
      ? base.verified_at
      : latestString(
          history
            .filter((entry) => entry.status === "ok")
            .map((entry) => entry.verified_at as string),
        );
  const historyWithCurrent = [
    ...history,
    { status: base.status, verified_at: base.verified_at },
  ];
  return {
    ...base,
    last_ok: lastOk,
    uptime_sample_ratio: uptimeRatio(historyWithCurrent),
  };
}

const results = (await mapLimit(surfaces, 16, probeSurface)).sort(
  (a, b) =>
    (a.subnet_slug as string).localeCompare(b.subnet_slug as string) ||
    (a.surface_id as string).localeCompare(b.surface_id as string),
);
const artifact = buildHealthArtifacts(results, {
  generatedAt: buildTimestamp(),
  source: "live-smoke-probe",
  probeStartedAt: new Date(startedAt).toISOString(),
  probeFinishedAt: new Date().toISOString(),
});

if (process.env.METAGRAPH_WRITE_PROBE_RESULTS === "1") {
  const rpcEndpointArtifact = typedBuildRpcEndpointArtifact({
    surfaces: allSurfaces,
    healthSurfaces: artifact.latest.surfaces,
    generatedAt: buildTimestamp(),
    contractVersion,
    source: "live-smoke-probe",
  });
  const endpointResourceArtifact = typedBuildEndpointResourceArtifact({
    surfaces: allSurfaces,
    healthSurfaces: artifact.latest.surfaces,
    generatedAt: buildTimestamp(),
    contractVersion,
    source: "live-smoke-probe",
  });
  // Current-state health is local-cache-only now. build-artifacts.mjs
  // intentionally stopped publishing health/latest.json, health/summary.json,
  // and health/subnets/*.json (the live /api/v1/health routes serve from KV/D1),
  // and the Worker unconditionally 410s those static paths. We only seed the
  // local fallback cache that build-artifacts.mjs still reads — the retired
  // static writes below are gone.
  await writeJson(
    path.join(repoRoot, ".cache/metagraphed/health/latest.json"),
    artifact.latest,
  );
  await writeJson(
    artifactOutputPath("rpc-endpoints.json"),
    rpcEndpointArtifact,
  );
  await writeJson(
    artifactOutputPath("endpoints.json"),
    endpointResourceArtifact,
  );
  await writeJson(
    artifactOutputPath("endpoint-incidents.json"),
    buildEndpointIncidentArtifact({
      endpointArtifact: endpointResourceArtifact,
      generatedAt: buildTimestamp(),
      contractVersion,
    }),
  );
  await writeJson(
    artifactOutputPath("rpc/pools.json"),
    typedBuildEndpointPoolArtifact({
      generatedAt: buildTimestamp(),
      contractVersion,
      rpcArtifact: rpcEndpointArtifact,
    }),
  );
  await writeJson(
    artifactOutputPath("endpoint-pools.json"),
    typedBuildEndpointPoolArtifact({
      generatedAt: buildTimestamp(),
      contractVersion,
      endpointArtifact: endpointResourceArtifact,
    }),
  );
  await fs.rm(
    artifactOutputPath("endpoints/0.json").replace(/\/0\.json$/, ""),
    {
      recursive: true,
      force: true,
    },
  );
  for (const subnet of subnets) {
    const subnetEndpoints = (
      endpointResourceArtifact.endpoints as Row[]
    ).filter((endpoint) => endpoint.netuid === subnet.netuid);
    await writeJson(artifactOutputPath(`endpoints/${subnet.netuid}.json`), {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: buildTimestamp(),
      netuid: subnet.netuid,
      slug: subnet.slug,
      name: subnet.name,
      summary: summarizeEndpoints(subnetEndpoints),
      endpoints: subnetEndpoints,
    });
  }
  for (const provider of providers) {
    const providerEndpoints = (
      endpointResourceArtifact.endpoints as Row[]
    ).filter((endpoint) => endpoint.provider === provider.id);
    await writeJson(
      artifactOutputPath(`providers/${provider.id}/endpoints.json`),
      {
        schema_version: 1,
        contract_version: contractVersion,
        generated_at: buildTimestamp(),
        provider: {
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          authority: provider.authority,
        },
        summary: summarizeEndpoints(providerEndpoints),
        endpoints: providerEndpoints,
      },
    );
  }
  const day = (artifact.latest.probe_finished_at as string).slice(0, 10);
  await writeJson(
    artifactOutputPath(`health/history/${day}.json`),
    buildHealthHistoryArtifact(artifact.latest, day),
  );
  await fs.rm(
    artifactOutputPath("health/badges/0.json").replace(/\/0\.json$/, ""),
    {
      recursive: true,
      force: true,
    },
  );
  for (const [netuid, badge] of artifact.badges) {
    await writeJson(artifactOutputPath(`health/badges/${netuid}.json`), badge);
  }
}

const ok = results.filter((result) => result.status === "ok").length;
const degraded = results.filter(
  (result) => result.status === "degraded",
).length;
const failed = results.filter((result) => result.status === "failed").length;
console.log(
  `Smoke-probed ${results.length} surface(s): ${ok} ok, ${degraded} degraded, ${failed} failed.`,
);

for (const result of results) {
  const latency =
    result.latency_ms === undefined ? "" : ` ${result.latency_ms}ms`;
  const code =
    result.status_code === undefined || result.status_code === null
      ? ""
      : ` HTTP ${result.status_code}`;
  console.log(
    `${(result.status as string).padEnd(8)} ${(result.classification as string).padEnd(16)} ${result.surface_id}${code}${latency}`,
  );
}

if (failed > 0 && process.env.METAGRAPH_STRICT_PROBES === "1") {
  process.exit(1);
}

process.exit(0);

interface BuildHealthArtifactsOptions {
  generatedAt: string;
  source: string;
  probeStartedAt: string;
  probeFinishedAt: string;
  observedAt?: string;
}

function buildHealthArtifacts(
  surfaceHealth: Row[],
  options: BuildHealthArtifactsOptions,
): {
  latest: Row;
  summary: Row;
  subnets: Map<unknown, Row>;
  badges: Map<unknown, Row>;
} {
  const byNetuid = groupByNetuid(surfaceHealth);
  const subnetArtifacts = new Map<unknown, Row>();
  const badgeArtifacts = new Map<unknown, Row>();
  const subnetSummaries: Row[] = [];

  for (const subnet of subnets) {
    const subnetSurfaces = byNetuid.get(subnet.netuid) || [];
    const summary = summarizeSubnet(subnet, subnetSurfaces);
    subnetSummaries.push(summary);
    subnetArtifacts.set(subnet.netuid, {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: options.generatedAt,
      netuid: subnet.netuid,
      slug: subnet.slug,
      name: subnet.name,
      summary,
      surfaces: subnetSurfaces,
    });
    badgeArtifacts.set(subnet.netuid, {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: options.generatedAt,
      netuid: subnet.netuid,
      label: `SN${subnet.netuid}`,
      message: summary.status,
      status: summary.status,
      color: badgeColor(summary.status as string),
      surface_count: summary.surface_count,
      ok_count: summary.ok_count,
      failed_count: summary.failed_count,
      degraded_count: summary.degraded_count,
    });
  }

  const latest: Row = {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: options.generatedAt,
    observed_at: options.probeFinishedAt || options.observedAt || null,
    probe_started_at: options.probeStartedAt,
    probe_finished_at: options.probeFinishedAt,
    source: options.source,
    summary: {
      surface_count: surfaceHealth.length,
      status_counts: countBy(surfaceHealth, "status"),
      classification_counts: countBy(surfaceHealth, "classification"),
    },
    surfaces: surfaceHealth,
  };

  return {
    latest,
    summary: {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: options.generatedAt,
      source: options.source,
      global: latest.summary,
      subnets: subnetSummaries.sort(
        (a, b) => (a.netuid as number) - (b.netuid as number),
      ),
    },
    subnets: subnetArtifacts,
    badges: badgeArtifacts,
  };
}

function summarizeEndpoints(endpoints: Row[]): Row {
  return {
    endpoint_count: endpoints.length,
    monitored_count: endpoints.filter(
      (endpoint) => endpoint.monitoring_status === "monitored",
    ).length,
    pool_eligible_count: endpoints.filter((endpoint) => endpoint.pool_eligible)
      .length,
    by_kind: countBy(endpoints, "kind"),
    by_layer: countBy(endpoints, "layer"),
    by_publication_state: countBy(endpoints, "publication_state"),
    by_status: countBy(endpoints, "status"),
  };
}

function buildHealthHistoryArtifact(latest: Row, date: string): Row {
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: latest.generated_at,
    date,
    probe_started_at: latest.probe_started_at || null,
    probe_finished_at: latest.probe_finished_at || null,
    source: latest.source,
    summary: latest.summary,
    surfaces: (latest.surfaces as Row[]).map((surface) => ({
      classification: surface.classification || "unknown",
      error_class: surface.error_class || null,
      kind: surface.kind,
      last_checked: surface.last_checked || null,
      last_ok: surface.last_ok || null,
      latency_ms: Number.isFinite(surface.latency_ms)
        ? surface.latency_ms
        : null,
      netuid: surface.netuid,
      provider: surface.provider,
      status: surface.status,
      status_code: Number.isInteger(surface.status_code)
        ? surface.status_code
        : null,
      surface_id: surface.surface_id,
      verified_at: surface.verified_at || null,
    })),
  };
}

function summarizeSubnet(subnet: Row, subnetSurfaces: Row[]): Row {
  const okCount = subnetSurfaces.filter(
    (surface) => surface.status === "ok",
  ).length;
  const failedCount = subnetSurfaces.filter(
    (surface) => surface.status === "failed",
  ).length;
  const degradedCount = subnetSurfaces.filter(
    (surface) => surface.status === "degraded",
  ).length;
  const unknownCount = subnetSurfaces.filter(
    (surface) => surface.status === "unknown",
  ).length;
  return {
    netuid: subnet.netuid,
    slug: subnet.slug,
    name: subnet.name,
    status: rollupSubnetStatus({
      ok: okCount,
      failed: failedCount,
      degraded: degradedCount,
      unknown: unknownCount,
      total: subnetSurfaces.length,
    }),
    surface_count: subnetSurfaces.length,
    ok_count: okCount,
    failed_count: failedCount,
    degraded_count: degradedCount,
    unknown_count: unknownCount,
    last_checked: latestString(
      subnetSurfaces.map(
        (surface) =>
          (surface.verified_at as string) || (surface.last_checked as string),
      ),
    ),
    last_ok: latestString(
      subnetSurfaces.map((surface) => surface.last_ok as string),
    ),
    avg_latency_ms: average(
      subnetSurfaces
        .map((surface) => surface.latency_ms as number)
        .filter(Number.isFinite),
    ),
  };
}

async function loadPriorHistory(): Promise<Map<string, Row[]>> {
  const historyRoot = artifactDirectoryPath("health/history");
  let entries;
  try {
    entries = await fs.readdir(historyRoot, { withFileTypes: true });
  } catch {
    return new Map();
  }

  const bySurface = new Map<string, Row[]>();
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(-30)) {
    try {
      const artifact: Row = JSON.parse(
        await fs.readFile(path.join(historyRoot, entry.name), "utf8"),
      );
      for (const surface of (artifact.surfaces as Row[] | undefined) || []) {
        const history = bySurface.get(surface.surface_id as string) || [];
        history.push(surface);
        bySurface.set(surface.surface_id as string, history);
      }
    } catch {
      // Ignore malformed historical snapshots; validate catches current artifacts.
    }
  }
  return bySurface;
}

function uptimeRatio(history: Row[]): number | null {
  if (history.length === 0) {
    return null;
  }
  const recent = history.slice(-30);
  return Number(
    (
      recent.filter((entry) => entry.status === "ok").length / recent.length
    ).toFixed(4),
  );
}

function badgeColor(status: string): string {
  return (
    (
      {
        ok: "brightgreen",
        degraded: "yellow",
        failed: "red",
        unknown: "lightgrey",
      } as Record<string, string>
    )[status] || "lightgrey"
  );
}

function groupByNetuid(items: Row[]): Map<unknown, Row[]> {
  const groups = new Map<unknown, Row[]>();
  for (const item of items) {
    const group = groups.get(item.netuid) || [];
    group.push(item);
    groups.set(item.netuid, group);
  }
  return groups;
}

function countBy(items: Row[], key: string): Record<string, number> {
  return Object.fromEntries(
    Object.entries(
      items.reduce(
        (accumulator: Record<string, number>, item) => {
          const value = String(item[key]);
          accumulator[value] = (accumulator[value] || 0) + 1;
          return accumulator;
        },
        {} as Record<string, number>,
      ),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function latestString(values: (string | undefined | null)[]): string | null {
  return values.filter(Boolean).sort().at(-1) || null;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.round(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}
