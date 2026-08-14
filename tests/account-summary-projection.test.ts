// The account summary card's aggregate leg, read from a sharded projection
// (#11131).
//
// This reader cannot make the route wrong by declining -- every null falls back
// to the lakehouse query the route ran before -- so the dangerous failures are
// the other direction: reading a HALF-PUBLISHED generation, or accepting a
// payload it should have refused.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { ACCOUNT_EVENT_SUMMARY_SCAN_CAP } from "../src/account-events.ts";
import {
  ACCOUNT_SUMMARY_MAX_AGE_MS,
  ACCOUNT_SUMMARY_POINTER_KEY,
  ACCOUNT_SUMMARY_SCHEMA_VERSION,
  accountShard,
  accountSummaryShardKey,
  loadAccountSummaryProjection,
} from "../src/account-summary-projection.ts";

const HOT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const COLD = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const GEN = "20260814T100000Z";
const SHARDS = 16384;

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

function pointer(over: Record<string, unknown> = {}) {
  return {
    schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION,
    generation: GEN,
    shard_count: SHARDS,
    generated_at: "2026-08-14T10:00:00Z",
    account_count: 812856,
    ...over,
  };
}

function published(accounts: Record<string, unknown>, over = {}) {
  return {
    [ACCOUNT_SUMMARY_POINTER_KEY]: pointer(over),
    [accountSummaryShardKey(HOT, SHARDS, GEN)]: {
      schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION,
      generated_at: "2026-08-14T10:00:00Z",
      shard_count: SHARDS,
      accounts,
    },
  };
}

const FRESH = { now: () => Date.parse("2026-08-14T11:00:00Z") };

describe("accountShard", () => {
  test("MATCHES THE PRODUCER BYTE FOR BYTE", () => {
    // Pinned identically in metagraphed-infra's test_account_summary_r2.py.
    // Two implementations of FNV-1a agree on every ASCII address and part
    // company on 32-bit overflow -- javascript's numbers are doubles, python's
    // ints do not overflow at all -- and that divergence is invisible to either
    // side's tests alone.
    assert.equal(accountShard(HOT, 256), 205);
    assert.equal(accountShard(COLD, 256), 70);
    assert.equal(accountShard("", 256), 197);
    assert.equal(accountShard(HOT, SHARDS), 11213);
  });

  test("the wrap is forced, not incidental", () => {
    const long = "5" + "z".repeat(200);
    assert.ok(accountShard(long, SHARDS) >= 0);
    assert.ok(accountShard(long, SHARDS) < SHARDS);
  });

  test("the key is scoped to a generation", () => {
    assert.equal(
      accountSummaryShardKey(HOT, SHARDS, GEN),
      `metagraph/projections/account-summary/${GEN}/11213.json`,
    );
  });
});

