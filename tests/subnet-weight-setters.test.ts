import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetWeightSetters,
  loadSubnetWeightSetters,
  SUBNET_WEIGHT_SETTERS_WINDOWS,
  DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW,
  SUBNET_WEIGHT_SETTERS_LIMIT,
} from "../src/subnet-weight-setters.ts";
import { WEIGHTS_EVENT_KIND } from "../src/subnet-weights.ts";
import type { Row } from "./row-type.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

const NETUID = 7;

// Two per-setter leaderboard rows + the subnet-wide totals, as the two D1 reads return them.
const LEADER_ROWS = [
  {
    hotkey: "5Grw...alice",
    uid: 3,
    weight_sets: 30,
    first_set: 1_750_000_000_000,
    last_set: 1_750_600_000_000,
  },
  {
    hotkey: null, // a uid-only setter (hotkey absent on the WeightsSet events)
    uid: 8,
    weight_sets: 10,
    first_set: 1_750_100_000_000,
    last_set: 1_750_200_000_000,
  },
];
const TOTALS = {
  weight_sets: 40,
  distinct_setters: 2,
  newest_observed: 1_750_600_000_000,
};

describe("buildSubnetWeightSetters", () => {
  test("cold / null inputs yield a schema-stable empty leaderboard", () => {
    const cases: [Row[] | null | undefined, Row | null | undefined][] = [
      [null, null],
      [undefined, undefined],
      [[], {}],
    ];
    for (const [rows, totals] of cases) {
      const d = buildSubnetWeightSetters(rows, totals, NETUID, {
        window: "7d",
      }) as Row as Row;
      assert.equal(d.schema_version, 1);
      assert.equal(d.netuid, NETUID);
      assert.equal(d.window, "7d");
      assert.equal(d.observed_at, null);
      assert.equal(d.distinct_setters, 0);
      assert.equal(d.weight_sets, 0);
      assert.equal(d.setter_count, 0);
      assert.deepEqual(d.setters, []);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildSubnetWeightSetters([], {}, NETUID).window, null);
  });

  test("a near-monopoly setter's share does not round up to a flat 1 while others set weights", () => {
    // One setter drove 49999 of the subnet's 50000 WeightsSet events (99.998%);
    // a second setter drove the last 1. A bare 4dp round lifts 0.99998 to exactly
    // 1, reading as if the top setter did ALL the weight-setting. Clamp holds it
    // below 1 while the true sole-setter case (below) still reports 1.
    const d = buildSubnetWeightSetters(
      [
        { hotkey: "5Grw...alice", uid: 3, weight_sets: 49999 },
        { hotkey: "5Frw...bob", uid: 4, weight_sets: 1 },
      ],
      { weight_sets: 50000, distinct_setters: 2 },
      NETUID,
    ) as Row;
    assert.ok(d.setters[0].share < 1, "near-monopoly share must stay below 1");
    assert.equal(d.setters[0].share, 0.9999);
    assert.equal(d.setters[1].share, 0); // 1/50000 rounds to 0.0000 at 4dp
  });

  test("a genuine sole setter keeps an exact share of 1", () => {
    const d = buildSubnetWeightSetters(
      [{ hotkey: "5Grw...alice", uid: 3, weight_sets: 100 }],
      { weight_sets: 100, distinct_setters: 1 },
      NETUID,
    ) as Row;
    assert.equal(d.setters[0].share, 1);
  });

  test("shapes the leaderboard: counts, shares, first/last, nullable hotkey/uid", () => {
    const d = buildSubnetWeightSetters(LEADER_ROWS, TOTALS, NETUID, {
      window: "30d",
    }) as Row;
    assert.equal(d.distinct_setters, 2);
    assert.equal(d.weight_sets, 40);
    assert.equal(d.setter_count, 2);
    assert.equal(d.observed_at, new Date(1_750_600_000_000).toISOString());

    const [a, b] = d.setters;
    assert.equal(a.hotkey, "5Grw...alice");
    assert.equal(a.uid, 3);
    assert.equal(a.weight_sets, 30);
    assert.equal(a.share, 0.75); // 30 / 40
    assert.equal(a.first_set_at, new Date(1_750_000_000_000).toISOString());
    assert.equal(a.last_set_at, new Date(1_750_600_000_000).toISOString());

    assert.equal(b.hotkey, null); // uid-only setter
    assert.equal(b.uid, 8);
    assert.equal(b.share, 0.25); // 10 / 40
  });

  test("share is null when the subnet total is zero", () => {
    const d = buildSubnetWeightSetters(
      [{ hotkey: "5x", uid: 1, weight_sets: 0 }],
      { weight_sets: 0, distinct_setters: 0 },
      NETUID,
    ) as Row;
    assert.equal(d.setters[0].share, null);
  });

  test("rounds share to 4dp", () => {
    const d = buildSubnetWeightSetters(
      [{ hotkey: "5x", uid: 1, weight_sets: 1 }],
      { weight_sets: 3, distinct_setters: 1 },
      NETUID,
    ) as Row;
    assert.equal(d.setters[0].share, 0.3333); // 1/3 = 0.3333...
  });

  test("coerces numeric-string cells and drops junk uid / hotkey / timestamps", () => {
    const d = buildSubnetWeightSetters(
      [
        {
          hotkey: "", // blank -> null
          uid: "12", // numeric string -> 12
          weight_sets: "5",
          first_set: "1750000000000", // numeric-string epoch
          last_set: "not-a-date", // junk -> null
        },
        {
          hotkey: 42, // non-string -> null
          uid: -1, // negative -> null
          weight_sets: -3, // negative -> 0
          first_set: 9e15, // out-of-range -> null
          last_set: 0, // <=0 -> null
        },
        {
          hotkey: "5real", // a hotkey-identified setter that carries no uid
          uid: null, // absent -> null (not a number, not a digit-string)
          weight_sets: 2,
        },
      ],
      { weight_sets: 7, distinct_setters: 2 },
      NETUID,
    ) as Row;
    assert.equal(d.setters[0].hotkey, null);
    assert.equal(d.setters[0].uid, 12);
    assert.equal(d.setters[0].weight_sets, 5);
    assert.equal(
      d.setters[0].first_set_at,
      new Date(1_750_000_000_000).toISOString(),
    );
    assert.equal(d.setters[0].last_set_at, null);
    assert.equal(d.setters[1].hotkey, null);
    assert.equal(d.setters[1].uid, null);
    assert.equal(d.setters[1].weight_sets, 0);
    assert.equal(d.setters[1].first_set_at, null);
    assert.equal(d.setters[1].last_set_at, null);
    assert.equal(d.setters[2].hotkey, "5real"); // hotkey kept
    assert.equal(d.setters[2].uid, null); // uid absent -> null
  });

  test("null-safe on a non-array rows input", () => {
    const d = buildSubnetWeightSetters(
      "nope" as unknown as Row[],
      TOTALS,
      NETUID,
    ) as Row;
    assert.deepEqual(d.setters, []);
    assert.equal(d.weight_sets, 40); // totals still read
  });

  test("exposes the window map, default, and leaderboard cap", () => {
    assert.deepEqual(SUBNET_WEIGHT_SETTERS_WINDOWS, { "7d": 7, "30d": 30 });
    assert.equal(DEFAULT_SUBNET_WEIGHT_SETTERS_WINDOW, "7d");
    assert.equal(SUBNET_WEIGHT_SETTERS_LIMIT, 50);
  });
});

