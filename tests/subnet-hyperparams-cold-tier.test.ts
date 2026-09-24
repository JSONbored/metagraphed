import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  loadSubnetHyperparamsColdTier,
  loadSubnetHyperparamsHistoryColdTier,
} from "../src/subnet-hyperparams-cold-tier.ts";
import { readD1Metadata } from "../src/d1-metadata-read.ts";
import { readStateArchiveRows } from "../src/state-archive-read.ts";
vi.mock("../src/d1-metadata-read.ts", () => ({ readD1Metadata: vi.fn() }));
vi.mock("../src/state-archive-read.ts", () => ({
  readStateArchiveRows: vi.fn(),
}));
const env = {
  NATIVE_PROJECTIONS: "enabled",
  NATIVE_HISTORY_FIXTURE: "retired-token-must-not-be-used",
};
const latest = vi.mocked(readD1Metadata),
  archive = vi.mocked(readStateArchiveRows);
const row = (id: number, observed_at = 1700000000000 + id) => ({
  netuid: 3,
  id,
  observed_at,
  block_number: 8600000 + id,
  tempo: 360,
  hyperparams_hash: `hash-${id}`,
});
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("Warehouse access is retired");
    }),
  );
});
afterEach(() => {
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
test("current parameters bind netuid and retain the canonical column set and absence", async () => {
  latest.mockResolvedValue([
    {
      tempo: 360,
      registration_allowed: true,
      block_number: 8700000,
      captured_at: 1700000000000,
    },
  ]);
  const data = await loadSubnetHyperparamsColdTier(env, 12);
  assert.equal(data!.netuid, 12);
  assert.equal((data!.hyperparameters as Record<string, unknown>).tempo, 360);
  const call = latest.mock.calls[0]!;
  assert.deepEqual(call.slice(0, 2), [env, "subnet_hyperparams"]);
  assert.match(call[2], /WHERE netuid = \? LIMIT 1/);
  for (const column of [
    "kappa_ratio",
    "min_childkey_take_ratio",
    "captured_at",
  ])
    assert.ok(call[2].includes(column));
  assert.deepEqual(call[3], [12]);
  latest.mockResolvedValue([]);
  assert.equal(
    (await loadSubnetHyperparamsColdTier(env, "7"))!.hyperparameters,
    null,
  );
});
test("missing and failed owners decline without using a surviving SQL credential", async () => {
  for (const value of [undefined, null]) {
    latest.mockResolvedValue(value);
    archive.mockResolvedValue(value);
    assert.equal(await loadSubnetHyperparamsColdTier(env, 3), null);
    assert.equal(
      await loadSubnetHyperparamsHistoryColdTier(env, 3, { limit: 5 }),
      null,
    );
  }
});
test("timeline filters netuid and orders timestamp ties before applying its cursor", async () => {
  archive.mockResolvedValue([
    row(8, 1700000000009),
    row(7),
    { ...row(10), netuid: 4 },
    row(9),
  ]);
  const data = await loadSubnetHyperparamsHistoryColdTier(env, 3, { limit: 2 });
  assert.deepEqual(
    (data!.entries as Record<string, unknown>[]).map((x) => x.hyperparams_hash),
    ["hash-9", "hash-8"],
  );
  assert.equal(data!.next_cursor, "1700000000009.8");
  const page = await loadSubnetHyperparamsHistoryColdTier(env, 3, {
    limit: 2,
    offset: 7,
    cursor: "1700000000009.9",
  });
  assert.deepEqual(
    (page!.entries as Record<string, unknown>[]).map((x) => x.hyperparams_hash),
    ["hash-8", "hash-7"],
  );
  assert.equal(page!.next_cursor, "1700000000007.7");
});
test("malformed cursors use offset; short and deep native pages preserve absence", async () => {
  archive.mockResolvedValue([row(7), row(9), row(8)]);
  const data = await loadSubnetHyperparamsHistoryColdTier(env, 3, {
    limit: 5,
    offset: 2,
    cursor: "junk",
  });
  assert.deepEqual(
    (data!.entries as Record<string, unknown>[]).map((x) => x.hyperparams_hash),
    ["hash-7"],
  );
  assert.equal(data!.next_cursor, null);
  assert.deepEqual(
    (await loadSubnetHyperparamsHistoryColdTier(env, 3, {
      limit: 5,
      offset: 100000,
    }))!.entries,
    [],
  );
});
test("invalid netuid or pagination declines before reading a store", async () => {
  assert.equal(await loadSubnetHyperparamsColdTier(env, "3; DROP"), null);
  for (const [netuid, page] of [
    ["bad", { limit: 5 }],
    [3, { limit: "abc" }],
    [3, { limit: 5, offset: -1 }],
    [3, { limit: 0 }],
  ] as const)
    assert.equal(
      await loadSubnetHyperparamsHistoryColdTier(env, netuid, page as never),
      null,
    );
  assert.equal(latest.mock.calls.length, 0);
  assert.equal(archive.mock.calls.length, 0);
});
test("nullable retained timestamps do not invent a cursor", async () => {
  archive.mockResolvedValue([{ ...row(3), observed_at: null }]);
  assert.equal(
    (await loadSubnetHyperparamsHistoryColdTier(env, 3, { limit: 1 }))!
      .next_cursor,
    null,
  );
});
