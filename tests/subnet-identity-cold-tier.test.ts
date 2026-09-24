import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  loadChainIdentityHistoryColdTier,
  loadSubnetIdentityHistoryColdTier,
} from "../src/subnet-identity-cold-tier.ts";
import {
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "../src/chain-identity-history.ts";
import { readStateArchiveRows } from "../src/state-archive-read.ts";
vi.mock("../src/state-archive-read.ts", () => ({
  readStateArchiveRows: vi.fn(),
}));
const env = {
    NATIVE_PROJECTIONS: "enabled",
    NATIVE_HISTORY_FIXTURE: "retired-token-must-not-be-used",
  },
  archive = vi.mocked(readStateArchiveRows);
const row = (id: number, netuid = 3) => ({
  id,
  netuid,
  block_number: 8600000 + id,
  observed_at: 1700000000000 + id,
  subnet_name: `subnet-${id}`,
  identity_hash: `hash-${id}`,
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
test("subnet timelines filter scope and order timestamp ties by ID", async () => {
  archive.mockResolvedValue([
    row(7),
    { ...row(8), observed_at: 1700000000009 },
    row(10, 4),
    row(9),
  ]);
  const data = await loadSubnetIdentityHistoryColdTier(env, 3, { limit: 2 });
  assert.deepEqual(
    (data!.entries as Record<string, unknown>[]).map((x) => x.identity_hash),
    ["hash-9", "hash-8"],
  );
  assert.equal(data!.next_cursor, "1700000000009.8");
  const page = await loadSubnetIdentityHistoryColdTier(env, 3, {
    limit: 2,
    offset: 7,
    cursor: "1700000000009.9",
  });
  assert.deepEqual(
    (page!.entries as Record<string, unknown>[]).map((x) => x.identity_hash),
    ["hash-8", "hash-7"],
  );
  assert.equal(page!.next_cursor, "1700000000007.7");
});
test("malformed cursors use offset and deep native pages confirm absence", async () => {
  archive.mockResolvedValue([row(8), row(7), row(9)]);
  const data = await loadSubnetIdentityHistoryColdTier(env, 3, {
    limit: 5,
    offset: 2,
    cursor: "junk",
  });
  assert.deepEqual(
    (data!.entries as Record<string, unknown>[]).map((x) => x.identity_hash),
    ["hash-7"],
  );
  assert.equal(data!.next_cursor, null);
  assert.deepEqual(
    (await loadSubnetIdentityHistoryColdTier(env, 3, {
      limit: 5,
      offset: 100000,
    }))!.entries,
    [],
  );
});
test("invalid subnet and paging inputs decline before reading the archive", async () => {
  for (const [netuid, page] of [
    ["3 OR 1=1", { limit: 5 }],
    [3, { limit: "abc" }],
    [3, { limit: 5, offset: -1 }],
    [3, { limit: 0 }],
  ] as const)
    assert.equal(
      await loadSubnetIdentityHistoryColdTier(env, netuid, page as never),
      null,
    );
  for (const limit of ["abc", 0, CHAIN_IDENTITY_HISTORY_LIMIT_MAX + 1])
    assert.equal(await loadChainIdentityHistoryColdTier(env, { limit }), null);
  assert.equal(archive.mock.calls.length, 0);
});
test("missing and failed archives never revive warehouse reads", async () => {
  for (const value of [undefined, null]) {
    archive.mockResolvedValue(value);
    assert.equal(
      await loadSubnetIdentityHistoryColdTier(env, 3, { limit: 5 }),
      null,
    );
    assert.equal(
      await loadChainIdentityHistoryColdTier(env, { limit: 5 }),
      null,
    );
  }
});
test("network feed orders block, netuid and ID independently of observation time", async () => {
  archive.mockResolvedValue([
    row(7, 4),
    { ...row(8, 2), block_number: 8600009 },
    { ...row(9, 2), observed_at: 1 },
    row(6, 1),
  ]);
  const data = await loadChainIdentityHistoryColdTier(env, { limit: 3 });
  assert.deepEqual(
    data!.changes.map((x) => x.identity_hash),
    ["hash-9", "hash-8", "hash-7"],
  );
  assert.equal(data!.count, 3);
  assert.equal(data!.subnet_count, 2);
  archive.mockResolvedValue(
    Array.from({ length: CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT + 1 }, (_, i) =>
      row(i),
    ),
  );
  assert.equal(
    (await loadChainIdentityHistoryColdTier(env))!.count,
    CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  );
});
test("empty histories remain measured empty and nullable timestamps have no cursor", async () => {
  archive.mockResolvedValue([]);
  assert.equal((await loadChainIdentityHistoryColdTier(env))!.count, 0);
  archive.mockResolvedValue([{ ...row(3), observed_at: null }]);
  assert.equal(
    (await loadSubnetIdentityHistoryColdTier(env, 3, { limit: 1 }))!
      .next_cursor,
    null,
  );
});
