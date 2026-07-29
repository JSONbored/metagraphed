// Unit tests for the web-push device-subscription routes (#8385):
// workers/data-api.ts's handleWatchPushSubscriptions* (owner-facing, T6
// watch-token authorized) and handleInternalPushSubscription (AlerterHub-only,
// internal-token gated).
//
// Own postgres mock, scoped to this file, mirroring
// tests/wallet-auth-keys-route.test.ts's shape (vi.mock is per-test-file).
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createTriggerToken } from "../src/wallet-auth.ts";
import type { Row } from "./row-type.ts";

const mockQueue = vi.hoisted(() => ({ current: [] as Row[][] }));
const sqlCalls = vi.hoisted(
  () => [] as Array<{ text: string; values: unknown[] }>,
);

vi.mock("postgres", () => ({
  default: () => {
    function sql(strings: TemplateStringsArray, ...values: unknown[]) {
      let text = strings[0];
      for (let i = 0; i < values.length; i += 1) text += "?" + strings[i + 1];
      sqlCalls.push({ text, values });
      return Promise.resolve(
        mockQueue.current.length ? mockQueue.current.shift() : [],
      );
    }
    sql.begin = (cb: (sql: unknown) => unknown) => cb(sql);
    sql.end = () => Promise.resolve();
    sql.json = (value: unknown) => value;
    sql.unsafe = () => Promise.resolve([]);
    return sql;
  },
}));

const { default: worker } = await import("../workers/data-api.ts");

const WATCH_SECRET = "test-watch-trigger-secret";
const INTERNAL_TOKEN = "test-internal-token";
const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
// Real shapes: p256dh is a 65-byte uncompressed P-256 point, auth 16 bytes.
const P256DH = Buffer.from([4, ...Array.from({ length: 64 }, (_, i) => i + 1)])
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const AUTH = Buffer.from(Array.from({ length: 16 }, (_, i) => i))
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

function baseEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    HYPERDRIVE: { connectionString: "postgres://mock" },
    WATCH_TRIGGER_TOKEN_SECRET: WATCH_SECRET,
    ALERT_TRIGGERS_INTERNAL_TOKEN: INTERNAL_TOKEN,
    ...overrides,
  } as unknown as Env;
}

async function watchHeaders(): Promise<Record<string, string>> {
  const token = await createTriggerToken(WATCH_SECRET, { ss58: SS58 });
  return { "x-watch-trigger-token": token, "content-type": "application/json" };
}

