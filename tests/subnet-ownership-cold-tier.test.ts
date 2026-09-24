import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { nativeOwnershipEnv } from "./helpers/native-ownership-env.ts";
import {
  fetchOwnershipChangeRows,
  loadAccountEntitiesColdTier,
  loadSubnetOwnershipHistoryColdTier,
  loadSubnetOwnerObservations,
} from "../src/subnet-ownership-cold-tier.ts";

const OLD_COLDKEY_BYTES = [
  [
    230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117, 251,
    19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175, 143, 88,
  ],
];
const NEW_COLDKEY_BYTES = [
  [
    109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ],
];
const NEW_COLDKEY_SS58 = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";

function ownershipRow(overrides: Record<string, unknown> = {}) {
  return {
    pallet: "SubtensorModule",
    method: "SubnetOwnerChanged",
    block_number: 8_587_754,
    observed_at: 1_783_600_000_000,
    // A JSON STRING, because that is what `chain_events.args` is in the
    // catalog -- the object form is the driver shape this tier RESTORES it to
    // (see the test below), never what R2 SQL answers. The read validates
    // against the catalog now, so the object form is a row the lakehouse
    // cannot emit.
    args: JSON.stringify({
      netuid: 7,
      old_coldkey: OLD_COLDKEY_BYTES,
      new_coldkey: NEW_COLDKEY_BYTES,
    }),
    ...overrides,
  };
}

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("SQL HTTP is retired");
    }),
  ),
);
afterEach(() => {
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  vi.unstubAllGlobals();
});

