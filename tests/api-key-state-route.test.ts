import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createSessionToken } from "../src/wallet-auth.ts";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import type { Row } from "./row-type.ts";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
const { default: worker } = await import("../workers/data-api.ts");

const TOKEN = "synthetic-state-token";
const KEY_ID = "key_state_fixture";
const RAW_KEY = "mg_state_capability_regression_fixture";
let db: PGlite;
let pending: Promise<unknown>[];
let provider: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  db = new PGlite();
  const existing = readFileSync(
    "migrations/neon/0005_remaining_d1_tables.sql",
    "utf8",
  );
  await db.exec(
    existing.slice(
      existing.indexOf("CREATE TABLE IF NOT EXISTS rpc_accounts"),
      existing.indexOf("-- The partial unique index is the constraint"),
    ),
  );
  await db.exec(
    readFileSync("migrations/neon/0038_api_key_revocation_intent.sql", "utf8"),
  );
  pg.control.postgres = async (text, values) =>
    (await db.query(text, values)).rows;
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.exec("TRUNCATE api_keys, rpc_accounts RESTART IDENTITY");
  await db.query(
    "INSERT INTO rpc_accounts (id,ss58,tier,created_at) VALUES (7,'5SyntheticOwner','free',0),(8,'5OtherOwner','paid',0)",
  );
  pg.control.queries.length = 0;
  pg.control.failNext = null;
  pending = [];
  provider = vi.fn(async () =>
    Response.json({
      data: {
        valid: true,
        code: "VALID",
        keyId: KEY_ID,
        identity: { externalId: "7" },
        meta: { tier: "paid" },
      },
    }),
  );
  vi.stubGlobal("fetch", provider);
});
afterEach(async () => {
  await Promise.allSettled(pending);
  vi.unstubAllGlobals();
});

const env = (overrides: Row = {}) =>
  dataApiEnv({
    ...pgMockEnv(),
    API_KEY_LOOKUP_INTERNAL_TOKEN: TOKEN,
    UNKEY_ROOT_KEY: "synthetic-provider-root",
    UNKEY_API_ID: "api_synthetic",
    WALLET_SESSION_SECRET: "synthetic-session-secret",
    ...overrides,
  });
const ctx = () =>
  ({
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
  }) as ExecutionContext;

