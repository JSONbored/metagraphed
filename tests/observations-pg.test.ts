import assert from "node:assert/strict";
import { test } from "vitest";
import { createPgObservations } from "../src/observations-pg.ts";
import {
  persistProbesToNeon,
  pruneChecksNeon,
  rollupFailureReasonsToNeon,
  rollupUptimeDailyToNeon,
  selectedObservationsStore,
  upsertSubnetSnapshotsToNeon,
} from "../src/observations-neon.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";
import { observationsReadDb } from "../src/observations-read-runner.ts";
import { readLiveSurfaceStatus } from "../src/health-status-live.ts";
import { mockEnv } from "./row-type.ts";

function fixture(fail = false) {
  const calls: { text: string; values?: unknown[] }[] = [];
  let transactions = 0;
  const native = createPgObservations({
    async transaction(callback) {
      transactions += 1;
      return callback({
        async run(text, values) {
          calls.push({ text, values });
          return { changes: 0 };
        },
        async first() {
          return null;
        },
        async query<Row>(text: string, values?: unknown[]) {
          calls.push({ text, values });
          if (fail) throw new Error("synthetic write failure");
          return (
            text.startsWith("SELECT netuid,kind")
              ? [
                  {
                    netuid: null,
                    kind: "api",
                    classification: "failed",
                    checks: 2,
                  },
                ]
              : []
          ) as Row[];
        },
      });
    },
  } satisfies Pick<PgStoreRuntime, "transaction">);
  return { native, calls, count: () => transactions };
}

test("observation selection is explicit and invalid native configuration cannot fall through", () => {
  for (const env of [null, undefined, 1, {}])
    assert.equal(selectedObservationsStore(env), undefined);
  const { native } = fixture();
  assert.equal(
    selectedObservationsStore({ OBSERVATIONS_STORE: native }),
    native,
  );
  for (const value of [
    null,
    {},
    { unsafe() {} },
    { unsafe() {}, transaction() {} },
  ]) {
    assert.throws(
      () => selectedObservationsStore({ OBSERVATIONS_STORE: value }),
      /invalid/,
    );
  }
});

test("native writers use one schema-scoped lease and the source conflict target", async () => {
  const f = fixture();
  const rows = [
    { surface_id: "a", surface_key: "key", checked_at_ms: 1000, status: "ok" },
  ];
  assert.deepEqual(await persistProbesToNeon(f.native, rows, 1000), {
    ok: true,
  });
  assert.equal(f.count(), 1);
  assert.match(f.calls[0].text, /SET LOCAL search_path/);
  assert.ok(
    f.calls.some(
      (call) =>
        call.text.includes("INSERT INTO surface_status") &&
        !call.text.includes("WITH alias_conflict"),
    ),
  );
  const days = [{ date: "day", start: 0, end: 2000 }];
  assert.deepEqual(await rollupFailureReasonsToNeon(f.native, days, 2000), {
    ok: true,
  });
  assert.ok(
    f.calls.some((call) =>
      call.text.includes("ON CONFLICT(day,(COALESCE(netuid,-1))"),
    ),
  );
  assert.deepEqual(await rollupUptimeDailyToNeon(f.native, days, 2000), {
    ok: true,
  });
  assert.deepEqual(await pruneChecksNeon(f.native, 0), { ok: true });
  assert.deepEqual(
    await upsertSubnetSnapshotsToNeon(f.native, [
      { netuid: 1, snapshot_date: "day" },
    ]),
    { ok: true },
  );
  assert.equal(f.count(), 5);
  await f.native.unsafe("SELECT 1");
  assert.equal(f.count(), 6);
  const reader = observationsReadDb({ OBSERVATIONS_STORE: f.native });
  assert.deepEqual(await reader?.query("SELECT 1"), []);
  assert.equal(f.count(), 7);
});

test("native transaction failure remains a failed observation result", async () => {
  const f = fixture(true);
  assert.deepEqual(await pruneChecksNeon(f.native, 0), {
    ok: false,
    reason: "synthetic write failure",
  });
  const invalid = {
    nativePostgres: true as const,
    unsafe: async () => [],
  };
  assert.deepEqual(await rollupFailureReasonsToNeon(invalid, [], 0), {
    ok: false,
    reason: "Native failure rollup is unavailable",
  });
});

test("native continuity reads preserve the prior-state fallback contract", async () => {
  const f = fixture();
  const env = mockEnv({ OBSERVATIONS_STORE: f.native });
  assert.deepEqual(await readLiveSurfaceStatus(env, 12.75), []);
  assert.ok(f.calls.some((call) => call.values?.[0] === 12));
  assert.deepEqual(await readLiveSurfaceStatus(env, NaN), []);
  assert.deepEqual(
    await readLiveSurfaceStatus(
      mockEnv({ OBSERVATIONS_STORE: fixture(true).native }),
      0,
    ),
    [],
  );
  const invalidRows = { ...f.native, unsafe: async () => ({ rows: [] }) };
  assert.deepEqual(
    await readLiveSurfaceStatus(
      mockEnv({ OBSERVATIONS_STORE: invalidRows }),
      0,
    ),
    [],
  );
});
