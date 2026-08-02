// Worker-side tests for the schema-snapshots cron (#9096): the daily scheduled
// branch that promotes the freshly published OpenAPI index into the durable
// drift-baseline store, replacing the retired sync-schema-snapshots.yml
// commit-a-file workflow.
//
// The retention tests are the load-bearing ones. A capture is a live fetch
// against third-party hosts; when one blips the published index drops that
// surface from `captured` and WIPES its hash, which resets its whole drift
// chain to "new" on the next capture. Retention is what makes a transient 502
// cost nothing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";
import {
  entryObservedAtMs,
  retainLastGoodSchemas,
  runSchemaSnapshotsSync,
  schemaEntriesById,
  schemaIndexContentDigest,
  summarizeSchemaEntries,
  SCHEMA_INDEX_ARTIFACT_PATH,
  SCHEMA_INDEX_R2_KEY,
  SCHEMA_SNAPSHOT_RETENTION_MS,
} from "../src/schema-snapshots-sync.ts";
import { mockEnv, type AnyFn, type Row } from "./row-type.ts";

const TICK_MS = Date.parse("2026-08-02T05:05:00.000Z");
const FRESH_OBSERVED_AT = new Date(TICK_MS - 86_400_000).toISOString();

function capturedEntry(overrides: Row = {}): Row {
  return {
    netuid: 1,
    subnet_slug: "sn-1",
    surface_id: "sn-1-openapi",
    url: "https://api.example.com",
    schema_url: "https://api.example.com/openapi.json",
    status: "captured",
    drift_status: "unchanged",
    hash: "abc",
    previous_hash: "abc",
    path: "/metagraph/schemas/sn-1-openapi.json",
    snapshot: { observed_at: FRESH_OBSERVED_AT, hash: "abc" },
    ...overrides,
  };
}

function missingEntry(overrides: Row = {}): Row {
  return {
    netuid: 1,
    subnet_slug: "sn-1",
    surface_id: "sn-1-openapi",
    url: "https://api.example.com",
    schema_url: null,
    status: "not-found",
    drift_status: "not-captured",
    hash: null,
    previous_hash: null,
    path: null,
    error: "no machine-readable OpenAPI JSON found",
    ...overrides,
  };
}

function publishedIndex(schemas: Row[]): Row {
  return {
    schema_version: 1,
    contract_version: "2026-07-03.2",
    generated_at: "1970-01-01T00:00:00.000Z",
    observed_at: FRESH_OBSERVED_AT,
    source: "openapi-snapshot",
    notes: "Machine-readable OpenAPI/Swagger JSON snapshots only.",
    summary: { surface_count: schemas.length },
    schemas,
  };
}

