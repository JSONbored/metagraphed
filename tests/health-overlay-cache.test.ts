// #11023. /api/v1/health cost 294-660 ms CPU per request in production, and the
// cost was its INPUT, not its output: loadGlobalOperationalHealth reads KV
// `health:current` -- a 253 KB value -- with `{ type: "json" }` and parses all
// of it to project a summary.
//
// The property under test is that the expensive read happens ONCE PER SNAPSHOT,
// not once per request. Asserting response equality would pass on the old
// behaviour too, so every case here counts reads of `health:current`.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { KV_HEALTH_CURRENT, KV_HEALTH_META } from "../src/kv-keys.ts";
import { buildEndpointResourceArtifact } from "../scripts/lib/endpoint-artifacts.ts";
import { ProviderSchema } from "../schemas-src/routes/providers-rpc.ts";
import type { Row } from "./row-type.ts";

const globalWithCaches = globalThis as unknown as { caches?: unknown };
const originalCaches = globalWithCaches.caches;
afterEach(() => {
  globalWithCaches.caches = originalCaches;
});

function installCaches() {
  const store = new Map<string, Response>();
  globalWithCaches.caches = {
    default: {
      async match(request: Request) {
        const hit = store.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request: Request, response: Response) {
        store.set(request.url, response.clone());
      },
    },
  } as unknown as Row;
  return store;
}

/** An env whose KV counts reads of the expensive snapshot. */
function envWithHealth(lastRunAt: () => string) {
  const reads = { current: 0, meta: 0 };
  const env = {
    METAGRAPH_CONTROL: {
      get: async (key: string) => {
        if (key === KV_HEALTH_META) {
          reads.meta += 1;
          return { last_run_at: lastRunAt(), status_counts: {} };
        }
        if (key === KV_HEALTH_CURRENT) {
          reads.current += 1;
          return {
            generated_at: lastRunAt(),
            global: { status: "up" },
            subnets: {},
          };
        }
        return null;
      },
      put: async () => {},
    },
  } as unknown as Parameters<typeof handleRequest>[1];
  return { env, reads };
}

const get = (path: string) =>
  new Request(`https://api.metagraph.sh${path}`, {
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });

describe("health is cached on the snapshot's own stamp (#11023)", () => {
  test("a second request within one snapshot does NOT re-read the 253 KB value", async () => {
    installCaches();
    const { env, reads } = envWithHealth(() => "2026-08-13T07:00:00.000Z");
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };

    const first = await handleRequest(get("/api/v1/health"), env, ctx);
    assert.equal(first.status, 200);
    await Promise.all(waits);
    const afterFirst = reads.current;
    assert.ok(afterFirst > 0, "the first request must actually read it");

    const second = await handleRequest(get("/api/v1/health"), env, ctx);
    assert.equal(second.status, 200);
    // THE assertion. The cheap meta read still happens (it is the cache key);
    // the expensive one does not.
    assert.equal(reads.current, afterFirst);
  });

  test("a new snapshot invalidates it -- staleness is bounded by the cron", async () => {
    const store = installCaches();
    const first = envWithHealth(() => "2026-08-13T07:00:00.000Z");
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };

    await handleRequest(get("/api/v1/health"), first.env, ctx);
    await Promise.all(waits);
    assert.ok(first.reads.current > 0);

    // A SECOND env, deliberately. readHealthMetaKv memoizes the stamp for
    // HEALTH_META_KV_TTL_MS keyed on `env` IDENTITY, so reusing the same object
    // would keep serving the old stamp and this test would be asserting the
    // memo rather than the cache key. A different env is also what reality
    // looks like: the next request lands in another isolate with its own memo.
    const next = envWithHealth(() => "2026-08-13T07:02:00.000Z");
    await handleRequest(get("/api/v1/health"), next.env, ctx);
    // The prober writes KV_HEALTH_CURRENT and KV_HEALTH_META in one
    // Promise.all, so a moved stamp means a moved snapshot -- which is what
    // makes this a safe cache key rather than a guess.
    assert.ok(
      next.reads.current > 0,
      "a new snapshot must not be served from the previous stamp's entry",
    );
    // Two stamps, two entries -- the old one is not overwritten, it is simply
    // no longer addressed.
    assert.equal(store.size, 2);
  });

  test("the per-subnet route gets the same treatment", async () => {
    // Its OUTPUT is small, which is why the endpoints note excludes the small
    // per-subnet variant -- but its INPUT is the same 253 KB snapshot, so the
    // small-output argument does not apply to it.
    installCaches();
    const { env, reads } = envWithHealth(() => "2026-08-13T07:00:00.000Z");
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };

    await handleRequest(get("/api/v1/subnets/1/health"), env, ctx);
    await Promise.all(waits);
    const afterFirst = reads.current;

    await handleRequest(get("/api/v1/subnets/1/health"), env, ctx);
    assert.equal(reads.current, afterFirst);
  });
});