describe("loadSubnetWeightSetters", () => {
  test("runs the leaderboard + totals reads over account_events and shapes them", async () => {
    const captured: Row[] = [];
    const d1 = async (sql: string, params: unknown[]) => {
      captured.push({ sql, params });
      return sql.includes("GROUP BY") ? LEADER_ROWS : [TOTALS];
    };
    const d = (await loadSubnetWeightSetters(d1, NETUID, {
      windowLabel: "7d",
      windowDays: 7,
    })) as Row;
    // Leaderboard read: grouped by the hotkey-or-uid identity, capped, ordered.
    const leader = captured.find((c) => c.sql.includes("GROUP BY"))!;
    assert.match(leader.sql, /FROM account_events/);
    assert.match(leader.sql, /WHEN hotkey IS NOT NULL/);
    assert.match(leader.sql, /'uid:' \|\| netuid \|\| ':' \|\| uid/);
    assert.match(leader.sql, /ORDER BY weight_sets DESC/);
    assert.equal(leader.params[0], NETUID);
    assert.equal(leader.params[1], WEIGHTS_EVENT_KIND);
    assert.equal(typeof leader.params[2], "number"); // cutoff epoch ms
    assert.equal(leader.params[3], SUBNET_WEIGHT_SETTERS_LIMIT);
    // Totals read: distinct-setter count over the same identity, no GROUP BY.
    const totals = captured.find((c) => c.sql.includes("COUNT(DISTINCT"))!;
    assert.doesNotMatch(totals.sql, /GROUP BY/);
    assert.equal(d.setter_count, 2);
    assert.equal(d.weight_sets, 40);
    assert.equal(d.setters[0].share, 0.75);
  });

  test("a cold store (no rows) yields the empty leaderboard", async () => {
    const d = (await loadSubnetWeightSetters(async () => [], 9, {
      windowLabel: "30d",
      windowDays: 30,
    })) as Row;
    assert.equal(d.netuid, 9);
    assert.equal(d.setter_count, 0);
    assert.equal(d.weight_sets, 0);
    assert.deepEqual(d.setters, []);
  });
});

