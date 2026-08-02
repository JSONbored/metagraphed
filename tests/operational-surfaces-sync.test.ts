// Worker-side tests for the operational-surfaces cron (#9096): the hourly
// scheduled branch that derives the prober's input list from the published
// registry and writes the R2 store, replacing the retired
// sync-operational-surfaces.yml commit-a-file workflow.
//
// Same double conventions as tests/github-signals-sync.test.ts — the artifact
// reader asserts the exact path it is asked for, so a derivation that reads
// the wrong artifact fails here instead of passing on a canned answer.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";
import {
  deriveOperationalSurfaces,
  operationalSurfacesContentDigest,
  runOperationalSurfacesSync,
  schemaSourcesById,
  OPERATIONAL_SURFACES_ARTIFACT_PATH,
  OPERATIONAL_SURFACES_R2_KEY,
  OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH,
  type OperationalSurfacesArtifact,
} from "../src/operational-surfaces-sync.ts";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import { mockEnv, type AnyFn, type Row } from "./row-type.ts";

const TICK_MS = Date.parse("2026-08-02T09:47:00.000Z");

function surfaceRow(overrides: Row = {}): Row {
  return {
    id: "sn-1-api",
    key: "srf-aaaa",
    netuid: 1,
    subnet_slug: "sn-1",
    subnet_name: "Apex",
    kind: "subnet-api",
    provider: "macrocosmos",
    authority: "official",
    url: "https://api.example.com",
    auth_required: false,
    public_safe: true,
    probe: { enabled: true, method: "GET", expect: "json", timeout_ms: 8000 },
    ...overrides,
  };
}

/** Artifact reader double keyed on the exact artifact paths this lane reads. */
function readArtifactStub(
  byPath: Record<string, Row | null>,
  calls?: string[],
): AnyFn {
  return vi.fn(async (_env: unknown, path: string) => {
    calls?.push(path);
    if (!Object.hasOwn(byPath, path)) {
      throw new Error(`unexpected artifact read: ${path}`);
    }
    const doc = byPath[path];
    return doc
      ? { ok: true, data: doc, source: "r2", storage_tier: "dual" }
      : { ok: false, status: 404, code: "artifact_not_found", message: "no" };
  });
}

/** In-memory R2 double: get/put over a Map, values stored as JSON strings. */
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

