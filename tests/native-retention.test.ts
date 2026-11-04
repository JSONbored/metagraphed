import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createPgRetentionStore } from "../src/pg-retention.ts";
import { selectedNativeRetentionStore } from "../src/native-retention-store.ts";
import {
  MIN_RETENTION_MS,
  NEON_PRUNE_PLANS,
  runNeonPrune,
} from "../src/neon-prune.ts";
import type { PgTransaction, PgTransactionRunner } from "../src/pg-pool.ts";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const calls: { text: string; values?: unknown[] }[] = [];
  let impact: unknown = { doomed: "2", survivors: "1" };
  let changes = 2;
  let fail: "impact" | "delete" | "raw" | "commit" | undefined;
  const transaction: PgTransactionRunner = async (run, options) => {
    assert.equal(options?.isolation, "read committed");
    const scope: PgTransaction = {
      async query<Row>() {
        return [] as Row[];
      },
      async first<Row>(text: string, values?: unknown[]) {
        calls.push({ text, values });
        if (fail === "impact") throw new Error("read rejected");
        return impact as Row;
      },
      async run(text, values) {
        calls.push({ text, values });
        if (text.startsWith("DELETE") && fail && fail !== "commit") {
          if (fail === "raw") throw "rejected";
          throw new Error("delete rejected");
        }
        return { changes };
      },
    };
    const result = await run(scope);
    if (fail === "commit") throw new Error("commit rejected");
    return result;
  };
  return {
    calls,
    source: {
      schema: "app",
      access: "read-write" as const,
      relations: ["surface_checks", "subnet_burn_history"],
      transaction,
    },
    impact(value: unknown) {
      impact = value;
    },
    changes(value: number) {
      changes = value;
    },
    fail(value: typeof fail) {
      fail = value;
    },
  };
}

test("native retention selection requires a complete explicit capability", () => {
  for (const env of [null, undefined, 1, "", false, {}])
    assert.equal(selectedNativeRetentionStore(env), null);
  const store = createPgRetentionStore(fixture().source);
  assert.equal(
    selectedNativeRetentionStore({ NATIVE_RETENTION_STORE: store }),
    store,
  );
  for (const value of [null, false, {}, { prune: 1 }])
    assert.throws(
      () => selectedNativeRetentionStore({ NATIVE_RETENTION_STORE: value }),
      /incomplete/,
    );
});

test("retention locks complete writable ownership and copies the guarded plans", async () => {
  const f = fixture();
  for (const source of [
    { ...f.source, schema: "jobs" },
    { ...f.source, access: "read" as const },
    { ...f.source, relations: ["surface_checks"] },
  ])
    assert.throws(
      () => createPgRetentionStore(source),
      /complete writable app/,
    );
  const plan = NEON_PRUNE_PLANS.surface_checks!;
  const saved = { ...plan };
  const native = createPgRetentionStore(f.source);
  try {
    plan.retentionMs = MIN_RETENTION_MS - 1;
    assert.throws(() => createPgRetentionStore(f.source), /safe floor/);
    plan.retentionMs = NaN;
    assert.throws(() => createPgRetentionStore(f.source), /safe floor/);
    plan.retentionMs = saved.retentionMs;
    plan.column = "unsafe-column";
    assert.throws(() => createPgRetentionStore(f.source), /identifier/i);
    plan.column = saved.column;
    plan.table = "unsafe-table";
    f.source.relations.push("unsafe-table");
    assert.throws(() => createPgRetentionStore(f.source), /identifier/i);
    const now = Date.UTC(2026, 10, 4);
    assert.deepEqual(await native.prune(now), [
      { table: "surface_checks", deleted: 2 },
      { table: "subnet_burn_history", deleted: 2 },
    ]);
    for (const [index, owner] of [
      saved,
      NEON_PRUNE_PLANS.subnet_burn_history!,
    ].entries()) {
      const [lock, count, deletion] = f.calls.slice(index * 3, index * 3 + 3);
      assert.equal(
        lock!.text,
        `LOCK TABLE app.${owner.table} IN SHARE ROW EXCLUSIVE MODE`,
      );
      assert(count!.text.includes(`${owner.column}<$1`));
      assert.deepEqual(count!.values, [now - owner.retentionMs]);
      assert.equal(
        deletion!.text,
        `DELETE FROM app.${owner.table} WHERE ${owner.column}<$1`,
      );
      assert.deepEqual(deletion!.values, count!.values);
    }
  } finally {
    Object.assign(plan, saved);
  }
  for (const now of [-1, 0.5, Infinity, NaN])
    await assert.rejects(native.prune(now), /timestamp is invalid/);
});

