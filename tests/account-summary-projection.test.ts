// The account summary card's aggregate leg, read from a sharded projection
// (#11131).
//
// This reader cannot make the route wrong by declining -- every null falls back
// to the lakehouse query the route ran before -- so the dangerous failures are
// the other direction: reading a HALF-PUBLISHED generation, or accepting a
// payload it should have refused.
import assert from "node:assert/strict";
import { describe, test, beforeEach } from "vitest";
import { ACCOUNT_EVENT_SUMMARY_SCAN_CAP } from "../src/account-events.ts";
import {
  AccountSummaryPointerSchema,
  AccountSummaryRecentEventSchema,
} from "../schemas-src/artifacts/account-summary-projection.ts";
import { ACCOUNT_EVENTS_COLUMNS } from "../generated/lakehouse/types.ts";
import {
  ACCOUNT_SUMMARY_MAX_AGE_MS,
  ACCOUNT_SUMMARY_POINTER_KEY,
  ACCOUNT_SUMMARY_SCHEMA_VERSION,
  accountShard,
  accountSummaryShardKey,
  loadAccountSummaryProjection,
  type AccountSummaryProjectionRead,
  recentFloorMs,
  accountHistoryFloorMs,
  ACCOUNT_SUMMARY_POINTER_TTL_MS,
} from "../src/account-summary-projection.ts";
import { DEFAULT_CHAIN_NETWORK } from "../src/chain-network.ts";
import { resetAccountSummaryPointerCache } from "../src/account-summary-projection.ts";

// The pointer memo is module-level and reset only between test FILES, so
// whichever test resolved it first would decide every later test's generation.
// Same reasoning as `resetDecodeWatermarkCache` in
// tests/analytics-edge-cache.test.ts: a file that varies the artifact per test
// has to own the memo that would otherwise answer from the previous one.
beforeEach(() => resetAccountSummaryPointerCache());

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

/**
 * The read narrowed to the variant that FOUND the account.
 *
 * The reader returns a union now: a found account, a positive absence (the
 * shard exists and does not list it), or null. Every assertion below this line
 * is about an account the projection holds, so narrowing once here beats
 * re-discriminating at each one -- and asserting the variant means a read that
 * silently became an absence fails loudly instead of reading as `undefined`.
 * Absence has its own describe block.
 */
async function readFound(
  ...args: Parameters<typeof loadAccountSummaryProjection>
): Promise<AccountSummaryProjectionRead> {
  const got = await loadAccountSummaryProjection(...args);
  assert.ok(
    got && got.absent !== true,
    "expected the projection to find this account",
  );
  return got;
}

/**
 * The span the GROUPS prove, which is the bound that works today.
 *
 * `recent` needs metagraphed-infra#575's published event map, and no generation
 * carries one: measured 2026-08-16 the live pointer publishes no `recent_limit`
 * and shard 12350 of generation 20260815T062657Z held 43 accounts, every one of
 * them groups-only. So the feed leg declined for EVERY account and fell to an
 * unbounded lifetime scan -- the 15s abort behind the 503 on /accounts/{ss58}.
 */
describe("the span the groups prove", () => {
  test("brackets every folded event, and says where the fold stops", async () => {
    const store = archive(
      published(
        {
          // THREE groups, deliberately unordered: the middle one moves both
          // ends outward and the last moves neither, so the running min/max
          // are exercised in both directions. Two ordered groups would leave
          // half of each comparison untaken.
          [HOT]: [
            { ...group(), fo: 5_000, lo: 3_000 },
            { ...group(), kind: "Transfer", fo: 1_000, lo: 9_000 },
            { ...group(), kind: "StakeAdded", fo: 7_000, lo: 8_000 },
          ],
        },
        { through: "2026-08-13" },
      ),
    );
    const found = await readFound(store.env, HOT, FRESH);
    assert.deepEqual(found.span, {
      // The EARLIEST first-observed and the LATEST last-observed across every
      // group -- one group's window alone would not contain the other's rows.
      firstMs: 1_000,
      lastMs: 9_000,
      // Midnight after the last complete day folded, so the bounded range and
      // the live probe MEET rather than overlapping or leaving a gap.
      foldFloorMs: Date.parse("2026-08-14T00:00:00.000Z"),
    });
  });

  test("one null fo or lo declines the whole span", async () => {
    // A partial bound is not a bound: the caller would have to invent the
    // missing edge, which drops rows off one end of the feed.
    for (const bad of [{ fo: null }, { lo: null }]) {
      const store = archive(
        published(
          {
            [HOT]: [
              { ...group(), fo: 1_000, lo: 2_000 },
              { ...group(), ...bad },
            ],
          },
          { through: "2026-08-13" },
        ),
      );
      const found = await readFound(store.env, HOT, FRESH);
      assert.equal(found.span, null, JSON.stringify(bad));
    }
  });

  test("no `through` means no fold edge, so no span", async () => {
    const store = archive(
      published({ [HOT]: [{ ...group(), fo: 1_000, lo: 2_000 }] }),
    );
    assert.equal((await readFound(store.env, HOT, FRESH)).span, null);
  });

  test("the production shape -- groups only, no recent map -- still bounds", async () => {
    // Read verbatim out of R2 on 2026-08-16: one group, no `recent` map on the
    // shard and no `recent_limit` on the pointer. Before this, exactly this
    // payload sent the feed to an unbounded scan.
    const store = archive(
      published(
        {
          [HOT]: [
            {
              kind: "NeuronRegistered",
              netuid: 105,
              count: 1,
              fb: 8836052,
              lb: 8836052,
              fo: 1786629372000,
              lo: 1786629372000,
            },
          ],
        },
        { through: "2026-08-14" },
      ),
    );
    const found = await readFound(store.env, HOT, {
      ...FRESH,
      recentLimit: 25,
    });
    assert.equal(found.recent, null, "premise: no recent map is published");
    assert.deepEqual(found.span, {
      firstMs: 1786629372000,
      lastMs: 1786629372000,
      foldFloorMs: Date.parse("2026-08-15T00:00:00.000Z"),
    });
  });
});