test("native ownership cards decode both string and parsed event arguments", async () => {
  for (const row of [
    ownershipRow(),
    ownershipRow({ args: JSON.parse(ownershipRow().args) }),
  ]) {
    const f = nativeOwnershipEnv([row]);
    const data = await loadAccountEntitiesColdTier(f.env, NEW_COLDKEY_SS58);
    assert.equal(data?.ownership_tie_count, 1);
    assert.equal(data?.ownership_ties[0].role, "gained_ownership");
    assert.equal(data?.ownership_ties[0].netuid, 7);
    assert.equal(data?.labels.length, 0);
    assert.equal(
      f.keys[0],
      "metagraph/native-projections/v1/mainnet/current.json",
    );
    assert.ok(f.keys[1]?.endsWith("/chain-ownership.json"));
  }
});
test("the lost-owner side uses the same decoder", async () => {
  const f = nativeOwnershipEnv([
    ownershipRow({
      args: JSON.stringify({
        netuid: 18,
        old_coldkey: NEW_COLDKEY_BYTES,
        new_coldkey: OLD_COLDKEY_BYTES,
      }),
    }),
  ]);
  const data = await loadAccountEntitiesColdTier(f.env, NEW_COLDKEY_SS58);
  assert.equal(data?.ownership_ties[0].role, "lost_ownership");
  assert.equal(data?.ownership_ties[0].netuid, 18);
});
test("absent, broken and malformed native projections decline even with a legacy token", async () => {
  for (const env of [
    undefined,
    { NATIVE_PROJECTIONS: "enabled", NATIVE_HISTORY_FIXTURE: "legacy" },
    nativeOwnershipEnv(null).env,
    nativeOwnershipEnv([ownershipRow({ args: "{not json" })]).env,
    {
      METAGRAPH_ARCHIVE: {
        get: async () => {
          throw Error("unavailable");
        },
      },
    },
  ]) {
    assert.equal(
      await loadAccountEntitiesColdTier(env as never, NEW_COLDKEY_SS58),
      null,
    );
  }
});
test("a complete empty stream is measured absence", async () => {
  const f = nativeOwnershipEnv([]);
  assert.equal(
    (await loadAccountEntitiesColdTier(f.env, NEW_COLDKEY_SS58))
      ?.ownership_tie_count,
    0,
  );
  assert.equal((await loadSubnetOwnershipHistoryColdTier(f.env, 7))?.count, 0);
});
test("subnet history narrows the shared event stream without discarding other-subnet evidence", async () => {
  const f = nativeOwnershipEnv([
    ownershipRow(),
    ownershipRow({
      block_number: 8600000,
      args: JSON.stringify({
        netuid: 18,
        old_coldkey: OLD_COLDKEY_BYTES,
        new_coldkey: NEW_COLDKEY_BYTES,
      }),
    }),
  ]);
  const data = await loadSubnetOwnershipHistoryColdTier(f.env, 7);
  assert.equal(data?.netuid, 7);
  assert.equal(data?.count, 1);
  assert.equal(
    (data?.ownership_changes as Array<Record<string, unknown>>)[0].netuid,
    7,
  );
  assert.equal(data?.event_method, "SubnetOwnerChanged");
  assert.equal((await loadSubnetOwnershipHistoryColdTier(f.env, 19))?.count, 0);
});
test("either missing source declines the entire ownership history", async () => {
  for (const f of [
    nativeOwnershipEnv(null, []),
    nativeOwnershipEnv([], null),
  ]) {
    assert.equal(await loadSubnetOwnershipHistoryColdTier(f.env, 7), null);
    assert.ok(f.keys.some((key) => key.endsWith("/chain-ownership.json")));
    assert.ok(
      f.keys.includes(
        "metagraph/state-archive/v1/subnet_ownership_history/current.json",
      ),
    );
  }
});
test("owner observations preserve chronological order, subnet filtering and empty slices", async () => {
  const f = nativeOwnershipEnv(
    [],
    [
      { netuid: 7, owner_coldkey: "second", captured_at: 2 },
      { netuid: 8, owner_coldkey: "other", captured_at: 0 },
      { netuid: 7, owner_coldkey: "first", captured_at: 1 },
    ],
  );
  assert.deepEqual(await loadSubnetOwnerObservations(f.env, 7), [
    { owner_coldkey: "first", captured_at: 1 },
    { owner_coldkey: "second", captured_at: 2 },
  ]);
  assert.deepEqual(await loadSubnetOwnerObservations(f.env, 999), []);
  const pointer =
    "metagraph/state-archive/v1/subnet_ownership_history/current.json";
  f.objects.set(pointer, { raw: "{}", etag: "broken", size: 2 });
  assert.equal(await loadSubnetOwnerObservations(f.env, 7), null);
});
test("invalid subnet identifiers stop before any storage read", async () => {
  const f = nativeOwnershipEnv([]);
  for (const value of [null, "seven", -3])
    assert.equal(await loadSubnetOwnershipHistoryColdTier(f.env, value), null);
  assert.equal(await loadSubnetOwnerObservations(f.env, -1), null);
  assert.deepEqual(f.keys, []);
});
test("the portable producer retains its explicitly injected native query and argument restoration", async () => {
  for (const network of [undefined, "testnet"] as const) {
    const queries: string[] = [];
    const rows = await fetchOwnershipChangeRows(
      {},
      network,
      async (_env, sql) => {
        queries.push(sql);
        return [ownershipRow(), ownershipRow({ args: { netuid: 18 } })];
      },
    );
    assert.equal(queries.length, 1);
    assert.match(
      queries[0],
      new RegExp(
        `FROM ${network === "testnet" ? "chain_testnet" : "chain"}\\.chain_events`,
      ),
    );
    assert.match(
      queries[0],
      /pallet = 'SubtensorModule' AND method = 'SubnetOwnerChanged' ORDER BY block_number ASC/,
    );
    assert.ok(!queries[0].includes(NEW_COLDKEY_SS58));
    assert.deepEqual(rows?.[0].args, JSON.parse(ownershipRow().args));
    assert.deepEqual(rows?.[1].args, { netuid: 18 });
  }
  assert.equal(
    await fetchOwnershipChangeRows({}, undefined, async () => null),
    null,
  );
  assert.equal(
    await fetchOwnershipChangeRows({}, undefined, async () => [
      ownershipRow({ args: "bad" }),
    ]),
    null,
  );
});
