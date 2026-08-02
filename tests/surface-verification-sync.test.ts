// Worker-side tests for the surface-verification cron (#9096): the daily
// scheduled branch that sweeps every registry subnet's 90-day uptime history
// out of D1 into the probe-evidence store, replacing the retired
// sync-surface-verification.yml commit-a-file workflow.
//
// This snapshot is the ONLY producer of `machine-verified`, so the refuse-to-
// run guards are the load-bearing tests here: a lane that publishes a
// plausible-but-empty snapshot strips the trust tier off the whole registry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";
import {
  netuidsFromSubnets,
  readProberLastRunAt,
  runSurfaceVerificationSync,
  SURFACE_HEALTH_R2_KEY,
  SURFACE_HEALTH_SUBNETS_ARTIFACT_PATH,
  SURFACE_HEALTH_WINDOW,
} from "../src/surface-verification-sync.ts";
import {
  buildSurfaceHealthArtifact,
  collectSurfaceProbeRecords,
  surfaceHealthContentDigest,
  type SurfaceHealthArtifact,
  type SurfaceProbeRecord,
} from "../src/surface-verification.ts";
import { KV_HEALTH_META } from "../src/kv-keys.ts";
import { mockEnv, type AnyFn, type Row } from "./row-type.ts";

const TICK_MS = Date.parse("2026-08-02T04:40:00.000Z");
const LAST_RUN_AT = "2026-08-02T04:30:12.000Z";

/** A surface that clears the promotion bar (7d, 100 samples, 0.99 uptime). */
function passingSurface(overrides: Row = {}): Row {
  return {
    surface_id: "sn-1-api",
    day_count: 30,
    samples: 2880,
    uptime_ratio: 0.9991,
    ...overrides,
  };
}

function fakeKv(value: unknown) {
  return {
    get: vi.fn(async (key: string) => {
      assert.equal(key, KV_HEALTH_META);
      return value;
    }),
  };
}

function fakeBucket(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const puts: Array<{ key: string; value: string }> = [];
  return {
    store,
    puts,
    bucket: {
      get: async (key: string) => {
        const raw = store.get(key);
        if (raw == null) return null;
        return { json: async () => JSON.parse(raw), text: async () => raw };
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
        puts.push({ key, value });
      },
    },
  };
}

function readArtifactStub(doc: Row | null): AnyFn {
  return vi.fn(async (_env: unknown, path: string) => {
    assert.equal(path, SURFACE_HEALTH_SUBNETS_ARTIFACT_PATH);
    return doc
      ? { ok: true, data: doc, source: "r2", storage_tier: "r2" }
      : { ok: false, status: 404, code: "artifact_not_found", message: "no" };
  });
}

/** A D1 double whose only job is to be `prepare`-shaped. */
const fakeDb = { prepare: () => ({ bind: () => ({ all: async () => [] }) }) };

function syncEnv(overrides: Record<string, unknown> = {}) {
  const { bucket, puts, store } = fakeBucket(
    (overrides.initialStore as Record<string, unknown>) ?? {},
  );
  delete overrides.initialStore;
  return {
    puts,
    store,
    env: mockEnv({
      METAGRAPH_HEALTH_DB: fakeDb,
      METAGRAPH_ARCHIVE: bucket,
      METAGRAPH_CONTROL: fakeKv({ last_run_at: LAST_RUN_AT }),
      ...overrides,
    }),
  };
}

