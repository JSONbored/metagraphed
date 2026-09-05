import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, test, vi } from "vitest";
import { createSessionToken } from "../src/wallet-auth.ts";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import { mockEnv } from "./row-type.ts";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
const { default: dataWorker } = await import("../workers/data-api.ts");
const { handleRequest } = await import("../workers/api.ts");

afterEach(() => vi.unstubAllGlobals());

test("a successful wallet key revoke prevents the next fullnode request with a cached identity", async () => {
  const rawKey = "mg_request_regression_synthetic_key";
  const keyId = "key_request_regression";
  const db = new PGlite();
  let enabled = true;
  let verifies = 0;
  let upstreamCalls = 0;
  const pending: Promise<unknown>[] = [];
  try {
    const migration = readFileSync(
      "migrations/neon/0005_remaining_d1_tables.sql",
      "utf8",
    );
    await db.exec(
      migration.slice(
        migration.indexOf("CREATE TABLE IF NOT EXISTS rpc_accounts"),
        migration.indexOf("-- The partial unique index is the constraint"),
      ),
    );
    await db.exec(
      readFileSync(
        "migrations/neon/0038_api_key_revocation_intent.sql",
        "utf8",
      ),
    );
    await db.query(
      "INSERT INTO rpc_accounts (id,ss58,tier,created_at) VALUES (11,'5SyntheticOwner','free',0)",
    );
    await db.query(
      "INSERT INTO api_keys (unkey_key_id,account_id,owner_contact,tier,created_at) VALUES ($1,11,'synthetic','free',0)",
      [keyId],
    );
    pg.control.postgres = async (text, values) =>
      (await db.query(text, values)).rows;
    const store = new Map<string, string>();
    const kv = {
      async get(key: string, options?: { type?: string }) {
        const entry = store.get(key);
        return entry
          ? options?.type === "json"
            ? JSON.parse(entry)
            : entry
          : null;
      },
      async put(
        key: string,
        value: string,
        options: { expirationTtl: number },
      ) {
        assert.ok(options.expirationTtl >= 60);
        store.set(key, value);
      },
    };
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
    } as ExecutionContext;
    const dataEnv = dataApiEnv({
      ...pgMockEnv(),
      METAGRAPH_CONTROL: kv,
      WALLET_SESSION_SECRET: "synthetic-session-secret",
      UNKEY_ROOT_KEY: "synthetic-unkey-root",
      UNKEY_API_ID: "api_synthetic",
      API_KEY_LOOKUP_INTERNAL_TOKEN: "synthetic-lookup",
    });
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (
          url.hostname === "api.unkey.com" &&
          url.pathname.endsWith("keys.verifyKey")
        ) {
          verifies++;
          assert.deepEqual(JSON.parse(String(init?.body)), { key: rawKey });
          return Response.json({
            data: enabled
              ? {
                  valid: true,
                  code: "VALID",
                  keyId,
                  meta: { tier: "free" },
                  identity: { externalId: "11" },
                }
              : { valid: false, code: "DISABLED" },
          });
        }
        if (
          url.hostname === "api.unkey.com" &&
          url.pathname.endsWith("keys.updateKey")
        ) {
          assert.deepEqual(JSON.parse(String(init?.body)), {
            keyId,
            enabled: false,
          });
          enabled = false;
          return Response.json({ data: {} });
        }
        if (url.hostname === "fullnode-fixture.example") {
          upstreamCalls++;
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: { peers: 1, isSyncing: false },
          });
        }
        throw new Error(
          `Unexpected outbound request: ${url.origin}${url.pathname}`,
        );
      },
    );
    const rateLimit = vi.fn(async () => ({ success: true }));
    const env = mockEnv({
      METAGRAPH_CONTROL: kv,
      API_KEY_LOOKUP_INTERNAL_TOKEN: "synthetic-lookup",
      DATA_API: {
        fetch: (request: Request) => dataWorker.fetch(request, dataEnv, ctx),
      },
      FULLNODE_RPC_ORIGINS: "https://fullnode-fixture.example",
      FULLNODE_RPC_RATE_LIMITER: { limit: rateLimit },
    });
    const request = () =>
      new Request("https://api.metagraph.sh/rpc/v1/fullnode", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "system_health",
        }),
      });
    assert.equal((await handleRequest(request(), env, ctx)).status, 200);
    assert.equal(verifies, 1);
    assert.equal(upstreamCalls, 1);
    await Promise.allSettled(pending);
    const cached = [...store.entries()].find(([key]) =>
      key.startsWith("api-key-lookup:v3:"),
    );
    assert.ok(cached);
    const session = await createSessionToken("synthetic-session-secret", {
      accountId: 11,
      ss58: "5SyntheticOwner",
    });
    const revoked = await dataWorker.fetch(
      new Request(`https://api.metagraph.sh/api/v1/keys/${keyId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session}` },
      }),
      dataEnv,
      ctx,
    );
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), { key_id: keyId, revoked: true });
    assert.equal(enabled, false);
    assert.notEqual(
      (
        await db.query<{ revoked_at: number | null }>(
          "SELECT revoked_at FROM api_keys WHERE unkey_key_id=$1",
          [keyId],
        )
      ).rows[0]!.revoked_at,
      null,
    );
    assert.equal(
      store.get(cached[0]),
      cached[1],
      "positive KV identity remains present for the regression",
    );
    const afterRevoke = await handleRequest(request(), env, ctx);
    assert.equal(afterRevoke.status, 401);
    assert.equal(
      verifies,
      1,
      "the current ledger state denies without another provider call",
    );
    assert.equal(
      upstreamCalls,
      1,
      "revoked key never reaches protected upstream",
    );
    assert.equal(
      rateLimit.mock.calls.length,
      1,
      "denial precedes the later limiter",
    );
  } finally {
    await Promise.allSettled(pending);
    await db.close();
  }
});
