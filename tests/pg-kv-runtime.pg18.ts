import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, after, describe, it } from "node:test";
import { Client } from "pg";
import { getPublicKey, secretFromSeed, sign } from "@scure/sr25519";
import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { createPgKv } from "../src/pg-kv.ts";
import type { OAuthPendingEnv } from "../src/app-kv.ts";
import {
  issueWalletChallenge,
  verifyWalletChallenge,
} from "../src/wallet-auth.ts";
import { encodeAccountId32 } from "../src/ss58.ts";
import {
  handleAuthorizeRequest,
  handleAuthorizeConsent,
  handleGithubOAuthCallback,
} from "../src/github-oauth.ts";
import {
  readRegistryKv,
  registryManifestKey,
  registryObjectKey,
} from "../src/registry-kv.ts";
import {
  latestPointer,
  readHealthKv,
  readR2Object,
} from "../workers/storage.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
let runtime: PgStoreRuntime;
let ownsSchema = false;
let clock = 100_000;
const make = (namespace = "control", limits = {}) =>
  createPgKv(runtime, namespace, { now: () => clock, ...limits });

describe("application KV on PostgreSQL 18.6", { concurrency: false }, () => {
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
    runtime = createPgStoreRuntime({
      connectionString,
      maxConnections: 4,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 1000,
      statementTimeoutMillis: 5000,
      onIdleError(error) {
        throw error;
      },
    });
  });
  beforeEach(async () => {
    clock = 100_000;
    await control.query("TRUNCATE auth.kv_entries");
  });
  after(async () => {
    try {
      await runtime?.close();
      if (ownsSchema) await control.query("DROP SCHEMA auth CASCADE");
    } finally {
      await control.end();
    }
  });

  it("stores byte-identical binary values and UTF-8 keys including NUL, with namespace isolation", async () => {
    const kv = make(),
      other = make("oauth-pending");
    const input = new Uint8Array([0, 255, 240, 159, 146, 169]);
    await kv.put("nul\0é", input);
    assert.deepEqual(
      new Uint8Array((await kv.get("nul\0é", "arrayBuffer"))!),
      input,
    );
    assert.deepEqual(
      new Uint8Array(
        await new Response(await kv.get("nul\0é", "stream")).arrayBuffer(),
      ),
      input,
    );
    assert.equal(await other.get("nul\0é"), null);
    assert.equal(await kv.get("nul\0é"), "\0�💩");
    await kv.put("json", '{"nested":[1,true,null]}');
    assert.deepEqual(await kv.get("json", { type: "json" }), {
      nested: [1, true, null],
    });
    await kv.put("empty", "");
    assert.equal(await kv.get("empty"), "");
    await kv.delete("json");
    assert.equal(await kv.get("json"), null);
  });

  it("keeps metadata values and expiry seconds while expired records become invisible", async () => {
    const kv = make();
    const metadata = { text: "quoted\0é", list: [null, false, 0] };
    await kv.put("expires", "secret", { metadata, expirationTtl: 60 });
    assert.deepEqual((await kv.list()).keys, [
      { name: "expires", expiration: 160, metadata },
    ]);
    clock = 160_000;
    assert.equal(await kv.get("expires"), null);
    assert.equal(await kv.consume!("expires"), null);
    assert.deepEqual((await kv.list()).keys, []);
    assert.equal(
      (await control.query("SELECT count(*) AS n FROM auth.kv_entries")).rows[0]
        .n,
      1,
    );
    await kv.put("expires", "replacement");
    assert.deepEqual((await kv.list()).keys, [{ name: "expires" }]);
  });

  it("lists by bytewise prefix and keyset while rejecting a cursor reused outside its scope", async () => {
    const kv = make();
    for (const key of ["x", "aé", "a\0", "ab", "a", "aa"])
      await kv.put(key, key);
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix: "a", limit: 2, cursor });
      names.push(...page.keys.map((entry) => entry.name));
      cursor = page.cursor;
    } while (cursor);
    assert.deepEqual(names, ["a", "a\0", "aa", "ab", "aé"]);
    const page = await kv.list({ prefix: "a", limit: 1 });
    await assert.rejects(
      make("other").list({ prefix: "a", cursor: page.cursor }),
    );
    await assert.rejects(kv.list({ prefix: "b", cursor: page.cursor }));
    await assert.rejects(kv.list({ cursor: "broken" }));
    await control.query("BEGIN");
    try {
      await control.query("SET LOCAL enable_seqscan=off");
      const plan = await control.query(
        "EXPLAIN (FORMAT JSON,COSTS FALSE) SELECT key FROM auth.kv_entries WHERE namespace='control' AND key>=$1 AND key<$2 ORDER BY key LIMIT 2",
        [Buffer.from("a"), Buffer.from("b")],
      );
      assert.match(JSON.stringify(plan.rows), /kv_entries_pkey/);
    } finally {
      await control.query("ROLLBACK");
    }
  });

  it("enforces stream and byte bounds before a write can replace an existing value", async () => {
    const kv = make("control", { maxValueBytes: 4 });
    await kv.put("bounded", "safe");
    await assert.rejects(
      kv.put(
        "bounded",
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(5));
          },
        }),
      ),
      /budget/,
    );
    assert.equal(await kv.get("bounded"), "safe");
    await make().put("large", "12345");
    await assert.rejects(kv.get("large"), /budget/);
    for (const settings of [
      { expirationTtl: 1 },
      { expiration: 1 },
      { expiration: 200, expirationTtl: 60 },
    ])
      await assert.rejects(kv.put("bad", "v", settings));
  });

  it("lets exactly one concurrent consumer retrieve a pending value", async () => {
    const kv = make();
    await kv.put("nonce", "one-time", { expirationTtl: 60 });
    const outcomes = await Promise.all([
      kv.consume!("nonce"),
      kv.consume!("nonce"),
      kv.consume!("nonce"),
    ]);
    assert.equal(outcomes.filter((value) => value === "one-time").length, 1);
    assert.equal(outcomes.filter((value) => value === null).length, 2);
  });

  it("passes existing wallet signatures through one atomic challenge consumption", async () => {
    const secret = secretFromSeed(new Uint8Array(32).fill(12));
    const ss58 = encodeAccountId32(getPublicKey(secret))!;
    const env = { CONTROL_KV_STORE: make() };
    const issued = await issueWalletChallenge(env, ss58);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const signature = Buffer.from(
      sign(secret, new TextEncoder().encode(issued.message)),
    ).toString("hex");
    const outcomes = await Promise.all([
      verifyWalletChallenge(env, ss58, signature),
      verifyWalletChallenge(env, ss58, signature),
    ]);
    assert.equal(outcomes.filter((value) => value.ok).length, 1);
    assert.deepEqual(
      outcomes.find((value) => !value.ok),
      { ok: false, code: "challenge_expired_or_missing" },
    );
    await issueWalletChallenge(env, ss58, "watch");
    assert.deepEqual(
      await verifyWalletChallenge(env, ss58, "invalid", "watch"),
      { ok: false, code: "invalid_signature" },
    );
    assert.deepEqual(
      await verifyWalletChallenge(env, ss58, signature, "watch"),
      { ok: false, code: "challenge_expired_or_missing" },
    );
  });

  it("runs consent and consumes GitHub pending state once before completing authorization", async () => {
    const pending = make("oauth-pending");
    const authRequest: AuthRequest = {
      responseType: "code",
      clientId: "fixture-client",
      redirectUri: "https://client.example/callback",
      scope: ["profile"],
      state: "client-state",
    };
    let completed = 0;
    const helpers = {
      parseAuthRequest: async () => authRequest,
      lookupClient: async () => ({ clientId: "fixture-client" }),
      completeAuthorization: async () => {
        completed += 1;
        return { redirectTo: "https://client.example/callback?code=done" };
      },
    } as unknown as OAuthHelpers;
    const env = {
      OAUTH_PENDING_STORE: pending,
      GITHUB_OAUTH_CLIENT_ID: "fixture-client",
      GITHUB_OAUTH_CLIENT_SECRET: "fixture-secret",
      API_KEY_LOOKUP_INTERNAL_TOKEN: "fixture-internal",
      DATA_API: { fetch: async () => Response.json({ id: 1 }) },
    } as unknown as Env & OAuthPendingEnv;
    const request = await handleAuthorizeRequest(
      new Request("https://example.com/authorize"),
      env,
      { getHelpers: async () => helpers },
    );
    const nonce = /name="consent_nonce" value="([^"]+)"/.exec(
      await request.text(),
    )?.[1];
    assert.ok(nonce);
    const consent = await handleAuthorizeConsent(
      new Request("https://example.com/authorize", {
        method: "POST",
        body: new URLSearchParams({ consent_nonce: nonce }),
      }),
      env,
    );
    assert.equal(consent.status, 302);
    const callback = () =>
      new Request(
        `https://example.com/oauth/callback/github?code=fixture&state=${nonce}`,
      );
    const fetcher: typeof fetch = async (input) =>
      String(input).includes("access_token")
        ? Response.json({ access_token: "fixture-token" })
        : Response.json({ id: 7, login: "fixture" });
    const responses = await Promise.all([
      handleGithubOAuthCallback(callback(), env, {
        getHelpers: async () => helpers,
        fetch: fetcher,
      }),
      handleGithubOAuthCallback(callback(), env, {
        getHelpers: async () => helpers,
        fetch: fetcher,
      }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [302, 400],
    );
    assert.equal(completed, 1);
  });

  it("serves registry objects and generic control reads from the explicit native capability", async () => {
    const kv = make();
    const digest = "a".repeat(64),
      object = "b".repeat(64);
    const value = new Uint8Array([0, 255, 42]);
    await kv.put(
      registryManifestKey(digest),
      JSON.stringify({
        version: 1,
        artifacts: [
          {
            path: "/metagraph/fixture.bin",
            sha256: object,
            size_bytes: value.length,
          },
        ],
      }),
    );
    await kv.put(registryObjectKey(object), value);
    const pointer = { registry_manifest_sha256: digest };
    const result = await readRegistryKv(kv, pointer, "/metagraph/fixture.bin");
    assert.equal(result.ok, true);
    if (result.ok)
      assert.deepEqual(
        new Uint8Array(await result.object.arrayBuffer()),
        value,
      );
    await kv.put("metagraph:latest", JSON.stringify(pointer));
    await kv.put("health:fixture", '{"ok":true}');
    const env = { CONTROL_KV_STORE: kv };
    assert.deepEqual(await latestPointer(env), pointer);
    assert.deepEqual(await readHealthKv(env, "health:fixture"), { ok: true });
    const served = await readR2Object(env, "/metagraph/fixture.bin", "hot");
    assert.equal(served.ok, true);
    if (served.ok)
      assert.deepEqual(
        new Uint8Array(await new Response(served.object.body).arrayBuffer()),
        value,
      );
  });
});
