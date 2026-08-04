// Unit tests for the registry-sync Worker (workers/registry-sync-api.ts).
//
// The registry moved off the self-hosted Postgres onto D1, so the DB double here
// is a D1 fake rather than a postgres.js mock. It records every statement --
// both the phase-1 reads and the statements handed to batch() -- into one
// ordered list, because the thing worth asserting is the STATEMENT STREAM the
// Worker produces, and that is exactly what changed shape in the move.
import { beforeEach, expect, test, vi } from "vitest";
import { jsonBody } from "./row-type.ts";
import type { Row } from "./row-type.ts";

const sqlCalls = vi.hoisted(() => [] as Row[]);
// What the phase-1 SELECTs return. `doomed` feeds the prune / delete-subnets
// reads; `existingSurface` feeds the per-surface existence probe that replaced
// Postgres' RETURNING (xmax = 0).
const selectResults = vi.hoisted(() => ({
  doomed: [] as Row[],
  existingSurface: null as Row | null,
}));
const failure = vi.hoisted(() => ({ error: null as Error | null }));

class FakeStatement {
  text: string;
  values: unknown[] = [];
  constructor(text: string) {
    this.text = text;
  }
  bind(...values: unknown[]) {
    this.values = values;
    sqlCalls.push({ text: this.text, values });
    return this;
  }
  async all() {
    // The per-surface existence probe is the narrower of the two SELECTs, so it
    // has to be matched first.
    if (
      /FROM surfaces\s+WHERE subnet_netuid = \? AND kind = \? AND url = \?/.test(
        this.text,
      )
    ) {
      return {
        results: selectResults.existingSurface
          ? [selectResults.existingSurface]
          : [],
      };
    }
    if (/SELECT id, subnet_netuid, overlay FROM surfaces/.test(this.text)) {
      return { results: selectResults.doomed };
    }
    return { results: [] };
  }
}

class FakeD1 {
  prepare(text: string) {
    return new FakeStatement(text);
  }
  async batch(statements: unknown[]) {
    // One batch, all-or-nothing -- a thrown error here is the D1 analogue of a
    // rolled-back transaction, which is what the 502 path must surface.
    if (failure.error) throw failure.error;
    return statements;
  }
}

const { default: worker, applyRegistrySyncToD1 } =
  await import("../workers/registry-sync-api.ts");

const SECRET = "test-registry-sync-secret";

function post(
  body: unknown,
  {
    secret,
    method = "POST",
    raw,
  }: { secret?: string; method?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret) headers["x-registry-sync-token"] = secret;
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = raw !== undefined ? raw : JSON.stringify(body ?? {});
  }
  return new Request("https://registry-sync.internal/", init);
}

function baseEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    REGISTRY_SYNC_SECRET: SECRET,
    REGISTRY_DB: new FakeD1(),
    ...overrides,
  } as unknown as Env;
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

const sqlText = () => sqlCalls.map((c) => c.text).join("\n");
const findCall = (pattern: RegExp) =>
  sqlCalls.find((c) => pattern.test(c.text as string))!;

beforeEach(() => {
  sqlCalls.length = 0;
  selectResults.doomed = [];
  selectResults.existingSurface = null;
  failure.error = null;
});

test("rejects non-POST (405)", async () => {
  const res = await worker.fetch(post(null, { method: "GET" }), baseEnv());
  expect(res.status).toBe(405);
});

test("is disabled (503) when REGISTRY_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    post({ providers: [provider()] }, { secret: SECRET }),
    { REGISTRY_DB: new FakeD1() } as unknown as Env,
  );
  expect(res.status).toBe(503);
});

test("rejects a missing or wrong token (401)", async () => {
  const env = baseEnv();
  const wrong = await worker.fetch(
    post({ providers: [provider()] }, { secret: "wrong" }),
    env,
  );
  expect(wrong.status).toBe(401);
  const missing = await worker.fetch(post({ providers: [provider()] }), env);
  expect(missing.status).toBe(401);
});

// #5548: gated by REGISTRY_SYNC_RATE_LIMITER (a no-op when the binding is
// absent). Mirrors the webhook-subscription/alert-trigger-create suites:
// within-limit success, over-limit 429 with the standard header family, and
// unbound-binding no-op (already covered implicitly by every test above,
// which uses baseEnv() with no limiter bound).
const allowLimiter = () => ({ limit: vi.fn(async () => ({ success: true })) });
const rejectLimiter = () => ({
  limit: vi.fn(async () => ({ success: false })),
});

