// The two default website requests can use the shared protocol and handlers
// without initializing the complete router, cron jobs or OAuth provider.
import {
  handleAccountHolderDirectory,
  handleValidatorOperatorDirectory,
} from "./request-handlers/explorer-directories.ts";
import { withStampedEdgeCache } from "./edge-cache.ts";
import { readExplorerDirectoryCacheStamp } from "./data-api-tier.ts";
import {
  auditRouteResponse,
  withRequestUsageTelemetry,
  withResponseTiming,
} from "./request-lifecycle.ts";
import { recordMatchedUsageRollup } from "./usage-rollup.ts";

export const EXPLORER_DIRECTORY_ENTRIES = [
  {
    path: "/api/v1/accounts/directory",
    id: "account-holder-directory",
    artifactTemplate: "/metagraph/accounts/directory.json",
    artifactPath: "/metagraph/accounts/directory.json",
    handle: handleAccountHolderDirectory,
  },
  {
    path: "/api/v1/validators/operators",
    id: "validator-operator-directory",
    artifactTemplate: "/metagraph/validators/operators.json",
    artifactPath: "/metagraph/validators/operators.json",
    handle: handleValidatorOperatorDirectory,
  },
] as const;

const usageMatchers = EXPLORER_DIRECTORY_ENTRIES.map(({ path }) => ({
  path,
  pattern: new RegExp(`^${path}$`),
}));

export async function handleDefaultExplorerDirectory(
  request: Request,
  env: Env,
  ctx: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<Response | null> {
  // Variants continue through the existing router's query, network, method and
  // payment gates. This entry owns only the two anonymous default reads.
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    env.METAGRAPH_NEURONS_SOURCE !== "data-api" ||
    request.headers.has("authorization") ||
    request.headers.has("x-payment") ||
    request.headers.has("payment-signature") ||
    request.headers.has("upgrade")
  )
    return null;
  const url = new URL(request.url);
  if (url.search) return null;
  const entry = EXPLORER_DIRECTORY_ENTRIES.find(
    (row) => row.path === url.pathname,
  );
  if (!entry) return null;
  const response = await withRequestUsageTelemetry(
    request,
    env,
    ctx,
    () =>
      withResponseTiming(() => {
        recordMatchedUsageRollup(env, ctx, url.pathname, false, usageMatchers);
        return withStampedEdgeCache(
          request,
          ctx,
          env,
          entry.id,
          (cacheRequest) => entry.handle(cacheRequest, env),
          entry.path,
          readExplorerDirectoryCacheStamp,
        );
      }),
    () => entry.id,
  );
  return auditRouteResponse(request, env, ctx, response, () => entry);
}
