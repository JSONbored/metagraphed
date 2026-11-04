import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { buildNativeOAuth } from "../../scripts/build-native-oauth.ts";
import { loadNativeOAuthProvider } from "../../src/native-oauth-provider.ts";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";

export async function nativeOAuthFixture() {
  const directory = await mkdtemp(join(tmpdir(), "oauth-fixture-"));
  const file = join(directory, "provider.mjs");
  await buildNativeOAuth(file);
  return {
    module: await loadNativeOAuthProvider(pathToFileURL(file)),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

export const oauthOptions = {
  apiRoute: "/mcp",
  apiHandler: {
    fetch: async (_request, _env, ctx) => Response.json(ctx.props),
  },
  defaultHandler: { fetch: async () => new Response("default") },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  disallowPublicClientRegistration: false,
  allowPlainPKCE: false,
  scopesSupported: ["profile", "read"],
  accessTokenTTL: 3600,
  onError: () => {},
} satisfies OAuthProviderOptions<object>;

export const oauthContext = {
  props: {},
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
export const verifier = "test-code-verifier-with-at-least-forty-three-bytes";
export const challenge = createHash("sha256")
  .update(verifier)
  .digest("base64url");

export function tokenRequest(
  values: Record<string, string>,
  url = "https://server.example/oauth/token",
) {
  return new Request(url, {
    method: "POST",
    body: new URLSearchParams(values),
  });
}

export function authorizeRequest(
  clientId: string,
  resource = "https://server.example/mcp",
) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://client.example/callback",
    scope: "profile read",
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  });
  return new Request(`https://server.example/authorize?${query}`);
}