/** Finite local artifact/KV sources, with the real router and existing cache. */
function catalogFixture(path: "endpoints" | "providers", initial: Row[]) {
  const observedAt = new Date().toISOString();
  let rows = initial;
  let stamp = "fixture-generation-0";
  let serialized = "";
  const reads = { artifact: 0, meta: 0 };
  function replace(next: Row[], nextStamp: string) {
    rows = next;
    stamp = nextStamp;
    serialized = JSON.stringify({
      schema_version: 1,
      generated_at: "2026-09-01T00:00:00Z",
      [path]: rows,
    });
  }
  replace(rows, stamp);
  return {
    path,
    reads,
    replace,
    get rows() {
      return rows;
    },
    get sourceBytes() {
      return Buffer.byteLength(serialized);
    },
    // A fresh env observes changed health metadata rather than a previous
    // isolate's short-lived metadata memo. All I/O remains local fixtures.
    env: () =>
      ({
        METAGRAPH_ARCHIVE: {
          get: async () => {
            reads.artifact += 1;
            return { json: async () => JSON.parse(serialized) };
          },
        },
        METAGRAPH_CONTROL: {
          get: async (key: string) => {
            if (key === KV_HEALTH_CURRENT) {
              return {
                last_run_at: observedAt,
                surfaces: rows.map((row) => ({
                  surface_id: row.surface_id ?? row.id,
                  status: row.status ?? "ok",
                  last_checked: row.last_checked ?? observedAt,
                  last_ok: observedAt,
                  latency_ms: 1,
                })),
              };
            }
            if (key !== KV_HEALTH_META) return null;
            reads.meta += 1;
            return { last_run_at: stamp };
          },
        },
      }) as unknown as Env,
  };
}

