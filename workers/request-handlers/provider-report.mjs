import {
  composeProviderReport,
  parseProviderReportDimensions,
  PROVIDER_REPORT_DIMENSIONS,
} from "../../src/provider-report.mjs";
import { resolveLiveEconomics } from "../../src/health-serving.mjs";
import { errorResponse } from "../http.mjs";
import { contractVersion, envelopeResponse } from "../responses.mjs";
import { readArtifact } from "../storage.mjs";
import {
  analyticsMeta,
  analyticsQueryError,
  d1All,
  hasD1FallbackRows,
  markD1FallbackResponse,
  validateQueryParams,
} from "./analytics.mjs";

export const PROVIDER_REPORT_PATH_PATTERN =
  /^\/api\/v1\/providers\/([a-z0-9-]+)\/report$/;

const PROVIDER_SLUG_PATTERN = /^[a-z0-9-]+$/;

async function envelopeWithD1Fallback(request, payload, cacheProfile, rowSets) {
  const response = await envelopeResponse(request, payload, cacheProfile);
  return hasD1FallbackRows(...rowSets)
    ? markD1FallbackResponse(response)
    : response;
}

async function loadSubnetMeta(env) {
  const artifact = await readArtifact(env, "/metagraph/profiles.json");
  const profiles = artifact.ok ? artifact.data?.profiles || [] : [];
  const subnetMeta = new Map();
  for (const profile of profiles) {
    if (!Number.isInteger(profile.netuid)) continue;
    subnetMeta.set(profile.netuid, {
      slug: profile.slug ?? null,
      name: profile.name ?? null,
    });
  }
  return subnetMeta;
}

async function resolveEconomicsRows(env, readEconomicsCurrentKv) {
  const live = await resolveLiveEconomics({
    readHealthKv: readEconomicsCurrentKv,
    env,
    contractVersion: contractVersion(env),
  });
  if (Array.isArray(live?.data?.subnets)) return live.data.subnets;
  const artifact = await readArtifact(env, "/metagraph/economics.json");
  return artifact.ok && Array.isArray(artifact.data?.subnets)
    ? artifact.data.subnets
    : [];
}

export function canonicalProviderReportCachePath(url) {
  if (validateQueryParams(url, ["dimensions"])) return null;
  const parsed = parseProviderReportDimensions(
    url.searchParams.get("dimensions"),
  );
  if (parsed?.error) return null;
  if (parsed.length === PROVIDER_REPORT_DIMENSIONS.length) {
    return url.pathname;
  }
  return `${url.pathname}?dimensions=${encodeURIComponent(parsed.join(","))}`;
}

export async function handleProviderReport(
  request,
  env,
  slug,
  url,
  { readHealthMetaKv, readEconomicsCurrentKv },
) {
  if (!PROVIDER_SLUG_PATTERN.test(slug)) {
    return errorResponse(
      "invalid_slug",
      "slug must be a lowercase slug-style provider id.",
      400,
      { slug },
    );
  }

  const validationError = validateQueryParams(url, ["dimensions"]);
  if (validationError) return analyticsQueryError(validationError);

  const dimensionsRaw = url.searchParams.get("dimensions");
  const dimensions = parseProviderReportDimensions(dimensionsRaw);
  if (dimensions?.error) {
    return errorResponse(
      "invalid_query",
      `Unknown dimension "${dimensions.error}". Valid dimensions: ${PROVIDER_REPORT_DIMENSIONS.join(", ")}.`,
      400,
      { parameter: "dimensions" },
    );
  }

  const detailArtifact = await readArtifact(
    env,
    `/metagraph/providers/${slug}.json`,
  );
  if (!detailArtifact.ok) {
    return errorResponse(
      "provider_not_found",
      `No provider matches the slug "${slug}".`,
      detailArtifact.status === 404 ? 404 : 503,
      { slug, artifact_path: `/metagraph/providers/${slug}.json` },
    );
  }

  const provider = detailArtifact.data?.provider ?? null;
  const netuids = Array.isArray(provider?.netuids)
    ? provider.netuids.filter((netuid) => Number.isInteger(netuid))
    : [];

  const includeSurfaces = dimensions.includes("surfaces");
  const includeHealth = dimensions.includes("health");
  const includeEconomics = dimensions.includes("economics");
  const needSurfaceStatus = includeSurfaces || includeHealth;

  const [subnetMeta, healthRows, surfaceKindRows, economicsRows, meta] =
    await Promise.all([
      loadSubnetMeta(env),
      needSurfaceStatus && includeHealth
        ? d1All(
            env,
            `SELECT netuid,
                    COUNT(*) AS surface_count,
                    SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
                    ROUND(AVG(latency_ms)) AS avg_latency_ms
             FROM surface_status
             WHERE provider = ?
             GROUP BY netuid`,
            [slug],
          )
        : null,
      needSurfaceStatus && includeSurfaces
        ? d1All(
            env,
            `SELECT netuid,
                    kind,
                    COUNT(*) AS count,
                    SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
                    ROUND(AVG(latency_ms)) AS avg_latency_ms
             FROM surface_status
             WHERE provider = ?
             GROUP BY netuid, kind`,
            [slug],
          )
        : null,
      includeEconomics
        ? resolveEconomicsRows(env, readEconomicsCurrentKv)
        : null,
      readHealthMetaKv(env),
    ]);

  const data = composeProviderReport({
    providerSlug: slug,
    provider,
    dimensions,
    netuids,
    subnetMeta,
    economicsRows,
    healthRows,
    surfaceKindRows,
    observedAt: meta?.last_run_at ?? null,
  });

  return envelopeWithD1Fallback(
    request,
    {
      data,
      meta: {
        ...(await analyticsMeta(
          env,
          `/metagraph/providers/${slug}/report.json`,
          data.observed_at,
        )),
        cache: "standard",
      },
    },
    "standard",
    [healthRows, surfaceKindRows],
  );
}