function syncDeps(overrides: Record<string, unknown> = {}) {
  return {
    readArtifact: readArtifactStub({
      [OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH]: {
        surfaces: [surfaceRow()],
      },
      [OPERATIONAL_SURFACES_ARTIFACT_PATH]: { surfaces: [] },
    }),
    now: () => TICK_MS,
    recordException: vi.fn(async () => true),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deriveOperationalSurfaces", () => {
  test("keeps only probe-enabled, public-safe, operational-kind surfaces", () => {
    const rows = deriveOperationalSurfaces([
      surfaceRow({ id: "keep" }),
      surfaceRow({ id: "probe-off", probe: { enabled: false, method: "GET" } }),
      surfaceRow({ id: "not-public", public_safe: false }),
      surfaceRow({ id: "docs-kind", kind: "docs" }),
      surfaceRow({ id: "no-probe-block", probe: undefined }),
      null,
    ]);
    assert.deepEqual(
      rows.map((row) => row.surface_id),
      ["keep"],
    );
  });

  test("projects exactly the prober's field subset, normalising booleans and a non-integer timeout", () => {
    const [row] = deriveOperationalSurfaces([
      surfaceRow({
        auth_required: "yes",
        probe: {
          enabled: true,
          method: "GET",
          expect: "json",
          timeout_ms: 1.5,
        },
      }),
    ]);
    assert.deepEqual(row, {
      surface_id: "sn-1-api",
      surface_key: "srf-aaaa",
      netuid: 1,
      subnet_slug: "sn-1",
      subnet_name: "Apex",
      kind: "subnet-api",
      provider: "macrocosmos",
      authority: "official",
      url: "https://api.example.com",
      auth_required: true,
      public_safe: true,
      probe: { method: "GET", expect: "json", timeout_ms: null },
      schema_source: null,
    });
  });

  test("sorts by netuid then surface_id, matching the build's own ordering", () => {
    const rows = deriveOperationalSurfaces([
      surfaceRow({ id: "b", netuid: 2 }),
      surfaceRow({ id: "z", netuid: 1 }),
      surfaceRow({ id: "a", netuid: 2 }),
    ]);
    assert.deepEqual(
      rows.map((row) => `${row.netuid}:${row.surface_id}`),
      ["1:z", "2:a", "2:b"],
    );
  });

  test("carries schema_source forward by surface_id, and leaves an idless surface null", () => {
    const rows = deriveOperationalSurfaces(
      [
        surfaceRow({ id: "with-schema", netuid: 1 }),
        surfaceRow({ id: undefined, netuid: 2 }),
      ],
      new Map([["with-schema", { match: "surface-id" }]]),
    );
    assert.deepEqual(rows[0].schema_source, { match: "surface-id" });
    assert.equal(rows[1].schema_source, null);
  });

  test("returns [] for a non-array input", () => {
    assert.deepEqual(deriveOperationalSurfaces(undefined), []);
    assert.deepEqual(deriveOperationalSurfaces({}), []);
  });

  test("the kind filter still matches the shared OPERATIONAL_SURFACE_KINDS list", () => {
    // A kind added to the prober's list but not reaching this derivation would
    // silently shrink the probe set. Assert every one of them survives.
    const rows = deriveOperationalSurfaces(
      OPERATIONAL_SURFACE_KINDS.map((kind, index) =>
        surfaceRow({ id: kind, kind, netuid: index }),
      ),
    );
    assert.equal(rows.length, OPERATIONAL_SURFACE_KINDS.length);
  });

  test("the committed artifact's own `kinds` list matches the shared constant", () => {
    // The build stamps the kinds it filtered by into the artifact; if that
    // list ever diverges from the constant this module filters by, the cron
    // would publish a different surface set than a build would.
    const committed = JSON.parse(
      readFileSync(
        new URL(
          "../public/metagraph/operational-surfaces.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Row;
    assert.deepEqual(committed.kinds, [...OPERATIONAL_SURFACE_KINDS].sort());
  });
});

describe("schemaSourcesById", () => {
  test("indexes non-null schema_source by surface_id and skips the rest", () => {
    const byId = schemaSourcesById({
      surfaces: [
        { surface_id: "a", schema_source: { match: "surface-id" } },
        { surface_id: "b", schema_source: null },
        { surface_id: "", schema_source: { match: "x" } },
        { schema_source: { match: "y" } },
        null,
      ],
    });
    assert.deepEqual([...byId.keys()], ["a"]);
  });

  test("an unusable document is an empty map, not a throw", () => {
    assert.equal(schemaSourcesById(null).size, 0);
    assert.equal(schemaSourcesById({ surfaces: "nope" }).size, 0);
  });
});

describe("operationalSurfacesContentDigest", () => {
  test("ignores generated_at but not the surface list", () => {
    const base = {
      schema_version: 1,
      source: "worker-cron",
      surface_count: 1,
      kinds: ["subnet-api"],
      surfaces: [{ surface_id: "a" }],
    } as unknown as OperationalSurfacesArtifact;
    const a = { ...base, generated_at: "2026-08-01T00:00:00.000Z" };
    const b = { ...base, generated_at: "2026-08-02T00:00:00.000Z" };
    assert.equal(
      operationalSurfacesContentDigest(a),
      operationalSurfacesContentDigest(b),
    );
    const moved = {
      ...b,
      surfaces: [{ surface_id: "a", url: "https://changed" }],
    } as unknown as OperationalSurfacesArtifact;
    assert.notEqual(
      operationalSurfacesContentDigest(b),
      operationalSurfacesContentDigest(moved),
    );
  });
});

describe("runOperationalSurfacesSync", () => {
  test("no R2 binding: no-ops LOUDLY — console.error + one exception event — and reads nothing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = syncDeps();
    const waited: Promise<unknown>[] = [];
    const result = await runOperationalSurfacesSync(
      mockEnv({}),
      { waitUntil: (p) => waited.push(p) },
      deps,
    );
    await Promise.all(waited);
    assert.deepEqual(result, {
      ok: false,
      skipped: true,
      reason: "r2_binding_missing",
    });
    assert.equal(errorSpy.mock.calls.length, 1);
    assert.equal((deps.recordException as Row).mock.calls.length, 1);
    assert.equal(
      (deps.recordException as Row).mock.calls[0][1].errorCode,
      "operational_surfaces_bucket_missing",
    );
    // Never reached the registry: refusing to write is the whole no-op.
    assert.equal((deps.readArtifact as Row).mock.calls.length, 0);
  });

  test("a bucket missing put() is treated as unbound too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runOperationalSurfacesSync(
      mockEnv({ METAGRAPH_ARCHIVE: { get: async () => null } }),
      undefined,
      syncDeps(),
    );
    assert.equal(result.reason, "r2_binding_missing");
  });

  test("no reader injected is a contained no-op, not a throw", async () => {
    const { bucket } = fakeBucket();
    const result = await runOperationalSurfacesSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      { readArtifact: undefined },
    );
    assert.deepEqual(result, { ok: false, reason: "reader_unavailable" });
  });

  test("an unavailable surfaces artifact never wipes the store", async () => {
    const { bucket, puts } = fakeBucket();
    const result = await runOperationalSurfacesSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        readArtifact: readArtifactStub({
          [OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH]: null,
        }),
      }),
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "surfaces_artifact_unavailable",
    });
    assert.equal(puts.length, 0);
  });

  test("a surfaces artifact with zero operational rows never wipes the store", async () => {
    const { bucket, puts } = fakeBucket();
    const result = await runOperationalSurfacesSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        readArtifact: readArtifactStub({
          [OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH]: {
            surfaces: [surfaceRow({ kind: "docs" })],
          },
          [OPERATIONAL_SURFACES_ARTIFACT_PATH]: { surfaces: [] },
        }),
      }),
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "no_operational_surfaces",
    });
    assert.equal(puts.length, 0);
  });

  test("writes the derived list on a cold store, seeding schema_source from the published artifact", async () => {
    const { store, puts } = fakeBucket();
    const paths: string[] = [];
    const result = await runOperationalSurfacesSync(
      mockEnv({ METAGRAPH_ARCHIVE: fakeBucketFrom(store, puts) }),
      undefined,
      syncDeps({
        readArtifact: readArtifactStub(
          {
            [OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH]: {
              surfaces: [surfaceRow()],
            },
            [OPERATIONAL_SURFACES_ARTIFACT_PATH]: {
              surfaces: [
                {
                  surface_id: "sn-1-api",
                  schema_source: { match: "surface-id" },
                },
              ],
            },
          },
          paths,
        ),
      }),
    );
    assert.deepEqual(result, {
      ok: true,
      changed: true,
      surface_count: 1,
    });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].key, OPERATIONAL_SURFACES_R2_KEY);
    const written = JSON.parse(puts[0].value) as Row;
    assert.equal(written.generated_at, new Date(TICK_MS).toISOString());
    assert.equal(written.source, "worker-cron");
    assert.deepEqual(written.surfaces[0].schema_source, {
      match: "surface-id",
    });
    // The published operational-surfaces artifact is only consulted on a cold
    // store — proving the carry-forward is a seed, not a per-run dependency.
    assert.deepEqual(paths, [
      OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH,
      OPERATIONAL_SURFACES_ARTIFACT_PATH,
    ]);
  });

  test("a failing published-artifact seed read degrades to null schema_source, not a failed tick", async () => {
    const { bucket, puts } = fakeBucket();
    const result = await runOperationalSurfacesSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        readArtifact: vi.fn(async (_env: unknown, path: string) =>
          path === OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH
            ? { ok: true, data: { surfaces: [surfaceRow()] } }
            : Promise.reject(new Error("seed read blew up")),
        ),
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(
      (JSON.parse(puts[0].value) as Row).surfaces[0].schema_source,
      null,
    );
  });

  test("prefers the store's own last schema_source over the published artifact", async () => {
    const { bucket, puts } = fakeBucket({
      [OPERATIONAL_SURFACES_R2_KEY]: {
        surfaces: [
          { surface_id: "sn-1-api", schema_source: { match: "from-store" } },
        ],
      },
    });
    const paths: string[] = [];
    await runOperationalSurfacesSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        readArtifact: readArtifactStub(
          {
            [OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH]: {
              surfaces: [surfaceRow()],
            },
          },
          paths,
        ),
      }),
    );
    assert.deepEqual(
      (JSON.parse(puts[0].value) as Row).surfaces[0].schema_source,
      {
        match: "from-store",
      },
    );
    // Only the source artifact was read: the seed path is skipped entirely.
    assert.deepEqual(paths, [OPERATIONAL_SURFACES_SOURCE_ARTIFACT_PATH]);
  });

  test("an unreadable previous store degrades to no carry-forward rather than throwing", async () => {
    const puts: Array<{ key: string; value: string }> = [];
    const result = await runOperationalSurfacesSync(
      mockEnv({
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

  test("skips the write when the content is unchanged (only generated_at moved)", async () => {
    const { bucket, puts } = fakeBucket();
    const first = await runOperationalSurfacesSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps(),
    );
    assert.equal(first.changed, true);
    const second = await runOperationalSurfacesSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({ now: () => TICK_MS + 3_600_000 }),
    );
    assert.deepEqual(second, {
      ok: true,
      changed: false,
      surface_count: 1,
    });
    assert.equal(puts.length, 1);
  });

  test("an unforeseen throw is contained as one failed tick, not an exception storm", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bucket } = fakeBucket();
    const result = await runOperationalSurfacesSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
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

  test("a telemetry failure never surfaces out of the loud no-op", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const waited: Promise<unknown>[] = [];
    const result = await runOperationalSurfacesSync(
      mockEnv({}),
      { waitUntil: (p) => waited.push(p) },
      syncDeps({
        recordException: vi.fn(async () => {
          throw new Error("telemetry down");
        }),
      }),
    );
    // The rejection is swallowed by the waitUntil promise, not rethrown.
    assert.deepEqual(await Promise.all(waited), [false]);
    assert.equal(result.skipped, true);
  });

  test("uses the real recordExceptionEvent when none is injected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // No POSTHOG token in env, so the real telemetry helper short-circuits —
    // the point is that the default branch is exercised and never throws.
    const result = await runOperationalSurfacesSync(mockEnv({}));
    assert.equal(result.skipped, true);
  });

  test("the hourly cron dispatches to it end-to-end through the Worker entry point", async () => {
    // Registering the trigger in wrangler.jsonc without wiring the branch
    // would fire a cron into a silent no-op forever.
    const { default: worker } = await import("../workers/api.ts");
    const { OPERATIONAL_SURFACES_SYNC_CRON } =
      await import("../workers/config.ts");
    const { store, bucket } = fakeBucket({
      // The real readArtifact resolves the artifact paths through the literal
      // latest/ prefix when no publish pointer exists.
      "latest/surfaces.json": { surfaces: [surfaceRow()] },
      "latest/operational-surfaces.json": { surfaces: [] },
    });
    const result = (await worker.scheduled(
      {
        cron: OPERATIONAL_SURFACES_SYNC_CRON,
        scheduledTime: Date.now(),
      } as never,
      mockEnv({ METAGRAPH_ARCHIVE: bucket }) as never,
      { waitUntil: () => {} } as never,
    )) as { ok: boolean; changed: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    // Proof the branch ran: only this cron writes the surfaces store key.
    assert.ok(store.has(OPERATIONAL_SURFACES_R2_KEY));
  });

  test("the registered cron matches the wrangler trigger", async () => {
    // A constant that drifts from wrangler.jsonc means the branch is dead in
    // production while every test here still passes.
    const { OPERATIONAL_SURFACES_SYNC_CRON } =
      await import("../workers/config.ts");
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    assert.ok(
      raw.includes(`"${OPERATIONAL_SURFACES_SYNC_CRON}"`),
      `wrangler.jsonc has no trigger for ${OPERATIONAL_SURFACES_SYNC_CRON}`,
    );
  });
});

/** Re-wraps an existing store Map as a bucket double sharing its puts list. */
function fakeBucketFrom(
  store: Map<string, string>,
  puts: Array<{ key: string; value: string }>,
) {
  return {
    get: async (key: string) => {
      const raw = store.get(key);
      if (raw == null) return null;
      return { json: async () => JSON.parse(raw), text: async () => raw };
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
      puts.push({ key, value });
    },
  };
}