test("rate limiting: 429 with the rate-limit header family when the limiter rejects", async () => {
  const limiter = rejectLimiter();
  const res = await worker.fetch(
    post({ providers: [provider()] }, { secret: SECRET }),
    baseEnv({ REGISTRY_SYNC_RATE_LIMITER: limiter }),
  );
  expect(res.status).toBe(429);
  expect((await jsonBody(res)).error).toMatch(
    /too many registry sync requests/,
  );
  expect(res.headers.get("retry-after")).toBe("60");
  expect(res.headers.get("x-ratelimit-limit")).toBe("30");
  expect(res.headers.get("x-ratelimit-policy")).toBe("30;w=60");
  expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
  expect(limiter.limit.mock.calls.length).toBe(1);
  expect(sqlCalls.length).toBe(0);
});

test("rate limiting: proceeds normally when the limiter allows the request", async () => {
  const limiter = allowLimiter();
  const res = await worker.fetch(
    post({ providers: [provider()] }, { secret: SECRET }),
    baseEnv({ REGISTRY_SYNC_RATE_LIMITER: limiter }),
  );
  expect(res.status).toBe(200);
  expect(limiter.limit.mock.calls.length).toBe(1);
});

test("rate limiting: rejects an invalid token before consulting the limiter", async () => {
  const limiter = rejectLimiter();
  const res = await worker.fetch(
    post({ providers: [provider()] }, { secret: "wrong" }),
    baseEnv({ REGISTRY_SYNC_RATE_LIMITER: limiter }),
  );
  expect(res.status).toBe(401);
  expect(limiter.limit.mock.calls.length).toBe(0);
});

test("returns 503 when the REGISTRY_DB binding is unavailable", async () => {
  const res = await worker.fetch(
    post({ providers: [provider()] }, { secret: SECRET }),
    { REGISTRY_SYNC_SECRET: SECRET } as unknown as Env,
  );
  expect(res.status).toBe(503);
});

test("rejects a body over the byte cap (413)", async () => {
  const res = await worker.fetch(
    post(null, { secret: SECRET, raw: "x".repeat(5_000_000) }),
    baseEnv(),
  );
  expect(res.status).toBe(413);
});

test("rejects malformed JSON (400)", async () => {
  const res = await worker.fetch(
    post(null, { secret: SECRET, raw: "{not json" }),
    baseEnv(),
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
  );
  expect(res.status).toBe(413);
});

test("rejects a non-object row (400)", async () => {
  const res = await worker.fetch(
    post({ providers: ["not-an-object"] }, { secret: SECRET }),
    baseEnv(),
  );
  expect(res.status).toBe(400);
});

test("rejects an empty payload with no rows of any kind (400)", async () => {
  const res = await worker.fetch(post({}, { secret: SECRET }), baseEnv());
  expect(res.status).toBe(400);
});

test("upserts providers + subnets + surfaces and reports written counts", async () => {
  const res = await worker.fetch(
    post(
      { providers: [provider()], subnets: [subnet()], surfaces: [surface()] },
      { secret: SECRET },
    ),
    baseEnv(),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({
    ok: true,
    providers_written: 1,
    subnets_written: 1,
    surfaces_written: 1,
  });
  const text = sqlText();
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
  );
  expect(res.status).toBe(200);
  const subnetCall = findCall(/INSERT INTO subnets/);
  expect(subnetCall.values).toContain("community");
  const surfaceCall = findCall(/INSERT INTO surfaces/);
  expect(surfaceCall.values).toContain(null);
});

test("does not log surface_history when the surface upsert is a no-op", async () => {
  // Postgres expressed this as WHERE ... IS DISTINCT FROM EXCLUDED.overlay and
  // let the statement no-op. The D1 path decides it BEFORE building any
  // statement: an existing row whose overlay is byte-identical is skipped
  // outright, so neither the upsert nor the history row is ever queued.
  selectResults.existingSurface = {
    id: "00000000-0000-0000-0000-0000000000ff",
    overlay: JSON.stringify(surface().overlay),
  };
  const res = await worker.fetch(
    post({ surfaces: [surface()] }, { secret: SECRET }),
    baseEnv(),
  );
  expect(res.status).toBe(200);
  const body = await jsonBody(res);
  expect(body.surfaces_written).toBe(0);
  const text = sqlText();
  expect(text).not.toMatch(/INSERT INTO surface_history/);
});

