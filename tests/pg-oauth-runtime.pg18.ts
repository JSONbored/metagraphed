import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgOAuthProvider } from "../src/pg-oauth-provider.ts";
import {
  nativeOAuthFixture,
  oauthOptions,
  oauthContext,
  tokenRequest,
  authorizeRequest,
  verifier,
} from "./helpers/native-oauth-fixture.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
let native: Awaited<ReturnType<typeof nativeOAuthFixture>>;
let runtime: PgStoreRuntime;
let provider: ReturnType<typeof createPgOAuthProvider<object>>;
let ownsSchema = false;

interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
  error?: string;
}

async function register() {
  const response = await provider.fetch(
    new Request("https://server.example/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        client_name: "fixture",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    }),
    {},
    oauthContext,
  );
  assert.equal(response.status, 201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorize(clientId: string, scope = ["profile"]) {
  const helpers = provider.helpers({});
  const request = await helpers.parseAuthRequest(authorizeRequest(clientId));
  const completed = await helpers.completeAuthorization({
    request,
    userId: "fixture-user",
    scope,
    props: { login: "fixture", accountId: 7 },
    metadata: { label: "fixture" },
  });
  return new URL(completed.redirectTo).searchParams.get("code")!;
}

function exchange(
  clientId: string,
  code: string,
  extra: Record<string, string> = {},
) {
  return provider.fetch(
    tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: "https://client.example/callback",
      ...extra,
    }),
    {},
    oauthContext,
  );
}

function refresh(
  clientId: string,
  refreshToken: string,
  extra: Record<string, string> = {},
) {
  return provider.fetch(
    tokenRequest({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      ...extra,
    }),
    {},
    oauthContext,
  );
}

function bearer(token: string, url = "https://server.example/mcp") {
  return provider.fetch(
    new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
    {},
    oauthContext,
  );
}

async function snapshot() {
  return (
    await control.query(
      "SELECT encode(key,'hex') AS key,encode(value,'hex') AS value,metadata,expires_at FROM auth.kv_entries ORDER BY namespace,key",
    )
  ).rows;
}

describe(
  "actual upstream OAuth on PostgreSQL 18.6",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await control.query(
        readFileSync(
          new URL("../migrations/postgres/0009_auth_kv.sql", import.meta.url),
          "utf8",
        ),
      );
      ownsSchema = true;
      native = await nativeOAuthFixture();
      const connection = new URL(connectionString);
      // Prove the namespace adapter does not inherit a stale transaction snapshot.
      connection.searchParams.set(
        "options",
        "-c default_transaction_isolation=repeatable\\ read",
      );
      runtime = createPgStoreRuntime({
        connectionString: connection.toString(),
        maxConnections: 4,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError(error) {
          throw error;
        },
      });
      provider = createPgOAuthProvider(runtime, native.module, oauthOptions);
    });
    beforeEach(async () => {
      await control.query("TRUNCATE auth.kv_entries");
    });
    after(async () => {
      try {
        await runtime?.close();
        await native?.close();
        if (ownsSchema) await control.query("DROP SCHEMA auth CASCADE");
      } finally {
        await control.end();
      }
    });

    it("keeps registration, PKCE, encrypted identity, audience and scope semantics", async () => {
      const clientId = await register(),
        code = await authorize(clientId);
      const wrong = await exchange(clientId, code, {
        code_verifier: "wrong-verifier",
      });
      assert.equal(wrong.status, 400);
      const response = await exchange(clientId, code);
      assert.equal(response.status, 200);
      const tokens = (await response.json()) as Tokens;
      assert.equal(tokens.scope, "profile");
      assert.deepEqual(await (await bearer(tokens.access_token)).json(), {
        login: "fixture",
        accountId: 7,
      });
      assert.equal(
        (await bearer(tokens.access_token, "https://other.example/mcp")).status,
        401,
      );
      const unwrapped = await provider
        .helpers({})
        .unwrapToken<{ accountId: number }>(tokens.access_token);
      assert.equal(unwrapped?.grant.props.accountId, 7);
      assert.deepEqual(unwrapped?.scope, ["profile"]);
      const exchanged = await provider.helpers({}).exchangeToken({
        subjectToken: tokens.access_token,
        scope: ["profile", "read"],
        aud: "https://server.example/mcp",
        expiresIn: 60,
      });
      assert.equal(exchanged.scope, "profile");
      assert.equal((await bearer(exchanged.access_token)).status, 200);
      await assert.rejects(
        provider.helpers({}).exchangeToken({
          subjectToken: tokens.access_token,
          aud: "https://other.example/mcp",
        }),
        /not included in the authorization request/,
      );
      const downscoped = await refresh(clientId, tokens.refresh_token, {
        scope: "read",
      });
      assert.equal(downscoped.status, 200);
      assert.equal(((await downscoped.json()) as Tokens).scope, "");
      assert.deepEqual(
        (await provider.helpers({}).listClients({ limit: 1 })).items.map(
          (client) => client.clientId,
        ),
        [clientId],
      );
      assert.equal(
        (await provider.helpers({}).listUserGrants("fixture-user")).items
          .length,
        1,
      );
    });

    it("preserves deliberate previous-refresh-token retry behavior", async () => {
      const clientId = await register(),
        code = await authorize(clientId);
      const original = (await (
        await exchange(clientId, code)
      ).json()) as Tokens;
      const first = (await (
        await refresh(clientId, original.refresh_token)
      ).json()) as Tokens;
      const retried = await refresh(clientId, original.refresh_token);
      assert.equal(retried.status, 200);
      const replacement = (await retried.json()) as Tokens;
      assert.notEqual(replacement.refresh_token, first.refresh_token);
      assert.equal((await refresh(clientId, first.refresh_token)).status, 400);
      assert.equal(
        (await refresh(clientId, replacement.refresh_token)).status,
        200,
      );
      assert.equal((await bearer(original.access_token)).status, 200);
    });

    it("serializes code replay across independent compositions and commits intentional revocation", async () => {
      const clientId = await register(),
        code = await authorize(clientId);
      const other = createPgOAuthProvider(runtime, native.module, oauthOptions);
      const request = () =>
        tokenRequest({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: "https://client.example/callback",
        });
      const responses = await Promise.all([
        provider.fetch(request(), {}, oauthContext),
        other.fetch(request(), {}, oauthContext),
      ]);
      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [200, 400],
      );
      const success = responses.find((response) => response.status === 200)!;
      const tokens = (await success.json()) as Tokens;
      assert.equal((await bearer(tokens.access_token)).status, 401);
      assert.equal(
        (await provider.helpers({}).listUserGrants("fixture-user")).items
          .length,
        0,
      );
    });

    it("keeps revocation, client update, deletion and purge on the native owner", async () => {
      const helpers = provider.helpers({});
      const client = await helpers.createClient({
        redirectUris: ["https://client.example/callback"],
        tokenEndpointAuthMethod: "none",
      });
      assert.equal(
        (await helpers.updateClient(client.clientId, { clientName: "changed" }))
          ?.clientName,
        "changed",
      );
      const code = await authorize(client.clientId);
      const tokens = (await (
        await exchange(client.clientId, code)
      ).json()) as Tokens;
      const revoked = await provider.fetch(
        tokenRequest({
          client_id: client.clientId,
          token: tokens.refresh_token,
          token_type_hint: "refresh_token",
        }),
        {},
        oauthContext,
      );
      assert.equal(revoked.status, 200);
      assert.equal((await bearer(tokens.access_token)).status, 401);
      await helpers.deleteClient(client.clientId);
      assert.equal(await helpers.lookupClient(client.clientId), null);
      assert.ok(await helpers.purgeExpiredData());
    });

    it("rolls back grant rotation when the actual token write fails, then permits retry", async () => {
      const clientId = await register(),
        code = await authorize(clientId);
      const original = await snapshot();
      await control.query(`CREATE FUNCTION auth.reject_token() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF convert_from(NEW.key,'UTF8') LIKE 'token:%' THEN RAISE EXCEPTION 'fixture token failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_token BEFORE INSERT OR UPDATE ON auth.kv_entries FOR EACH ROW EXECUTE FUNCTION auth.reject_token()`);
      try {
        const response = await exchange(clientId, code).catch(() => null);
        if (response) assert.ok(response.status >= 500);
        assert.deepEqual(await snapshot(), original);
      } finally {
        await control.query(
          "DROP TRIGGER reject_token ON auth.kv_entries; DROP FUNCTION auth.reject_token()",
        );
      }
      assert.equal((await exchange(clientId, code)).status, 200);
    });

    it("rolls back a new grant when upstream catches a prior-grant deletion failure", async () => {
      const clientId = await register();
      await authorize(clientId);
      const original = await snapshot();
      await control.query(`CREATE FUNCTION auth.reject_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'fixture revoke failure'; END $$;
      CREATE TRIGGER reject_revoke BEFORE DELETE ON auth.kv_entries FOR EACH ROW EXECUTE FUNCTION auth.reject_revoke()`);
      try {
        await assert.rejects(authorize(clientId), /fixture revoke failure/);
        assert.deepEqual(await snapshot(), original);
      } finally {
        await control.query(
          "DROP TRIGGER reject_revoke ON auth.kv_entries; DROP FUNCTION auth.reject_revoke()",
        );
      }
    });

    it("releases bearer lookup admission before delegated application work", async () => {
      const clientId = await register(),
        code = await authorize(clientId);
      const tokens = (await (await exchange(clientId, code)).json()) as Tokens;
      const single = createPgStoreRuntime({
        connectionString,
        maxConnections: 1,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 1000,
        statementTimeoutMillis: 5000,
        onIdleError(error) {
          throw error;
        },
      });
      try {
        const delegated = createPgOAuthProvider(single, native.module, {
          ...oauthOptions,
          apiHandler: {
            async fetch(_request, env) {
              const helpers = (
                env as { OAUTH_PROVIDER: ReturnType<typeof provider.helpers> }
              ).OAUTH_PROVIDER;
              await helpers.lookupClient(clientId);
              assert.equal(
                (
                  await single.producer.first<{ value: number }>(
                    "SELECT 7 AS value",
                  )
                )?.value,
                7,
              );
              return new Response("application complete");
            },
          },
        });
        const response = await delegated.fetch(
          new Request("https://server.example/mcp", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          }),
          {},
          oauthContext,
        );
        assert.equal(await response.text(), "application complete");
      } finally {
        await single.close();
      }
    });
  },
);
