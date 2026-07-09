import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

function identityRow(overrides = {}) {
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

function historyRow(overrides = {}) {
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

function dbWith({ identity, identityHistory } = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (/FROM account_identity WHERE account = \?/.test(sql)) {
                  return { results: identity || [] };
                }
                if (/FROM account_identity_history/.test(sql)) {
                  return { results: identityHistory || [] };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

test("GET /accounts/{ss58}/identity returns the account's identity (#4328)", async () => {
  const env = dbWith({ identity: [identityRow()] });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/identity`),
    env,
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
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/identity is schema-stable when D1 is cold", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/identity`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.account, SS58);
  assert.equal(body.data.has_identity, false);
});

test("GET /accounts/{ss58}/identity-history returns the identity timeline (#4328)", async () => {
  const env = dbWith({ identityHistory: [historyRow()] });
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/identity-history`),
    env,
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
    {},
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /accounts/{ss58}/identity-history is schema-stable when D1 is cold", async () => {
  const res = await handleRequest(
    req(`/api/v1/accounts/${SS58}/identity-history`),
    {},
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
    {},
    {},
  );
  assert.equal(res.status, 404);
});