async function call(
  path = "/api/v1/internal/keys/state",
  body: unknown = { keyId: KEY_ID, accountId: "7" },
  overrides: Row = {},
  token: string | null = TOKEN,
) {
  return worker.fetch(
    new Request(`https://api.metagraph.sh${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { "x-api-key-lookup-token": token }),
      },
      body: JSON.stringify(body),
    }),
    env(overrides),
    ctx(),
  );
}

async function key({
  owner = 7,
  requested = null,
  revoked = null,
}: {
  owner?: number | null;
  requested?: number | null;
  revoked?: number | null;
} = {}) {
  await db.query(
    "INSERT INTO api_keys (unkey_key_id,account_id,owner_contact,tier,created_at,revocation_requested_at,revoked_at) VALUES ($1,$2,'synthetic','free',0,$3,$4)",
    [KEY_ID, owner, requested, revoked],
  );
}

test("state capability requires the internal token before reading any ledger data", async () => {
  for (const [overrides, token, expected] of [
    [{ API_KEY_LOOKUP_INTERNAL_TOKEN: undefined }, TOKEN, 503],
    [{}, null, 401],
    [{}, "wrong", 401],
  ] as const) {
    assert.equal(
      (await call(undefined, undefined, overrides, token)).status,
      expected,
    );
  }
  assert.equal(pg.control.queries.length, 0);
  assert.equal(provider.mock.calls.length, 0);
});

test.each([
  null,
  [],
  {},
  { keyId: null },
  { keyId: 7 },
  { keyId: "mg_not_an_identifier" },
  { keyId: "key_" },
])("malformed key-state input is rejected (%#)", async (body) => {
  assert.equal((await call(undefined, body)).status, 400);
  assert.equal(pg.control.queries.length, 0);
});

test("malformed JSON and oversized bodies retain the internal route body limits", async () => {
  for (const [body, expected] of [
    ["{broken", 400],
    ["x".repeat(4097), 413],
  ] as const) {
    const response = await worker.fetch(
      new Request("https://api.metagraph.sh/api/v1/internal/keys/state", {
        method: "POST",
        headers: {
          "x-api-key-lookup-token": TOKEN,
          "content-type": "application/json",
        },
        body,
      }),
      env(),
      ctx(),
    );
    assert.equal(response.status, expected);
  }
});

test("an unknown provider key is explicitly unmanaged, never ledger-authorized", async () => {
  const response = await call();
  assert.deepEqual(await response.json(), { state: "unmanaged" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(provider.mock.calls.length, 0);
});

test.each([7, "7"])(
  "managed state binds the verified identity to its owner (%s)",
  async (accountId) => {
    await key();
    const response = await call(undefined, { keyId: KEY_ID, accountId });
    assert.deepEqual(await response.json(), { state: "active" });
    assert.ok(
      pg.control.queries.some(
        (query) =>
          query.values[0] === KEY_ID &&
          /LEFT JOIN rpc_accounts/.test(query.text),
      ),
    );
  },
);

test.each([8, null, {}, "", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "known keys deny mismatched or malformed owners (%#)",
  async (accountId) => {
    await key();
    assert.deepEqual(
      await (await call(undefined, { keyId: KEY_ID, accountId })).json(),
      { state: "denied" },
    );
  },
);

test("a missing ledger owner stays denied instead of becoming unmanaged", async () => {
  await key();
  await db.query("DELETE FROM rpc_accounts WHERE id=7");
  assert.deepEqual(await (await call()).json(), { state: "denied" });
});

test("legacy rows without an account binding stay denied", async () => {
  await key({ owner: null });
  assert.deepEqual(await (await call()).json(), { state: "denied" });
});

test("each state request rereads pending and completed revocation", async () => {
  await key();
  assert.deepEqual(await (await call()).json(), { state: "active" });
  await db.query("UPDATE api_keys SET revocation_requested_at=123");
  assert.deepEqual(await (await call()).json(), { state: "pending" });
  await db.query("UPDATE api_keys SET revoked_at=456");
  assert.deepEqual(
    await (await call(undefined, { keyId: KEY_ID, accountId: 8 })).json(),
    { state: "revoked" },
  );
  assert.equal(
    pg.control.queries.filter((query) => /FROM api_keys k/.test(query.text))
      .length,
    3,
  );
});

test("state read failure and missing storage never become unmanaged", async () => {
  assert.equal(
    (await call(undefined, undefined, { HYPERDRIVE: undefined })).status,
    503,
  );
  pg.control.failNext = new Error("ledger unavailable");
  assert.equal((await call()).status, 502);
});

test("verified managed keys return additive internal identity fields and preserve provider tier", async () => {
  await key();
  const response = await call("/api/v1/internal/keys/verify", { key: RAW_KEY });
  assert.deepEqual(await response.json(), {
    valid: true,
    code: "VALID",
    tier: "paid",
    accountId: "7",
    keyId: KEY_ID,
    managed: true,
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  await Promise.allSettled(pending);
  assert.ok(
    (
      await db.query<{ last_used_at: number | null }>(
        "SELECT last_used_at FROM api_keys",
      )
    ).rows[0]!.last_used_at,
  );
});

test("verified external keys stay unmanaged without inserting ledger trust", async () => {
  const response = await call("/api/v1/internal/keys/verify", { key: RAW_KEY });
  assert.deepEqual(await response.json(), {
    valid: true,
    code: "VALID",
    tier: "paid",
    accountId: "7",
    keyId: KEY_ID,
    managed: false,
  });
  assert.equal((await db.query("SELECT * FROM api_keys")).rows.length, 0);
});

test.each([undefined, null, "bad_key_id"])(
  "a provider success without a valid identity ID fails closed (%#)",
  async (keyId) => {
    provider.mockResolvedValue(Response.json({ data: { valid: true, keyId } }));
    assert.deepEqual(
      await (
        await call("/api/v1/internal/keys/verify", { key: RAW_KEY })
      ).json(),
      { valid: false, code: "NOT_FOUND" },
    );
  },
);

test.each([{ requested: 1 }, { revoked: 1 }, { owner: 8 }])(
  "provider success cannot override a ledger denial (%#)",
  async (state) => {
    await key(state);
    assert.deepEqual(
      await (
        await call("/api/v1/internal/keys/verify", { key: RAW_KEY })
      ).json(),
      { valid: false, code: "owner" in state ? "NOT_FOUND" : "DISABLED" },
    );
  },
);

test("a lookup that completes after intent commits is denied by the post-verify guard", async () => {
  await key();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  provider.mockImplementation(async () => {
    started();
    await barrier;
    return Response.json({
      data: { valid: true, keyId: KEY_ID, identity: { externalId: "7" } },
    });
  });
  const lookup = call("/api/v1/internal/keys/verify", { key: RAW_KEY });
  await entered;
  await db.query("UPDATE api_keys SET revocation_requested_at=123");
  release();
  assert.deepEqual(await (await lookup).json(), {
    valid: false,
    code: "DISABLED",
  });
});

test("provider success with an unavailable ledger fails closed", async () => {
  pg.control.failNext = new Error("ledger unavailable");
  assert.equal(
    (await call("/api/v1/internal/keys/verify", { key: RAW_KEY })).status,
    502,
  );
});

test("best-effort usage bookkeeping failure does not invalidate checked identity", async () => {
  await key();
  pg.control.onQuery = (query) => {
    if (/UPDATE api_keys SET last_used_at/.test(query.text))
      pg.control.failNext = new Error("usage write unavailable");
  };
  try {
    assert.equal(
      (await call("/api/v1/internal/keys/verify", { key: RAW_KEY })).status,
      200,
    );
    await Promise.allSettled(pending);
  } finally {
    pg.control.onQuery = null;
  }
});

test("list exposes active, pending and completed state; migration reruns preserve intent", async () => {
  const session = await createSessionToken("synthetic-session-secret", {
    accountId: 7,
    ss58: "5SyntheticOwner",
  });
  await key();
  for (const [requested, revoked, expected] of [
    [null, null, "active"],
    [123, null, "pending"],
    [123, 456, "revoked"],
  ] as const) {
    await db.query(
      "UPDATE api_keys SET revocation_requested_at=$1, revoked_at=$2",
      [requested, revoked],
    );
    await db.exec(
      readFileSync(
        "migrations/neon/0038_api_key_revocation_intent.sql",
        "utf8",
      ),
    );
    const response = await worker.fetch(
      new Request("https://api.metagraph.sh/api/v1/keys", {
        headers: { Authorization: `Bearer ${session}` },
      }),
      env(),
      ctx(),
    );
    const body = (await response.json()) as {
      keys: {
        revocation_requested_at: number | null;
        revocation_state: string;
      }[];
    };
    assert.equal(body.keys[0]!.revocation_requested_at, requested);
    assert.equal(body.keys[0]!.revocation_state, expected);
  }
});

test("a previously unmanaged verification cannot outlive a newly recorded local denial", async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  provider.mockImplementation(async () => {
    started();
    await barrier;
    return Response.json({
      data: { valid: true, keyId: KEY_ID, identity: { externalId: "7" } },
    });
  });
  const lookup = call("/api/v1/internal/keys/verify", { key: RAW_KEY });
  await entered;
  await key({ requested: 123 });
  release();
  assert.deepEqual(await (await lookup).json(), {
    valid: false,
    code: "DISABLED",
  });
  assert.equal((await db.query("SELECT * FROM api_keys")).rows.length, 1);
});
