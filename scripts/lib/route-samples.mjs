// Shared sample route ids and query defaults for try-it URLs (#1682, #1652).
// Consumed by scripts/smoke-live-api.mjs and scripts/generate-docs-site.mjs so
// docs examples and live smoke stay aligned without duplicate constants.

export const SAMPLE_NETUID = "7";
export const SAMPLE_SLUG = "allways";
export const SAMPLE_SS58 = "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM";
export const SAMPLE_HASH = `0x${"0".repeat(64)}`;
export const SAMPLE_SURFACE_ID = "sn-7-allways-subnet-api";
export const DOCS_SAMPLE_DATE = "2026-06-01";

export function substituteRoutePlaceholders(
  routePath,
  { date = DOCS_SAMPLE_DATE, surfaceId = SAMPLE_SURFACE_ID } = {},
) {
  const route = routePath
    .replaceAll("{netuid}", SAMPLE_NETUID)
    .replaceAll("{slug}", SAMPLE_SLUG)
    .replaceAll("{date}", date)
    .replaceAll("{uid}", "0")
    .replaceAll("{hash}", SAMPLE_HASH)
    .replaceAll("{ref}", "0")
    .replaceAll("{ss58}", SAMPLE_SS58)
    .replaceAll("{surface_id}", surfaceId);
  if (route.includes("{")) {
    throw new Error(`unsubstituted placeholder in route ${routePath}`);
  }
  return route;
}

export function sampleQueryParams(routePath) {
  if (routePath === "/api/v1/subnets") {
    return { limit: "3", sort: "netuid" };
  }
  if (routePath === "/api/v1/compare") {
    return { netuids: "7,8" };
  }
  if (
    [
      "/api/v1/surfaces",
      "/api/v1/endpoints",
      "/api/v1/candidates",
      "/api/v1/search",
    ].includes(routePath)
  ) {
    return { limit: "3" };
  }
  return {};
}

export function buildSampleRouteUrl(
  routePath,
  baseUrl,
  { date = DOCS_SAMPLE_DATE } = {},
) {
  const url = new URL(
    substituteRoutePlaceholders(routePath, { date }),
    baseUrl,
  );
  for (const [key, value] of Object.entries(sampleQueryParams(routePath))) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