describe("loadAccountSummaryProjection", () => {
  test("reads the pointer, THEN the account's shard in that generation", async () => {
    const store = archive(published({ [HOT]: [group()] }));
    const groups = await loadAccountSummaryProjection(store.env, HOT, FRESH);
    assert.deepEqual(store.asked, [
      ACCOUNT_SUMMARY_POINTER_KEY,
      accountSummaryShardKey(HOT, SHARDS, GEN),
    ]);
    assert.deepEqual(groups, [
      {
        kind: "AxonServed",
        netuid: 7,
        count: 3,
        fb: 10,
        lb: 90,
        fo: 1000,
        lo: 9000,
      },
    ]);
  });

  test("THE FAN-OUT COMES FROM THE POINTER, not a compiled constant", async () => {
    // The number lives in two repositories and nothing can diff a python
    // function against a typescript one, so the producer owns it and this
    // learns it. A different fan-out is simply followed.
    const store = archive({
      [ACCOUNT_SUMMARY_POINTER_KEY]: pointer({ shard_count: 64 }),
      [accountSummaryShardKey(HOT, 64, GEN)]: {
        schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION,
        accounts: { [HOT]: [group()] },
      },
    });
    const groups = await loadAccountSummaryProjection(store.env, HOT, FRESH);
    assert.equal(groups!.length, 1);
  });

  test("A HALF-PUBLISHED GENERATION IS INVISIBLE", async () => {
    // The property the pointer exists for. Shards for a new generation are on
    // R2 but the pointer still names the old one, so the reader keeps serving
    // a COHERENT set rather than a mixture of two.
    const store = archive({
      ...published({ [HOT]: [group({ count: 1 })] }),
      // A newer, partially written generation nothing points at yet.
      [`metagraph/projections/account-summary/20260815T100000Z/11213.json`]: {
        schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION,
        accounts: { [HOT]: [group({ count: 999 })] },
      },
    });
    const groups = await loadAccountSummaryProjection(store.env, HOT, FRESH);
    assert.equal(groups![0]!.count, 1, "must read the pointed-at generation");
  });

  test("no pointer means no answer", async () => {
    // Including the case where a shard happens to exist: without a pointer
    // there is no generation that is known-complete.
    const store = archive({
      [accountSummaryShardKey(HOT, SHARDS, GEN)]: {
        schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION,
        accounts: { [HOT]: [group()] },
      },
    });
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
    assert.equal(store.asked.length, 1, "and it does not go looking");
  });

  test("a stale generation is refused", async () => {
    // The only way this reader could publish something WRONG rather than
    // merely fall back. The card's generated_at comes from the LIVE feed leg,
    // so a frozen aggregate beside a fresh feed looks entirely healthy.
    const store = archive(published({ [HOT]: [group()] }));
    const written = Date.parse("2026-08-14T10:00:00Z");
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, {
        now: () => written + ACCOUNT_SUMMARY_MAX_AGE_MS + 1,
      }),
      null,
    );
    assert.ok(
      await loadAccountSummaryProjection(store.env, HOT, {
        now: () => written + ACCOUNT_SUMMARY_MAX_AGE_MS - 1,
      }),
    );
  });

  test("the bound clears two missed producer runs", () => {
    assert.ok(ACCOUNT_SUMMARY_MAX_AGE_MS > 2 * 20 * 60 * 60 * 1000);
  });

  test("an unreadable generated_at is refused; unknown age is not young", async () => {
    for (const generated_at of [undefined, "", "nope", 12345]) {
      const store = archive({
        ...published({ [HOT]: [group()] }),
        [ACCOUNT_SUMMARY_POINTER_KEY]: pointer({ generated_at }),
      });
      assert.equal(
        await loadAccountSummaryProjection(store.env, HOT, FRESH),
        null,
        String(generated_at),
      );
    }
  });

  test("a schema it does not understand is refused", async () => {
    const store = archive({
      ...published({ [HOT]: [group()] }),
      [ACCOUNT_SUMMARY_POINTER_KEY]: pointer({
        schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION + 1,
      }),
    });
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
  });

  test("a malformed pointer is refused", async () => {
    for (const over of [
      { shard_count: 0 },
      { shard_count: "many" },
      { generation: "" },
      { generation: 7 },
    ]) {
      const store = archive({
        ...published({ [HOT]: [group()] }),
        [ACCOUNT_SUMMARY_POINTER_KEY]: pointer(over),
      });
      assert.equal(
        await loadAccountSummaryProjection(store.env, HOT, FRESH),
        null,
        JSON.stringify(over),
      );
    }
  });

  test("no binding, a throwing bucket, and an unseen account all decline", async () => {
    assert.equal(
      await loadAccountSummaryProjection({} as never, HOT, FRESH),
      null,
    );
    assert.equal(await loadAccountSummaryProjection(null, HOT, FRESH), null);
    assert.equal(
      await loadAccountSummaryProjection(
        archive({}, { throws: true }).env,
        HOT,
        FRESH,
      ),
      null,
    );
    const store = archive(published({ [COLD]: [group()] }));
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
  });

  test("a malformed entry is skipped and absent fields degrade to null", async () => {
    const store = archive(published({ [HOT]: [null, "text", { count: 2 }] }));
    const groups = await loadAccountSummaryProjection(store.env, HOT, FRESH);
    assert.deepEqual(groups, [
      {
        kind: null,
        netuid: null,
        count: 2,
        fb: null,
        lb: null,
        fo: null,
        lo: null,
      },
    ]);
  });

  test("a non-object body is refused, at the pointer and at the shard", async () => {
    // `readJson` returns null for anything that parses but is not an object --
    // a bare string or number would otherwise be indexed into and read as an
    // empty payload rather than a refusal.
    const badPointer = archive({ [ACCOUNT_SUMMARY_POINTER_KEY]: "nope" });
    assert.equal(
      await loadAccountSummaryProjection(badPointer.env, HOT, FRESH),
      null,
      "pointer",
    );
    const badShard = archive({
      [ACCOUNT_SUMMARY_POINTER_KEY]: pointer(),
      [accountSummaryShardKey(HOT, SHARDS, GEN)]: 42,
    });
    assert.equal(
      await loadAccountSummaryProjection(badShard.env, HOT, FRESH),
      null,
      "shard",
    );
  });

  test("a shard with no accounts map, or a non-array account, declines", async () => {
    // Both mean "the object exists but says nothing about this account", which
    // is a decline rather than an empty answer.
    for (const accounts of [
      undefined,
      "nope",
      { [HOT]: { not: "an array" } },
    ]) {
      const store = archive({
        [ACCOUNT_SUMMARY_POINTER_KEY]: pointer(),
        [accountSummaryShardKey(HOT, SHARDS, GEN)]: {
          schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION,
          accounts,
        },
      });
      assert.equal(
        await loadAccountSummaryProjection(store.env, HOT, FRESH),
        null,
        JSON.stringify(accounts),
      );
    }
  });

  test("AN ACCOUNT OVER THE CAP DECLINES -- the two tiers would disagree", async () => {
    // The defect this exists for, caught in production before it was trusted.
    // The projection aggregates an account's WHOLE history; the live path
    // aggregates the newest CAP events. `event_count` clamps to CAP either way,
    // so the difference hides there -- but `event_kinds` and `subnet_count`
    // silently widen to lifetime.
    //
    // Measured on a real account: live reported 4 kinds across 2 subnets, the
    // projection 10 across 3. Same route, different answer by tier.
    const over = [
      group({
        kind: "AxonServed",
        netuid: 7,
        count: ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
      }),
      group({ kind: "Transfer", netuid: null, count: 1 }),
    ];
    const store = archive(published({ [HOT]: over }));
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
  });

  test("an account EXACTLY at the cap is still answered", async () => {
    // At the cap the two windows are the same set, so the answers agree -- an
    // off-by-one here would drop the busiest accounts the tier CAN serve.
    const atCap = [group({ count: ACCOUNT_EVENT_SUMMARY_SCAN_CAP })];
    const store = archive(published({ [HOT]: atCap }));
    const groups = await loadAccountSummaryProjection(store.env, HOT, FRESH);
    assert.equal(groups!.length, 1);
  });

  test("an account present with no usable groups declines", async () => {
    const store = archive(published({ [HOT]: [] }));
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
  });
});
