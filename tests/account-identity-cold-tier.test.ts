import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  loadAccountIdentityColdTier,
  loadAccountIdentityHistoryColdTier,
} from "../src/account-identity-cold-tier.ts";
import { readD1Metadata } from "../src/d1-metadata-read.ts";
import { readStateArchiveRows } from "../src/state-archive-read.ts";
vi.mock("../src/d1-metadata-read.ts", () => ({ readD1Metadata: vi.fn() }));
vi.mock("../src/state-archive-read.ts", () => ({
  readStateArchiveRows: vi.fn(),
}));
const ADDR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const env = {
  NATIVE_PROJECTIONS: "enabled",
  NATIVE_HISTORY_FIXTURE: "retired-token-must-not-be-used",
};
const latest = vi.mocked(readD1Metadata),
  archive = vi.mocked(readStateArchiveRows);
const row = (id: number, observed_at = 1700000000000 + id) => ({
  account: ADDR,
  id,
  observed_at,
  name: `name-${id}`,
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
test("current identity binds the account and preserves nullable fields and confirmed absence", async () => {
  latest.mockResolvedValue([
    {
      account: ADDR,
      name: "Validator Co",
      url: null,
      github: null,
      image: null,
      discord: null,
      description: null,
      additional: null,
      captured_at: 1700000000000,
    },
  ]);
  const data = await loadAccountIdentityColdTier(env, ADDR);
  assert.equal(data!.name, "Validator Co");
  assert.equal(data!.has_identity, true);
  assert.deepEqual(latest.mock.calls[0]?.slice(0, 2), [
    env,
    "account_identity",
  ]);
  assert.match(latest.mock.calls[0]![2], /WHERE account = \?/);
  assert.deepEqual(latest.mock.calls[0]![3], [ADDR]);
  latest.mockResolvedValue([]);
  assert.equal(
    (await loadAccountIdentityColdTier(env, ADDR))!.has_identity,
    false,
  );
});
test("missing and failed owners decline even if a retired SQL credential exists", async () => {
  for (const value of [undefined, null]) {
    latest.mockResolvedValue(value);
    archive.mockResolvedValue(value);
    assert.equal(await loadAccountIdentityColdTier(env, ADDR), null);
    assert.equal(
      await loadAccountIdentityHistoryColdTier(env, ADDR, { limit: 5 }),
      null,
    );
  }
});
test("timeline scopes the account, orders timestamp ties by ID and emits the existing cursor", async () => {
  archive.mockResolvedValue([
    row(7),
    row(8, 1700000000009),
    { ...row(10), account: "another" },
    row(9),
  ]);
  const data = await loadAccountIdentityHistoryColdTier(env, ADDR, {
    limit: 2,
  });
  assert.deepEqual(
    data!.entries.map((x) => x.identity_hash),
    ["hash-9", "hash-8"],
  );
  assert.equal(data!.next_cursor, "1700000000009.8");
  archive.mockResolvedValue([row(10), row(9), row(8), row(7)]);
  const page = await loadAccountIdentityHistoryColdTier(env, ADDR, {
    limit: 2,
    offset: 7,
    cursor: "1700000000009.9",
  });
  assert.deepEqual(
    page!.entries.map((x) => x.identity_hash),
    ["hash-8", "hash-7"],
  );
  assert.equal(page!.next_cursor, "1700000000007.7");
});
test("invalid cursors use offset, short and deep native pages prove absence", async () => {
  archive.mockResolvedValue([row(7), row(9), row(8)]);
  const data = await loadAccountIdentityHistoryColdTier(env, ADDR, {
    limit: 5,
    offset: 2,
    cursor: "junk",
  });
  assert.deepEqual(
    data!.entries.map((x) => x.identity_hash),
    ["hash-7"],
  );
  assert.equal(data!.next_cursor, null);
  const empty = await loadAccountIdentityHistoryColdTier(env, ADDR, {
    limit: 5,
    offset: 100000,
  });
  assert.deepEqual(empty!.entries, []);
  assert.equal(empty!.next_cursor, null);
});
test("unusable addresses and pagination decline before touching either store", async () => {
  assert.equal(await loadAccountIdentityColdTier(env, "not-an-address"), null);
  for (const [address, page] of [
    ["bad", { limit: 5 }],
    [ADDR, { limit: "abc" }],
    [ADDR, { limit: 5, offset: -1 }],
    [ADDR, { limit: 0 }],
  ] as const)
    assert.equal(
      await loadAccountIdentityHistoryColdTier(env, address, page as never),
      null,
    );
  assert.equal(latest.mock.calls.length, 0);
  assert.equal(archive.mock.calls.length, 0);
});
test("nullable retained timestamps do not invent a cursor", async () => {
  archive.mockResolvedValue([{ ...row(3), observed_at: null }]);
  assert.equal(
    (await loadAccountIdentityHistoryColdTier(env, ADDR, { limit: 1 }))!
      .next_cursor,
    null,
  );
});
