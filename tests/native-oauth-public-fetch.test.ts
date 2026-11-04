import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { buildOAuthProviderOptions } from "../src/github-oauth.ts";
import {
  nativeOAuthFixture,
  authorizeRequest,
} from "./helpers/native-oauth-fixture.ts";

let native: Awaited<ReturnType<typeof nativeOAuthFixture>>;
beforeAll(async () => {
  native = await nativeOAuthFixture();
});
afterAll(async () => {
  await native.close();
});
const options = buildOAuthProviderOptions({
  fetch: async () => new Response("application"),
});
const metadataUrl = "https://client.example/client.json";
const metadata = {
  client_id: metadataUrl,
  client_name: "Public fixture client",
  redirect_uris: ["https://client.example/callback"],
  token_endpoint_auth_method: "none",
};
const resolver = (async () => [
  { address: "93.184.216.34", family: 4 },
]);

test("real provider advertises and resolves CIMD using isolated public-only fetch", async () => {
  const beforeFetch = globalThis.fetch;
  const beforeCloudflare = Object.getOwnPropertyDescriptor(
    globalThis,
    "Cloudflare",
  );
  const requests: string[] = [];
  const module = native.module.createNativeOAuthModule({
    resolver,
    transport: (async (input) => {
      requests.push(String(input));
      return Response.json(metadata);
    }) as typeof fetch,
  });
  const helpers = module.getOAuthApi(options, {} as Env);
  const client = await helpers.lookupClient(metadataUrl);
  assert.equal(client?.clientName, metadata.client_name);
  assert.equal(
    (await helpers.parseAuthRequest(authorizeRequest(metadataUrl))).clientId,
    metadataUrl,
  );
  const provider = new module.OAuthProvider(options);
  const discovery = await provider.fetch(
    new Request(
      "https://server.example/.well-known/oauth-authorization-server",
    ),
    {} as Env,
    { waitUntil() {} },
  );
  assert.equal(
    (
      (await discovery.json()) as {
        client_id_metadata_document_supported: boolean;
      }
    ).client_id_metadata_document_supported,
    true,
  );
  assert.deepEqual(requests, [metadataUrl, metadataUrl]);
  assert.equal(globalThis.fetch, beforeFetch);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(globalThis, "Cloudflare"),
    beforeCloudflare,
  );
});

test("real CIMD refuses private redirects and mismatched metadata without fetching private hosts", async () => {
  const requests: string[] = [];
  const module = native.module.createNativeOAuthModule({
    resolver,
    transport: (async (input) => {
      requests.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      });
    }) as typeof fetch,
  });
  assert.equal(
    await module.getOAuthApi(options, {} as Env).lookupClient(metadataUrl),
    null,
  );
  assert.deepEqual(requests, [metadataUrl]);
  const mismatch = native.module.createNativeOAuthModule({
    resolver,
    transport: (async () =>
      Response.json({
        ...metadata,
        client_id: "https://other.example/client.json",
      })) as typeof fetch,
  });
  assert.equal(
    await mismatch.getOAuthApi(options, {} as Env).lookupClient(metadataUrl),
    null,
  );
});