test("records an update action in surface_history when the row already existed", async () => {
  // Replaces Postgres' RETURNING (xmax = 0), which read MVCC internals SQLite
  // does not have: existence is asked directly, and a changed overlay means
  // "update".
  selectResults.existingSurface = {
    id: "00000000-0000-0000-0000-0000000000ff",
    overlay: JSON.stringify({ kind: "docs", url: "https://old.example/docs" }),
  };
  await worker.fetch(
    post({ surfaces: [surface()] }, { secret: SECRET }),
    baseEnv(),
  );
  // The action is bound as a value, not embedded in the SQL text -- assert it
  // was passed to the surface_history insert as "update", not "insert".
  const historyCall = findCall(/INSERT INTO surface_history/);
  expect(historyCall.values).toContain("update");
});

test("prunes surfaces absent from the current subnet payload and records delete history", async () => {
  selectResults.doomed = [
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
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ surfaces_deleted: 1 });
  const text = sqlText();
  expect(text).toMatch(/DELETE FROM surfaces WHERE id IN/);
  // The action is a literal here rather than a bind: unlike the upsert path,
  // where it varies between insert/update, a prune only ever records a delete.
  const historyCall = findCall(/INSERT INTO surface_history/);
  expect(historyCall.text).toMatch(/'delete'/);
  // and it describes the row that was actually read in phase 1
  expect(historyCall.values).toContain("00000000-0000-0000-0000-000000000001");
  expect(historyCall.values).toContain("def456");
});

test("REGRESSION: prune_surfaces with authority_scope 'community' passes a true scope flag, bounding the DELETE to community-authority rows", async () => {
  selectResults.doomed = [];

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
  );

  expect(res.status).toBe(200);
  // The scope moved into the phase-1 SELECT that decides WHICH rows die; the
  // DELETE itself is now by explicit id. Bound as 0/1, not a boolean -- SQLite
  // has no boolean type.
  const readCall = findCall(/SELECT id, subnet_netuid, overlay FROM surfaces/);
  expect(readCall.text).toMatch(/authority = 'community'/);
  expect(readCall.values).toContain(1);
});

test("does not scope by authority when authority_scope is absent (the scheduled full-resync path)", async () => {
  selectResults.doomed = [];

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
  );

  expect(res.status).toBe(200);
  // The flag is still present in the query shape (always-composed OR clause),
  // but bound to 0 so it never actually filters by authority.
  const readCall = findCall(/SELECT id, subnet_netuid, overlay FROM surfaces/);
  expect(readCall.values).toContain(0);
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
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ surfaces_deleted: 0 });
  const text = sqlText();
  expect(text).not.toMatch(/DELETE FROM surfaces/);
});

test("deletes every surface for a subnet when current_surfaces has no valid kind/url entries", async () => {
  selectResults.doomed = [
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
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ surfaces_deleted: 1 });
  const deleteCall = findCall(/DELETE FROM surfaces/);
  expect(deleteCall.text).not.toMatch(/ANY/);
});

test("skips a delete_subnets entry missing netuid/source_commit instead of failing the request", async () => {
  const res = await worker.fetch(
    post(
      { delete_subnets: [{ netuid: null, source_commit: "def456" }] },
      { secret: SECRET },
    ),
    baseEnv(),
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    surfaces_deleted: 0,
    subnets_deleted: 0,
  });
  const text = sqlText();
  expect(text).not.toMatch(/DELETE FROM subnets/);
});

test("deletes a removed subnet after recording delete history for its surfaces", async () => {
  selectResults.doomed = [
    {
      id: "00000000-0000-0000-0000-000000000002",
      subnet_netuid: 9,
      overlay: { kind: "subnet-api", url: "https://stale.example/api" },
    },
  ];

  const res = await worker.fetch(
    post(
      { delete_subnets: [{ netuid: 9, source_commit: "def456" }] },
      { secret: SECRET },
    ),
    baseEnv(),
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    surfaces_deleted: 1,
    subnets_deleted: 1,
  });
  const text = sqlText();
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
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    subnets_written: 1,
    surfaces_written: 1,
    surfaces_deleted: 0,
    subnets_deleted: 0,
  });
  const text = sqlText();
  expect(text).toMatch(/INSERT INTO subnets/);
  expect(text).toMatch(/INSERT INTO surfaces/);
  expect(text).not.toMatch(/DELETE FROM subnets/);
});