async function walkCatalogFixture(
  fixture: ReturnType<typeof catalogFixture>,
  guarded: boolean,
  limit: number,
  beforePage: (page: number) => void = () => {},
) {
  const initialRows = fixture.rows.length;
  const ids: string[] = [];
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const started = performance.now();
  const artifactReads = fixture.reads.artifact;
  let sampledHeapHighWaterBytes = before.heapUsed;
  let sampledRssHighWaterBytes = before.rss;
  let requests = 0;
  let wireBytes = 0;
  let snapshot = "start";
  let cursor = 0;
  let firstTotal: number | undefined;
  function receipt(outcome: "complete" | "restart_required") {
    const used = process.cpuUsage(cpu);
    return {
      outcome,
      ids: outcome === "complete" ? ids : [],
      loadedBeforeRejection: outcome === "restart_required" ? ids.length : 0,
      requests,
      wireBytes,
      artifactReads: fixture.reads.artifact - artifactReads,
      wallMs: performance.now() - started,
      processCpuUserMs: used.user / 1000,
      processCpuSystemMs: used.system / 1000,
      heapBeforeBytes: before.heapUsed,
      rssBeforeBytes: before.rss,
      sampledHeapHighWaterBytes,
      sampledRssHighWaterBytes,
      sampledHeapIncreaseBytes: sampledHeapHighWaterBytes - before.heapUsed,
      sampledRssIncreaseBytes: sampledRssHighWaterBytes - before.rss,
      heapDeltaBytes: process.memoryUsage().heapUsed - before.heapUsed,
    };
  }
  // Bound the walk from the original fixture population, even if a case
  // accidentally keeps inserting rows. No implicit restart or retry loop.
  const maxPages = Math.ceil(initialRows / limit) + 1;
  for (let page = 0; page < maxPages; page += 1) {
    beforePage(page);
    const url = new URL(`https://api.metagraph.sh/api/v1/${fixture.path}`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("cursor", String(cursor));
    url.searchParams.set("fields", "id");
    if (guarded) url.searchParams.set("page_snapshot", snapshot);
    const waits: Promise<unknown>[] = [];
    const response = await handleRequest(new Request(url), fixture.env(), {
      waitUntil: (pending: Promise<unknown>) => waits.push(pending),
    });
    requests += 1;
    const text = await response.text();
    wireBytes += Buffer.byteLength(text);
    const body = JSON.parse(text) as Row;
    await Promise.all(waits);
    const memory = process.memoryUsage();
    sampledHeapHighWaterBytes = Math.max(
      sampledHeapHighWaterBytes,
      memory.heapUsed,
    );
    sampledRssHighWaterBytes = Math.max(sampledRssHighWaterBytes, memory.rss);
    if (response.status === 400) {
      assert.equal(guarded, true);
      assert.equal(body.error.code, "invalid_query");
      assert.equal(body.meta.parameter, "page_snapshot");
      return receipt("restart_required");
    }
    assert.equal(response.status, 200);
    const rows = body.data[fixture.path] as Row[];
    const pagination = body.meta.pagination as Row;
    assert.equal(pagination.cursor, cursor);
    assert.equal(pagination.returned, rows.length);
    assert.ok(Number.isSafeInteger(pagination.total));
    if (guarded) {
      assert.match(pagination.snapshot, /^v1\.[0-9a-f]{64}$/);
      if (snapshot !== "start") assert.equal(pagination.snapshot, snapshot);
      if (firstTotal !== undefined) assert.equal(pagination.total, firstTotal);
      snapshot = pagination.snapshot;
    } else assert.equal(pagination.snapshot, undefined);
    firstTotal ??= pagination.total;
    ids.push(...rows.map((row) => String(row.id)));
    cursor += rows.length;
    if (pagination.next_cursor === null) {
      assert.equal(cursor, pagination.total);
      return receipt("complete");
    }
    assert.ok(rows.length > 0);
    assert.equal(pagination.next_cursor, cursor);
  }
  assert.fail("Fixture walk exceeded its finite page budget");
}

test("native catalog fixture measurements compare guarded and legacy cold/warm complete walks", async () => {
  // Timing/heap values are observations, never pass thresholds. Native CI
  // coverage, GC and other work in the process affect them. Sampling between
  // pages is not peak allocation, and this Map does not model edge TTL/colos.
  for (const [path, count] of [
    ["endpoints", 1200],
    ["providers", 160],
  ] as const) {
    const surfaces = Array.from({ length: count }, (_, n) => ({
      id: `fixture-${n}`,
      name: `Fixture ${n}`,
      key: `fixture-${n}`,
      netuid: 0,
      subnet_slug: "root",
      subnet_name: "Root",
      provider: "fixture",
      kind: "subnet-api",
      public_safe: true,
      auth_required: false,
      probe: { enabled: true },
      url: `https://example.invalid/${n}`,
      source_urls: [`https://example.invalid/${"source/".repeat(75)}${n}`],
    }));
    const rows: Row[] =
      path === "endpoints"
        ? buildEndpointResourceArtifact({
            surfaces,
            healthSurfaces: [],
            generatedAt: "2026-09-01T00:00:00Z",
            contractVersion: "fixture",
            source: "test",
          }).endpoints
        : surfaces.map((row) =>
            ProviderSchema.parse({
              schema_version: 1,
              id: row.id,
              name: row.name,
              kind: "infrastructure-provider",
              authority: "community",
              website_url: row.url,
              public_notes: "Source note. ".repeat(50),
              netuids: [],
            }),
          );
    const expected = rows.map((row) => row.id);
    for (let sample = 0; sample < 3; sample += 1) {
      // Alternate order so all guarded observations are not always warmer.
      for (const guarded of sample % 2 ? [true, false] : [false, true]) {
        const cache = installCaches();
        const fixture = catalogFixture(path, rows);
        for (const phase of ["cold", "warm"]) {
          const result = await walkCatalogFixture(fixture, guarded, 200);
          assert.equal(result.outcome, "complete");
          assert.deepEqual(result.ids, expected);
          assert.equal(new Set(result.ids).size, count);
          assert.equal(result.requests, Math.ceil(count / 200));
          assert.equal(
            result.artifactReads,
            !guarded && phase === "warm" ? 0 : result.requests,
          );
          const { ids: _ids, ...measurement } = result;
          console.log(
            "CATALOG_WALK_FIXTURE",
            JSON.stringify({
              path,
              rows: count,
              sourceBytes: fixture.sourceBytes,
              limit: 200,
              guarded,
              phase,
              sample,
              cacheEntries: cache.size,
              ...measurement,
              node: process.version,
            }),
          );
        }
      }
    }
  }
});

test("finite catalog churn rejects mixed walks, restarts after one change and stops under persistent change", async () => {
  const rows = Array.from({ length: 12 }, (_, n) => ({
    id: `row-${n}`,
    surface_id: `row-${n}`,
    status: "ok",
  }));
  const changed = [
    ...rows.slice(1),
    { id: "new-row", surface_id: "new-row", status: "ok" },
  ];
  for (const guarded of [false, true]) {
    installCaches();
    const fixture = catalogFixture("endpoints", rows);
    const result = await walkCatalogFixture(fixture, guarded, 4, (page) => {
      if (page === 1) fixture.replace(changed, "fixture-generation-1");
    });
    if (guarded) {
      assert.equal(result.outcome, "restart_required");
      assert.deepEqual(result.ids, []);
      assert.equal(result.requests, 2);
      const restarted = await walkCatalogFixture(fixture, true, 4);
      assert.equal(restarted.outcome, "complete");
      assert.deepEqual(
        restarted.ids,
        changed.map((row) => row.id),
      );
      assert.equal(restarted.requests, 3);
      const { ids: _restartedIds, ...restartMeasurement } = restarted;
      console.log(
        "CATALOG_CHURN_FIXTURE",
        JSON.stringify({
          scenario: "restarted-after-one-change",
          guarded: true,
          ...restartMeasurement,
        }),
      );
    } else {
      // Equal length and a terminal cursor do not certify completeness.
      assert.equal(result.outcome, "complete");
      assert.equal(result.ids.length, changed.length);
      assert.notDeepEqual(
        result.ids,
        changed.map((row) => row.id),
      );
    }
    const { ids: _ids, ...measurement } = result;
    console.log(
      "CATALOG_CHURN_FIXTURE",
      JSON.stringify({ scenario: "one-change", guarded, ...measurement }),
    );
  }

  const cache = installCaches();
  const fixture = catalogFixture("endpoints", rows);
  let revision = 0;
  let requests = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await walkCatalogFixture(fixture, true, 4, (page) => {
      if (page === 1) {
        revision += 1;
        fixture.replace(
          rows.map((row) => ({
            ...row,
            last_checked: new Date(Date.now() + revision).toISOString(),
          })),
          `fixture-generation-${revision}`,
        );
      }
    });
    assert.equal(result.outcome, "restart_required");
    assert.deepEqual(result.ids, []);
    requests += result.requests;
    const { ids: _ids, ...measurement } = result;
    console.log(
      "CATALOG_CHURN_FIXTURE",
      JSON.stringify({
        scenario: "persistent-change-attempt",
        attempt,
        ...measurement,
      }),
    );
  }
  assert.equal(requests, 4);
  assert.equal(cache.size, 0, "checked pages and rejected continuations never seed the cache");
  console.log(
    "CATALOG_CHURN_FIXTURE",
    JSON.stringify({
      scenario: "persistent-change",
      attempts: 2,
      requests,
      complete: false,
    }),
  );
});

