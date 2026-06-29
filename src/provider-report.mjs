export const PROVIDER_REPORT_DIMENSIONS = [
  "identity",
  "surfaces",
  "health",
  "economics",
];

export function parseProviderReportDimensions(dimensionsRaw) {
  if (dimensionsRaw === null) return PROVIDER_REPORT_DIMENSIONS;
  const requested = dimensionsRaw.split(",");
  const unknown = requested.find(
    (dimension) => !PROVIDER_REPORT_DIMENSIONS.includes(dimension),
  );
  if (unknown !== undefined) return { error: unknown };
  return PROVIDER_REPORT_DIMENSIONS.filter((dimension) =>
    requested.includes(dimension),
  );
}

function mapEconomicsRow(row) {
  if (!row) return null;
  return {
    registration_cost_tao: row.registration_cost_tao ?? null,
    registration_allowed: row.registration_allowed ?? false,
    open_slots: row.open_slots ?? null,
    emission_share: row.emission_share ?? null,
    alpha_price_tao: row.alpha_price_tao ?? null,
    validator_count: row.validator_count ?? 0,
    miner_count: row.miner_count ?? 0,
    total_stake_tao: row.total_stake_tao ?? null,
    miner_readiness: row.miner_readiness ?? null,
  };
}

function mapHealthRow(row) {
  if (!row) return null;
  return {
    surface_count: row.surface_count ?? 0,
    ok_count: row.ok_count ?? 0,
    avg_latency_ms: row.avg_latency_ms ?? null,
  };
}

function surfaceKindsByKind(rowsForNetuid) {
  const kinds = {};
  for (const row of rowsForNetuid) {
    kinds[row.kind] = {
      count: row.count ?? 0,
      ok_count: row.ok_count ?? 0,
      avg_latency_ms: row.avg_latency_ms ?? null,
    };
  }
  return kinds;
}

function indexRowsByNetuid(rows, mapRow) {
  const byNetuid = new Map();
  for (const row of rows || []) {
    byNetuid.set(row.netuid, mapRow(row));
  }
  return byNetuid;
}

function indexSurfaceKindRows(rows) {
  const byNetuid = new Map();
  for (const row of rows || []) {
    if (!byNetuid.has(row.netuid)) byNetuid.set(row.netuid, []);
    byNetuid.get(row.netuid).push(row);
  }
  return byNetuid;
}

export function composeProviderReport({
  providerSlug,
  provider,
  dimensions,
  netuids,
  subnetMeta,
  economicsRows,
  healthRows,
  surfaceKindRows,
  observedAt,
}) {
  const includeIdentity = dimensions.includes("identity");
  const includeSurfaces = dimensions.includes("surfaces");
  const includeHealth = dimensions.includes("health");
  const includeEconomics = dimensions.includes("economics");

  const economicsByNetuid = indexRowsByNetuid(economicsRows, mapEconomicsRow);
  const healthByNetuid = indexRowsByNetuid(healthRows, mapHealthRow);
  const kindRowsByNetuid = indexSurfaceKindRows(surfaceKindRows);

  const subnets = netuids.map((netuid) => {
    const meta = subnetMeta.get(netuid) || null;
    const entry = {
      netuid,
      name: meta?.name ?? null,
      slug: meta?.slug ?? null,
      found: meta !== null,
    };
    if (includeSurfaces) {
      const rowsForNetuid = kindRowsByNetuid.get(netuid) || [];
      const count = rowsForNetuid.reduce(
        (sum, row) => sum + (row.count ?? 0),
        0,
      );
      entry.surfaces =
        rowsForNetuid.length > 0
          ? { count, kinds: surfaceKindsByKind(rowsForNetuid) }
          : null;
    }
    if (includeHealth) {
      entry.health = meta ? (healthByNetuid.get(netuid) ?? null) : null;
    }
    if (includeEconomics) {
      entry.economics = meta ? (economicsByNetuid.get(netuid) ?? null) : null;
    }
    return entry;
  });

  let totalSurfaces = 0;
  let totalOk = 0;
  for (const row of healthRows || []) {
    totalSurfaces += row.surface_count ?? 0;
    totalOk += row.ok_count ?? 0;
  }

  return {
    schema_version: 1,
    source: "registry+economics+live-cron-prober",
    observed_at: observedAt ?? null,
    provider: providerSlug,
    dimensions,
    found: provider !== null,
    identity:
      includeIdentity && provider
        ? {
            id: provider.id,
            name: provider.name ?? null,
            kind: provider.kind ?? null,
            website_url: provider.website_url ?? null,
            authority: provider.authority ?? null,
            subnet_count: provider.subnet_count ?? netuids.length,
            surface_count: provider.surface_count ?? totalSurfaces,
            endpoint_count: provider.endpoint_count ?? 0,
            netuids,
          }
        : null,
    subnets,
    totals: {
      subnet_count: netuids.length,
      surface_count: provider?.surface_count ?? totalSurfaces,
      health_ok_ratio:
        totalSurfaces > 0
          ? Math.round((totalOk / totalSurfaces) * 10_000) / 10_000
          : null,
    },
  };
}
