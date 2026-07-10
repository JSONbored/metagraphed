// Unit tests for the registry-sync Worker (workers/registry-sync-api.mjs). postgres.js
// is mocked so the auth/validation/upsert routing is tested with no real DB — the live
// Hyperdrive path is validated separately.
import { beforeEach, expect, test, vi } from "vitest";

const sqlCalls = vi.hoisted(() => []);
const surfaceResult = vi.hoisted(() => ({ current: [{ inserted: true }] }));
const deleteResult = vi.hoisted(() => ({ surfaces: [], subnets: [] }));
const failure = vi.hoisted(() => ({ error: null }));

vi.mock("postgres", () => ({
  default: () => {
    const sql = (strings, ...values) => {
      const text = Array.from(strings).join("?");
      sqlCalls.push({ text, values });
      if (failure.error && /INSERT INTO providers/.test(text)) {
        return Promise.reject(failure.error);
      }
      if (/INSERT INTO surfaces/.test(text)) {
        return Promise.resolve(surfaceResult.current);
      }
      if (/DELETE FROM surfaces/.test(text)) {
        return Promise.resolve(deleteResult.surfaces);
      }
      if (/DELETE FROM subnets/.test(text)) {
        return Promise.resolve(deleteResult.subnets);
      }
      return Promise.resolve([]);
    };
    sql.json = (value) => value;
    sql.end = () => Promise.resolve();
    // sql.begin(cb) reserves a connection for cb in real postgres.js; the
    // mock just invokes cb with this same sql function so every existing
    // tagged-template assertion (sqlCalls) still sees the identical call
    // stream, and resolves to (or rejects with) whatever cb does.
    sql.begin = (cb) => cb(sql);
    return sql;
  },
}));

const { default: worker } = await import("../workers/registry-sync-api.mjs");

const SECRET = "test-registry-sync-secret";

function post(body, { secret, method = "POST", raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret) headers["x-registry-sync-token"] = secret;
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = raw !== undefined ? raw : JSON.stringify(body ?? {});
  }
  return new Request("https://registry-sync.internal/", init);
}

function baseEnv(overrides = {}) {
  return {
    REGISTRY_SYNC_SECRET: SECRET,
    HYPERDRIVE: { connectionString: "postgres://mock" },
    ...overrides,
  };
}

const provider = () => ({
  id: "acme",
  overlay: { id: "acme", name: "Acme" },
  source_commit: "abc123",
});

const subnet = () => ({
  netuid: 8,
  slug: "taoshi",
  name: "Taoshi",
  source: "community",
  overlay: { netuid: 8, slug: "taoshi", name: "Taoshi" },
  source_commit: "abc123",
});

const surface = () => ({
  subnet_netuid: 8,
  provider_id: "acme",
  surface_key: "sn-8-example",
  kind: "docs",
  url: "https://example.com/docs",
  overlay: { kind: "docs", url: "https://example.com/docs" },
  source_commit: "abc123",
});

beforeEach(() => {
  sqlCalls.length = 0;
  surfaceResult.current = [{ inserted: true }];
  deleteResult.surfaces = [];
  deleteResult.subnets = [];
  failure.error = null;
});

test("rejects non-POST (405)", async () => {
  const res = await worker.fetch(post(null, { method: "GET" }), baseEnv(), {});
  expect(res.status).toBe(405);
});

test("is disabled (503) when REGISTRY_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    post({ providers: [provider()] }, { secret: SECRET }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    {},
  );
  expect(res.status).toBe(503);
});

test("rejects a missing or wrong token (401)", async () => {
  const env = baseEnv();
  const wrong = await worker.fetch(
    post({ providers: [provider()] }, { secret: "wrong" }),
    env,
    {},
  );
  expect(wrong.status).toBe(401);
  const missing = await worker.fetch(
    post({ providers: [provider()] }),
    env,
    {},
  );
  expect(missing.status).toBe(401);
});

test("returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    post({ providers: [provider()] }, { secret: SECRET }),
    { REGISTRY_SYNC_SECRET: SECRET },
    {},
  );
  expect(res.status).toBe(503);
});

