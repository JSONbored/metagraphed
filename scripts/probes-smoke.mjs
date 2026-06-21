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
  writeJson,
} from "./lib.mjs";
import {
  mapLimit,
  nodeWebSocketConnector,
  probeSurface as coreProbeSurface,
  rollupSubnetStatus,
} from "../src/health-probe-core.mjs";

const contractVersion = "2026-06-06.1";
const subnets = await loadSubnets();
const providers = await loadProviders();
const allSurfaces = flattenSurfaces(subnets);
const surfaces = allSurfaces.filter(
  (surface) => surface.probe?.enabled && surface.public_safe,
);
const startedAt = Date.now();
const priorHistory = await loadPriorHistory();

// Probe primitives now live in the isomorphic core (src/health-probe-core.mjs),
// shared with the Worker cron prober. The Node build injects the DNS-aware SSRF
// guard + the global-WebSocket connector; this thin wrapper layers the daily
// history-derived fields (last_ok, uptime_sample_ratio) the build artifacts need.
const probeOptions = {
  isUnsafeUrl: isUnsafeResolvedUrl,
  connect: nodeWebSocketConnector(),
};

async function probeSurface(surface) {
  const base = await coreProbeSurface(surface, probeOptions);
  const history = priorHistory.get(surface.id) || [];
  const lastOk =
    base.status === "ok"
      ? base.verified_at
      : latestString(
          history
            .filter((entry) => entry.status === "ok")
            .map((entry) => entry.verified_at),
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
    a.subnet_slug.localeCompare(b.subnet_slug) ||
    a.surface_id.localeCompare(b.surface_id),
);
const artifact = buildHealthArtifacts(results, {
  generatedAt: buildTimestamp(),
  source: "live-smoke-probe",
  probeStartedAt: new Date(startedAt).toISOString(),
  probeFinishedAt: new Date().toISOString(),
});

if (process.env.METAGRAPH_WRITE_PROBE_RESULTS === "1") {
  const rpcEndpointArtifact = buildRpcEndpointArtifact({
    surfaces: allSurfaces,
    healthSurfaces: artifact.latest.surfaces,
    generatedAt: buildTimestamp(),
    contractVersion,
    source: "live-smoke-probe",
  });
  const endpointResourceArtifact = buildEndpointResourceArtifact({
    surfaces: allSurfaces,
    healthSurfaces: artifact.latest.surfaces,
    generatedAt: buildTimestamp(),
    contractVersion,
    source: "live-smoke-probe",
  });
  await writeJson(
    path.join(repoRoot, ".cache/metagraphed/health/latest.json"),
    artifact.latest,
  );
  await writeJson(artifactOutputPath("health/latest.json"), artifact.latest);
  await writeJson(artifactOutputPath("health/summary.json"), artifact.summary);
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
    buildEndpointPoolArtifact({
      generatedAt: buildTimestamp(),
      contractVersion,
      rpcArtifact: rpcEndpointArtifact,
    }),
  );
  await writeJson(
    artifactOutputPath("endpoint-pools.json"),
    buildEndpointPoolArtifact({
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
    const subnetEndpoints = endpointResourceArtifact.endpoints.filter(
      (endpoint) => endpoint.netuid === subnet.netuid,
    );
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
    const providerEndpoints = endpointResourceArtifact.endpoints.filter(
      (endpoint) => endpoint.provider === provider.id,
    );
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
  const day = artifact.latest.probe_finished_at.slice(0, 10);
  await writeJson(
    artifactOutputPath(`health/history/${day}.json`),
    buildHealthHistoryArtifact(artifact.latest, day),
  );
  await fs.rm(
    artifactOutputPath("health/subnets/0.json").replace(/\/0\.json$/, ""),
    {
      recursive: true,
      force: true,
    },
  );
  await fs.rm(
    artifactOutputPath("health/badges/0.json").replace(/\/0\.json$/, ""),
    {
      recursive: true,
      force: true,
    },
  );
  for (const [netuid, subnetHealth] of artifact.subnets) {
    await writeJson(
      artifactOutputPath(`health/subnets/${netuid}.json`),
      subnetHealth,
    );
  }
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
    `${result.status.padEnd(8)} ${result.classification.padEnd(16)} ${result.surface_id}${code}${latency}`,
  );
}

if (failed > 0 && process.env.METAGRAPH_STRICT_PROBES === "1") {
  process.exit(1);
}

process.exit(0);

function buildHealthArtifacts(surfaceHealth, options) {
  const byNetuid = groupByNetuid(surfaceHealth);
  const subnetArtifacts = new Map();
  const badgeArtifacts = new Map();
  const subnetSummaries = [];

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
      color: badgeColor(summary.status),
      surface_count: summary.surface_count,
      ok_count: summary.ok_count,
      failed_count: summary.failed_count,
      degraded_count: summary.degraded_count,
    });
  }

  const latest = {
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
      subnets: subnetSummaries.sort((a, b) => a.netuid - b.netuid),
    },
    subnets: subnetArtifacts,
    badges: badgeArtifacts,
  };
}

function summarizeEndpoints(endpoints) {
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

function buildHealthHistoryArtifact(latest, date) {
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: latest.generated_at,
    date,
    probe_started_at: latest.probe_started_at || null,
    probe_finished_at: latest.probe_finished_at || null,
    source: latest.source,
    summary: latest.summary,
    surfaces: latest.surfaces.map((surface) => ({
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

function summarizeSubnet(subnet, subnetSurfaces) {
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
        (surface) => surface.verified_at || surface.last_checked,
      ),
    ),
    last_ok: latestString(subnetSurfaces.map((surface) => surface.last_ok)),
    avg_latency_ms: average(
      subnetSurfaces
        .map((surface) => surface.latency_ms)
        .filter(Number.isFinite),
    ),
  };
}

async function loadPriorHistory() {
  const historyRoot = artifactDirectoryPath("health/history");
  let entries;
  try {
    entries = await fs.readdir(historyRoot, { withFileTypes: true });
  } catch {
    return new Map();
  }

  const bySurface = new Map();
  for (const entry of entries
    .filter((item) => item.isFile() && item.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(-30)) {
    try {
      const artifact = JSON.parse(
        await fs.readFile(path.join(historyRoot, entry.name), "utf8"),
      );
      for (const surface of artifact.surfaces || []) {
        const history = bySurface.get(surface.surface_id) || [];
        history.push(surface);
        bySurface.set(surface.surface_id, history);
      }
    } catch {
      // Ignore malformed historical snapshots; validate catches current artifacts.
    }
  }
  return bySurface;
}

function uptimeRatio(history) {
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

function badgeColor(status) {
  return (
    {
      ok: "brightgreen",
      degraded: "yellow",
      failed: "red",
      unknown: "lightgrey",
    }[status] || "lightgrey"
  );
}

function groupByNetuid(items) {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.netuid) || [];
    group.push(item);
    groups.set(item.netuid, group);
  }
  return groups;
}

function countBy(items, key) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        accumulator[item[key]] = (accumulator[item[key]] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function latestString(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function average(values) {
  if (values.length === 0) {
    return null;
  }
  return Math.round(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}