test("retention refuses unreadable or all-stale impacts and counts actual deletion", async () => {
  const f = fixture();
  const native = createPgRetentionStore(f.source);
  for (const impact of [
    null,
    { doomed: "bad", survivors: "1" },
    { doomed: -1, survivors: 1 },
    { doomed: 1, survivors: -1 },
    { doomed: 1, survivors: 0.5 },
  ]) {
    f.impact(impact);
    assert(
      (await native.prune(0)).every(
        (outcome) => outcome.skipped === "impact unreadable",
      ),
    );
  }
  f.impact({ doomed: "0", survivors: "0" });
  assert(
    (await native.prune(0)).every(
      (outcome) => outcome.deleted === 0 && !outcome.skipped,
    ),
  );
  f.impact({ doomed: "2", survivors: "0" });
  assert(
    (await native.prune(0)).every(
      (outcome) =>
        outcome.skipped ===
        "refused: every one of 2 row(s) is older than the cutoff",
    ),
  );
  f.impact({ doomed: "2", survivors: "1" });
  f.changes(1);
  assert((await native.prune(0)).every((outcome) => outcome.deleted === 1));
  f.changes(-1);
  assert(
    (await native.prune(0)).every(
      (outcome) =>
        outcome.skipped ===
        "delete not acknowledged: Invalid native retention deletion receipt",
    ),
  );
  f.changes(2);
  for (const [failure, message] of [
    ["impact", "impact unreadable"],
    ["delete", "delete not acknowledged: delete rejected"],
    ["raw", "delete not acknowledged: rejected"],
    ["commit", "delete not acknowledged: commit rejected"],
  ] as const) {
    f.fail(failure);
    assert(
      (await native.prune(0)).every((outcome) => outcome.skipped === message),
    );
  }
});

test("the prune lane selects native storage and preserves health verdicts", async () => {
  const writes: unknown[][] = [];
  const env = {
    NATIVE_RETENTION_STORE: {
      async prune(at: number) {
        assert.equal(at, 42);
        return [{ table: "surface_checks", deleted: 2 }];
      },
    },
    D1_STATE_TABLES: "surface_checks,subnet_burn_history",
    D1_STATE: {
      prepare() {
        throw new Error("legacy selected");
      },
      async batch() {
        throw new Error("legacy selected");
      },
    },
  };
  const deps = {
    now: () => 42,
    laneHealthDb: {
      async query() {
        return [];
      },
      async run(_text: string, values?: unknown[]) {
        writes.push(values ?? []);
        return { changes: 1 };
      },
    },
  };
  assert.deepEqual(await runNeonPrune(env, { waitUntil() {} }, deps), {
    attempted: true,
    outcomes: [{ table: "surface_checks", deleted: 2 }],
  });
  assert(writes[0]!.includes("ok"));
  env.NATIVE_RETENTION_STORE.prune = async () => [
    { table: "surface_checks", deleted: 0, skipped: "impact unreadable" },
  ];
  vi.spyOn(Date, "now").mockReturnValue(42);
  await runNeonPrune(
    env,
    { waitUntil() {} },
    { laneHealthDb: deps.laneHealthDb },
  );
  assert(writes.some((values) => values.includes("stale")));
});