test("maps a DB failure to a clean 502 instead of throwing", async () => {
  failure.error = new Error("connection reset");
  const res = await worker.fetch(
    post({ providers: [provider()] }, { secret: SECRET }),
    baseEnv(),
  );
  expect(res.status).toBe(502);
  expect((await jsonBody(res)).error).toBe("write failed");
});

test("captures a write failure as a PostHog $exception (previously only console.error, no Sentry/PostHog capture at all)", async () => {
  failure.error = new Error("connection reset");
  const calls: Row[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: Row) => {
    calls.push(JSON.parse(init.body));
    return { ok: true };
  }) as unknown as typeof fetch;
  try {
    const res = await worker.fetch(
      post({ providers: [provider()] }, { secret: SECRET }),
      baseEnv({ POSTHOG_PROJECT_TOKEN: "phc_test" }),
    );
    expect(res.status).toBe(502);
  } finally {
    globalThis.fetch = original;
  }
  expect(calls.length).toBe(1);
  expect(calls[0].event).toBe("$exception");
  expect(calls[0].properties.route).toBe("registry-sync");
  expect(calls[0].properties.error_code).toBe("internal_error");
  expect(calls[0].properties.$exception_list[0].value).toBe("connection reset");
});

// metagraphed#7768: PostHog distributed tracing -- one root span per
// request, awaited directly (this Worker's fetch has no ExecutionContext to
// waitUntil against). Off by default (see src/tracing.ts's own header);
// this is the one representative case proving the wiring fires end-to-end
// when sampled, on a clean success so it's not conflated with the
// $exception test above.
test("emits a PostHog trace span for the request when sampled", async () => {
  const calls: Row[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: Row) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true };
  }) as unknown as typeof fetch;
  try {
    const res = await worker.fetch(
      post({ providers: [provider()] }, { secret: SECRET }),
      baseEnv({
        POSTHOG_PROJECT_TOKEN: "phc_test",
        POSTHOG_TRACES_SAMPLE_RATE: "1",
      }),
    );
    expect(res.status).toBe(200);
  } finally {
    globalThis.fetch = original;
  }
  expect(calls.length).toBe(1);
  expect(calls[0].url.endsWith("/i/v1/traces")).toBe(true);
  const span = calls[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  expect(span.name).toBe("registry-sync");
  expect(span.status.code).toBe(1); // OK
});

// dispatchRegistrySyncRequest's own auth/validation/DB-write logic all
// returns a controlled error Response rather than throwing -- the only
// realistic way for the default export's try/catch (ok = false; throw
// error;) to actually run is something genuinely unexpected escaping past
// all of that, like the body stream itself erroring mid-read (`await
// request.text()` is not wrapped in its own try/catch).
test("a body stream that errors mid-read still records ok:false on the trace span, and propagates", async () => {
  const calls: Row[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: Row) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true };
  }) as unknown as typeof fetch;
  const brokenBody = new ReadableStream({
    start(controller) {
      controller.error(new Error("client disconnected mid-upload"));
    },
  });
  const request = new Request("https://registry-sync.internal/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-registry-sync-token": SECRET,
    },
    // @ts-expect-error -- duplex is required by undici for a streaming body
    // but isn't in the RequestInit type this codebase targets.
    duplex: "half",
    body: brokenBody,
  });
  try {
    await expect(
      worker.fetch(
        request,
        baseEnv({
          POSTHOG_PROJECT_TOKEN: "phc_test",
          POSTHOG_TRACES_SAMPLE_RATE: "1",
        }),
      ),
    ).rejects.toThrow();
  } finally {
    globalThis.fetch = original;
  }
  // #9440: an uncaught fault now posts TWO things -- the span this test was
  // written for, and an $exception carrying the stack. Selected by shape
  // rather than by index so neither assertion depends on POST ordering.
  const spans = calls.filter((c) => c.body.resourceSpans);
  expect(spans.length).toBe(1);
  const span = spans[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  expect(span.status.code).toBe(2); // ERROR

  const exceptions = calls.filter((c) => c.body.event === "$exception");
  expect(exceptions.length).toBe(1);
  expect(exceptions[0].body.properties.route).toBe("registry-sync");
});

// Hyperdrive's connection-retry tests (METAGRAPHED-7) are gone with Hyperdrive:
// a D1 binding is not a pooled TCP connection, so there is no dropped socket to
// retry. What replaces them are the risks D1 actually introduces.