function syncDeps(overrides: Record<string, unknown> = {}) {
  return {
    readArtifact: readArtifactStub({ subnets: [{ netuid: 1 }] }),
    loadUptime: vi.fn(async () => ({
      observed_at: LAST_RUN_AT,
      surfaces: [passingSurface()],
    })),
    now: () => TICK_MS,
    recordException: vi.fn(async () => true),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("netuidsFromSubnets", () => {
  test("dedupes, sorts, and drops non-integer / negative netuids", () => {
    assert.deepEqual(
      netuidsFromSubnets([
        { netuid: 7 },
        { netuid: 0 },
        { netuid: 7 },
        { netuid: -1 },
        { netuid: 1.5 },
        { netuid: "x" },
        null,
      ]),
      [0, 7],
    );
  });

  test("returns [] for a non-array input", () => {
    assert.deepEqual(netuidsFromSubnets(undefined), []);
    assert.deepEqual(netuidsFromSubnets({}), []);
  });
});

describe("collectSurfaceProbeRecords", () => {
  test("maps the uptime payload field-for-field, exactly as the retired script did", () => {
    const records = collectSurfaceProbeRecords(
      {
        observed_at: LAST_RUN_AT,
        surfaces: [
          passingSurface({ classification: "dead" }),
          {
            surface_id: "from-reliability",
            day_count: 9,
            reliability: { sample_count: 400, uptime_ratio: 0.995 },
          },
          { surface_id: "", day_count: 1 },
          { day_count: 1 },
        ],
      },
      {},
    );
    assert.deepEqual(records["sn-1-api"], {
      day_count: 30,
      samples: 2880,
      uptime_ratio: 0.9991,
      last_ok: LAST_RUN_AT,
      classification: "dead",
    });
    // The reliability fallbacks and the non-string classification default.
    assert.deepEqual(records["from-reliability"], {
      day_count: 9,
      samples: 400,
      uptime_ratio: 0.995,
      last_ok: LAST_RUN_AT,
      classification: null,
    });
    // Idless rows never enter the map.
    assert.deepEqual(Object.keys(records).sort(), [
      "from-reliability",
      "sn-1-api",
    ]);
  });

  test("a per-surface last_ok wins over the payload's observed_at, and both absent is null", () => {
    const records = collectSurfaceProbeRecords(
      {
        surfaces: [
          passingSurface({ id: "a", last_ok: "2026-07-31T00:00:00.000Z" }),
          passingSurface({ surface_id: "b" }),
        ],
      },
      {},
    );
    assert.equal(records["sn-1-api"].last_ok, "2026-07-31T00:00:00.000Z");
    assert.equal(records.b.last_ok, null);
  });

  test("a surface with no numbers at all zeroes rather than producing NaN", () => {
    // A row carrying neither the top-level counts nor a reliability block must
    // read as "no evidence" (0/0/0), which withholds verification. NaN would
    // slip past Number.isFinite checks nowhere and silently poison the digest.
    const records = collectSurfaceProbeRecords(
      { surfaces: [{ surface_id: "bare" }] },
      {},
    );
    assert.deepEqual(records.bare, {
      day_count: 0,
      samples: 0,
      uptime_ratio: 0,
      last_ok: null,
      classification: null,
    });
  });

  test("accumulates across payloads and tolerates a degenerate one", () => {
    const records: Record<string, SurfaceProbeRecord> = {};
    collectSurfaceProbeRecords({ surfaces: [passingSurface()] }, records);
    collectSurfaceProbeRecords(null, records);
    collectSurfaceProbeRecords({ surfaces: "nope" }, records);
    collectSurfaceProbeRecords(
      { surfaces: [passingSurface({ surface_id: "sn-2-api" })] },
      records,
    );
    assert.deepEqual(Object.keys(records).sort(), ["sn-1-api", "sn-2-api"]);
  });
});

describe("buildSurfaceHealthArtifact", () => {
  test("counts verified surfaces and buckets failure reasons by condition, not by number", () => {
    const artifact = buildSurfaceHealthArtifact({
      records: {
        good: {
          day_count: 30,
          samples: 2880,
          uptime_ratio: 0.9991,
          last_ok: LAST_RUN_AT,
        },
        "short-a": {
          day_count: 2,
          samples: 100,
          uptime_ratio: 1,
          last_ok: LAST_RUN_AT,
        },
        "short-b": {
          day_count: 4,
          samples: 100,
          uptime_ratio: 1,
          last_ok: LAST_RUN_AT,
        },
        flaky: {
          day_count: 30,
          samples: 2880,
          uptime_ratio: 0.5,
          last_ok: LAST_RUN_AT,
        },
      },
      subnetsReached: 3,
      subnetsTotal: 4,
      generatedAt: "2026-08-02T04:40:00.000Z",
    });
    assert.equal(artifact.surface_count, 4);
    assert.equal(artifact.verified_count, 1);
    assert.equal(artifact.subnets_reached, 3);
    assert.equal(artifact.subnets_total, 4);
    assert.deepEqual(artifact.unverified_reasons, {
      "observed on N of N required days": 2,
      "uptime N below N": 1,
    });
    // Surface ids are re-inserted in sorted order for a stable diff/digest.
    assert.deepEqual(Object.keys(artifact.surfaces), [
      "flaky",
      "good",
      "short-a",
      "short-b",
    ]);
  });
});

describe("surfaceHealthContentDigest", () => {
  test("ignores generated_at but not the evidence", () => {
    const base = {
      schema_version: 1,
      surfaces: { a: { day_count: 1 } },
    } as unknown as SurfaceHealthArtifact;
    assert.equal(
      surfaceHealthContentDigest({ ...base, generated_at: "x" }),
      surfaceHealthContentDigest({ ...base, generated_at: "y" }),
    );
    assert.notEqual(
      surfaceHealthContentDigest({ ...base, generated_at: "x" }),
      surfaceHealthContentDigest({
        ...base,
        generated_at: "x",
        surfaces: { a: { day_count: 2 } },
      } as unknown as SurfaceHealthArtifact),
    );
  });

  test("is insensitive to key order but sensitive to array order", () => {
    // The digest walks arrays positionally and objects key-sorted; both halves
    // matter, since unverified_reasons is an object and a future list field
    // would be an array.
    const ordered = {
      unverified_reasons: { a: 1, b: 2 },
      surfaces: { x: { day_count: 1, samples: 2 } },
    } as unknown as SurfaceHealthArtifact;
    const reordered = {
      surfaces: { x: { samples: 2, day_count: 1 } },
      unverified_reasons: { b: 2, a: 1 },
    } as unknown as SurfaceHealthArtifact;
    assert.equal(
      surfaceHealthContentDigest(ordered),
      surfaceHealthContentDigest(reordered),
    );
    assert.notEqual(
      surfaceHealthContentDigest({
        notes: ["a", "b"],
      } as unknown as SurfaceHealthArtifact),
      surfaceHealthContentDigest({
        notes: ["b", "a"],
      } as unknown as SurfaceHealthArtifact),
    );
  });
});

describe("readProberLastRunAt", () => {
  test("reads the prober's last_run_at from KV health:meta", async () => {
    assert.equal(
      await readProberLastRunAt(
        mockEnv({ METAGRAPH_CONTROL: fakeKv({ last_run_at: LAST_RUN_AT }) }),
      ),
      LAST_RUN_AT,
    );
  });

  test("a cold, malformed, unbound or throwing KV all read as null", async () => {
    assert.equal(await readProberLastRunAt(mockEnv({})), null);
    assert.equal(
      await readProberLastRunAt(mockEnv({ METAGRAPH_CONTROL: fakeKv(null) })),
      null,
    );
    assert.equal(
      await readProberLastRunAt(
        mockEnv({ METAGRAPH_CONTROL: fakeKv({ last_run_at: 42 }) }),
      ),
      null,
    );
    assert.equal(
      await readProberLastRunAt(
        mockEnv({
          METAGRAPH_CONTROL: {
            get: async () => {
              throw new Error("KV down");
            },
          },
        }),
      ),
      null,
    );
  });
});

describe("runSurfaceVerificationSync", () => {
  test("no D1 binding: refuses to run LOUDLY rather than publish a registry-wide demotion", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, puts } = syncEnv({ METAGRAPH_HEALTH_DB: undefined });
    const deps = syncDeps();
    const waited: Promise<unknown>[] = [];
    const result = await runSurfaceVerificationSync(
      env,
      { waitUntil: (p) => waited.push(p) },
      deps,
    );
    await Promise.all(waited);
    assert.deepEqual(result, {
      ok: false,
      skipped: true,
      reason: "d1_binding_missing",
    });
    assert.equal(errorSpy.mock.calls.length, 1);
    assert.equal(
      (deps.recordException as Row).mock.calls[0][1].errorCode,
      "surface_verification_d1_missing",
    );
    assert.equal(puts.length, 0);
    // Never even asked the registry what to sweep.
    assert.equal((deps.readArtifact as Row).mock.calls.length, 0);
  });

  test("no R2 binding: refuses to run LOUDLY", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = syncDeps();
    const result = await runSurfaceVerificationSync(
      mockEnv({ METAGRAPH_HEALTH_DB: fakeDb }),
      undefined,
      deps,
    );
    assert.deepEqual(result, {
      ok: false,
      skipped: true,
      reason: "r2_binding_missing",
    });
    assert.equal(
      (deps.recordException as Row).mock.calls[0][1].errorCode,
      "surface_verification_bucket_missing",
    );
  });

  test("no reader injected is a contained no-op, not a throw", async () => {
    const { env } = syncEnv();
    const result = await runSurfaceVerificationSync(env, undefined, {
      readArtifact: undefined,
    });
    assert.deepEqual(result, { ok: false, reason: "reader_unavailable" });
  });

  test("a cold prober meta refuses to run LOUDLY — every record would attest to nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, puts } = syncEnv({ METAGRAPH_CONTROL: fakeKv(null) });
    const deps = syncDeps();
    const result = await runSurfaceVerificationSync(env, undefined, deps);
    assert.deepEqual(result, {
      ok: false,
      skipped: true,
      reason: "prober_meta_cold",
    });
    assert.equal(
      (deps.recordException as Row).mock.calls[0][1].errorCode,
      "surface_verification_prober_meta_cold",
    );
    assert.equal(puts.length, 0);
  });

  test("an unavailable subnets artifact never wipes the store", async () => {
    const { env, puts } = syncEnv();
    const result = await runSurfaceVerificationSync(
      env,
      undefined,
      syncDeps({ readArtifact: readArtifactStub(null) }),
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "subnets_artifact_unavailable",
    });
    assert.equal(puts.length, 0);
  });

  test("a subnets artifact with no netuids never wipes the store", async () => {
    const { env, puts } = syncEnv();
    const result = await runSurfaceVerificationSync(
      env,
      undefined,
      syncDeps({ readArtifact: readArtifactStub({ subnets: [] }) }),
    );
    assert.deepEqual(result, { ok: false, reason: "no_subnets" });
    assert.equal(puts.length, 0);
  });

  test("sweeps every netuid over the 90-day window with the prober's own observed_at", async () => {
    const { env, puts } = syncEnv();
    const deps = syncDeps({
      readArtifact: readArtifactStub({
        subnets: [{ netuid: 2 }, { netuid: 1 }],
      }),
    });
    const result = await runSurfaceVerificationSync(env, undefined, deps);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.subnets_reached, 2);
    assert.equal(result.subnets_total, 2);
    assert.equal(result.verified_count, 1);
    const calls = (deps.loadUptime as Row).mock.calls;
    assert.deepEqual(
      calls.map((call: unknown[]) => call[0]),
      [1, 2],
    );
    assert.equal(calls[0][1].window, SURFACE_HEALTH_WINDOW);
    assert.equal(calls[0][1].observedAt, LAST_RUN_AT);
    assert.equal(calls[0][1].db, fakeDb);
    assert.equal(puts[0].key, SURFACE_HEALTH_R2_KEY);
    const written = JSON.parse(puts[0].value) as Row;
    assert.equal(written.source, "live-cron-prober");
    assert.equal(written.generated_at, new Date(TICK_MS).toISOString());
    assert.equal(written.surfaces["sn-1-api"].last_ok, LAST_RUN_AT);
  });

  test("a D1 read failure mid-sweep refuses to write a partial snapshot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, puts } = syncEnv();
    const deps = syncDeps({
      // A real failing read: d1All swallows the throw and bumps the failure
      // generation, which is exactly the signal this guard reads.
      loadUptime: async (netuid: number, options: Row) => {
        const { loadSubnetUptime } = await import("../src/analytics-live.ts");
        return loadSubnetUptime(netuid, {
          ...options,
          db: {
            prepare: () => ({
              bind: () => ({
                all: async () => {
                  throw new Error("D1 unavailable");
                },
              }),
            }),
          },
        } as Parameters<typeof loadSubnetUptime>[1]);
      },
    });
    const result = await runSurfaceVerificationSync(env, undefined, deps);
    assert.deepEqual(result, {
      ok: false,
      skipped: true,
      reason: "d1_read_failed",
    });
    assert.equal(
      (deps.recordException as Row).mock.calls[0][1].errorCode,
      "surface_verification_d1_read_failed",
    );
    assert.equal(puts.length, 0);
  });

  test("a healthy D1 with a cold uptime rollup never wipes the store", async () => {
    const { env, puts } = syncEnv();
    const result = await runSurfaceVerificationSync(
      env,
      undefined,
      syncDeps({ loadUptime: async () => ({ surfaces: [] }) }),
    );
    assert.deepEqual(result, { ok: false, reason: "no_probe_evidence" });
    assert.equal(puts.length, 0);
  });

  test("skips the write when the evidence is unchanged (only generated_at moved)", async () => {
    const { env, puts } = syncEnv();
    const first = await runSurfaceVerificationSync(env, undefined, syncDeps());
    assert.equal(first.changed, true);
    const second = await runSurfaceVerificationSync(
      env,
      undefined,
      syncDeps({ now: () => TICK_MS + 86_400_000 }),
    );
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(second.verified_count, 1);
    assert.equal(puts.length, 1);
  });

  test("a malformed previous store is treated as no baseline, not as a match", async () => {
    const { env, puts } = syncEnv({
      initialStore: { [SURFACE_HEALTH_R2_KEY]: { surfaces: ["not-a-map"] } },
    });
    const result = await runSurfaceVerificationSync(env, undefined, syncDeps());
    assert.equal(result.changed, true);
    assert.equal(puts.length, 1);
  });

  test("an unreadable previous store degrades to a write rather than throwing", async () => {
    const puts: Array<{ key: string; value: string }> = [];
    const result = await runSurfaceVerificationSync(
      mockEnv({
        METAGRAPH_HEALTH_DB: fakeDb,
        METAGRAPH_CONTROL: fakeKv({ last_run_at: LAST_RUN_AT }),
        METAGRAPH_ARCHIVE: {
          get: async () => {
            throw new Error("R2 read failed");
          },
          put: async (key: string, value: string) => {
            puts.push({ key, value });
          },
        },
      }),
      undefined,
      syncDeps(),
    );
    assert.equal(result.changed, true);
    assert.equal(puts.length, 1);
  });

  test("an unforeseen throw is contained as one failed tick, not an exception storm", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = syncEnv();
    const result = await runSurfaceVerificationSync(
      env,
      undefined,
      syncDeps({
        readArtifact: vi.fn(async () => {
          throw new Error("artifact layer down");
        }),
      }),
    );
    assert.deepEqual(result, { ok: false, reason: "unreachable" });
    assert.equal(errorSpy.mock.calls.length, 1);
  });

  test("a telemetry failure never surfaces out of a refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const waited: Promise<unknown>[] = [];
    const result = await runSurfaceVerificationSync(
      mockEnv({}),
      { waitUntil: (p) => waited.push(p) },
      syncDeps({
        recordException: vi.fn(async () => {
          throw new Error("telemetry down");
        }),
      }),
    );
    assert.deepEqual(await Promise.all(waited), [false]);
    assert.equal(result.skipped, true);
  });

  test("uses the real recordExceptionEvent when none is injected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runSurfaceVerificationSync(mockEnv({}));
    assert.equal(result.skipped, true);
  });

  test("uses the real loadSubnetUptime when none is injected", async () => {
    // No D1 rows behind the fake, so the real loader returns a schema-stable
    // empty payload -- the point is that the default branch is wired.
    const { env, puts } = syncEnv();
    const result = await runSurfaceVerificationSync(env, undefined, {
      readArtifact: readArtifactStub({ subnets: [{ netuid: 1 }] }),
      now: () => TICK_MS,
      recordException: vi.fn(async () => true),
    });
    assert.deepEqual(result, { ok: false, reason: "no_probe_evidence" });
    assert.equal(puts.length, 0);
  });

  test("the daily cron dispatches to it end-to-end through the Worker entry point", async () => {
    const { default: worker } = await import("../workers/api.ts");
    const { SURFACE_VERIFICATION_SYNC_CRON } =
      await import("../workers/config.ts");
    const { store, bucket } = fakeBucket({
      "latest/subnets.json": { subnets: [{ netuid: 1 }] },
    });
    const result = (await worker.scheduled(
      {
        cron: SURFACE_VERIFICATION_SYNC_CRON,
        scheduledTime: Date.now(),
      } as never,
      mockEnv({
        METAGRAPH_ARCHIVE: bucket,
        METAGRAPH_CONTROL: fakeKv({ last_run_at: LAST_RUN_AT }),
        METAGRAPH_HEALTH_DB: {
          prepare: () => ({
            bind: () => ({
              all: async () => ({
                results: [
                  {
                    surface_id: "sn-1-api",
                    surface_key: "srf-a",
                    day_count: 30,
                    day: "2026-08-01",
                    samples: 2880,
                    ok_count: 2880,
                    status: "ok",
                  },
                ],
              }),
            }),
          }),
        },
      }) as never,
      { waitUntil: () => {} } as never,
    )) as { ok: boolean; changed: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    // Proof the branch ran: only this cron writes the surface-health store key.
    assert.ok(store.has(SURFACE_HEALTH_R2_KEY));
  });

  test("the registered cron matches the wrangler trigger", async () => {
    const { SURFACE_VERIFICATION_SYNC_CRON } =
      await import("../workers/config.ts");
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    assert.ok(
      raw.includes(`"${SURFACE_VERIFICATION_SYNC_CRON}"`),
      `wrangler.jsonc has no trigger for ${SURFACE_VERIFICATION_SYNC_CRON}`,
    );
  });
});