describe("loadAccountSummaryProjection", () => {
  test("reads the pointer, THEN the account's shard in that generation", async () => {
    const store = archive(published({ [HOT]: [group()] }));
    const groups = await readFound(store.env, HOT, FRESH);
    assert.deepEqual(store.asked, [
      ACCOUNT_SUMMARY_POINTER_KEY,
      accountSummaryShardKey(HOT, SHARDS, GEN),
    ]);
    assert.deepEqual(groups, {
      groups: [
        {
          kind: "AxonServed",
          netuid: 7,
          count: 3,
          fb: 10,
          lb: 90,
          fo: 1000,
          lo: 9000,
        },
      ],
      // No `recentLimit` asked for, so the feed leg is not read at all -- the
      // aggregate leg is what every caller before #575 wanted and still gets.
      recent: null,
      // No `through` on this pointer, so there is no fold edge to bound
      // against and the span declines rather than guessing one.
      span: null,
    });
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
    const groups = await readFound(store.env, HOT, FRESH);
    assert.equal(groups!.groups.length, 1);
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
    const groups = await readFound(store.env, HOT, FRESH);
    assert.equal(
      groups!.groups[0]!.count,
      1,
      "must read the pointed-at generation",
    );
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
      await readFound(store.env, HOT, {
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
    // An unseen account declines HERE because this generation publishes no
    // `through`, so no bounded floor can be placed. With one it is a positive
    // absence instead -- see "an account the projection does not list".
    const store = archive(published({ [COLD]: [group()] }));
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
  });

  test("a malformed entry DECLINES the account rather than dropping the row", async () => {
    // BEHAVIOUR CHANGE, and deliberate (metagraphed-infra#580). This used to
    // skip entries it could not read and coerce a missing `count` to 0, so a
    // producer writing the wrong shape published a card that was quietly short
    // some events. That is confidently wrong, which is the one outcome this
    // family refuses -- and the alternative is not an error, it is the lakehouse
    // read this tier is an optimisation over.
    //
    // Safe against the real producer: `iter_shards` emits all seven keys on
    // every row, explicit nulls included, verified against the live shard on
    // 2026-08-15 (`['count','fb','fo','kind','lb','lo','netuid']`).
    const store = archive(published({ [HOT]: [null, "text", { count: 2 }] }));
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
  });

  test("a well-formed entry with null fields is still an answer", async () => {
    // The other side of the rule: nulls are legitimate -- Transfer carries no
    // netuid -- so strictness must not turn a real row into a decline.
    const store = archive(
      published({
        [HOT]: [
          {
            kind: "Transfer",
            netuid: null,
            count: 2,
            fb: null,
            lb: null,
            fo: null,
            lo: null,
          },
        ],
      }),
    );
    assert.deepEqual(await readFound(store.env, HOT, FRESH), {
      recent: null,
      // Null `fo`/`lo` make the range a guess, so there is no span to offer.
      span: null,
      groups: [
        {
          kind: "Transfer",
          netuid: null,
          count: 2,
          fb: null,
          lb: null,
          fo: null,
          lo: null,
        },
      ],
    });
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

  test("AN ACCOUNT OVER THE CAP IS ANSWERED -- with the history it really has", async () => {
    // THE DECLINE THIS USED TO ASSERT, and why it inverted (#11468).
    //
    // The disagreement it was built on is real: the projection aggregates an
    // account's WHOLE history, the live path aggregates the newest CAP events,
    // and above the cap `event_kinds`/`subnet_count` differ. Measured on a real
    // account, live reported 4 kinds across 2 subnets and the projection 10
    // across 3. One route must not answer two ways.
    //
    // What declining got wrong is WHICH answer to keep. The capped one is the
    // degraded one -- `event_count` clamped to 5,000, `first_block` and
    // `first_seen_at` nulled outright -- while the projection's is the account's
    // real history, folded forward associatively from a 2020 floor. Declining
    // held the route to the worse answer AND made it slow: null is the signal
    // the caller reads to pick its arms, so it sent both legs to unbounded
    // scans. Measured on production 2026-08-17, over-cap correlated with slow
    // 16/16 -- 0.63-1.07s under the cap, 6.7-22.8s and 503s over it.
    //
    // So an over-cap account is now ANSWERED, with the totals it really has.
    const over = [
      group({
        kind: "AxonServed",
        netuid: 7,
        count: ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
      }),
      group({ kind: "Transfer", netuid: null, count: 1 }),
    ];
    const store = archive(published({ [HOT]: over }));
    const found = await readFound(store.env, HOT, FRESH);
    assert.equal(
      found.groups.length,
      2,
      "the over-cap account is served, not declined",
    );
    assert.equal(
      found.groups.reduce((n, g) => n + Number(g.count), 0),
      ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1,
      "and its lifetime total is published rather than clamped",
    );
  });

  test("an account EXACTLY at the cap is still answered", async () => {
    // At the cap the two windows are the same set, so the answers agree -- an
    // off-by-one here would drop the busiest accounts the tier CAN serve.
    const atCap = [group({ count: ACCOUNT_EVENT_SUMMARY_SCAN_CAP })];
    const store = archive(published({ [HOT]: atCap }));
    const groups = await readFound(store.env, HOT, FRESH);
    assert.equal(groups!.groups.length, 1);
  });

  test("an account present with no usable groups declines", async () => {
    const store = archive(published({ [HOT]: [] }));
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
  });
});

describe("the pointer is PARSED, not indexed (metagraphed-infra#580)", () => {
  // The producer lives in another repository, so a shape nobody has written
  // down is a shape nothing can compare. These pin the rules the previous
  // hand-rolled checks encoded, now that a schema carries them.

  test("the shape production actually publishes is accepted", () => {
    // Read from the live pointer on 2026-08-15. If the producer adds a field
    // without declaring it, `.strict()` refuses here rather than letting an
    // undeclared field reach a reader -- which is #10790's whole argument.
    assert.equal(
      AccountSummaryPointerSchema.safeParse({
        schema_version: 1,
        generation: "20260814T150712Z",
        shard_count: 16384,
        generated_at: "2026-08-14T15:07:12Z",
        account_count: 812977,
      }).success,
      true,
    );
  });

  test("`through` is accepted but not required", () => {
    // Added after the first generations were published, so a pointer written
    // before it must still read. It is the producer's own bookkeeping.
    assert.equal(
      AccountSummaryPointerSchema.safeParse({
        ...pointer(),
        through: "2026-08-14",
      }).success,
      true,
    );
  });

  test("a numeric generated_at is refused, not coerced", () => {
    // `Date.parse(String(12345))` is a valid date -- the year 12345 -- so a
    // numeric field would read as fresh forever and the staleness bound this
    // tier depends on would never fire.
    assert.equal(
      AccountSummaryPointerSchema.safeParse(pointer({ generated_at: 12345 }))
        .success,
      false,
    );
  });

  test("a zero or fractional shard_count is refused", () => {
    // The reader derives an object key from it. A bad value does not fail
    // loudly -- it addresses an object that does not exist, which reads as
    // "this account has no events".
    for (const bad of [0, -1, 1.5]) {
      assert.equal(
        AccountSummaryPointerSchema.safeParse(pointer({ shard_count: bad }))
          .success,
        false,
        `shard_count ${bad}`,
      );
    }
  });

  test("an undeclared field is STRIPPED, not refused", () => {
    // THIS ASSERTION USED TO READ `false`, and it pinned the assumption that
    // caused an outage. On 2026-08-16T17:30Z the producer -- which lives in
    // another repository and deploys on its own schedule -- published
    // `recent_from`, and `.strict()` rejected the whole pointer over it. Every
    // account lost its projection silently; see the dedicated describe block at
    // the end of this file for the full account.
    //
    // The field is dropped rather than carried onward, which is the difference
    // from `.passthrough()` (banned by the no-passthrough gate) and the reason
    // nothing undeclared can reach a caller.
    const parsed = AccountSummaryPointerSchema.safeParse(
      pointer({ surprise: 1 }),
    );
    assert.equal(parsed.success, true);
    assert.ok(parsed.data && !("surprise" in parsed.data));
  });

  test("a pointer that fails the schema declines the tier rather than throwing", async () => {
    // The end-to-end consequence: an unparseable pointer must be a null answer
    // the caller can fall back from, never an exception on a serving path.
    const store = archive({
      ...published({ [HOT]: [group()] }),
      [ACCOUNT_SUMMARY_POINTER_KEY]: pointer({ generated_at: 12345 }),
    });
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
  });
});

// --- the feed leg (metagraphed-infra#575) ------------------------------------

/** One published event, in the producer's column names. */
function event(over: Record<string, unknown> = {}) {
  return {
    block_number: 900,
    event_index: 1,
    extrinsic_index: 2,
    event_kind: "AxonServed",
    hotkey: HOT,
    coldkey: COLD,
    netuid: 7,
    uid: 3,
    amount_tao: null,
    alpha_amount: null,
    observed_at: Date.parse("2026-08-13T12:00:00Z"),
    ...over,
  };
}

/** A generation that carries a recent map, with the pointer fields #575 adds. */
function withRecent(
  recent: Record<string, unknown>,
  { over = {}, limit = 10 as number | undefined } = {},
) {
  // `count: 1`, so a fixture holding ONE event is a COMPLETE list. The reader
  // serves a list only when it holds `min(published, lifetime)` entries, and
  // the default `group()` claims three events -- which would make every
  // fixture below fall back for a reason none of them is about.
  const objects = published(
    { [HOT]: [group({ count: 1 })] },
    {
      through: "2026-08-13",
      ...(limit === undefined ? {} : { recent_limit: limit }),
      ...over,
    },
  ) as Record<string, Record<string, unknown>>;
  objects[accountSummaryShardKey(HOT, SHARDS, GEN)]!.recent = recent;
  return objects;
}

describe("recentFloorMs", () => {
  test("the floor is the END of the last complete day, not the run's clock", () => {
    // THE ARITHMETIC THE WHOLE MERGE RESTS ON. `through` names a complete day,
    // so the projection describes up to its last millisecond and the probe
    // must start at the next one. Anchoring on `generated_at` instead would
    // skip every event between midnight and the run -- six hours on the
    // generation measured 2026-08-15.
    assert.equal(
      recentFloorMs("2026-08-13"),
      Date.parse("2026-08-14T00:00:00.000Z"),
    );
  });

  test("anything that is not a plain calendar day places no floor", () => {
    // A floor that is a guess is worse than the lakehouse read it replaces, so
    // every one of these declines the leg rather than approximating it.
    for (const bad of [
      undefined,
      "",
      "2026-08",
      "2026-8-13",
      "2026-08-13T00:00:00Z",
      "yesterday",
      "0000-00-00",
    ]) {
      assert.equal(recentFloorMs(bad), null, String(bad));
    }
  });
});

describe("the projection's recent map", () => {
  test("is returned with the floor the probe resumes from", async () => {
    const store = archive(withRecent({ [HOT]: [event()] }));
    const read = await readFound(store.env, HOT, {
      ...FRESH,
      recentLimit: 10,
    });
    assert.deepEqual(read!.recent!.rows, [event()]);
    assert.equal(read!.recent!.floorMs, Date.parse("2026-08-14T00:00:00.000Z"));
    // The aggregate leg is unaffected by any of this.
    assert.equal(read!.groups.length, 1);
  });

  test("A SHORTER PUBLISHED LIMIT DECLINES, rather than serving a short feed", async () => {
    // The reason the N travels in the pointer at all. The producer is in
    // another repository, so a reader that assumed the published N matched its
    // own would serve nine events as though they were the newest ten, with
    // nothing on the card to say the tenth was never published.
    const store = archive(withRecent({ [HOT]: [event()] }, { limit: 9 }));
    const read = await readFound(store.env, HOT, {
      ...FRESH,
      recentLimit: 10,
    });
    assert.equal(read!.recent, null);
    assert.equal(read!.groups.length, 1, "the aggregate leg still answers");
  });

  test("an equal published limit is enough", async () => {
    // The boundary the test above brackets: >= is the rule, not >.
    const store = archive(withRecent({ [HOT]: [event()] }, { limit: 10 }));
    const read = await readFound(store.env, HOT, {
      ...FRESH,
      recentLimit: 10,
    });
    assert.deepEqual(read!.recent!.rows, [event()]);
  });

  test("a generation published before #575 declines the leg alone", async () => {
    // Every generation written before the producer change has no recent map
    // and no `recent_limit`, and those pointers stay perfectly good for the
    // expensive half. Failing both would throw away the aggregate saving to
    // fix the feed.
    const store = archive(
      published({ [HOT]: [group()] }, { through: "2026-08-13" }),
    );
    const read = await readFound(store.env, HOT, {
      ...FRESH,
      recentLimit: 10,
    });
    assert.equal(read!.recent, null);
    assert.equal(read!.groups.length, 1);
  });

  test("no `through` means no floor, so the list is refused", async () => {
    // A recent list with nowhere to resume from would freeze the feed at the
    // last day the producer folded -- the card would stop updating and look
    // exactly like a quiet account.
    const store = archive(
      withRecent({ [HOT]: [event()] }, { over: { through: undefined } }),
    );
    const read = await readFound(store.env, HOT, {
      ...FRESH,
      recentLimit: 10,
    });
    assert.equal(read!.recent, null);
  });

  test("a malformed row declines the whole list", async () => {
    // The same rule the groups follow: a card quietly short some events is
    // confidently wrong, which costs more than being slow. Note the row is
    // WELL-FORMED apart from one field -- a shape check that only looked at
    // the array would pass it.
    const store = archive(
      withRecent({ [HOT]: [event(), event({ block_number: null })] }),
    );
    const read = await readFound(store.env, HOT, {
      ...FRESH,
      recentLimit: 10,
    });
    assert.equal(read!.recent, null);
  });

  test("an undeclared column declines the list", async () => {
    // `.strict()` is doing work here: a producer that added a column would
    // otherwise have it silently dropped from every card, and the divergence
    // would only show up as a field the API stopped serving.
    const store = archive(withRecent({ [HOT]: [{ ...event(), surprise: 1 }] }));
    const read = await readFound(store.env, HOT, {
      ...FRESH,
      recentLimit: 10,
    });
    assert.equal(read!.recent, null);
  });

  test("an account absent from the map, or empty in it, declines", async () => {
    for (const map of [{}, { [HOT]: [] }, { [COLD]: [event()] }]) {
      const store = archive(withRecent(map));
      const read = await readFound(store.env, HOT, {
        ...FRESH,
        recentLimit: 10,
      });
      assert.equal(read!.recent, null, JSON.stringify(map));
    }
  });

  test("a non-object recent map is refused rather than indexed", async () => {
    for (const map of ["nope", 7, null] as unknown[]) {
      const store = archive(withRecent(map as Record<string, unknown>));
      const read = await readFound(store.env, HOT, {
        ...FRESH,
        recentLimit: 10,
      });
      assert.equal(read!.recent, null, String(map));
    }
  });

  test("asking for no recent events reads no recent map at all", async () => {
    // The default. Every caller before #575 wants the aggregate leg only, and
    // must not start paying to parse a list it will not use.
    const store = archive(withRecent({ [HOT]: [event()] }));
    const read = await readFound(store.env, HOT, FRESH);
    assert.equal(read!.recent, null);
  });
});

describe("a published list is only served when it IS the newest N", () => {
  // THE PROPERTY THAT LETS THE FEATURE SHIP BEFORE THE WALK FINISHES. The
  // producer seeds these lists backward from the day it folded to, so mid-walk
  // they are a suffix of history. `min(published, lifetime)` is how many
  // entries a COMPLETE list has, and the shard already carries both numbers.

  /** A shard whose groups sum to `lifetime` and whose list holds `held`. */
  function shard(lifetime: number, held: number) {
    const objects = published(
      { [HOT]: [group({ count: lifetime })] },
      {
        through: "2026-08-13",
        recent_limit: 10,
      },
    ) as Record<string, Record<string, unknown>>;
    objects[accountSummaryShardKey(HOT, SHARDS, GEN)]!.recent = {
      [HOT]: Array.from({ length: held }, (_, i) =>
        event({ block_number: 900 - i, event_index: i }),
      ),
    };
    return archive(objects);
  }

  const read = (store: ReturnType<typeof archive>) =>
    readFound(store.env, HOT, { ...FRESH, recentLimit: 10 });

  test("a FULL list is served -- the walk has passed this account's events", async () => {
    assert.equal((await read(shard(500, 10)))!.recent!.rows.length, 10);
  });

  test("A SHORT LIST IS REFUSED when the account has more events than it holds", async () => {
    // The failure this exists for: four events served as though they were the
    // newest ten, on an account with five hundred. Nothing in the payload
    // distinguishes that from an account that has only ever done four things.
    assert.equal((await read(shard(500, 4)))!.recent, null);
    // And the aggregate leg is untouched -- only the feed falls back.
    assert.equal((await read(shard(500, 4)))!.groups.length, 1);
  });

  test("a short list IS served when it is the account's whole history", async () => {
    // `min(10, 4) === 4`, so four of four is complete. Refusing here would
    // send every low-activity account to the lakehouse forever.
    assert.equal((await read(shard(4, 4)))!.recent!.rows.length, 4);
  });

  test("the boundary is exact on both sides", async () => {
    assert.equal((await read(shard(10, 10)))!.recent!.rows.length, 10);
    assert.equal((await read(shard(11, 10)))!.recent!.rows.length, 10);
    assert.equal((await read(shard(5, 4)))!.recent, null);
  });
});

/**
 * Absence as an ANSWER, which is the whole reason the producer writes empty
 * shards. See `empty_payload` in metagraphed-infra's account_summary_r2.py:
 * "The reader cannot tell 'no such account' from 'this shard was never
 * produced' when the object is absent -- and the first is an answer while the
 * second is a decline."
 *
 * Before this, both collapsed to `null` and the caller ran an unbounded
 * lifetime scan for an account proven to have no history.
 */
describe("an account the projection does not list", () => {
  const THROUGH = { through: "2026-08-14" };
  const FLOOR = Date.parse("2026-08-15T00:00:00.000Z");

  test("is a positive absence carrying the floor, not a decline", async () => {
    // The shard EXISTS and does not hold HOT, so the projection has established
    // there is nothing at or before `through`.
    const store = archive(published({}, THROUGH));
    const got = await loadAccountSummaryProjection(store.env, HOT, FRESH);
    assert.deepEqual(got, { absent: true, floorMs: FLOOR });
  });

  test("a MISSING shard stays a decline, and is never read as absence", async () => {
    // The distinction the producer writes empty shards to make. Treating an
    // unwritten shard as "no history" would publish an empty card for an
    // account with a full one -- confidently wrong, the one outcome this
    // family refuses.
    const store = archive({
      [ACCOUNT_SUMMARY_POINTER_KEY]: pointer(THROUGH),
    });
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
  });

  test("declines when the generation cannot place the floor", async () => {
    // No `through`, so there is nowhere to start a bounded read. A guessed
    // floor is worse than the lakehouse scan it would replace.
    const store = archive(published({}));
    assert.equal(
      await loadAccountSummaryProjection(store.env, HOT, FRESH),
      null,
    );
  });

  test("an account the shard DOES list is never reported absent", async () => {
    const store = archive(published({ [HOT]: [group()] }, THROUGH));
    const got = await loadAccountSummaryProjection(store.env, HOT, FRESH);
    assert.equal(got!.absent, undefined);
  });
});

describe("AccountSummaryRecentEventSchema", () => {
  test("ITS KEYS ARE THE LAKEHOUSE TABLE'S, exactly", () => {
    // The reader merges these rows with rows selected straight out of
    // `chain.account_events`, into one feed. A column added to the table and
    // not to this schema would be dropped from the projection's half only --
    // half a card carrying a field the other half does not. Pinned against the
    // GENERATED list so the table is the thing that has to change first.
    assert.deepEqual(
      Object.keys(AccountSummaryRecentEventSchema.shape).sort(),
      [...ACCOUNT_EVENTS_COLUMNS].sort(),
    );
  });
});

/**
 * The one bound every account route can push into its own `where`.
 *
 * Kept as a named helper rather than four copies of `loadAccountSummaryProjection(...)
 * ?.span?.firstMs`: the two projection answers floor DIFFERENTLY -- present at
 * `min(fo)`, absent at the generation edge -- and a caller that reached for
 * `span` alone would silently take no floor on exactly the accounts whose
 * unbounded walk is most expensive.
 */
/** A pointer stamped now, so a freshness check is not a clock race. */
const nowIso = () => new Date().toISOString();

describe("accountHistoryFloorMs", () => {
  test("a PRESENT account floors at its earliest folded event", async () => {
    const store = archive(
      published(
        {
          [HOT]: [
            { ...group(), fo: 5_000 },
            { ...group(), fo: 1_000 },
          ],
        },
        { through: "2026-08-13", generated_at: nowIso() },
      ),
    );
    assert.equal(await accountHistoryFloorMs(store.env, HOT), 1_000);
  });

  test("an ABSENT account floors at the generation's edge", async () => {
    // The producer writes every shard, so absence from a shard that EXISTS
    // proves there is nothing at or before `through` -- a strictly stronger
    // bound than any present account gets.
    const store = archive(
      published({}, { through: "2026-08-13", generated_at: nowIso() }),
    );
    assert.equal(
      await accountHistoryFloorMs(store.env, HOT),
      Date.parse("2026-08-14T00:00:00.000Z"),
    );
  });

  test("a pointer with NO `through` yields no floor, not a guessed one", async () => {
    // `span` declines without a fold edge, and this must decline with it: a
    // floor invented here would bound a feed below rows that exist.
    const store = archive(
      published({ [HOT]: [group()] }, { generated_at: nowIso() }),
    );
    assert.equal(await accountHistoryFloorMs(store.env, HOT), null);
  });

  test("NO projection is null, not a throw", async () => {
    assert.equal(await accountHistoryFloorMs(archive({}).env, HOT), null);
  });

  test("A NON-DEFAULT NETWORK READS NOTHING AT ALL", async () => {
    // The projection describes mainnet. Flooring another chain's feed with it
    // would bound that feed against the wrong history -- a WRONG answer, where
    // the unbounded walk is merely a slow right one. Asserted on `asked` and
    // not just the return value: a null that came from reading the mainnet
    // pointer and discarding it would pass a return-value check while still
    // paying for the read.
    const store = archive(
      published({ [HOT]: [group()] }, { generated_at: nowIso() }),
    );
    assert.equal(await accountHistoryFloorMs(store.env, HOT, "testnet"), null);
    assert.deepEqual(store.asked, []);
  });

  test("the DEFAULT network passed explicitly still floors", async () => {
    // `undefined` and "finney" are the same request; only the third value
    // declines. A guard written as `network !== undefined` alone would refuse
    // a caller that names its own default.
    const store = archive(
      published(
        { [HOT]: [{ ...group(), fo: 4_242 }] },
        { through: "2026-08-13", generated_at: nowIso() },
      ),
    );
    assert.equal(
      await accountHistoryFloorMs(store.env, HOT, DEFAULT_CHAIN_NETWORK),
      4_242,
    );
  });
});

/**
 * The pointer must survive a producer that publishes MORE than this declares.
 *
 * 2026-08-16T17:30Z, production: the account-summary lane recovered after two
 * days out (metagraphed-infra#599, #601) and its first generation published a
 * field this schema did not declare. `.strict()` rejected the whole pointer
 * over it -- not the field, the POINTER -- so `loadAccountSummaryProjection`
 * returned null for every account. The card lost its projection, `readRecent`
 * never ran, and `accountHistoryFloorMs` returned null, which made every scan
 * floor #11425 had just added INERT. `/events?limit=5` went back to 21s.
 *
 * Nothing failed. Every route quietly took its slow path.
 */
describe("the pointer, against a producer that deploys independently", () => {
  /** The exact bytes production published at 2026-08-16T17:30:20Z. */
  const LIVE = {
    schema_version: 1,
    generation: "20260816T173020Z",
    shard_count: 16384,
    generated_at: "2026-08-16T17:30:20Z",
    account_count: 814072,
    recent_limit: 10,
    recent_from: "2026-07-16",
    through: "2026-08-15",
  };

  test("THE LIVE POINTER PARSES", () => {
    const parsed = AccountSummaryPointerSchema.safeParse(LIVE);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.recent_limit, 10);
    assert.equal(parsed.data.recent_from, "2026-07-16");
  });

  test("A FIELD THIS SCHEMA HAS NEVER SEEN is stripped, not fatal", () => {
    // The next `recent_from`. The producer is in another repository and ships
    // on its own schedule, so this WILL happen again -- and the cost of being
    // wrong is total and silent, where the cost of stripping is that one
    // unknown field is ignored.
    const parsed = AccountSummaryPointerSchema.safeParse({
      ...LIVE,
      some_field_added_next_quarter: { nested: true },
    });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.generation, "20260816T173020Z");
    assert.ok(
      !("some_field_added_next_quarter" in parsed.data),
      "stripped, not carried onward -- this is not passthrough",
    );
  });

  test("A DECLARED FIELD IS STILL VALIDATED EXACTLY AS STRICTLY", () => {
    // Dropping `.strict()` loosens what the object may CONTAIN, never what a
    // declared field may BE. A producer that starts writing a string count is
    // still refused.
    for (const bad of [
      { ...LIVE, shard_count: "16384" },
      { ...LIVE, shard_count: 0 },
      { ...LIVE, generation: "" },
      { ...LIVE, recent_limit: 0 },
      { ...LIVE, account_count: -1 },
    ]) {
      assert.equal(
        AccountSummaryPointerSchema.safeParse(bad).success,
        false,
        JSON.stringify(bad).slice(0, 90),
      );
    }
  });

  test("THE WHOLE READ SURVIVES an unknown pointer field, end to end", async () => {
    // The unit above is the rule; this is the property that broke. A pointer
    // that parses but a read that still declines would be the same outage.
    const store = archive(
      published(
        { [HOT]: [group()] },
        {
          through: "2026-08-13",
          generated_at: nowIso(),
          recent_from: "2026-07-16",
          a_field_from_the_future: 1,
        },
      ),
    );
    const found = await readFound(store.env, HOT, FRESH);
    assert.equal(found.groups.length, 1);
    assert.ok(found.span, "the floor every account route depends on");
  });
});

/**
 * The pointer memo, and the miss that makes it safe.
 *
 * Measured 2026-08-16: an R2 artifact read from this Worker costs ~370 ms
 * (`/api/v1/coverage`, which does exactly one), and the projection does two in
 * sequence -- the pointer, then the shard it names. The pointer changes once an
 * hour and was being fetched on EVERY account request.
 */
describe("the pointer memo", () => {
  const FRESH_POINTER = () => ({ generated_at: nowIso() });

  test("ONE R2 READ across many callers, not one each", async () => {
    const store = archive(published({ [HOT]: [group()] }, FRESH_POINTER()));
    for (let i = 0; i < 4; i += 1) {
      await loadAccountSummaryProjection(store.env, HOT);
    }
    const pointerReads = store.asked.filter(
      (key) => key === ACCOUNT_SUMMARY_POINTER_KEY,
    ).length;
    assert.equal(pointerReads, 1, store.asked.join("\n"));
    assert.equal(
      store.asked.length,
      5,
      "one pointer read plus one shard read per caller",
    );
  });

  test("CONCURRENT CALLERS SHARE ONE IN-FLIGHT READ", async () => {
    // The PROMISE is memoized, not the value, so a cold isolate taking four
    // simultaneous requests issues one R2 GET rather than racing four.
    const store = archive(published({ [HOT]: [group()] }, FRESH_POINTER()));
    await Promise.all(
      [0, 1, 2, 3].map(() => loadAccountSummaryProjection(store.env, HOT)),
    );
    assert.equal(
      store.asked.filter((key) => key === ACCOUNT_SUMMARY_POINTER_KEY).length,
      1,
    );
  });

  test("A SHARD MISS DROPS THE MEMO, so the next request re-reads", async () => {
    // THE THING THAT MAKES MEMOIZING SAFE AT ALL. The producer deletes a
    // generation's shards once the next one is live, so a memoized pointer can
    // name a generation that no longer exists. Without this, every account
    // request would decline for the rest of the TTL -- turning a 370 ms saving
    // into a multi-minute outage once an hour.
    const gone = archive({
      [ACCOUNT_SUMMARY_POINTER_KEY]: pointer(FRESH_POINTER()),
    });
    assert.equal(await loadAccountSummaryProjection(gone.env, HOT), null);

    const live = archive(published({ [HOT]: [group()] }, FRESH_POINTER()));
    const found = await readFound(live.env, HOT, FRESH);
    assert.equal(
      found.groups.length,
      1,
      "the next request re-read the pointer",
    );
    assert.ok(
      live.asked.includes(ACCOUNT_SUMMARY_POINTER_KEY),
      "it must not have answered from the dropped memo",
    );
  });

  test("A ROTATION IS SERVED, not declined and left to the lakehouse", async () => {
    // THE COST OF DECLINING, which the memo-drop above does not pay back. It
    // repairs the NEXT request on THIS isolate; the memo is isolate-local, so
    // every isolate alive across a rotation still has one request that finds no
    // shard -- and that request does not merely go slow, it falls through to
    // the caller's unbounded `windowedRowRead` walk of chain.account_events.
    //
    // Measured on production 2026-08-17: six accounts whose shards all existed
    // and whose payloads all parsed, three answered in 0.64-0.89s from the
    // projection while the others took 19.2s, 25.7s and 30.8s with five r2sql
    // calls, and /accounts/{ss58} 503s when that walk overruns the 15s ceiling.
    // Every generation but the current one is deleted, so the only difference
    // between those two outcomes was which generation the isolate had memoized.
    const NEXT = "20260814T110000Z";
    const rotated = archive({
      // The pointer the producer has already advanced...
      [ACCOUNT_SUMMARY_POINTER_KEY]: pointer({
        generation: NEXT,
        generated_at: "2026-08-14T11:00:00Z",
      }),
      // ...and only the new generation's shard, because the old one is deleted.
      [accountSummaryShardKey(HOT, SHARDS, NEXT)]: {
        schema_version: ACCOUNT_SUMMARY_SCHEMA_VERSION,
        generated_at: "2026-08-14T11:00:00Z",
        shard_count: SHARDS,
        accounts: { [HOT]: [group()] },
      },
    });

    // Warm the memo onto the OLD generation, exactly as an isolate that served
    // a request before the rotation would hold it.
    const stale = archive(published({ [HOT]: [group()] }));
    await readFound(stale.env, HOT, FRESH);

    // Now the same isolate takes a request after the producer rotated.
    const found = await readFound(rotated.env, HOT, FRESH);
    assert.equal(
      found.groups.length,
      1,
      "the rotation must be re-resolved and served, not declined",
    );
    assert.deepEqual(
      rotated.asked,
      [
        accountSummaryShardKey(HOT, SHARDS, GEN),
        ACCOUNT_SUMMARY_POINTER_KEY,
        accountSummaryShardKey(HOT, SHARDS, NEXT),
      ],
      "the miss on the memoized generation re-reads the pointer, then the shard it now names",
    );
  });

  test("a shard absent under the CURRENT generation is not re-read", async () => {
    // The retry is for a rotation, and a fresh pointer naming the SAME
    // generation is not one: the shard is genuinely absent -- a partial
    // publish, or an account the producer never wrote -- and asking for the
    // identical key a second time buys the same miss twice. So this declines on
    // one shard GET plus the pointer re-read that proved nothing had moved.
    const gone = archive({
      [ACCOUNT_SUMMARY_POINTER_KEY]: pointer(),
    });
    assert.equal(
      await loadAccountSummaryProjection(gone.env, HOT, FRESH),
      null,
    );
    assert.deepEqual(
      gone.asked,
      [
        ACCOUNT_SUMMARY_POINTER_KEY,
        accountSummaryShardKey(HOT, SHARDS, GEN),
        ACCOUNT_SUMMARY_POINTER_KEY,
      ],
      "one shard read, never two for the same key",
    );
  });

  test("AN UNREADABLE POINTER IS NOT MEMOIZED for the TTL", async () => {
    // A transient R2 blip must cost one request, not five minutes of declines.
    const broken = archive({ [ACCOUNT_SUMMARY_POINTER_KEY]: { nope: 1 } });
    assert.equal(await loadAccountSummaryProjection(broken.env, HOT), null);

    const live = archive(published({ [HOT]: [group()] }, FRESH_POINTER()));
    const found = await readFound(live.env, HOT, FRESH);
    assert.equal(found.groups.length, 1);
  });

  test("THE MEMO EXPIRES, so a new generation is picked up", async () => {
    const first = archive(published({ [HOT]: [group()] }, FRESH_POINTER()));
    await loadAccountSummaryProjection(first.env, HOT);
    const later = () => Date.now() + ACCOUNT_SUMMARY_POINTER_TTL_MS + 1;
    const second = archive(published({ [HOT]: [group()] }, FRESH_POINTER()));
    await loadAccountSummaryProjection(second.env, HOT, { now: later });
    assert.ok(
      second.asked.includes(ACCOUNT_SUMMARY_POINTER_KEY),
      "past the TTL the pointer must be re-read",
    );
  });
});