test("checked pages revalidate content with unchanged stamps; legacy warm pages remain isolated", async () => {
  const cache = installCaches();
  const fixture = catalogFixture("providers", [{ id: "a", name: "Before" }, { id: "b", name: "Other" }]);
  const read = async (query: string) => {
    const waits: Promise<unknown>[] = [];
    const response = await handleRequest(new Request("https://api.metagraph.sh/api/v1/providers?limit=1&" + query), fixture.env(), { waitUntil: (pending: Promise<unknown>) => waits.push(pending) });
    await Promise.all(waits);
    return { response, body: await response.json() as Row };
  };
  const legacy = await read("");
  const first = await read("page_snapshot=start");
  const snapshot = first.body.meta.pagination.snapshot;
  assert.equal(first.response.headers.get("cache-control"), "no-store");
  assert.equal(first.response.headers.get("x-metagraph-cache-profile"), "no-store");
  const entries = cache.size;
  fixture.replace([{ id: "a", name: "Changed under the same stamp" }, { id: "b", name: "Other" }], "fixture-generation-0");
  const stale = await read("page_snapshot=" + snapshot + "&cursor=1");
  assert.equal(stale.response.status, 400);
  assert.deepEqual(stale.body.meta.catalog_paging, { reason: "catalog_changed" });
  const fresh = await read("page_snapshot=start");
  assert.notEqual(fresh.body.meta.pagination.snapshot, snapshot);
  assert.equal(fresh.body.data.providers[0].name, "Changed under the same stamp");
  const reads = fixture.reads.artifact;
  const warm = await read("");
  assert.equal(fixture.reads.artifact, reads);
  assert.deepEqual(warm.body.data, legacy.body.data);
  assert.equal(cache.size, entries);
});
