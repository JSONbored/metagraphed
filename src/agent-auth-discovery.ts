import {
  AGENT_AUTH_CLAIM_GRANT,
  AGENT_AUTH_ISSUER,
  AGENT_AUTH_JWT_GRANT,
  isAgentAuthReady,
  type AgentAuthEnv,
} from "./agent-auth.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

// Discovery may briefly lag a readiness change; credential issuance still
// checks the live bindings and private schema on every request.
const READY_TTL_MS = 30_000;
const UNREADY_TTL_MS = 5_000;
const READINESS_CONFIGURATION = [
  "D1_STATE",
  "D1_STATE_TABLES",
  "AUTHMD_SIGNING_JWK",
  "AGENT_AUTH_RATE_LIMITER",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "DATA_API",
  "API_KEY_LOOKUP_INTERNAL_TOKEN",
] as const satisfies readonly (keyof AgentAuthEnv)[];
type ReadinessConfiguration = Pick<
  AgentAuthEnv,
  (typeof READINESS_CONFIGURATION)[number]
>;
type ReadinessEntry = {
  configuration: ReadinessConfiguration;
  expiresAt: number;
  promise: Promise<boolean>;
};
let readinessCache: ReadinessEntry | undefined;
registerModuleStateReset("src/agent-auth-discovery.ts", () => {
  readinessCache = undefined;
});

/** One bounded entry coalesces probes without retaining old configurations. */
async function discoveryReady(env: AgentAuthEnv): Promise<boolean> {
  const previous = readinessCache;
  if (
    previous &&
    READINESS_CONFIGURATION.every(
      (key) => previous.configuration[key] === env[key],
    ) &&
    Date.now() < previous.expiresAt
  ) {
    return previous.promise;
  }
  const entry: ReadinessEntry = {
    configuration: Object.fromEntries(
      READINESS_CONFIGURATION.map((key) => [key, env[key]]),
    ) as ReadinessConfiguration,
    // Bound even an unresolved probe; an old completion only updates its own
    // entry, never a newer configuration's cached result.
    expiresAt: Date.now() + READY_TTL_MS,
    promise: Promise.resolve(false),
  };
  entry.promise = isAgentAuthReady(env)
    .catch(() => false)
    .then((ready) => {
      entry.expiresAt = Date.now() + (ready ? READY_TTL_MS : UNREADY_TTL_MS);
      return ready;
    });
  readinessCache = entry;
  return entry.promise;
}

/** Publish registration only after the key and private migration are usable. */
export async function augmentAgentAuthDiscovery(
  request: Request,
  response: Response,
  env: AgentAuthEnv,
): Promise<Response> {
  if (
    request.method !== "GET" ||
    response.status !== 200 ||
    !(await discoveryReady(env))
  ) {
    return response;
  }
  const metadata: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    (metadata as Record<string, unknown>).issuer !== AGENT_AUTH_ISSUER
  ) {
    return response;
  }
  const document = metadata as Record<string, unknown>;
  const grants = Array.isArray(document.grant_types_supported)
    ? document.grant_types_supported.filter(
        (grant): grant is string => typeof grant === "string",
      )
    : [];
  const endpoint = (path: string) => `${AGENT_AUTH_ISSUER}${path}`;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({
      ...document,
      jwks_uri: endpoint("/oauth/jwks"),
      grant_types_supported: [
        ...new Set([...grants, AGENT_AUTH_CLAIM_GRANT, AGENT_AUTH_JWT_GRANT]),
      ],
      agent_auth: {
        skill: endpoint("/auth.md"),
        identity_endpoint: endpoint("/agent/register"),
        claim_endpoint: endpoint("/agent/claim"),
        // register_uri is the discovery alias used by older Auth.md scanners.
        register_uri: endpoint("/agent/register"),
        identity_types_supported: ["service_auth"],
        service_auth: {
          claim_required: true,
          post_claim_scopes: ["profile"],
        },
      },
    }),
    { status: response.status, headers },
  );
}
