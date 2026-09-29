import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { readRevisionedChainHolders } from "../src/chain-holders-cache.ts";
import { loadChainHolders } from "../src/chain-holders.ts";
import { resetModuleState } from "../src/module-state-registry.ts";

beforeEach(() => resetModuleState());
afterEach(() => vi.restoreAllMocks());
type Row = Record<string, unknown>;
function fixture() {
  const state = { revisions: [1, 1], fail: false, checks: 0, loads: 0 };
  const binding = {
    batch() {
      throw new Error("Read path must not write");
    },
    prepare(text: string) {
      assert.match(text, /archive_export_revisions/);
      return {
        async all() {
          state.checks++;
          if (state.fail) throw new Error("Revision unavailable");
          return {
            results: state.revisions.map((revision, i) => ({
              table_name: ["hotkey_alpha", "nominator_positions"][i],
              revision,
            })),
            meta: {},
          };
        },
      };
    },
  };
  const env = {
    D1_STATE: binding,
    D1_EXPORT_REVISIONS: "enabled",
    D1_STATE_TABLES: "hotkey_alpha,nominator_positions,hotkey_alpha_passes",
  };
  const read = async (): Promise<Row[]> => {
    state.loads++;
    return [
      { netuid: 7, total_alpha: state.revisions[0], top_holder: "holder" },
    ];
  };
  return { state, env, read };
}

test("every hit checks both producer revisions and the selected complete pass", async () => {
  const f = fixture();
  const first = await readRevisionedChainHolders(f.env, 100, f.read);
  first[0]!.total_alpha = 999;
  first.push({ netuid: 99 });
  const again = await readRevisionedChainHolders(f.env, 100, f.read);
  assert.deepEqual(again, [
    { netuid: 7, total_alpha: 1, top_holder: "holder" },
  ]);
  assert.equal(f.state.loads, 1);
  assert.equal(f.state.checks, 2);
  f.state.revisions[0]++;
  await readRevisionedChainHolders(f.env, 100, f.read);
  f.state.revisions[1]++;
  await readRevisionedChainHolders(f.env, 100, f.read);
  await readRevisionedChainHolders(f.env, 101, f.read);
  assert.equal(f.state.loads, 4);
  const other = fixture();
  await readRevisionedChainHolders(other.env, 101, other.read);
  assert.equal(other.state.loads, 1);
});

test("concurrent callers share a load, with bounded lifetime and module reset", async () => {
  const f = fixture();
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const rows = await Promise.all(
    Array.from({ length: 3 }, () =>
      readRevisionedChainHolders(f.env, 100, f.read),
    ),
  );
  assert.equal(f.state.loads, 1);
  assert.equal(f.state.checks, 3);
  assert.notEqual(rows[0]![0], rows[1]![0]);
  now += 300_000;
  await readRevisionedChainHolders(f.env, 100, f.read);
  assert.equal(f.state.loads, 2);
  resetModuleState();
  await readRevisionedChainHolders(f.env, 100, f.read);
  assert.equal(f.state.loads, 3);
});

test("unavailable or invalid revision evidence never serves a retained snapshot", async () => {
  const f = fixture();
  await readRevisionedChainHolders(f.env, 100, f.read);
  for (const revisions of [[], [1], [NaN, 1], [-1, 1], [1, 0.5]]) {
    f.state.revisions = revisions;
    await readRevisionedChainHolders(f.env, 100, f.read);
  }
  f.state.revisions = [1, 1];
  f.state.fail = true;
  await readRevisionedChainHolders(f.env, 100, f.read);
  f.state.fail = false;
  await readRevisionedChainHolders(f.env, 100, f.read);
  assert.equal(f.state.loads, 8);
});

test("disabled and non-D1 selections bypass revision reads", async () => {
  const f = fixture();
  for (const env of [
    undefined,
    {},
    { ...f.env, D1_EXPORT_REVISIONS: "" },
    { ...f.env, D1_STATE_TABLES: "" },
  ]) {
    await readRevisionedChainHolders(env, 100, f.read);
    await readRevisionedChainHolders(env, 100, f.read);
  }
  assert.equal(f.state.loads, 8);
  assert.equal(f.state.checks, 0);
});

test("failed loads are retried and an older failure cannot evict a newer revision", async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const old = readRevisionedChainHolders(f.env, 100, () => {
    started();
    return new Promise<Row[]>((_resolve, fail) => {
      reject = fail;
    });
  });
  const rejected = assert.rejects(old, /load failed/);
  await pending;
  f.state.revisions[0]++;
  await readRevisionedChainHolders(f.env, 100, f.read);
  reject(new Error("load failed"));
  await rejected;
  await readRevisionedChainHolders(f.env, 100, f.read);
  assert.equal(f.state.loads, 1);
  f.state.revisions[0]++;
  await assert.rejects(
    readRevisionedChainHolders(f.env, 100, async () => {
      throw new Error("current load failed");
    }),
    /current load failed/,
  );
  await readRevisionedChainHolders(f.env, 100, f.read);
  assert.equal(f.state.loads, 2);
});

test("oversized answers remain available without being retained", async () => {
  const f = fixture();
  for (const rows of [
    Array.from({ length: 1001 }, () => ({ netuid: 7 })),
    [{ top_holder: "x".repeat(512 * 1024) }],
  ]) {
    let calls = 0;
    const read = async () => {
      calls++;
      return rows;
    };
    assert.deepEqual(await readRevisionedChainHolders(f.env, 100, read), rows);
    assert.deepEqual(await readRevisionedChainHolders(f.env, 100, read), rows);
    assert.equal(calls, 2);
  }
});

test("the shared loader still requires a proven pool pass on every call", async () => {
  const f = fixture();
  let pass: Record<string, unknown> | null = {
    captured_at: 100,
    expected_rows: 1,
    received_rows: 1,
  };
  let queries = 0;
  const db = {
    async first() {
      return pass;
    },
    async query<T>() {
      queries++;
      return [{ netuid: 7 }] as T[];
    },
  };
  assert.equal((await loadChainHolders(db, f.env)).decline, null);
  assert.equal((await loadChainHolders(db, f.env)).decline, null);
  assert.equal(queries, 1);
  pass = null;
  assert.equal(
    (await loadChainHolders(db, f.env)).decline,
    "pool_totals_unproven",
  );
  assert.equal(queries, 1);
});