test("rejects a body over the byte cap (413)", async () => {
  const res = await worker.fetch(
    post(null, { secret: SECRET, raw: "x".repeat(5_000_000) }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(413);
});

test("rejects malformed JSON (400)", async () => {
  const res = await worker.fetch(
    post(null, { secret: SECRET, raw: "{not json" }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(400);
});

test("rejects more than the rows-per-kind cap (413)", async () => {
  const many = Array.from({ length: 5001 }, (_, i) => ({
    ...subnet(),
    netuid: i,
  }));
  const res = await worker.fetch(
    post({ subnets: many }, { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(413);
});

test("rejects a non-object row (400)", async () => {
  const res = await worker.fetch(
    post({ providers: ["not-an-object"] }, { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(400);
});

test("rejects an empty payload with no rows of any kind (400)", async () => {
  const res = await worker.fetch(post({}, { secret: SECRET }), baseEnv(), {});
  expect(res.status).toBe(400);
});

test("upserts providers + subnets + surfaces and reports written counts", async () => {
  const res = await worker.fetch(
    post(
      { providers: [provider()], subnets: [subnet()], surfaces: [surface()] },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({
    ok: true,
    providers_written: 1,
    subnets_written: 1,
    surfaces_written: 1,
  });
  const text = sqlCalls.map((c) => c.text).join("\n");
  expect(text).toMatch(/INSERT INTO providers/);
  expect(text).toMatch(/INSERT INTO subnets/);
  expect(text).toMatch(/INSERT INTO surfaces/);
  expect(text).toMatch(/INSERT INTO surface_history/);
});

test("skips rows missing required fields without failing the request", async () => {
  const res = await worker.fetch(
    post(
      {
        providers: [{ id: "acme" }], // missing overlay/source_commit
        subnets: [{ netuid: 8 }], // missing slug/name/overlay/source_commit
        surfaces: [{ subnet_netuid: 8 }], // missing surface_key/kind/url/overlay/source_commit
      },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({
    providers_written: 0,
    subnets_written: 0,
    surfaces_written: 0,
  });
});

test("defaults subnet source and surface provider_id when omitted", async () => {
  const { source: _source, ...subnetWithoutSource } = subnet();
  const { provider_id: _providerId, ...surfaceWithoutProvider } = surface();
  const res = await worker.fetch(
    post(
      { subnets: [subnetWithoutSource], surfaces: [surfaceWithoutProvider] },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(200);
  const subnetCall = sqlCalls.find((c) => /INSERT INTO subnets/.test(c.text));
  expect(subnetCall.values).toContain("community");
  const surfaceCall = sqlCalls.find((c) => /INSERT INTO surfaces/.test(c.text));
  expect(surfaceCall.values).toContain(null);
});

test("does not log surface_history when the surface upsert is a no-op", async () => {
  // WHERE surfaces.overlay IS DISTINCT FROM EXCLUDED.overlay yields zero
  // RETURNING rows when the overlay is unchanged -- no history entry, no
  // surfaces_written increment.
  surfaceResult.current = [];
  const res = await worker.fetch(
    post({ surfaces: [surface()] }, { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.surfaces_written).toBe(0);
  const text = sqlCalls.map((c) => c.text).join("\n");
  expect(text).not.toMatch(/INSERT INTO surface_history/);
});

test("records an update action in surface_history when the row already existed", async () => {
  surfaceResult.current = [{ inserted: false }];
  await worker.fetch(
    post({ surfaces: [surface()] }, { secret: SECRET }),
    baseEnv(),
    {},
  );
  // The action is bound as a value, not embedded in the SQL text -- assert it
  // was passed to the surface_history insert as "update", not "insert".
  const historyCall = sqlCalls.find((c) =>
    /INSERT INTO surface_history/.test(c.text),
  );
  expect(historyCall.values).toContain("update");
});

test("prunes surfaces absent from the current subnet payload and records delete history", async () => {
  deleteResult.surfaces = [
    {
      id: "00000000-0000-0000-0000-000000000001",
      subnet_netuid: 8,
      overlay: { kind: "docs", url: "https://stale.example/docs" },
    },
  ];

  const res = await worker.fetch(
    post(
      {
        prune_surfaces: [
          {
            subnet_netuid: 8,
            current_surfaces: [
              { kind: "docs", url: "https://example.com/docs" },
            ],
            source_commit: "def456",
          },
        ],
      },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ surfaces_deleted: 1 });
  const text = sqlCalls.map((c) => c.text).join("\n");
  expect(text).toMatch(/DELETE FROM surfaces/);
  const historyCall = sqlCalls.find((c) =>
    /INSERT INTO surface_history/.test(c.text),
  );
  expect(historyCall.values).toContain("delete");
});

test("REGRESSION: prune_surfaces with authority_scope 'community' passes a true scope flag, bounding the DELETE to community-authority rows", async () => {
  deleteResult.surfaces = [];

  const res = await worker.fetch(
    post(
      {
        prune_surfaces: [
          {
            subnet_netuid: 8,
            current_surfaces: [
              { kind: "docs", url: "https://example.com/docs" },
            ],
            source_commit: "def456",
            authority_scope: "community",
          },
        ],
      },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );

  expect(res.status).toBe(200);
  const deleteCall = sqlCalls.find((c) => /DELETE FROM surfaces/.test(c.text));
  expect(deleteCall.text).toMatch(/authority = /);
  // The scope flag is bound as a real parameter (true), not spliced into the query text.
  expect(deleteCall.values).toContain(true);
  expect(deleteCall.values).toContain("community");
});

test("does not scope by authority when authority_scope is absent (the scheduled full-resync path)", async () => {
  deleteResult.surfaces = [];

  const res = await worker.fetch(
    post(
      {
        prune_surfaces: [
          {
            subnet_netuid: 8,
            current_surfaces: [
              { kind: "docs", url: "https://example.com/docs" },
            ],
            source_commit: "def456",
          },
        ],
      },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );

  expect(res.status).toBe(200);
  const deleteCall = sqlCalls.find((c) => /DELETE FROM surfaces/.test(c.text));
  // The scope flag is still present in the query shape (always-composed OR clause),
  // but bound to false so it never actually filters by authority.
  expect(deleteCall.values).toContain(false);
});

test("skips a prune_surfaces entry missing subnet_netuid/current_surfaces/source_commit instead of failing the request", async () => {
  const res = await worker.fetch(
    post(
      {
        prune_surfaces: [
          { subnet_netuid: 8 }, // missing current_surfaces and source_commit
        ],
      },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ surfaces_deleted: 0 });
  const text = sqlCalls.map((c) => c.text).join("\n");
  expect(text).not.toMatch(/DELETE FROM surfaces/);
});

test("deletes every surface for a subnet when current_surfaces has no valid kind/url entries", async () => {
  deleteResult.surfaces = [
    {
      id: "00000000-0000-0000-0000-000000000003",
      subnet_netuid: 8,
      overlay: { kind: "docs", url: "https://stale.example/docs" },
    },
  ];

  const res = await worker.fetch(
    post(
      {
        prune_surfaces: [
          { subnet_netuid: 8, current_surfaces: [], source_commit: "def456" },
        ],
      },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ surfaces_deleted: 1 });
  const deleteCall = sqlCalls.find((c) => /DELETE FROM surfaces/.test(c.text));
  expect(deleteCall.text).not.toMatch(/ANY/);
});

test("skips a delete_subnets entry missing netuid/source_commit instead of failing the request", async () => {
  const res = await worker.fetch(
    post(
      { delete_subnets: [{ netuid: null, source_commit: "def456" }] },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    surfaces_deleted: 0,
    subnets_deleted: 0,
  });
  const text = sqlCalls.map((c) => c.text).join("\n");
  expect(text).not.toMatch(/DELETE FROM subnets/);
});

test("deletes a removed subnet after recording delete history for its surfaces", async () => {
  deleteResult.surfaces = [
    {
      id: "00000000-0000-0000-0000-000000000002",
      subnet_netuid: 9,
      overlay: { kind: "subnet-api", url: "https://stale.example/api" },
    },
  ];
  deleteResult.subnets = [{ netuid: 9 }];

  const res = await worker.fetch(
    post(
      { delete_subnets: [{ netuid: 9, source_commit: "def456" }] },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    surfaces_deleted: 1,
    subnets_deleted: 1,
  });
  const text = sqlCalls.map((c) => c.text).join("\n");
  expect(text).toMatch(/DELETE FROM surfaces/);
  expect(text).toMatch(/DELETE FROM subnets/);
});

test("does not delete a subnet that is also upserted in the same request", async () => {
  const res = await worker.fetch(
    post(
      {
        subnets: [subnet()],
        surfaces: [surface()],
        delete_subnets: [{ netuid: 8, source_commit: "def456" }],
      },
      { secret: SECRET },
    ),
    baseEnv(),
    {},
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    subnets_written: 1,
    surfaces_written: 1,
    surfaces_deleted: 0,
    subnets_deleted: 0,
  });
  const text = sqlCalls.map((c) => c.text).join("\n");
  expect(text).toMatch(/INSERT INTO subnets/);
  expect(text).toMatch(/INSERT INTO surfaces/);
  expect(text).not.toMatch(/DELETE FROM subnets/);
});

test("maps a DB failure to a clean 502 instead of throwing", async () => {
  failure.error = new Error("connection reset");
  const res = await worker.fetch(
    post({ providers: [provider()] }, { secret: SECRET }),
    baseEnv(),
    {},
  );
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});