function readArtifactStub(doc: Row | null): AnyFn {
  return vi.fn(async (_env: unknown, path: string) => {
    assert.equal(path, SCHEMA_INDEX_ARTIFACT_PATH);
    return doc
      ? { ok: true, data: doc, source: "r2", storage_tier: "dual" }
      : { ok: false, status: 404, code: "artifact_not_found", message: "no" };
  });
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

function syncDeps(overrides: Record<string, unknown> = {}) {
  return {
    readArtifact: readArtifactStub(publishedIndex([capturedEntry()])),
    now: () => TICK_MS,
    recordException: vi.fn(async () => true),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("schemaEntriesById", () => {
  test("indexes by surface_id and skips idless / malformed rows", () => {
    const byId = schemaEntriesById({
      schemas: [capturedEntry(), { surface_id: "" }, {}, null],
    });
    assert.deepEqual([...byId.keys()], ["sn-1-openapi"]);
  });

  test("an unusable document is an empty map, not a throw", () => {
    assert.equal(schemaEntriesById(null).size, 0);
    assert.equal(schemaEntriesById({ schemas: "nope" }).size, 0);
  });
});

describe("entryObservedAtMs", () => {
  test("reads the entry's own snapshot instant, not the index-level stamp", () => {
    assert.equal(
      entryObservedAtMs(capturedEntry()),
      Date.parse(FRESH_OBSERVED_AT),
    );
  });

  test("absent, non-string and unparseable instants all read as null", () => {
    assert.equal(entryObservedAtMs(undefined), null);
    assert.equal(entryObservedAtMs({}), null);
    assert.equal(entryObservedAtMs({ snapshot: {} }), null);
    assert.equal(entryObservedAtMs({ snapshot: { observed_at: 42 } }), null);
    assert.equal(
      entryObservedAtMs({ snapshot: { observed_at: "not-a-date" } }),
      null,
    );
  });
});

describe("retainLastGoodSchemas", () => {
  test("a fresh capture always wins over the store", () => {
    const published = [capturedEntry({ hash: "new" })];
    const { schemas, retained_count } = retainLastGoodSchemas(
      published,
      schemaEntriesById({ schemas: [capturedEntry({ hash: "old" })] }),
      TICK_MS,
    );
    assert.equal(schemas[0].hash, "new");
    assert.equal(retained_count, 0);
  });

  test("a transient failure keeps the store's last-good captured entry", () => {
    const { schemas, retained_count } = retainLastGoodSchemas(
      [missingEntry()],
      schemaEntriesById({ schemas: [capturedEntry()] }),
      TICK_MS,
    );
    assert.equal(schemas[0].status, "captured");
    assert.equal(schemas[0].hash, "abc");
    assert.equal(retained_count, 1);
  });

  test("retention expires: past the window the honest failure entry stands", () => {
    const stale = capturedEntry({
      snapshot: {
        observed_at: new Date(
          TICK_MS - SCHEMA_SNAPSHOT_RETENTION_MS - 1000,
        ).toISOString(),
      },
    });
    const { schemas, retained_count } = retainLastGoodSchemas(
      [missingEntry()],
      schemaEntriesById({ schemas: [stale] }),
      TICK_MS,
    );
    assert.equal(schemas[0].status, "not-found");
    assert.equal(retained_count, 0);
  });

  test("a store entry with no readable observed_at is never retained", () => {
    const { schemas, retained_count } = retainLastGoodSchemas(
      [missingEntry()],
      schemaEntriesById({ schemas: [capturedEntry({ snapshot: {} })] }),
      TICK_MS,
    );
    assert.equal(schemas[0].status, "not-found");
    assert.equal(retained_count, 0);
  });

  test("a failure with no store history, or a store history that also failed, stands as-is", () => {
    assert.equal(
      retainLastGoodSchemas([missingEntry()], new Map(), TICK_MS)
        .retained_count,
      0,
    );
    assert.equal(
      retainLastGoodSchemas(
        [missingEntry()],
        schemaEntriesById({ schemas: [missingEntry()] }),
        TICK_MS,
      ).retained_count,
      0,
    );
  });

  test("an idless published entry can never match a store entry", () => {
    const { retained_count } = retainLastGoodSchemas(
      [missingEntry({ surface_id: 42 })],
      schemaEntriesById({ schemas: [capturedEntry()] }),
      TICK_MS,
    );
    assert.equal(retained_count, 0);
  });

  test("a surface the publish no longer lists is dropped, not resurrected", () => {
    const { schemas } = retainLastGoodSchemas(
      [capturedEntry({ surface_id: "sn-2-openapi" })],
      schemaEntriesById({ schemas: [capturedEntry()] }),
      TICK_MS,
    );
    assert.deepEqual(
      schemas.map((entry) => entry.surface_id),
      ["sn-2-openapi"],
    );
  });

  test("a null published row is passed through untouched", () => {
    const { schemas, retained_count } = retainLastGoodSchemas(
      [null as unknown as Row],
      schemaEntriesById({ schemas: [capturedEntry()] }),
      TICK_MS,
    );
    assert.deepEqual(schemas, [null]);
    assert.equal(retained_count, 0);
  });
});

describe("summarizeSchemaEntries", () => {
  test("recounts over what survived retention, with sorted count keys", () => {
    assert.deepEqual(
      summarizeSchemaEntries([
        capturedEntry(),
        capturedEntry({ surface_id: "b", drift_status: "changed" }),
        missingEntry({ surface_id: "c" }),
      ]),
      {
        surface_count: 3,
        schema_count: 2,
        by_status: { captured: 2, "not-found": 1 },
        by_drift_status: { changed: 1, "not-captured": 1, unchanged: 1 },
      },
    );
  });
});

describe("schemaIndexContentDigest", () => {
  test("ignores the re-stamped timestamps, so an identical capture is not a change", () => {
    const a = publishedIndex([capturedEntry()]);
    const b = publishedIndex([
      capturedEntry({
        snapshot: { observed_at: "2026-08-02T05:00:00.000Z", hash: "abc" },
      }),
    ]);
    b.observed_at = "2026-08-02T05:00:00.000Z";
    assert.equal(schemaIndexContentDigest(a), schemaIndexContentDigest(b));
  });

  test("a changed hash IS a change", () => {
    assert.notEqual(
      schemaIndexContentDigest(publishedIndex([capturedEntry()])),
      schemaIndexContentDigest(publishedIndex([capturedEntry({ hash: "z" })])),
    );
  });

  test("handles entries with a missing or non-object snapshot, and a schemaless doc", () => {
    assert.equal(
      typeof schemaIndexContentDigest(publishedIndex([missingEntry()])),
      "string",
    );
    assert.equal(
      typeof schemaIndexContentDigest(
        publishedIndex([capturedEntry({ snapshot: "nope" })]),
      ),
      "string",
    );
    assert.equal(typeof schemaIndexContentDigest({}), "string");
  });
});

describe("runSchemaSnapshotsSync", () => {
  test("no R2 binding: no-ops LOUDLY — console.error + one exception event — and reads nothing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = syncDeps();
    const waited: Promise<unknown>[] = [];
    const result = await runSchemaSnapshotsSync(
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
    assert.equal(
      (deps.recordException as Row).mock.calls[0][1].errorCode,
      "schema_snapshots_bucket_missing",
    );
    assert.equal((deps.readArtifact as Row).mock.calls.length, 0);
  });

  test("no reader injected is a contained no-op, not a throw", async () => {
    const { bucket } = fakeBucket();
    const result = await runSchemaSnapshotsSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      { readArtifact: undefined },
    );
    assert.deepEqual(result, { ok: false, reason: "reader_unavailable" });
  });

  test("an unavailable published index never wipes the baseline", async () => {
    const { bucket, puts } = fakeBucket();
    const result = await runSchemaSnapshotsSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({ readArtifact: readArtifactStub(null) }),
    );
    assert.deepEqual(result, {
      ok: false,
      reason: "schema_index_artifact_unavailable",
    });
    assert.equal(puts.length, 0);
  });

  test("an empty published index never wipes the baseline", async () => {
    const { bucket, puts } = fakeBucket();
    for (const doc of [publishedIndex([]), { schemas: "nope" } as Row]) {
      const result = await runSchemaSnapshotsSync(
        mockEnv({ METAGRAPH_ARCHIVE: bucket }),
        undefined,
        syncDeps({ readArtifact: readArtifactStub(doc) }),
      );
      assert.deepEqual(result, { ok: false, reason: "empty_schema_index" });
    }
    assert.equal(puts.length, 0);
  });

  test("promotes the published index verbatim, keeping `source` so the build still reuses it", async () => {
    const { bucket, puts } = fakeBucket();
    const result = await runSchemaSnapshotsSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps(),
    );
    assert.deepEqual(result, {
      ok: true,
      changed: true,
      surface_count: 1,
      schema_count: 1,
      retained_count: 0,
    });
    assert.equal(puts[0].key, SCHEMA_INDEX_R2_KEY);
    const written = JSON.parse(puts[0].value) as Row;
    // reusableSchemaIndexArtifact refuses any baseline whose source is not
    // "openapi-snapshot" — rewriting it would discard the whole index.
    assert.equal(written.source, "openapi-snapshot");
    assert.equal(written.contract_version, "2026-07-03.2");
    assert.equal(written.observed_at, FRESH_OBSERVED_AT);
    assert.equal(written.promoted_by, "worker-cron");
    assert.equal(written.promoted_at, new Date(TICK_MS).toISOString());
    assert.equal(written.summary.schema_count, 1);
  });

  test("retains a last-good capture through a transient publish failure and recounts the summary", async () => {
    const { bucket, puts } = fakeBucket({
      [SCHEMA_INDEX_R2_KEY]: publishedIndex([capturedEntry()]),
    });
    const result = await runSchemaSnapshotsSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        readArtifact: readArtifactStub(publishedIndex([missingEntry()])),
      }),
    );
    assert.equal(result.retained_count, 1);
    assert.equal(result.schema_count, 1);
    const written = JSON.parse(puts[0].value) as Row;
    assert.equal(written.schemas[0].hash, "abc");
    assert.deepEqual(written.summary.by_status, { captured: 1 });
  });

  test("an unreadable previous store degrades to no retention credit rather than throwing", async () => {
    const puts: Array<{ key: string; value: string }> = [];
    const result = await runSchemaSnapshotsSync(
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
    assert.equal(result.retained_count, 0);
    assert.equal(puts.length, 1);
  });

  test("skips the write when only the re-stamped timestamps moved", async () => {
    const { bucket, puts } = fakeBucket();
    const first = await runSchemaSnapshotsSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps(),
    );
    assert.equal(first.changed, true);
    const restamped = publishedIndex([
      capturedEntry({
        snapshot: { observed_at: "2026-08-03T05:00:00.000Z", hash: "abc" },
      }),
    ]);
    restamped.observed_at = "2026-08-03T05:00:00.000Z";
    const second = await runSchemaSnapshotsSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps({
        readArtifact: readArtifactStub(restamped),
        now: () => TICK_MS + 86_400_000,
      }),
    );
    assert.deepEqual(second, {
      ok: true,
      changed: false,
      surface_count: 1,
      schema_count: 1,
      retained_count: 0,
    });
    assert.equal(puts.length, 1);
  });

  test("a malformed previous store is treated as no baseline, not as a match", async () => {
    const { bucket, puts } = fakeBucket({
      [SCHEMA_INDEX_R2_KEY]: { schemas: "nope" },
    });
    const result = await runSchemaSnapshotsSync(
      mockEnv({ METAGRAPH_ARCHIVE: bucket }),
      undefined,
      syncDeps(),
    );
    assert.equal(result.changed, true);
    assert.equal(puts.length, 1);
  });

  test("an unforeseen throw is contained as one failed tick, not an exception storm", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bucket } = fakeBucket();
    const result = await runSchemaSnapshotsSync(
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
    const result = await runSchemaSnapshotsSync(
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
    const result = await runSchemaSnapshotsSync(mockEnv({}));
    assert.equal(result.skipped, true);
  });

  test("the daily cron dispatches to it end-to-end through the Worker entry point", async () => {
    const { default: worker } = await import("../workers/api.ts");
    const { SCHEMA_SNAPSHOTS_SYNC_CRON } = await import("../workers/config.ts");
    const { store, bucket } = fakeBucket({
      "latest/schemas/index.json": publishedIndex([capturedEntry()]),
    });
    const result = (await worker.scheduled(
      {
        cron: SCHEMA_SNAPSHOTS_SYNC_CRON,
        scheduledTime: Date.now(),
      } as never,
      mockEnv({ METAGRAPH_ARCHIVE: bucket }) as never,
      { waitUntil: () => {} } as never,
    )) as { ok: boolean; changed: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    // Proof the branch ran: only this cron writes the schema-index store key.
    assert.ok(store.has(SCHEMA_INDEX_R2_KEY));
  });

  test("the registered cron matches the wrangler trigger", async () => {
    const { SCHEMA_SNAPSHOTS_SYNC_CRON } = await import("../workers/config.ts");
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    assert.ok(
      raw.includes(`"${SCHEMA_SNAPSHOTS_SYNC_CRON}"`),
      `wrangler.jsonc has no trigger for ${SCHEMA_SNAPSHOTS_SYNC_CRON}`,
    );
  });
});
