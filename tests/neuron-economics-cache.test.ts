import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { readRevisionedNeuronEconomics } from "../src/neuron-economics-cache.ts";
import { resetModuleState } from "../src/module-state-registry.ts";

beforeEach(() => resetModuleState());
afterEach(() => vi.restoreAllMocks());

function fixture() {
  let revision: number | null = 1;
  let fail = false;
  let checks = 0;
  let loads = 0;
  const binding = {};
  const store = {
    async first<T>() {
      checks++;
      if (fail) throw new Error("Revision unavailable");
      return revision === null ? null : ({ revision } as T);
    },
  };
  return {
    binding,
    store,
    setRevision(value: number | null) {
      revision = value;
    },
    failRevision() {
      fail = true;
    },
    checks: () => checks,
    loads: () => loads,
    async load() {
      loads++;
      return [{ uid: 0, stake_tao: revision, hotkey: null }];
    },
  };
}

test("every cache hit checks the current revision and cannot mutate another caller's rows", async () => {
  const f = fixture();
  const first = await readRevisionedNeuronEconomics(f.store, f.binding, f.load);
  first[0].stake_tao = 999;
  first.push({ uid: 99 });
  const again = await readRevisionedNeuronEconomics(f.store, f.binding, f.load);
  assert.deepEqual(again, [{ uid: 0, stake_tao: 1, hotkey: null }]);
  assert.equal(f.loads(), 1);
  assert.equal(f.checks(), 2);
  f.setRevision(2);
  assert.equal(
    (await readRevisionedNeuronEconomics(f.store, f.binding, f.load))[0]
      .stake_tao,
    2,
  );
  assert.equal(f.loads(), 2);
  await readRevisionedNeuronEconomics(f.store, {}, f.load);
  assert.equal(f.loads(), 3);
});

test("simultaneous requests share one load and expiration releases the old snapshot", async () => {
  const f = fixture();
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const rows = await Promise.all(
    Array.from({ length: 3 }, () =>
      readRevisionedNeuronEconomics(f.store, f.binding, f.load),
    ),
  );
  assert.deepEqual(rows[0], rows[1]);
  assert.notEqual(rows[0][0], rows[1][0]);
  assert.equal(f.loads(), 1);
  now += 30_000;
  await readRevisionedNeuronEconomics(f.store, f.binding, f.load);
  assert.equal(f.loads(), 2);
  resetModuleState();
  await readRevisionedNeuronEconomics(f.store, f.binding, f.load);
  assert.equal(f.loads(), 3);
});

test("missing, invalid and failed revision reads use a fresh load instead of cached data", async () => {
  const f = fixture();
  await readRevisionedNeuronEconomics(f.store, f.binding, f.load);
  for (const revision of [null, 1.5, -1]) {
    f.setRevision(revision);
    for (let n = 0; n < 2; n++)
      await readRevisionedNeuronEconomics(f.store, f.binding, f.load);
  }
  f.failRevision();
  await readRevisionedNeuronEconomics(f.store, f.binding, f.load);
  assert.equal(f.loads(), 8);
});

test("a failed data read is retried and an obsolete failure cannot evict a newer revision", async () => {
  const f = fixture();
  await assert.rejects(
    readRevisionedNeuronEconomics(f.store, f.binding, async () => {
      throw new Error("Data unavailable");
    }),
  );
  await readRevisionedNeuronEconomics(f.store, f.binding, f.load);
  assert.equal(f.loads(), 1);
  f.setRevision(2);
  let reject!: (error: Error) => void;
  const pending = readRevisionedNeuronEconomics(
    f.store,
    f.binding,
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  // Wait until the earlier request has begun its data load.
  while (!reject) await Promise.resolve();
  f.setRevision(3);
  await readRevisionedNeuronEconomics(f.store, f.binding, f.load);
  reject(new Error("Old request failed"));
  await assert.rejects(pending);
  await readRevisionedNeuronEconomics(f.store, f.binding, f.load);
  assert.equal(f.loads(), 2);
});

test("large valid answers are returned intact but are not retained", async () => {
  const f = fixture();
  for (const rows of [
    Array.from({ length: 50_001 }, (_, uid) => ({ uid })),
    [{ hotkey: "x".repeat(8 * 1024 * 1024) }],
  ]) {
    let loads = 0;
    const read = async () => {
      loads++;
      return rows;
    };
    for (let n = 0; n < 2; n++)
      assert.deepEqual(
        await readRevisionedNeuronEconomics(f.store, f.binding, read),
        rows,
      );
    assert.equal(loads, 2);
  }
});
