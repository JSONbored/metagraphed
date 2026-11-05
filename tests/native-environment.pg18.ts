import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { before, after, afterEach, describe, it } from "node:test";
import { Client, Pool, type PoolConfig } from "pg";
import { createNativeEnvironment } from "../src/native-environment.ts";
import { NativeStartupCleanupError } from "../src/native-api-process.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgOAuthProvider } from "../src/pg-oauth-provider.ts";
import { listenNativeApi } from "../src/native-http-server.ts";
import { createNativeChainWebSocketTransport } from "../src/native-chain-websocket.ts";
import { nativeEnvironmentFixture } from "./helpers/native-environment-fixture.ts";
import {
  nativeOAuthFixture,
  oauthOptions,
  authorizeRequest,
  tokenRequest,
  verifier,
} from "./helpers/native-oauth-fixture.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const url = pg18FixtureUrl();
const database = "native_environment_" + randomUUID().replaceAll("-", "");
const target = new URL(url);
target.pathname = "/" + database;
const admin = new Client({
  connectionString: url.toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const control = new Client({
  connectionString: target.toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
let created = false;
let directory = "";
let oauth: Awaited<ReturnType<typeof nativeOAuthFixture>>;
let outbound = 0;
const originalFetch = globalThis.fetch;
const applications: Awaited<ReturnType<typeof createNativeEnvironment>>[] = [];
const listeners: Awaited<ReturnType<typeof listenNativeApi>>[] = [];
const pools: { pool: Pool; ended: number }[] = [];
const poolFactory = (config: PoolConfig) => {
  const pool = new Pool(config);
  const state = { pool, ended: 0 };
  const end = pool.end.bind(pool);
  Object.defineProperty(pool, "end", {
    value: async () => {
      state.ended++;
      await end();
    },
  });
  pools.push(state);
  return pool;
};
function options() {
  return nativeEnvironmentFixture(
    target.toString(),
    url.username,
    { assets: join(directory, "assets"), archive: join(directory, "archive") },
    oauth.module,
  );
}

describe(
  "complete native application environment",
  { concurrency: false },
  () => {
    before(async () => {
      await admin.connect();
      assert.equal(
        (await admin.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await admin.query(`CREATE DATABASE ${database}`);
      created = true;
      await control.connect();
      const root = new URL("../migrations/postgres/", import.meta.url);
      for (const file of readdirSync(root)
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        await control.query("BEGIN");
        try {
          if (file === "0019_raw_capture_activate.sql")
            await control.query(
              "INSERT INTO app.raw_capture_budget(id) VALUES(1)",
            );
          await control.query(readFileSync(new URL(file, root), "utf8"));
          await control.query("COMMIT");
        } catch (error) {
          await control.query("ROLLBACK");
          throw error;
        }
      }
      directory = await mkdtemp(join(tmpdir(), "native-environment-"));
      await mkdir(join(directory, "assets"), { mode: 0o700 });
      await mkdir(join(directory, "archive"), { mode: 0o700 });
      await writeFile(
        join(directory, "assets", "fixture.txt"),
        "native fixture\n",
        { mode: 0o600 },
      );
      oauth = await nativeOAuthFixture();
      globalThis.fetch = async () => {
        outbound++;
        throw new Error("Environment fixture must not make outbound requests");
      };
    });
    afterEach(async () => {
      for (const listener of listeners.splice(0)) await listener.close();
      for (const application of applications.splice(0))
        await application.close();
    });
    after(async () => {
      globalThis.fetch = originalFetch;
      if (oauth) await oauth.close();
      if (directory) await rm(directory, { recursive: true, force: true });
      await control.end();
      if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await admin.end();
    });

    it("serves actual main, data, registry, OAuth and actor paths through one pool", async () => {
      const count = pools.length;
      const requested = options();
      requested.postgres.maxConnections = 5;
      const application = await createNativeEnvironment(requested, poolFactory);
      applications.push(application);
      assert.equal(pools.length, count + 1);
      assert.equal(application.state, "ready");
      const listener = await listenNativeApi(application, {
        origin: "https://fixture.example",
        hostname: "127.0.0.1",
        port: 0,
        maxRequestBytes: 1048576,
        requestTimeoutMillis: 1000,
        headersTimeoutMillis: 1000,
        upgrade: createNativeChainWebSocketTransport(application.chain, {
          closeGraceMillis: 100,
          onError(error) {
            throw error;
          },
        }),
        onError(error) {
          throw error;
        },
      });
      listeners.push(listener);
      assert.equal(
        await (
          await originalFetch(
            `http://127.0.0.1:${listener.address.port}/fixture.txt`,
          )
        ).text(),
        "native fixture\n",
      );

      const registry = await application.owners.registry.fetch(
        new Request("https://registry.example/", {
          method: "POST",
          headers: { "x-registry-sync-token": "fixture-secret" },
          body: JSON.stringify({
            providers: [
              {
                id: "fixture",
                overlay: { name: "Fixture" },
                source_commit: "fixture",
              },
            ],
          }),
        }),
      );
      assert.equal(registry.status, 200);
      assert.equal(
        ((await registry.json()) as { providers_written: number })
          .providers_written,
        1,
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::int n FROM app.providers WHERE id='fixture'",
          )
        ).rows[0].n,
        1,
      );

      await control.query(
        "INSERT INTO app.surface_status(surface_id,netuid,last_checked) VALUES('fixture',7,1)",
      );
      const data = await application.owners.data.fetch(
        new Request(
          "https://data.example/api/v1/internal/health-status-live?since=0",
        ),
      );
      assert.equal(data.status, 200);
      assert.equal(
        ((await data.json()) as { rows: { surface_id: string }[] }).rows[0]!
          .surface_id,
        "fixture",
      );
      const detail = await application.owners.data.fetch(
        new Request("https://data.example/api/v1/validators/fixture"),
      );
      assert.equal(
        detail.status,
        200,
        "one enabled validator detail fanout must fit the shared pool",
      );
      await detail.text();

      const client = await application.fetch(
        new Request("https://fixture.example/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "Fixture",
            redirect_uris: ["https://client.example/callback"],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
          }),
        }),
      );
      assert.equal(client.status, 201);
      const clientId = ((await client.json()) as { client_id: string })
        .client_id;
      assert.equal(typeof clientId, "string");
      assert(
        (await control.query("SELECT count(*)::int n FROM auth.kv_entries"))
          .rows[0].n > 0,
      );

      const initialize = (token?: string) =>
        application.fetch(
          new Request("https://fixture.example/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "fixture", version: "1" },
              },
            }),
          }),
        );
      const anonymous = await initialize();
      assert.equal(anonymous.status, 401);
      await anonymous.text();
      // Fixture-only grant setup uses the already-created application pool.
      // The upstream provider still owns grant formats, crypto and exchange.
      const seed = createPgStoreRuntime(
        options().postgres,
        () => pools[count]!.pool,
      );
      const grants = createPgOAuthProvider(
        seed,
        oauth.module,
        oauthOptions,
      ).helpers({});
      const authRequest = await grants.parseAuthRequest(
        authorizeRequest(clientId, "https://fixture.example/mcp"),
      );
      const account = await control.query(
        "INSERT INTO app.github_accounts(github_user_id,github_login,created_at) VALUES(7,'fixture',1) RETURNING id",
      );
      const grant = await grants.completeAuthorization({
        request: authRequest,
        userId: "fixture",
        scope: ["profile"],
        props: { login: "fixture", accountId: Number(account.rows[0].id) },
        metadata: { label: "fixture" },
      });
      const exchanged = await application.fetch(
        tokenRequest(
          {
            grant_type: "authorization_code",
            client_id: clientId,
            code: new URL(grant.redirectTo).searchParams.get("code")!,
            code_verifier: verifier,
            redirect_uri: "https://client.example/callback",
          },
          "https://fixture.example/oauth/token",
        ),
      );
      assert.equal(exchanged.status, 200, await exchanged.clone().text());
      const token = ((await exchanged.json()) as { access_token: string })
        .access_token;
      const initialized = await initialize(token);
      assert.equal(initialized.status, 200, await initialized.clone().text());
      await initialized.text();
      assert(
        (
          await control.query(
            "SELECT count(*)::int n FROM realtime.mcp_sessions",
          )
        ).rows[0].n > 0,
      );
      const changed = await application.background("api", () =>
        application.chain.fetch(
          new Request("https://chain.internal/mcp-subscribe", {
            method: "POST",
            body: JSON.stringify({ sessionId: "fixture-session" }),
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      assert.equal(changed.status, 200);
      await changed.text();
      assert(
        (
          await control.query(
            "SELECT state FROM realtime.chain_firehose_actor WHERE singleton",
          )
        ).rows[0].state.includes("fixture-session"),
      );

      await control.query(
        "INSERT INTO app.subnet_hyperparams(netuid,captured_at) VALUES(7,1000)",
      );
      const exported = await application.fetch(
        new Request("https://fixture.example/api/v1/internal/state-export", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-state-export-token": "fixture-secret",
          },
          body: JSON.stringify({
            table: "subnet_hyperparams",
            kind: "rows",
            columns: ["netuid", "captured_at"],
          }),
        }),
      );
      assert.equal(exported.status, 200);
      assert((await exported.text()).includes("1000"));
      assert.equal(
        (await control.query("SELECT count(*)::int n FROM jobs.cron_schedules"))
          .rows[0].n,
        0,
        "construction must not activate schedules",
      );
      assert.equal(outbound, 0);
      const socket = new WebSocket(
        `ws://127.0.0.1:${listener.address.port}/api/v1/chain/stream`,
      );
      await once(socket, "open");
      const socketClosed = once(socket, "close");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admitted = application.background("api", async () => {
        await gate;
        assert.equal(
          application.chain.state,
          "ready",
          "socket closure must not close an adapter used by admitted work",
        );
      });
      const closing = listener.close();
      assert.equal(listener.close(), closing);
      try {
        await socketClosed;
        assert.equal(application.chain.state, "ready");
      } finally {
        release();
      }
      await admitted;
      await closing;
      await application.close();
      assert.equal(application.state, "closed");
      assert.equal(pools[count]!.ended, 1);
      assert.equal(
        (
          await control.query(
            "SELECT owner_token FROM realtime.alerter_owner WHERE singleton",
          )
        ).rows[0].owner_token,
        null,
      );
    });

    it("preserves a retryable cleanup owner and pool after partial startup failure", async () => {
      await control.query(
        "CREATE FUNCTION realtime.fixture_reject_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_token IS NULL THEN RAISE EXCEPTION 'fixture release rejected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_reject_release BEFORE UPDATE ON realtime.alerter_owner FOR EACH ROW EXECUTE FUNCTION realtime.fixture_reject_release()",
      );
      const count = pools.length;
      let pending: NativeStartupCleanupError | undefined;
      try {
        const invalid = options();
        invalid.queues.maxMessages = 0;
        await assert.rejects(
          createNativeEnvironment(invalid, poolFactory),
          (error: unknown) => {
            assert(error instanceof NativeStartupCleanupError, String(error));
            pending = error;
            return true;
          },
        );
        assert.equal(pools.length, count + 1);
        assert.equal(pools[count]!.ended, 0);
      } finally {
        await control.query(
          "DROP TRIGGER fixture_reject_release ON realtime.alerter_owner; DROP FUNCTION realtime.fixture_reject_release()",
        );
        await pending?.close();
      }
      assert.equal(pools[count]!.ended, 1);
      assert.equal(outbound, 0);
    });

    it("refuses to drop an existing alert channel's required credentials", async () => {
      await control.query(
        "INSERT INTO app.chain_alert_triggers(owner_token,channel,destination,created_at,updated_at) VALUES('fixture','telegram','fixture',1,1)",
      );
      const count = pools.length;
      try {
        await assert.rejects(
          createNativeEnvironment(options(), poolFactory),
          /TELEGRAM_BOT_TOKEN/,
        );
        assert.equal(pools[count]!.ended, 1);
      } finally {
        await control.query(
          "DELETE FROM app.chain_alert_triggers WHERE owner_token='fixture'",
        );
      }
      assert.equal(outbound, 0);
    });
    it("cleans the complete environment when explicit HTTP binding fails", async () => {
      const occupied = createServer();
      await new Promise<void>((resolve) =>
        occupied.listen(0, "127.0.0.1", resolve),
      );
      const address = occupied.address();
      assert(address && typeof address !== "string");
      const count = pools.length;
      const application = await createNativeEnvironment(options(), poolFactory);
      applications.push(application);
      try {
        await assert.rejects(
          listenNativeApi(application, {
            origin: "https://fixture.example",
            hostname: "127.0.0.1",
            port: address.port,
            maxRequestBytes: 1048576,
            requestTimeoutMillis: 1000,
            headersTimeoutMillis: 1000,
            upgrade: createNativeChainWebSocketTransport(application.chain, {
              closeGraceMillis: 100,
              onError() {},
            }),
            onError() {},
          }),
          /EADDRINUSE/,
        );
        assert.equal(application.state, "closed");
        assert.equal(pools[count]!.ended, 1);
      } finally {
        await new Promise<void>((resolve, reject) =>
          occupied.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  },
);
