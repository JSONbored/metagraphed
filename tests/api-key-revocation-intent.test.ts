import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  test,
  vi,
  type Mock,
} from "vitest";
import { validateApiKey } from "../src/api-key-validation.ts";
import { createSessionToken } from "../src/wallet-auth.ts";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import { mockEnv } from "./row-type.ts";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
const { default: worker } = await import("../workers/data-api.ts");
const KEY_ID = "key_intent_fixture";
const RAW_KEY = "mg_intent_synthetic_credential";
const TOKEN = "synthetic-internal-token";
const SESSION = "synthetic-session-secret";
let db: PGlite;
let pending: Promise<unknown>[];
let disable: Mock<() => Promise<Response>>;
let enabled: boolean;
let stateFailure: "intent" | "completion" | "missing-completion" | null;
let verifies: number;
const now = 1_800_000_000_000;

beforeAll(async () => {
  db = new PGlite();
  const schema = readFileSync(
    "migrations/neon/0005_remaining_d1_tables.sql",
    "utf8",
  );
  await db.exec(
    schema.slice(
      schema.indexOf("CREATE TABLE IF NOT EXISTS rpc_accounts"),
      schema.indexOf("-- The partial unique index is the constraint"),
    ),
  );
  await db.exec(
    readFileSync("migrations/neon/0038_api_key_revocation_intent.sql", "utf8"),
  );
  pg.control.postgres = async (text, values) => {
    if (
      stateFailure === "intent" &&
      text.includes("SET revocation_requested_at")
    )
      throw new Error("intent unavailable");
    if (text.includes("SET revoked_at")) {
      if (stateFailure === "completion")
        throw new Error("completion unavailable");
      if (stateFailure === "missing-completion") return [];
    }
    return (await db.query(text, values)).rows;
  };
});
afterAll(async () => db.close());
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  stateFailure = null;
  enabled = true;
  verifies = 0;
  pending = [];
  await db.exec("TRUNCATE api_keys, rpc_accounts RESTART IDENTITY");
  await db.exec(
    "INSERT INTO rpc_accounts (id,ss58,tier,created_at) VALUES (7,'5SyntheticOwner','free',0),(8,'5OtherOwner','free',0)",
  );
  await db.query(
    "INSERT INTO api_keys (unkey_key_id,account_id,owner_contact,tier,created_at) VALUES ($1,7,'synthetic','free',0)",
    [KEY_ID],
  );
  disable = vi.fn(async () => {
    enabled = false;
    return Response.json({ data: {} });
  });
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.hostname, "api.unkey.com");
      if (url.pathname.endsWith("keys.verifyKey")) {
        verifies++;
        return Response.json({
          data: enabled
            ? {
                valid: true,
                keyId: KEY_ID,
                identity: { externalId: "7" },
                meta: { tier: "free" },
              }
            : { valid: false, code: "DISABLED" },
        });
      }
      assert.ok(url.pathname.endsWith("keys.updateKey"));
      assert.deepEqual(JSON.parse(String(init?.body)), {
        keyId: KEY_ID,
        enabled: false,
      });
      return disable();
    },
  );
});
afterEach(async () => {
  await Promise.allSettled(pending);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ctx = () =>
  ({
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
  }) as ExecutionContext;
const env = () =>
  dataApiEnv({
    ...pgMockEnv(),
    API_KEY_LOOKUP_INTERNAL_TOKEN: TOKEN,
    WALLET_SESSION_SECRET: SESSION,
    UNKEY_ROOT_KEY: "synthetic-root",
    UNKEY_API_ID: "api_synthetic",
  });
async function revoke(owner = 7, overrides = {}) {
  const session = await createSessionToken(SESSION, {
    accountId: owner,
    ss58: owner === 7 ? "5SyntheticOwner" : "5OtherOwner",
  });
  return worker.fetch(
    new Request(`https://api.metagraph.sh/api/v1/keys/${KEY_ID}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session}` },
    }),
    { ...env(), ...overrides },
    ctx(),
  );
}
async function row() {
  return (
    await db.query<{
      revocation_requested_at: number | null;
      revoked_at: number | null;
    }>(
      "SELECT revocation_requested_at,revoked_at FROM api_keys WHERE unkey_key_id=$1",
      [KEY_ID],
    )
  ).rows[0]!;
}
function edge() {
  const store = new Map<string, string>();
  return mockEnv({
    API_KEY_LOOKUP_INTERNAL_TOKEN: TOKEN,
    METAGRAPH_CONTROL: {
      get: async (key: string) =>
        store.has(key) ? JSON.parse(store.get(key)!) : null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    },
    DATA_API: {
      fetch: (request: Request) => worker.fetch(request, env(), ctx()),
    },
  });
}
async function assertPending(response: Response) {
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: {
      code: "KEY_REVOCATION_PENDING",
      message:
        "Key access is disabled. Revocation confirmation is pending; retry.",
    },
    key_id: KEY_ID,
    revoked: false,
    revocation_state: "pending",
    access_disabled: true,
  });
  assert.deepEqual(await row(), {
    revocation_requested_at: now,
    revoked_at: null,
  });
}