describe("GET /api/v1/subnets/{netuid}/weights/setters", () => {
  function eventsEnv(leaderRows: Row[], totalsRow: Row | null) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: sql.includes("GROUP BY")
                    ? leaderRows
                    : totalsRow
                      ? [totalsRow]
                      : [],
                }),
            }),
          };
        },
      },
    };
  }

  test("defaults to the 7d window when omitted", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/subnets/${NETUID}/weights/setters`,
      ),
      eventsEnv([], null) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.window, "7d");
  });

  test("rejects an unknown query parameter with 400", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/subnets/${NETUID}/weights/setters?bogus=1`,
      ),
      eventsEnv([], null) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/subnets/${NETUID}/weights/setters?window=1y`,
      ),
      eventsEnv([], null) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.meta.parameter, "window");
  });

  test("cold store → 200 with an empty leaderboard", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/subnets/${NETUID}/weights/setters`,
      ),
      eventsEnv([], null) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.setter_count, 0);
    assert.deepEqual(body.data.setters, []);
  });
});

// #9389: the overdue verdict. `weight_sets` alone hides a dead tail -- a setter can post a
// healthy-looking count and then stop -- so the alarm is the gap between its last set and
// the subnet's own tempo.
describe("buildSubnetWeightSetters — overdue detection (#9389)", () => {
  const TEMPO = 360; // blocks; * 12s = 72 min per tempo
  const TEMPO_MS = TEMPO * 12 * 1000;
  const NOW = 1_785_800_000_000;

  function card(lastSetMs: number, tempo: unknown = TEMPO) {
    return buildSubnetWeightSetters(
      [
        {
          hotkey: "5Grw...alice",
          uid: 3,
          weight_sets: 45,
          last_set: lastSetMs,
        },
      ],
      { weight_sets: 45, distinct_setters: 1, newest_observed: NOW },
      NETUID,
      { window: "7d", tempo },
    );
  }

  test("a setter inside the jitter band is NOT overdue", () => {
    // One missed tempo is a restart or a slow epoch, not an outage. Alarming here is
    // what #9330 spent a PR removing from the watchdogs.
    const setter = (card(NOW - TEMPO_MS).setters as Row[])[0];
    assert.equal(setter.overdue, false);
    assert.equal(setter.tempos_since_last_set, 1);
  });

  test("the real SN8 case is caught", () => {
    // Measured live 2026-08-04: a setter with 45 sets in the window whose last was
    // 6.3 days earlier. The count looks healthy; the tail is dead.
    const setter = (card(NOW - 9111 * 60 * 1000).setters as Row[])[0];
    assert.equal(setter.overdue, true);
    assert.equal(
      setter.weight_sets,
      45,
      "the healthy-looking count is unchanged",
    );
    assert.ok((setter.tempos_since_last_set as number) > 100);
  });

  test("the payload counts and explains its own verdicts", () => {
    const c = card(NOW - 10 * TEMPO_MS);
    assert.equal(c.overdue_setter_count, 1);
    assert.equal(c.tempo, TEMPO);
    assert.equal(c.overdue_tempo_multiple, 3);
  });

  test("an unknown tempo leaves overdue NULL, never false", () => {
    // "We could not evaluate" is not "on time". A false here would be a confident wrong
    // answer about the one signal this route exists to give.
    // Built inline rather than through card(), whose default parameter would swallow
    // an explicit `undefined` and silently test the happy path instead.
    for (const tempo of [null, undefined, 0, "abc", -1, 1.5e308]) {
      const c = buildSubnetWeightSetters(
        [
          {
            hotkey: "5Grw...alice",
            uid: 3,
            weight_sets: 45,
            last_set: NOW - 50 * TEMPO_MS,
          },
        ],
        { weight_sets: 45, distinct_setters: 1, newest_observed: NOW },
        NETUID,
        { window: "7d", tempo },
      );
      const setter = (c.setters as Row[])[0];
      assert.equal(setter.overdue, null, `tempo=${String(tempo)}`);
      assert.equal(setter.tempos_since_last_set, null);
      assert.equal(c.tempo, null);
      // An unevaluated setter is not counted as overdue.
      assert.equal(c.overdue_setter_count, 0);
    }
  });

  test("a setter with no last_set_at is not evaluated", () => {
    const c = buildSubnetWeightSetters(
      [{ hotkey: "5Grw...alice", uid: 3, weight_sets: 1, last_set: null }],
      { weight_sets: 1, distinct_setters: 1, newest_observed: NOW },
      NETUID,
      { window: "7d", tempo: TEMPO },
    );
    assert.equal((c.setters as Row[])[0].overdue, null);
    assert.equal(c.overdue_setter_count, 0);
  });

  test("lag is measured against the window's newest event, not wall-clock now", () => {
    // A tier that answered an hour late must not report an extra hour of lag on every
    // setter -- the payload has to be internally consistent.
    const setter = (card(NOW - 2 * TEMPO_MS).setters as Row[])[0];
    assert.equal(setter.seconds_since_last_set, (2 * TEMPO_MS) / 1000);
  });

  test("a setter that last set AFTER the window's newest event clamps to zero", () => {
    const setter = (card(NOW + 60_000).setters as Row[])[0];
    assert.equal(setter.seconds_since_last_set, 0);
    assert.equal(setter.overdue, false);
  });

  test("the existing fields are untouched", () => {
    const setter = (card(NOW - TEMPO_MS).setters as Row[])[0];
    assert.equal(setter.hotkey, "5Grw...alice");
    assert.equal(setter.uid, 3);
    assert.equal(setter.weight_sets, 45);
    assert.equal(setter.share, 1);
  });
});

