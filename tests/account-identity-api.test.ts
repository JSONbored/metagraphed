import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { buildAccountIdentity } from "../src/account-identity.ts";
import { buildAccountIdentityHistory } from "../src/account-identity-history.ts";
import type { Row } from "./row-type.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function identityRow(overrides: Row = {}) {
  return {
    account: SS58,
    name: "Example Team",
    url: "https://miao.example/",
    github: "https://github.com/miao-team/miao-repo",
    image: "https://miao.example/logo.png",
    discord: "examplehandle",
    description: "An example subnet operator.",
    additional: null,
    captured_at: 1_700_000_000_000,
    ...overrides,
  };
}

function historyRow(overrides: Row = {}) {
  return {
    id: 1,
    observed_at: 1_700_000_000_000,
    name: "Example Team",
    url: null,
    github: null,
    image: null,
    discord: null,
    description: null,
    additional: null,
    identity_hash: "hash-1",
    ...overrides,
  };
}

// D1 fully eliminated (2026-07-16, #4328): handleAccountIdentity /
// handleAccountIdentityHistory now read METAGRAPH_ACCOUNT_IDENTITY_SOURCE's
// Postgres tier only, via tryPostgresTier(env, request, ...) -> DATA_API. On a
// hit, DATA_API's JSON body is used directly as `data` (no reshaping), so the
// mock returns the already-built builder output, mirroring what
// workers/data-api.mjs actually serves for these two routes.
function postgresIdentityEnv({
  identity,
  identityHistory,
}: { identity?: Row | null; identityHistory?: Row[] } = {}) {
  return {
    METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
    DATA_API: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        if (/\/identity-history$/.test(url.pathname)) {
          return Response.json(
            buildAccountIdentityHistory(identityHistory || [], SS58, {
              limit: 100,
              offset: 0,
              nextCursor: null,
            }),
          );
        }
        return Response.json(buildAccountIdentity(identity ?? null, SS58));
      },
    },
  };
}

test("GET /accounts/{ss58}/identity returns the account's identity (#4328)", async () => {
  const env = postgresIdentityEnv({ identity: identityRow() });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/identity`),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.account, SS58);
  assert.equal(body.data.has_identity, true);
  assert.equal(body.data.name, "Example Team");
});

test("GET /accounts/{ss58}/identity rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/identity?bogus=1`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/identity is schema-stable when D1 is cold", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/identity`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.account, SS58);
  assert.equal(body.data.has_identity, false);
});

test("GET /accounts/{ss58}/identity-history returns the identity timeline (#4328)", async () => {
  const env = postgresIdentityEnv({ identityHistory: [historyRow()] });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/identity-history`),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.account, SS58);
  assert.equal(body.data.entry_count, 1);
  assert.equal(body.data.entries[0].name, "Example Team");
});

test("GET /accounts/{ss58}/identity-history rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/identity-history?bogus=1`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/identity-history is schema-stable when D1 is cold", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/identity-history`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.account, SS58);
  assert.equal(body.data.entry_count, 0);
  assert.deepEqual(body.data.entries, []);
});

test("GET /testnet/accounts/{ss58}/identity has no variant (mainnet-only D1 tier)", async () => {
  const res = await handleRequest(
    req(`/api/v1/testnet/accounts/${SS58}/identity`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 404);
});