test("intent persistence fails before the provider is called", async () => {
  stateFailure = "intent";
  const response = await revoke();
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "write failed" });
  assert.equal(disable.mock.calls.length, 0);
  assert.deepEqual(await row(), {
    revocation_requested_at: null,
    revoked_at: null,
  });
});

test("unbound storage fails without provider mutation or a pending claim", async () => {
  const response = await revoke(7, { HYPERDRIVE: undefined });
  assert.equal(response.status, 503);
  assert.equal(disable.mock.calls.length, 0);
  assert.deepEqual(await row(), {
    revocation_requested_at: null,
    revoked_at: null,
  });
});

test.each(["provider", "completion", "missing-completion"] as const)(
  "%s failure retains intent and cached requests deny; retry confirms completion",
  async (failure) => {
    const reader = edge();
    assert.deepEqual(await validateApiKey(reader, RAW_KEY), {
      ok: true,
      tier: "free",
      accountId: "7",
    });
    await Promise.allSettled(pending);
    if (failure === "provider")
      disable.mockResolvedValueOnce(
        new Response("unavailable", { status: 503 }),
      );
    else stateFailure = failure;
    await assertPending(await revoke());
    assert.equal(enabled, failure === "provider");
    assert.deepEqual(await validateApiKey(reader, RAW_KEY), {
      ok: false,
      code: "key_revoked",
    });
    assert.equal(
      verifies,
      1,
      "pending denies the existing identity without external verification",
    );
    assert.deepEqual(await validateApiKey(edge(), RAW_KEY), {
      ok: false,
      code: "key_revoked",
    });
    stateFailure = null;
    vi.setSystemTime(now + 60_000);
    const completed = await revoke();
    assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), { key_id: KEY_ID, revoked: true });
    assert.deepEqual(await row(), {
      revocation_requested_at: now,
      revoked_at: now + 60_000,
    });
    assert.equal(enabled, false);
    const calls = disable.mock.calls.length;
    vi.setSystemTime(now + 120_000);
    assert.equal((await revoke()).status, 200);
    assert.equal(
      disable.mock.calls.length,
      calls,
      "completed retry avoids another provider mutation",
    );
    assert.deepEqual(await row(), {
      revocation_requested_at: now,
      revoked_at: now + 60_000,
    });
  },
);

test.each([false, true])(
  "cross-account revoke never mutates another owner's key (pending=%s)",
  async (requested) => {
    if (requested)
      await db.query("UPDATE api_keys SET revocation_requested_at=$1", [
        now - 1,
      ]);
    const before = await row();
    assert.equal((await revoke(8)).status, 404);
    assert.equal(disable.mock.calls.length, 0);
    assert.deepEqual(await row(), before);
  },
);

test("an unknown key preserves the same response as an ownership mismatch", async () => {
  await db.exec("DELETE FROM api_keys");
  const response = await revoke();
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "no such key" });
  assert.equal(disable.mock.calls.length, 0);
});

test("an already completed legacy record is idempotent without adding intent", async () => {
  await db.query("UPDATE api_keys SET revoked_at=$1", [now - 1]);
  assert.equal((await revoke()).status, 200);
  assert.equal(disable.mock.calls.length, 0);
  assert.deepEqual(await row(), {
    revocation_requested_at: null,
    revoked_at: now - 1,
  });
});

test("pending access is denied while provider confirmation is still in flight", async () => {
  const reader = edge();
  await validateApiKey(reader, RAW_KEY);
  await Promise.allSettled(pending);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  disable.mockImplementation(async () => {
    entered();
    await barrier;
    enabled = false;
    return Response.json({ data: {} });
  });
  const request = revoke();
  await started;
  assert.deepEqual(await row(), {
    revocation_requested_at: now,
    revoked_at: null,
  });
  assert.deepEqual(await validateApiKey(reader, RAW_KEY), {
    ok: false,
    code: "key_revoked",
  });
  release();
  assert.equal((await request).status, 200);
});

test("overlapping retries preserve the first intent and first confirmed completion", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  disable.mockImplementationOnce(async () => {
    entered();
    await barrier;
    enabled = false;
    return Response.json({ data: {} });
  });
  const first = revoke();
  await started;
  vi.setSystemTime(now + 10_000);
  assert.equal((await revoke()).status, 200);
  vi.setSystemTime(now + 20_000);
  release();
  assert.equal((await first).status, 200);
  assert.equal(disable.mock.calls.length, 2);
  assert.deepEqual(await row(), {
    revocation_requested_at: now,
    revoked_at: now + 10_000,
  });
});