describe("loadSubnetWeightSetters — the tempo read cannot break the leaderboard (#9389)", () => {
  const LEADER = [
    {
      hotkey: "5Grw...alice",
      uid: 3,
      weight_sets: 5,
      first_set: 1,
      last_set: 2,
    },
  ];
  const TOTALS = [{ weight_sets: 5, distinct_setters: 1, newest_observed: 2 }];

  function runner(onHyperparams: () => Promise<Row[]>) {
    const seen: string[] = [];
    return {
      seen,
      d1: async (sql: string) => {
        seen.push(sql);
        if (sql.includes("subnet_hyperparams")) return onHyperparams();
        if (sql.includes("COUNT(DISTINCT")) return TOTALS;
        return LEADER;
      },
    };
  }

  test("a throwing hyperparams read still serves the leaderboard", async () => {
    // The whole card must not be lost because a cadence was unknown -- that trades a
    // useful answer for no answer.
    const { d1, seen } = runner(async () => {
      throw new Error("D1_ERROR: no such table: subnet_hyperparams");
    });
    const card = await loadSubnetWeightSetters(d1, NETUID, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.equal((card.setters as Row[]).length, 1);
    assert.equal(card.tempo, null);
    assert.equal((card.setters as Row[])[0].overdue, null);
    assert.equal(card.overdue_setter_count, 0);
    assert.ok(seen.some((s) => s.includes("subnet_hyperparams")));
  });

  test("a subnet with no hyperparams row leaves the verdicts unevaluated", async () => {
    const { d1 } = runner(async () => []);
    const card = await loadSubnetWeightSetters(d1, NETUID, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.equal(card.tempo, null);
    assert.equal((card.setters as Row[])[0].overdue, null);
  });

  test("a present tempo is looked up by primary key, not scanned", async () => {
    const { d1, seen } = runner(async () => [{ tempo: 360 }]);
    const card = await loadSubnetWeightSetters(d1, NETUID, {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.equal(card.tempo, 360);
    const hp = seen.find((s) => s.includes("subnet_hyperparams"))!;
    assert.match(hp, /WHERE netuid = \?/);
  });
});
