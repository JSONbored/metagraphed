import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildValidatorNominators,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
  DEFAULT_NOMINATOR_SORT,
  NOMINATOR_LIMIT_MAX,
} from "../src/validator-nominators.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// One GROUP BY coldkey, event_kind row.
function row(coldkey, kind, tao, count, lastObserved) {
  return {
    coldkey,
    event_kind: kind,
    total_tao: tao,
    event_count: count,
    last_observed: lastObserved,
  };
}
const added = (coldkey, tao, count = 1, at = 1000) =>
  row(coldkey, STAKE_ADDED_KIND, tao, count, at);
const removed = (coldkey, tao, count = 1, at = 1000) =>
  row(coldkey, STAKE_REMOVED_KIND, tao, count, at);

const HOTKEY = "5GReferenceValidatorHotkeyForNominatorTestsssssss";

describe("buildValidatorNominators", () => {
  test("cold / empty input yields a zeroed, schema-stable card", () => {
    for (const rows of [[], null, undefined]) {
      const d = buildValidatorNominators(rows, HOTKEY, { window: "30d" });
      assert.equal(d.schema_version, 1);
      assert.equal(d.hotkey, HOTKEY);
      assert.equal(d.window, "30d");
      assert.equal(d.sort, DEFAULT_NOMINATOR_SORT);
      assert.equal(d.nominator_count, 0);
      assert.deepEqual(d.nominators, []);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildValidatorNominators([], HOTKEY).window, null);
  });

  test("folds per-(coldkey, kind) rows into per-nominator flow", () => {
    const d = buildValidatorNominators(
      [added("ck-a", 100, 3), removed("ck-a", 40, 2), added("ck-b", 10, 1)],
      HOTKEY,
    );
    const a = d.nominators.find((n) => n.coldkey === "ck-a");
    assert.equal(a.staked_tao, 100);
    assert.equal(a.unstaked_tao, 40);
    assert.equal(a.net_staked_tao, 60);
    assert.equal(a.gross_staked_tao, 140);
    assert.equal(a.event_count, 5);
    assert.equal(d.nominator_count, 2);
  });

  test("skips a malformed (non-string / empty) coldkey", () => {
    const d = buildValidatorNominators(
      [
        added(null, 100),
        added(undefined, 100),
        added("", 100),
        added("ck-a", 25),
      ],
      HOTKEY,
    );
    assert.equal(d.nominator_count, 1);
    assert.equal(d.nominators[0].coldkey, "ck-a");
  });

  test("folds SQL-paginated per-coldkey aggregate rows", () => {
    const d = buildValidatorNominators(
      [
        {
          coldkey: "ck-a",
          staked_tao: 50,
          unstaked_tao: null,
          event_count: 2,
          last_observed: 5000,
        },
        {
          coldkey: "ck-b",
          staked_tao: null,
          unstaked_tao: 5,
          event_count: 1,
          last_observed: 4000,
        },
        {
          coldkey: "ck-empty",
          staked_tao: null,
          unstaked_tao: null,
          event_count: 1,
        },
      ],
      HOTKEY,
      { totalCount: 5, limit: 2, offset: 2 },
    );
    assert.equal(d.nominator_count, 5);
    assert.deepEqual(
      d.nominators.map((n) => [n.coldkey, n.staked_tao, n.unstaked_tao]),
      [
        ["ck-a", 50, 0],
        ["ck-b", 0, 5],
      ],
    );
  });

  test("skips a non-stake event_kind (e.g. Transfer rows sharing the same query)", () => {
    const d = buildValidatorNominators(
      [row("ck-a", "Transfer", 100, 1, 1000), added("ck-a", 25)],
      HOTKEY,
    );
    assert.equal(d.nominator_count, 1);
    assert.equal(d.nominators[0].staked_tao, 25);
  });

  test("skips blank/null/non-numeric total_tao cells instead of counting a phantom event", () => {
    for (const blank of [null, "", "   ", "nope"]) {
      const d = buildValidatorNominators(
        [
          {
            coldkey: "ck-a",
            event_kind: STAKE_ADDED_KIND,
            total_tao: blank,
            event_count: 5,
          },
          added("ck-a", 25, 2),
        ],
        HOTKEY,
      );
      assert.equal(
        d.nominators[0].staked_tao,
        25,
        `total_tao=${JSON.stringify(blank)}`,
      );
      assert.equal(d.nominators[0].event_count, 2);
    }
  });

  test("truncates a fractional/negative event_count to a non-negative integer", () => {
    const d = buildValidatorNominators([added("ck-a", 100, 2.9)], HOTKEY);
    assert.equal(d.nominators[0].event_count, 2);
    const negative = buildValidatorNominators(
      [row("ck-a", STAKE_ADDED_KIND, 100, -5, 1000)],
      HOTKEY,
    );
    assert.equal(negative.nominators[0].event_count, 0);
  });

  test("a missing/NaN event_count counts as zero events, not NaN", () => {
    const d = buildValidatorNominators(
      [row("ck-a", STAKE_ADDED_KIND, 100, undefined, 1000)],
      HOTKEY,
    );
    assert.equal(d.nominators[0].event_count, 0);
  });

  test("tracks the latest last_observed_at per coldkey, ignoring an earlier or null observed cell", () => {
    const d = buildValidatorNominators(
      [
        added("ck-a", 10, 1, 9000), // newest, seen first
        removed("ck-a", 5, 1, 3000), // older, must not overwrite
        row("ck-a", STAKE_ADDED_KIND, 1, 1, Number.NaN), // non-finite, ignored
      ],
      HOTKEY,
    );
    assert.equal(
      d.nominators[0].last_observed_at,
      new Date(9000).toISOString(),
    );
  });

  test("an out-of-range last_observed timestamp yields a null last_observed_at (not epoch 1970)", () => {
    const d = buildValidatorNominators(
      [added("ck-a", 10, 1, "8640000000000001")],
      HOTKEY,
    );
    assert.equal(d.nominators[0].last_observed_at, null);
  });

  test("sorting by last_activity falls back to -Infinity for a nominator with no valid observed timestamp", () => {
    const d = buildValidatorNominators(
      [
        added("ck-no-activity", 100, 1, Number.NaN),
        added("ck-with-activity", 1, 1, 1000),
      ],
      HOTKEY,
      { sort: "last_activity" },
    );
    // The nominator with a real timestamp ranks above the one with none,
    // proving the missing side falls back to -Infinity rather than throwing
    // or comparing equal.
    assert.deepEqual(
      d.nominators.map((n) => n.coldkey),
      ["ck-with-activity", "ck-no-activity"],
    );
  });

  test("sorts by net_staked (default), gross_staked, or last_activity", () => {
    const rows = [
      added("ck-big-net", 100, 1, 1000),
      added("ck-small-net", 20, 1, 5000),
      removed("ck-small-net", 15, 1, 5000), // net 5, gross 35
    ];
    const byNet = buildValidatorNominators(rows, HOTKEY, {
      sort: "net_staked",
    });
    assert.deepEqual(
      byNet.nominators.map((n) => n.coldkey),
      ["ck-big-net", "ck-small-net"],
    );

    const byGross = buildValidatorNominators(rows, HOTKEY, {
      sort: "gross_staked",
    });
    // ck-small-net gross = 20+15 = 35, still less than ck-big-net's 100.
    assert.deepEqual(
      byGross.nominators.map((n) => n.coldkey),
      ["ck-big-net", "ck-small-net"],
    );

    const byActivity = buildValidatorNominators(rows, HOTKEY, {
      sort: "last_activity",
    });
    // ck-small-net's last activity (5000) is newer than ck-big-net's (1000).
    assert.deepEqual(
      byActivity.nominators.map((n) => n.coldkey),
      ["ck-small-net", "ck-big-net"],
    );
  });

  test("an unsupported sort falls back to the default", () => {
    assert.equal(
      buildValidatorNominators([], HOTKEY, { sort: "bogus" }).sort,
      DEFAULT_NOMINATOR_SORT,
    );
  });

  test("ties break by coldkey ascending", () => {
    const d = buildValidatorNominators(
      [added("ck-z", 100), added("ck-a", 100)],
      HOTKEY,
    );
    assert.deepEqual(
      d.nominators.map((n) => n.coldkey),
      ["ck-a", "ck-z"],
    );
  });

  test("limit clamps to [0, max] and paginates via offset; nominator_count reports the full set", () => {
    const rows = Array.from({ length: 5 }, (_, i) => added(`ck-${i}`, 10 - i));
    const clamped = buildValidatorNominators(rows, HOTKEY, {
      limit: NOMINATOR_LIMIT_MAX + 50,
    });
    assert.equal(clamped.limit, NOMINATOR_LIMIT_MAX);

    const zero = buildValidatorNominators(rows, HOTKEY, { limit: 0 });
    assert.equal(zero.limit, 0);
    assert.equal(zero.nominator_count, 5);
    assert.deepEqual(zero.nominators, []);

    const page = buildValidatorNominators(rows, HOTKEY, {
      limit: 2,
      offset: 2,
    });
    assert.equal(page.offset, 2);
    assert.deepEqual(
      page.nominators.map((n) => n.coldkey),
      ["ck-2", "ck-3"],
    );
  });

  test("a non-finite limit/offset falls back to the default", () => {
    const d = buildValidatorNominators([added("ck-a", 1)], HOTKEY, {
      limit: "bogus",
      offset: -5,
    });
    assert.equal(d.limit, 20);
    assert.equal(d.offset, 0);
  });

  test("rounds tao output to rao precision", () => {
    const d = buildValidatorNominators(
      [added("ck-a", 0.1), removed("ck-a", 0.2)],
      HOTKEY,
    );
    assert.equal(d.nominators[0].net_staked_tao, -0.1);
  });
});

