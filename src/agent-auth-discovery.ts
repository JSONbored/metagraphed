import {
  AGENT_AUTH_CLAIM_GRANT,
  AGENT_AUTH_ISSUER,
  AGENT_AUTH_JWT_GRANT,
  isAgentAuthReady,
  type AgentAuthEnv,
} from "./agent-auth.ts";

/** Publish registration only after the key and private migration are usable. */
export async function augmentAgentAuthDiscovery(
  request: Request,
  response: Response,
  env: AgentAuthEnv,
): Promise<Response> {
  if (
    request.method !== "GET" ||
    response.status !== 200 ||
    !(await isAgentAuthReady(env))
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
