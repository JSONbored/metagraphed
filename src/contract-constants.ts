// Shared protocol constants, independent of the route and schema catalogue.
export const CONTRACT_VERSION = "2026-07-03.2";

// The API + artifacts are served from the api subdomain; the bare apex
// (metagraph.sh) is the metagraphed-ui UI. PRIMARY_DOMAIN drives the OpenAPI
// server URL and the consumer metadata in contracts.json / api-index.json.
export const PRIMARY_DOMAIN = "api.metagraph.sh";

export const ARTIFACT_BASE_PATH = "/metagraph";

export const CACHE_SECONDS = {
  short: 60,
  standard: 300,
  static: 600,
};