// A minimal D1 mock scoped to this route's exact SQL shape (COUNT DISTINCT and
// GROUP BY coldkey), self-contained rather than extending the broader multi-purpose
// account-routes.test.mjs dispatcher.
function accountEventsD1(rows) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            all() {
              const whereOffset = sql.startsWith("SELECT coldkey") ? 3 : 0;
              let r = rows.filter((x) => x.hotkey === params[whereOffset]);
              if (sql.includes("AND coldkey = ?")) {
                const coldkeyParam = params[whereOffset + 4];
                r = r.filter((x) => x.coldkey === coldkeyParam);
              }
              if (/COUNT\(DISTINCT coldkey\)/.test(sql)) {
                return Promise.resolve({
                  results: [
                    {
                      nominator_count: new Set(r.map((x) => x.coldkey)).size,
                    },
                  ],
                });
              }
              if (!/GROUP BY coldkey/.test(sql)) {
                return Promise.resolve({ results: [] });
              }
              const buckets = new Map();
              for (const event of r) {
                const bucket = buckets.get(event.coldkey) ?? {
                  coldkey: event.coldkey,
                  staked_tao: 0,
                  unstaked_tao: 0,
                  event_count: 0,
                  last_observed: null,
                };
                if (event.event_kind === STAKE_ADDED_KIND) {
                  bucket.staked_tao += event.total_tao;
                } else if (event.event_kind === STAKE_REMOVED_KIND) {
                  bucket.unstaked_tao += event.total_tao;
                }
                bucket.event_count += event.event_count;
                bucket.last_observed = Math.max(
                  bucket.last_observed ?? 0,
                  event.last_observed,
                );
                buckets.set(event.coldkey, bucket);
              }
              const results = [...buckets.values()].sort(
                (a, b) =>
                  b.staked_tao -
                    b.unstaked_tao -
                    (a.staked_tao - a.unstaked_tao) ||
                  a.coldkey.localeCompare(b.coldkey),
              );
              return Promise.resolve({ results });
            },
          };
        },
      };
    },
  };
}

