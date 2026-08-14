// The account summary card's aggregate leg, read from a sharded projection
// (#11131).
//
// The claims worth pinning are the ones whose failure is SILENT. This reader
// cannot make the route wrong by declining -- every null falls back to the
// lakehouse query the route ran before -- so the dangerous failures are the
// other direction: routing to the wrong object, or accepting a payload it
// should have refused.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ACCOUNT_SUMMARY_SCHEMA_VERSION,
  ACCOUNT_SUMMARY_SHARDS,
  accountShard,
  accountSummaryShardKey,
  loadAccountSummaryProjection,
} from "../src/account-summary-projection.ts";

const HOT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const COLD = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

function group(over: Record<string, unknown> = {}) {
  return {
    kind: "AxonServed",
    netuid: 7,
    count: 3,
    fb: 10,
    lb: 90,
    fo: 1_000,
    lo: 9_000,
    ...over,
  };
}

/** An R2 bucket holding exactly the objects given, keyed as the reader asks. */
function archive(objects: Record<string, unknown>, { throws = false } = {}) {
  const asked: string[] = [];
  return {
    env: {
      METAGRAPH_ARCHIVE: {
        get: async (key: string) => {
          asked.push(key);
          if (throws) throw new Error("r2 down");
          if (!(key in objects)) return null;
          return { json: async () => objects[key] };
        },
      },
    } as never,
    asked,
  };
}

function shardBody(
  accounts: Record<string, unknown>,
  over: Record<string, unknown> = {},
) {
  return {
    schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION,
    generated_at: "2026-08-14T00:00:00Z",
    shard_count: ACCOUNT_SUMMARY_SHARDS,
    account_count: Object.keys(accounts).length,
    accounts,
    ...over,
  };
}

describe("accountShard", () => {
  test("the fan-out is sized from the real payload", () => {
    // This is what the route pays PER REQUEST: one whole shard is fetched to
    // answer for one account. ~601 MB of groups over 16384 shards is ~36 KB a
    // request; over 256 it would have been 2.3 MB.
    assert.equal(ACCOUNT_SUMMARY_SHARDS, 16384);
  });

  test("MATCHES THE PRODUCER AT THE DEFAULT FAN-OUT", () => {
    // Pinned identically in metagraphed-infra's test_account_summary_r2.py.
    assert.equal(accountShard(HOT), 11213);
    assert.equal(accountShard(COLD), 5958);
    assert.equal(accountShard(""), 7621);
  });

  test("MATCHES THE PRODUCER BYTE FOR BYTE", () => {
    // These three values are asserted IDENTICALLY in metagraphed-infra's
    // services/indexer-rs/loader/test_account_summary_r2.py. Two
    // implementations of FNV-1a agree on every ASCII address and part company
    // on 32-bit overflow -- javascript's numbers are doubles, python's ints do
    // not overflow at all -- and that divergence is invisible to either side's
    // tests alone. It would show up only as every lookup missing in production,
    // which reads as "the projection has no data" rather than as a bug.
    assert.equal(accountShard(HOT, 256), 205);
    assert.equal(accountShard(COLD, 256), 70);
    assert.equal(accountShard("", 256), 197);
  });

  test("the wrap is forced, not incidental", () => {
    // A long address is where a `h * 0x01000193` without Math.imul silently
    // loses precision past 2^53 and starts disagreeing with python.
    const long = "5" + "z".repeat(200);
    assert.ok(Number.isInteger(accountShard(long)));
    assert.ok(
      accountShard(long) >= 0 && accountShard(long) < ACCOUNT_SUMMARY_SHARDS,
    );
  });

  test("stays inside the shard count for every fan-out", () => {
    for (const n of [1, 2, 16, 256, 1024]) {
      for (const account of [HOT, COLD, "5A", "z".repeat(64)]) {
        const shard = accountShard(account, n);
        assert.ok(shard >= 0 && shard < n, `${account} -> ${shard} of ${n}`);
      }
    }
  });

  test("the key names the object the producer writes", () => {
    assert.equal(
      accountSummaryShardKey(HOT),
      "metagraph/projections/account-summary/11213.json",
    );
  });
});