test("the keep-list is ONE bound JSON parameter, so the statement text is constant regardless of its size", async () => {
  // The Postgres version built a VALUES join with two positional binds per kept
  // surface. Carried over literally, a subnet with thousands of surfaces would
  // run into SQLite's variable ceiling, and every distinct list length would be
  // a distinct statement D1 could not reuse a plan for. json_each over a single
  // bound JSON array fixes both, so the shape is pinned here.
  const keptCount = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      kind: "docs",
      url: `https://example.com/${i}`,
    }));

  for (const n of [1, 250]) {
    sqlCalls.length = 0;
    await worker.fetch(
      post(
        {
          prune_surfaces: [
            {
              subnet_netuid: 8,
              current_surfaces: keptCount(n),
              source_commit: "def456",
            },
          ],
        },
        { secret: SECRET },
      ),
      baseEnv(),
    );
    const read = findCall(/SELECT id, subnet_netuid, overlay FROM surfaces/);
    expect(read.text).toMatch(/json_each\(\?\)/);
    // netuid, scope flag, keep-list -- three binds whatever n is.
    expect((read.values as unknown[]).length).toBe(3);
    expect(JSON.parse((read.values as string[])[2])).toHaveLength(n);
  }
});

test("the prune DELETE targets the ids read in phase 1, not a re-evaluated predicate", async () => {
  // The history rows describe the rows read in phase 1. Re-running the
  // predicate inside the batch could delete a different set than the one being
  // recorded, so the delete is pinned to those exact ids.
  selectResults.doomed = [
    { id: "id-a", subnet_netuid: 8, overlay: { k: 1 } },
    { id: "id-b", subnet_netuid: 8, overlay: { k: 2 } },
  ];
  await worker.fetch(
    post(
      {
        prune_surfaces: [
          {
            subnet_netuid: 8,
            current_surfaces: [{ kind: "docs", url: "https://example.com/d" }],
            source_commit: "def456",
          },
        ],
      },
      { secret: SECRET },
    ),
    baseEnv(),
  );
  const del = findCall(/DELETE FROM surfaces WHERE id IN/);
  expect(JSON.parse((del.values as string[])[0])).toEqual(["id-a", "id-b"]);
});

test("every write lands in exactly one batch, so a partial sync is not representable", async () => {
  // D1 has no interactive transaction; batch() IS the transaction. More than one
  // batch per request would reintroduce the partial-sync state the Postgres
  // version used sql.begin() to eliminate.
  let batches = 0;
  const db = new FakeD1();
  const spy = {
    prepare: (t: string) => db.prepare(t),
    batch: async (stmts: unknown[]) => {
      batches += 1;
      return stmts;
    },
  };
  const summary = await applyRegistrySyncToD1(spy as never, {
    providers: [provider()],
    subnets: [subnet()],
    surfaces: [surface()],
    pruneSurfaces: [],
    deleteSubnets: [],
  });
  expect(batches).toBe(1);
  expect(summary).toMatchObject({
    providers_written: 1,
    subnets_written: 1,
    surfaces_written: 1,
  });
});

test("nothing is batched when the payload produces no writes", async () => {
  let batches = 0;
  const db = new FakeD1();
  const spy = {
    prepare: (t: string) => db.prepare(t),
    batch: async () => {
      batches += 1;
    },
  };
  const summary = await applyRegistrySyncToD1(spy as never, {
    providers: [{ id: "acme" }],
    subnets: [],
    surfaces: [],
    pruneSurfaces: [],
    deleteSubnets: [],
  });
  expect(batches).toBe(0);
  expect(summary.providers_written).toBe(0);
});

test("the #8981 type translations are applied to the bound values", async () => {
  await worker.fetch(
    post(
      {
        surfaces: [{ ...surface(), probe_eligible: true, public_safe: false }],
      },
      { secret: SECRET },
    ),
    baseEnv(),
  );
  const insert = findCall(/INSERT INTO surfaces/);
  const values = insert.values as unknown[];
  // jsonb -> TEXT: the overlay is bound as a JSON string, never an object.
  expect(typeof values[10]).toBe("string");
  expect(JSON.parse(values[10] as string)).toEqual(surface().overlay);
  // boolean -> 0/1, with a CHECK constraint behind it.
  expect(values[8]).toBe(1);
  expect(values[9]).toBe(0);
  // timestamptz -> epoch ms, computed in SQL rather than bound.
  expect(insert.text).toMatch(/unixepoch\(\) \* 1000/);
  expect(insert.text).not.toMatch(/now\(\)/);
  // uuid: no DB default, so the caller supplies one.
  expect(values[0]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});