const HTTP_HOTKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

describe("GET /api/v1/validators/{hotkey}/nominators via the Worker", () => {
  const getJson = async (path, env) => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    return { res, body: await res.json() };
  };

  test("is schema-stable when D1 is cold (never 404)", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: accountEventsD1([]),
    };
    const { res, body } = await getJson(
      `/api/v1/validators/${HTTP_HOTKEY}/nominators`,
      env,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(body.data.nominators, []);
    assert.equal(body.data.nominator_count, 0);
  });

  test("rejects an invalid window/sort/limit/offset/coldkey", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: accountEventsD1([]),
    };
    const badWindow = await getJson(
      `/api/v1/validators/${HTTP_HOTKEY}/nominators?window=1y`,
      env,
    );
    assert.equal(badWindow.res.status, 400);

    const badSort = await getJson(
      `/api/v1/validators/${HTTP_HOTKEY}/nominators?sort=bogus`,
      env,
    );
    assert.equal(badSort.res.status, 400);

    const badLimit = await getJson(
      `/api/v1/validators/${HTTP_HOTKEY}/nominators?limit=0`,
      env,
    );
    assert.equal(badLimit.res.status, 400);

    const badOffset = await getJson(
      `/api/v1/validators/${HTTP_HOTKEY}/nominators?offset=-1`,
      env,
    );
    assert.equal(badOffset.res.status, 400);

    const badColdkey = await getJson(
      `/api/v1/validators/${HTTP_HOTKEY}/nominators?coldkey=not-ss58`,
      env,
    );
    assert.equal(badColdkey.res.status, 400);

    const unsupported = await getJson(
      `/api/v1/validators/${HTTP_HOTKEY}/nominators?foo=bar`,
      env,
    );
    assert.equal(unsupported.res.status, 400);
  });
});