describe("loadAccountSummaryProjection", () => {
  test("reads the account's groups from ITS OWN shard", async () => {
    const store = archive({
      [accountSummaryShardKey(HOT)]: shardBody({ [HOT]: [group()] }),
    });
    const groups = await loadAccountSummaryProjection(store.env, HOT);
    assert.deepEqual(store.asked, [
      "metagraph/projections/account-summary/11213.json",
    ]);
    assert.equal(groups!.length, 1);
    assert.deepEqual(groups![0], {
      kind: "AxonServed",
      netuid: 7,
      count: 3,
      fb: 10,
      lb: 90,
      fo: 1_000,
      lo: 9_000,
    });
  });

  test("ONE GET, whatever the account", async () => {
    // The whole point against the 4,374 MB scan it replaces. If this ever grew
    // a second fetch it would still be correct and would have given back most
    // of the win.
    const store = archive({
      [accountSummaryShardKey(HOT)]: shardBody({ [HOT]: [group()] }),
    });
    await loadAccountSummaryProjection(store.env, HOT);
    assert.equal(store.asked.length, 1);
  });

  test("an account the projection has not seen DECLINES", async () => {
    // Not an empty card: the caller reads the lakehouse, which is the only
    // thing that can tell "no events" from "not projected yet".
    const store = archive({
      [accountSummaryShardKey(COLD)]: shardBody({ [HOT]: [group()] }),
    });
    assert.equal(await loadAccountSummaryProjection(store.env, COLD), null);
  });

  test("a missing shard, a bad body and a throwing bucket all decline", async () => {
    assert.equal(
      await loadAccountSummaryProjection(archive({}).env, HOT),
      null,
      "missing object",
    );
    assert.equal(
      await loadAccountSummaryProjection(
        archive({ [accountSummaryShardKey(HOT)]: "not an object" }).env,
        HOT,
      ),
      null,
      "unparseable body",
    );
    assert.equal(
      await loadAccountSummaryProjection(
        archive({}, { throws: true }).env,
        HOT,
      ),
      null,
      "r2 unavailable",
    );
    assert.equal(
      await loadAccountSummaryProjection({} as never, HOT),
      null,
      "no binding",
    );
    assert.equal(
      await loadAccountSummaryProjection(null, HOT),
      null,
      "no env at all",
    );
  });

  test("A SCHEMA IT DOES NOT UNDERSTAND IS REFUSED", async () => {
    // The version exists so a producer can change a field's MEANING without
    // this reader publishing the old interpretation of the new bytes.
    const store = archive({
      [accountSummaryShardKey(HOT)]: shardBody(
        { [HOT]: [group()] },
        { schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION + 1 },
      ),
    });
    assert.equal(await loadAccountSummaryProjection(store.env, HOT), null);
  });

  test("A SHARD WRITTEN FOR A DIFFERENT FAN-OUT IS REFUSED", async () => {
    // The dangerous case, because it does not look like an error: both sides
    // compute a shard number happily and disagree about which object holds an
    // account. Without this the reader would read a real, parseable object,
    // fail to find the account in it, and report "not projected" forever.
    const store = archive({
      [accountSummaryShardKey(HOT)]: shardBody(
        { [HOT]: [group()] },
        { shard_count: 64 },
      ),
    });
    assert.equal(await loadAccountSummaryProjection(store.env, HOT), null);
  });

  test("an account present with NO usable groups declines", async () => {
    const store = archive({
      [accountSummaryShardKey(HOT)]: shardBody({ [HOT]: [] }),
    });
    assert.equal(await loadAccountSummaryProjection(store.env, HOT), null);
  });

  test("a group missing its count contributes zero rather than NaN", async () => {
    // foldSummaryGroups sums these; one NaN would make the whole card's
    // event_count NaN, which serialises to null and reads as "no events".
    const store = archive({
      [accountSummaryShardKey(HOT)]: shardBody({
        [HOT]: [group({ count: undefined })],
      }),
    });
    const groups = await loadAccountSummaryProjection(store.env, HOT);
    assert.equal(groups![0]!.count, 0);
  });

  test("a shard with no accounts map, or a non-array account, declines", async () => {
    // Both are "the object exists but says nothing about this account", which
    // is a decline rather than an empty answer.
    for (const body of [
      shardBody({} as never, { accounts: undefined }),
      shardBody({} as never, { accounts: "nope" }),
      shardBody({ [HOT]: { not: "an array" } as never }),
    ]) {
      const store = archive({ [accountSummaryShardKey(HOT)]: body });
      assert.equal(await loadAccountSummaryProjection(store.env, HOT), null);
    }
  });

  test("a malformed entry is skipped, not published as nulls", async () => {
    // A row that is not an object has no fields to degrade; keeping it would
    // add a phantom group to the card's event_kinds.
    const store = archive({
      [accountSummaryShardKey(HOT)]: shardBody({
        [HOT]: [null, "text", group()],
      }),
    });
    const groups = await loadAccountSummaryProjection(store.env, HOT);
    assert.equal(groups!.length, 1);
  });

  test("every absent field degrades to null rather than undefined", async () => {
    // These feed foldSummaryGroups, which reads them positionally; `undefined`
    // would serialise away and change the card's shape rather than its values.
    const store = archive({
      [accountSummaryShardKey(HOT)]: shardBody({
        [HOT]: [{ count: 2 }],
      }),
    });
    const groups = await loadAccountSummaryProjection(store.env, HOT);
    assert.deepEqual(groups![0], {
      kind: null,
      netuid: null,
      count: 2,
      fb: null,
      lb: null,
      fo: null,
      lo: null,
    });
  });

  test("a shard that does not declare its fan-out is still read", async () => {
    // shard_count is a guard, not a requirement: an older producer that omits
    // it is trusted, because the reader asked for the key IT computed.
    const store = archive({
      [accountSummaryShardKey(HOT)]: shardBody(
        { [HOT]: [group()] },
        { shard_count: undefined },
      ),
    });
    const groups = await loadAccountSummaryProjection(store.env, HOT);
    assert.equal(groups!.length, 1);
  });

  test("a null netuid survives as null", async () => {
    // Transfer carries no netuid, and coercing it to 0 would attribute balance
    // movement to subnet zero.
    const store = archive({
      [accountSummaryShardKey(HOT)]: shardBody({
        [HOT]: [group({ kind: "Transfer", netuid: null })],
      }),
    });
    const groups = await loadAccountSummaryProjection(store.env, HOT);
    assert.equal(groups![0]!.netuid, null);
  });
});