function call(path: string, init?: RequestInit, env: Env = baseEnv()) {
  return worker.fetch(
    new Request(`https://data-api.internal${path}`, init),
    env,
    {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  mockQueue.current = [];
  sqlCalls.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

// --- owner-facing: list ----------------------------------------------------

test("GET push-subscriptions: 401 without a valid watch token", async () => {
  const res = await call("/api/v1/watch/push-subscriptions");
  assert.equal(res.status, 401);
});

test("GET push-subscriptions: 503 when watch tokens aren't provisioned", async () => {
  const res = await call(
    "/api/v1/watch/push-subscriptions",
    { headers: await watchHeaders() },
    baseEnv({ WATCH_TRIGGER_TOKEN_SECRET: undefined }),
  );
  assert.equal(res.status, 503);
});

test("GET push-subscriptions: returns device metadata and the cap, never key material", async () => {
  mockQueue.current = [
    [
      {
        id: 7,
        endpoint: ENDPOINT,
        user_agent: "Chrome on Mac",
        created_at: 1785000000000,
        last_used_at: null,
      },
    ],
  ];
  const res = await call("/api/v1/watch/push-subscriptions", {
    headers: await watchHeaders(),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.max_devices, 3);
  assert.deepEqual(body.subscriptions, [
    {
      id: "7",
      endpoint: ENDPOINT,
      user_agent: "Chrome on Mac",
      created_at: 1785000000000,
      last_used_at: null,
    },
  ]);
  // The owner-facing view must never leak the crypto material.
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(P256DH));
  assert.ok(!serialized.includes(AUTH));
});

// --- owner-facing: create --------------------------------------------------

test("POST push-subscriptions: 400 on a non-JSON body", async () => {
  const res = await call("/api/v1/watch/push-subscriptions", {
    method: "POST",
    headers: await watchHeaders(),
    body: "not json",
  });
  assert.equal(res.status, 400);
});

test("POST push-subscriptions: 400 on a private or non-https endpoint (SSRF)", async () => {
  for (const endpoint of [
    "http://fcm.googleapis.com/x",
    "https://127.0.0.1/push",
    "https://localhost/push",
  ]) {
    const res = await call("/api/v1/watch/push-subscriptions", {
      method: "POST",
      headers: await watchHeaders(),
      body: JSON.stringify({ endpoint, p256dh: P256DH, auth: AUTH }),
    });
    assert.equal(res.status, 400, endpoint);
  }
});

test("POST push-subscriptions: 400 when key material is missing or malformed", async () => {
  const bodies = [
    { endpoint: ENDPOINT, p256dh: "", auth: AUTH },
    { endpoint: ENDPOINT, p256dh: P256DH, auth: "" },
    // Right shape of string, wrong byte lengths.
    { endpoint: ENDPOINT, p256dh: "AAAA", auth: AUTH },
    { endpoint: ENDPOINT, p256dh: P256DH, auth: "AAAA" },
  ];
  for (const body of bodies) {
    const res = await call("/api/v1/watch/push-subscriptions", {
      method: "POST",
      headers: await watchHeaders(),
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("POST push-subscriptions: 201 stores a new device and truncates the UA", async () => {
  mockQueue.current = [
    [], // existing lookup by endpoint -> none
    [{ n: 0 }], // count for this address
    [
      {
        id: 1,
        endpoint: ENDPOINT,
        user_agent: "x".repeat(120),
        created_at: 1,
        last_used_at: null,
      },
    ],
  ];
  const res = await call("/api/v1/watch/push-subscriptions", {
    method: "POST",
    headers: await watchHeaders(),
    body: JSON.stringify({
      endpoint: ENDPOINT,
      p256dh: P256DH,
      auth: AUTH,
      user_agent: "y".repeat(500),
    }),
  });
  assert.equal(res.status, 201);
  const insert = sqlCalls.find((c) =>
    /INSERT INTO watch_push_subscriptions/.test(c.text),
  );
  assert.ok(insert);
  // UA bounded at write time rather than trusted.
  const ua = insert!.values.find(
    (v) => typeof v === "string" && v.startsWith("y"),
  );
  assert.equal((ua as string).length, 120);
});

test("POST push-subscriptions: 409 at the device cap", async () => {
  mockQueue.current = [
    [], // no existing row for this endpoint
    [{ n: 3 }], // already at the cap
  ];
  const res = await call("/api/v1/watch/push-subscriptions", {
    method: "POST",
    headers: await watchHeaders(),
    body: JSON.stringify({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH }),
  });
  assert.equal(res.status, 409);
});

test("POST push-subscriptions: the SAME owner re-subscribing upserts without spending cap", async () => {
  // A browser reissues its own endpoint on key rotation, so charging it
  // against the cap again would surface as a bogus "device limit reached".
  mockQueue.current = [
    [{ id: 4, address: SS58 }], // existing row, owned by THIS caller
    [
      {
        id: 4,
        endpoint: ENDPOINT,
        user_agent: null,
        created_at: 1,
        last_used_at: null,
      },
    ],
  ];
  const res = await call("/api/v1/watch/push-subscriptions", {
    method: "POST",
    headers: await watchHeaders(),
    body: JSON.stringify({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH }),
  });
  assert.equal(res.status, 201);
  assert.ok(!sqlCalls.some((c) => /COUNT\(\*\)/.test(c.text)));
});

test("POST push-subscriptions: 409 when the endpoint belongs to ANOTHER address", async () => {
  // Endpoints are globally unique. Without an ownership check the upsert
  // reassigned the row: the original owner silently lost their device, the
  // taker skipped their own cap, and the taker's triggers would then push to
  // a browser that never subscribed to them.
  mockQueue.current = [
    [{ id: 4, address: "5SomeoneElsesAddress000000000000000000000000000" }],
  ];
  const res = await call("/api/v1/watch/push-subscriptions", {
    method: "POST",
    headers: await watchHeaders(),
    body: JSON.stringify({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH }),
  });
  assert.equal(res.status, 409);
  // Nothing was written, and the cap was not consulted on a rejected takeover.
  assert.ok(
    !sqlCalls.some((c) => /INSERT INTO watch_push_subscriptions/.test(c.text)),
  );
  assert.ok(!sqlCalls.some((c) => /COUNT\(\*\)/.test(c.text)));
});

test("POST push-subscriptions: the upsert can never reassign `address`", async () => {
  mockQueue.current = [
    [{ id: 4, address: SS58 }],
    [
      {
        id: 4,
        endpoint: ENDPOINT,
        user_agent: null,
        created_at: 1,
        last_used_at: null,
      },
    ],
  ];
  await call("/api/v1/watch/push-subscriptions", {
    method: "POST",
    headers: await watchHeaders(),
    body: JSON.stringify({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH }),
  });
  const insert = sqlCalls.find((c) =>
    /INSERT INTO watch_push_subscriptions/.test(c.text),
  )!;
  // Inspect ONLY the SET list (up to WHERE): the WHERE clause legitimately
  // mentions address, so a greedy match over the whole statement proves
  // nothing.
  const setClause = insert.text.slice(
    insert.text.indexOf("DO UPDATE SET"),
    insert.text.indexOf("WHERE watch_push_subscriptions"),
  );
  assert.ok(setClause.length > 0, "expected a guarded DO UPDATE SET ... WHERE");
  assert.ok(
    !/address\s*=/.test(setClause),
    `address is reassignable: ${setClause}`,
  );
  assert.match(
    insert.text,
    /WHERE watch_push_subscriptions\.address = EXCLUDED\.address/,
  );
});

test("POST push-subscriptions: 409 rather than an empty 201 if the guarded upsert matches nothing", async () => {
  // Race: ownership passed the explicit check, then the ON CONFLICT WHERE
  // rejected the update anyway. Must not emit a 201 with an empty body.
  mockQueue.current = [
    [{ id: 4, address: SS58 }],
    [], // guarded upsert updated nothing
  ];
  const res = await call("/api/v1/watch/push-subscriptions", {
    method: "POST",
    headers: await watchHeaders(),
    body: JSON.stringify({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH }),
  });
  assert.equal(res.status, 409);
});

// --- owner-facing: delete --------------------------------------------------

test("DELETE push-subscriptions/{id}: 400 on a malformed id", async () => {
  const res = await call("/api/v1/watch/push-subscriptions/not-an-id", {
    method: "DELETE",
    headers: await watchHeaders(),
  });
  assert.equal(res.status, 400);
});

test("DELETE push-subscriptions/{id}: 404 for another address' device (anti-oracle)", async () => {
  mockQueue.current = [[]]; // scoped delete matched nothing
  const res = await call("/api/v1/watch/push-subscriptions/9", {
    method: "DELETE",
    headers: await watchHeaders(),
  });
  assert.equal(res.status, 404);
  const del = sqlCalls.find((c) =>
    /DELETE FROM watch_push_subscriptions/.test(c.text),
  );
  // Always scoped by address, so a foreign id is indistinguishable from absent.
  assert.ok(del!.values.includes(SS58));
});

test("DELETE push-subscriptions/{id}: 200 removes the caller's own device", async () => {
  mockQueue.current = [[{ id: 9 }]];
  const res = await call("/api/v1/watch/push-subscriptions/9", {
    method: "DELETE",
    headers: await watchHeaders(),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: true, id: "9" });
});

test("push-subscriptions: 405 on an unsupported method/shape", async () => {
  const res = await call("/api/v1/watch/push-subscriptions", {
    method: "PATCH",
    headers: await watchHeaders(),
  });
  assert.equal(res.status, 405);
});

// --- internal (AlerterHub) -------------------------------------------------

test("internal push-subscription: 401 without the internal token", async () => {
  const res = await call(
    `/api/v1/internal/push-subscription?endpoint=${encodeURIComponent(ENDPOINT)}`,
  );
  assert.equal(res.status, 401);
});

test("internal push-subscription: 503 when the internal token isn't provisioned", async () => {
  const res = await call(
    `/api/v1/internal/push-subscription?endpoint=${encodeURIComponent(ENDPOINT)}`,
    { headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN } },
    baseEnv({ ALERT_TRIGGERS_INTERNAL_TOKEN: undefined }),
  );
  assert.equal(res.status, 503);
});

test("internal push-subscription GET: 400 without an endpoint", async () => {
  const res = await call("/api/v1/internal/push-subscription", {
    headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
  });
  assert.equal(res.status, 400);
});

test("internal push-subscription GET: returns key material and stamps last_used_at", async () => {
  mockQueue.current = [
    [{ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH }],
    [],
  ];
  const res = await call(
    `/api/v1/internal/push-subscription?endpoint=${encodeURIComponent(ENDPOINT)}`,
    { headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN } },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.deepEqual(body.subscription, {
    endpoint: ENDPOINT,
    p256dh: P256DH,
    auth: AUTH,
  });
  assert.ok(
    sqlCalls.some((c) =>
      /UPDATE watch_push_subscriptions SET last_used_at/.test(c.text),
    ),
  );
});

test("internal push-subscription GET: null for a pruned device, without stamping", async () => {
  mockQueue.current = [[]];
  const res = await call(
    `/api/v1/internal/push-subscription?endpoint=${encodeURIComponent(ENDPOINT)}`,
    { headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN } },
  );
  assert.deepEqual(await res.json(), { subscription: null });
  assert.ok(!sqlCalls.some((c) => /SET last_used_at/.test(c.text)));
});

test("internal push-subscription DELETE: prunes, and is idempotent", async () => {
  const headers = {
    "x-alert-triggers-internal-token": INTERNAL_TOKEN,
    "content-type": "application/json",
  };
  const res = await call("/api/v1/internal/push-subscription", {
    method: "DELETE",
    headers,
    body: JSON.stringify({ endpoint: ENDPOINT }),
  });
  assert.equal(res.status, 200);
  // Pruning an already-pruned device is a success: the caller is
  // fire-and-forget and must never see a spurious error.
  assert.deepEqual(await res.json(), { pruned: true });
});

test("internal push-subscription DELETE: 400 on a bad body or missing endpoint", async () => {
  const headers = {
    "x-alert-triggers-internal-token": INTERNAL_TOKEN,
    "content-type": "application/json",
  };
  const bad = await call("/api/v1/internal/push-subscription", {
    method: "DELETE",
    headers,
    body: "not json",
  });
  assert.equal(bad.status, 400);
  const empty = await call("/api/v1/internal/push-subscription", {
    method: "DELETE",
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);
});

test("internal push-subscription: 405 on an unsupported method", async () => {
  const res = await call("/api/v1/internal/push-subscription", {
    method: "POST",
    headers: { "x-alert-triggers-internal-token": INTERNAL_TOKEN },
  });
  assert.equal(res.status, 405);
});

// --- branch completeness -----------------------------------------------------
// Each of these pins one side of a defensive branch that the happy-path tests
// above never reach. They are cheap, but they are the difference between "the
// null-safety is written" and "the null-safety is exercised".

test("GET push-subscriptions: a row with null metadata degrades instead of emitting junk", async () => {
  // Postgres can hand back nulls for user_agent/created_at/last_used_at, and a
  // row missing `endpoint` entirely must not serialize as "undefined".
  mockQueue.current = [[{ id: 5 }]];
  const res = await call("/api/v1/watch/push-subscriptions", {
    headers: await watchHeaders(),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.deepEqual(body.subscriptions, [
    {
      id: "5",
      endpoint: "",
      user_agent: null,
      created_at: null,
      last_used_at: null,
    },
  ]);
});

test("GET push-subscriptions: numeric timestamps are coerced, not passed through", async () => {
  mockQueue.current = [
    [
      {
        id: 6,
        endpoint: ENDPOINT,
        user_agent: "UA",
        created_at: "1785000000000",
        last_used_at: "1785000009999",
      },
    ],
  ];
  const res = await call("/api/v1/watch/push-subscriptions", {
    headers: await watchHeaders(),
  });
  const body = (await res.json()) as Row;
  const sub = (body.subscriptions as Row[])[0]!;
  assert.equal(sub.created_at, 1785000000000);
  assert.equal(sub.last_used_at, 1785000009999);
});

test("POST push-subscriptions: 401 without a valid watch token", async () => {
  const res = await call("/api/v1/watch/push-subscriptions", {
    method: "POST",
    body: JSON.stringify({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH }),
  });
  assert.equal(res.status, 401);
});

test("DELETE push-subscriptions/{id}: 401 without a valid watch token", async () => {
  const res = await call("/api/v1/watch/push-subscriptions/9", {
    method: "DELETE",
  });
  assert.equal(res.status, 401);
});

test("POST push-subscriptions: 400 when body fields are the wrong TYPE, not just absent", async () => {
  // A JSON number/object where a string belongs must be rejected the same way
  // a missing field is, rather than being coerced into the query.
  const res = await call("/api/v1/watch/push-subscriptions", {
    method: "POST",
    headers: await watchHeaders(),
    body: JSON.stringify({ endpoint: 42, p256dh: { a: 1 }, auth: ["x"] }),
  });
  assert.equal(res.status, 400);
});

test("POST push-subscriptions: treats an empty COUNT result as zero devices", async () => {
  // Defensive: if the aggregate ever returns no row, the cap must read as 0
  // (allow the write) rather than NaN (which compares false and would also
  // allow it, but for the wrong reason).
  mockQueue.current = [
    [], // no existing row for this endpoint
    [], // COUNT returned nothing at all
    [
      {
        id: 2,
        endpoint: ENDPOINT,
        user_agent: null,
        created_at: 1,
        last_used_at: null,
      },
    ],
  ];
  const res = await call("/api/v1/watch/push-subscriptions", {
    method: "POST",
    headers: await watchHeaders(),
    body: JSON.stringify({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH }),
  });
  assert.equal(res.status, 201);
});
