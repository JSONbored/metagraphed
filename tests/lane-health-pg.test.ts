import assert from "node:assert/strict";
import { test } from "vitest";
import { createPgLaneHealth } from "../src/lane-health-pg.ts";
import { laneHealthStore } from "../src/lane-health-store.ts";
import { recordLaneVerdict } from "../src/lane-health.ts";
import type { PgTransaction } from "../src/pg-pool.ts";

function fixture(ready: boolean | null = true) {
  const calls: { text: string; values: unknown[] }[] = [];
  let transactions = 0;
  let rows: Record<string, unknown>[] = [];
  let failure: Error | undefined;
  const tx: PgTransaction = {
    async first<Row>(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return (ready === null ? null : { ready }) as Row | null;
    },
    async query<Row>(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (failure) throw failure;
      return rows as Row[];
    },
    async run(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (failure) throw failure;
      return { changes: 2 };
    },
  };
  const store = createPgLaneHealth({
    async transaction<T>(callback: (transaction: PgTransaction) => Promise<T>) {
      transactions += 1;
      return callback(tx);
    },
  });
  return {
    store,
    calls,
    transactions: () => transactions,
    rows(value: typeof rows) {
      rows = value;
    },
    fail(error: Error) {
      failure = error;
    },
  };
}

test("explicit native lane capability keeps one owner and preserves explicit test injection", () => {
  const native = fixture().store;
  const injected = fixture().store;
  const env = {
    LANE_HEALTH_STORE: native,
    HYPERDRIVE: { connectionString: "postgresql://example/db" },
  };
  assert.equal(laneHealthStore(env), native);
  assert.equal(laneHealthStore(env, injected), injected);
  assert.equal(laneHealthStore({ LANE_HEALTH_STORE: undefined }), undefined);
  assert.equal(laneHealthStore(42), undefined);
});

test("native statements select app only within their checked transaction", async () => {
  const f = fixture();
  f.rows([{ lane: "blocks", checked_at: 12 }]);
  assert.deepEqual(
    await f.store.query(
      "SELECT lane,checked_at FROM lane_health WHERE checked_at=?",
      [12],
    ),
    [{ lane: "blocks", checked_at: 12 }],
  );
  assert.equal(f.transactions(), 1);
  assert.equal(
    f.calls[0].text,
    "SET LOCAL search_path = app, pg_catalog, pg_temp",
  );
  assert.match(f.calls[1].text, /COUNT\(\*\) = 4/);
  assert.deepEqual(f.calls.at(-1)?.values, [12]);
  assert.deepEqual(await f.store.run("DELETE FROM lane_health"), {
    changes: 2,
  });
  assert.equal(f.store.historyRowId, "source_row_id");
  assert.equal("close" in f.store, false);
});

test("unactivated or absent projections refuse reads and writes", async () => {
  for (const readiness of [false, null]) {
    const f = fixture(readiness);
    assert.equal(await f.store.retentionReady!(), false);
    await assert.rejects(
      f.store.query("SELECT * FROM lane_health"),
      /not activated/,
    );
    await assert.rejects(
      f.store.run("INSERT INTO lane_health VALUES (?)", [1]),
      /not activated/,
    );
    assert.equal(
      f.calls.some(
        (call) =>
          call.text.startsWith("SELECT *") || call.text.startsWith("INSERT"),
      ),
      false,
    );
  }
  assert.equal(await fixture().store.retentionReady!(), true);
});

test("native projections retain bounded samples, parameters and numeric public gaps", async () => {
  const f = fixture();
  f.rows([{ lane: "blocks", max_gap: 100, n: 3 }]);
  assert.deepEqual(await f.store.latest!(), [
    { lane: "blocks", max_gap: 100, n: 3 },
  ]);
  assert.match(f.calls.at(-1)!.text, /FROM lane_health_current/);
  await f.store.maxGaps!(10, 4);
  assert.match(f.calls.at(-1)!.text, /max_gap::double precision/);
  assert.deepEqual(f.calls.at(-1)!.values, [10, 4, 10]);
  await f.store.verdictRuns!("stale");
  assert.match(f.calls.at(-1)!.text, /WHERE c.verdict = \?/);
  assert.deepEqual(f.calls.at(-1)!.values, ["stale"]);
});

test("ordinary verdict confirmations and retention use the native physical identity", async () => {
  const f = fixture();
  const record = {
    lane: "blocks",
    verdict: "ok" as const,
    age_ms: null,
    detail: "ready",
    checked_at: 100,
  };
  f.rows([record]);
  assert.equal(
    await recordLaneVerdict(f.store, record, { confirm: true }),
    true,
  );
  assert.match(
    f.calls.find((call) => call.text.startsWith("INSERT"))!.text,
    /RETURNING lane, verdict/,
  );
  assert.match(
    f.calls.at(-1)!.text,
    /DELETE FROM lane_health WHERE source_row_id IN/,
  );
  assert.equal(f.transactions(), 3);
});

test("native failures retain the original error and never select another destination", async () => {
  const f = fixture();
  const failure = new Error("database unavailable");
  f.fail(failure);
  const selected = laneHealthStore({
    LANE_HEALTH_STORE: f.store,
    HYPERDRIVE: { connectionString: "unused" },
  });
  await assert.rejects(selected!.latest!(), (error) => error === failure);
  assert.equal(
    await recordLaneVerdict(selected, {
      lane: "blocks",
      verdict: "ok",
      age_ms: null,
      detail: null,
      checked_at: 100,
    }),
    false,
  );
});
