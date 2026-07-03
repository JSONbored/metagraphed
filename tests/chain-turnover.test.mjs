import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  buildChainTurnover,
  loadChainTurnover,
} from "../src/chain-turnover.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

describe("buildChainTurnover", () => {
  test("cold / empty / non-array / no-window inputs yield a schema-stable empty block", () => {
    const cases = [
      { rows: [], opts: { window: "30d" } },
      { rows: [], opts: { window: "30d", startDate: null, endDate: null } },
      // dates present but no rows:
      {
        rows: [],
        opts: { window: "30d", startDate: "2026-06-01", endDate: "2026-06-30" },
      },
      // non-array rows → coerced to []:
      {
        rows: null,
        opts: { window: "7d", startDate: "2026-06-01", endDate: "2026-06-30" },
      },
      { rows: undefined, opts: {} }, // also exercises the window ?? null default
    ];
    for (const { rows, opts } of cases) {
      const data = buildChainTurnover(rows, opts);
      assert.equal(data.schema_version, 1);
      assert.equal(data.comparable, false);
      assert.equal(data.subnet_count, 0);
      assert.equal(data.validators_entered, 0);
      assert.equal(data.validator_retention, null);
      assert.equal(data.neuron_retention, null);
      assert.equal(data.stability_score, null);
    }
    // An omitted window resolves to null in the envelope.
    assert.equal(buildChainTurnover([], {}).window, null);
  });

  test("rows present but neither boundary date resolves is not comparable", () => {
    // Only a mid-window snapshot exists; the requested boundary dates have no
    // rows. jaccard(empty, empty) = 1 must NOT surface as perfect retention.
    const data = buildChainTurnover(
      [
        {
          snapshot_date: "2026-06-15",
          netuid: 1,
          uid: 0,
          hotkey: "H0",
          validator_permit: 1,
        },
      ],
      { window: "30d", startDate: "2026-06-01", endDate: "2026-06-30" },
    );
    assert.equal(data.comparable, false);
    assert.equal(data.subnet_count, 0);
    assert.equal(data.validator_retention, null);
    assert.equal(data.neuron_retention, null);
    assert.equal(data.stability_score, null);
    assert.equal(data.validators_start, 0);
    assert.equal(data.neurons_end, 0);
  });

  test("a missing end snapshot is not read as total churn", () => {
    const data = buildChainTurnover(
      [
        {
          snapshot_date: "2026-06-01",
          netuid: 1,
          uid: 0,
          hotkey: "V1",
          validator_permit: 1,
        },
      ],
      { window: "30d", startDate: "2026-06-01", endDate: "2026-06-30" },
    );
    assert.equal(data.comparable, false);
    assert.equal(data.validator_retention, null);
    assert.equal(data.stability_score, null);
  });

  test("computes network-wide churn across MULTIPLE subnets", () => {
    const rows = [
      // subnet 1 start: validators V1 (uid0), V2 (uid1); miner M1 (uid2)
      {
        snapshot_date: "2026-06-01",
        netuid: 1,
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        netuid: 1,
        uid: 1,
        hotkey: "V2",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        netuid: 1,
        uid: 2,
        hotkey: "M1",
        validator_permit: 0,
      },
      // subnet 7 start: validator W1 (uid0)
      {
        snapshot_date: "2026-06-01",
        netuid: 7,
        uid: 0,
        hotkey: "W1",
        validator_permit: 1,
      },
      // subnet 1 end: V1 retained; uid1 swapped V2→V3 (a dereg); M1 retained
      {
        snapshot_date: "2026-06-30",
        netuid: 1,
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: 1,
        uid: 1,
        hotkey: "V3",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: 1,
        uid: 2,
        hotkey: "M1",
        validator_permit: 0,
      },
      // subnet 7 end: W1 retained
      {
        snapshot_date: "2026-06-30",
        netuid: 7,
        uid: 0,
        hotkey: "W1",
        validator_permit: 1,
      },
    ];
    const data = buildChainTurnover(rows, {
      window: "30d",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    assert.equal(data.comparable, true);
    assert.equal(data.start_date, "2026-06-01");
    assert.equal(data.end_date, "2026-06-30");
    assert.equal(data.subnet_count, 2); // netuids 1 and 7
    // validator ids: start {1:V1, 1:V2, 7:W1}; end {1:V1, 1:V3, 7:W1}
    assert.equal(data.validators_start, 3);
    assert.equal(data.validators_end, 3);
    assert.equal(data.validators_entered, 1); // 1:V3
    assert.equal(data.validators_exited, 1); // 1:V2
    assert.equal(data.validator_retention, 0.5); // {1:V1,7:W1} / union of 4
    assert.equal(data.neurons_start, 4);
    assert.equal(data.neurons_end, 4);
    assert.equal(data.uids_deregistered, 1); // slot 1:1 swapped V2 → V3
    // neuron ids retained: {1:0:V1, 1:2:M1, 7:0:W1} = 3 of 5 distinct
    assert.equal(data.neuron_retention, 0.6);
    assert.equal(data.stability_score, 55); // round((0.5 + 0.6)/2 * 100)
  });

  test("netuid-scoped keys: identical uids on different subnets never collide", () => {
    // uid 0 exists on subnet 1 AND subnet 7 with different hotkeys at each
    // boundary. If keys weren't netuid-scoped, the two would clobber each other.
    const rows = [
      {
        snapshot_date: "2026-06-01",
        netuid: 1,
        uid: 0,
        hotkey: "A1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        netuid: 7,
        uid: 0,
        hotkey: "B1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: 1,
        uid: 0,
        hotkey: "A1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: 7,
        uid: 0,
        hotkey: "B1",
        validator_permit: 1,
      },
    ];
    const data = buildChainTurnover(rows, {
      window: "30d",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    assert.equal(data.subnet_count, 2);
    assert.equal(data.validators_start, 2); // 1:A1 and 7:B1, distinct
    assert.equal(data.validators_end, 2);
    assert.equal(data.neurons_start, 2); // 1:0 and 7:0, distinct slots
    assert.equal(data.validator_retention, 1);
    assert.equal(data.neuron_retention, 1);
    assert.equal(data.stability_score, 100);
    assert.equal(data.uids_deregistered, 0);
  });

  test("a hotkey validating on two subnets counts once PER subnet", () => {
    // The same hotkey "SHARED" holds a permit on subnet 1 and subnet 7. It must
    // be two distinct validator identities (1:SHARED, 7:SHARED).
    const rows = [
      {
        snapshot_date: "2026-06-01",
        netuid: 1,
        uid: 0,
        hotkey: "SHARED",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        netuid: 7,
        uid: 4,
        hotkey: "SHARED",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: 1,
        uid: 0,
        hotkey: "SHARED",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: 7,
        uid: 4,
        hotkey: "SHARED",
        validator_permit: 1,
      },
    ];
    const data = buildChainTurnover(rows, {
      window: "30d",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    assert.equal(data.validators_start, 2); // 1:SHARED and 7:SHARED
    assert.equal(data.validators_end, 2);
    assert.equal(data.validator_retention, 1);
  });

  test("subnet_count counts DISTINCT netuids, ignoring blank/non-integer/negative", () => {
    const rows = [
      {
        snapshot_date: "2026-06-01",
        netuid: 1,
        uid: 0,
        hotkey: "A",
        validator_permit: 0,
      },
      {
        snapshot_date: "2026-06-01",
        netuid: "1", // numeric string — same subnet, not double-counted
        uid: 1,
        hotkey: "B",
        validator_permit: 0,
      },
      {
        snapshot_date: "2026-06-01",
        netuid: 2,
        uid: 0,
        hotkey: "C",
        validator_permit: 0,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: "", // blank → must not coerce to subnet 0
        uid: 0,
        hotkey: "A",
        validator_permit: 0,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: "abc", // non-integer → skipped
        uid: 1,
        hotkey: "B",
        validator_permit: 0,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: -1, // negative → skipped
        uid: 2,
        hotkey: "D",
        validator_permit: 0,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: 1,
        uid: 0,
        hotkey: "A",
        validator_permit: 0,
      },
    ];
    const data = buildChainTurnover(rows, {
      window: "30d",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    assert.equal(data.subnet_count, 2); // netuids 1 and 2 only
  });

  test("a single snapshot (start === end) is flagged not comparable but trivially stable", () => {
    const rows = [
      {
        snapshot_date: "2026-06-30",
        netuid: 1,
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-30",
        netuid: 1,
        uid: 1,
        hotkey: "M1",
        validator_permit: 0,
      },
    ];
    const data = buildChainTurnover(rows, {
      window: "7d",
      startDate: "2026-06-30",
      endDate: "2026-06-30",
    });
    assert.equal(data.comparable, false);
    assert.equal(data.subnet_count, 1);
    assert.equal(data.validators_entered, 0);
    assert.equal(data.validators_exited, 0);
    assert.equal(data.validator_retention, 1);
    assert.equal(data.uids_deregistered, 0);
    assert.equal(data.neuron_retention, 1);
    assert.equal(data.stability_score, 100);
  });

  test("a UID-slot hotkey reassignment is a deregistration (keyed by netuid:uid)", () => {
    const rows = [
      {
        snapshot_date: "2026-05-01",
        netuid: 3,
        uid: 5,
        hotkey: "OLD",
        validator_permit: 0,
      },
      {
        snapshot_date: "2026-06-01",
        netuid: 3,
        uid: 5,
        hotkey: "NEW",
        validator_permit: 0,
      },
    ];
    const data = buildChainTurnover(rows, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.equal(data.uids_deregistered, 1); // slot 3:5 swapped OLD → NEW
    assert.equal(data.neuron_retention, 0); // {3:5:OLD} vs {3:5:NEW}, disjoint
  });

  test("anti-overstatement: a sub-perfect retention mean must not round stability up to 100", () => {
    // 100 retained neurons on subnet 1 (one a retained validator) plus one new
    // neuron at the end: neuron_retention = 100/101 ≈ 0.9901, validator_retention
    // = 1, mean ≈ 0.99505 → must clamp to 99, never an overstated 100.
    const rows = [];
    for (let uid = 0; uid < 100; uid += 1) {
      const validator_permit = uid === 0 ? 1 : 0;
      rows.push({
        snapshot_date: "2026-05-01",
        netuid: 1,
        uid,
        hotkey: `H${uid}`,
        validator_permit,
      });
      rows.push({
        snapshot_date: "2026-06-01",
        netuid: 1,
        uid,
        hotkey: `H${uid}`,
        validator_permit,
      });
    }
    rows.push({
      snapshot_date: "2026-06-01",
      netuid: 1,
      uid: 100,
      hotkey: "Hnew",
      validator_permit: 0,
    });
    const data = buildChainTurnover(rows, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.equal(data.validator_retention, 1);
    assert.equal(data.neuron_retention, 0.9901); // 100/101, churned
    assert.equal(data.stability_score, 99); // clamped, never an overstated 100
  });

  test("round() clamp: a sub-perfect jaccard that would round up to 1 clamps to 0.9999", () => {
    const rows = [];
    for (let uid = 0; uid < 20000; uid++) {
      rows.push({
        snapshot_date: "2026-05-01",
        netuid: 1,
        uid,
        hotkey: `M${uid}`,
        validator_permit: 0,
      });
    }
    for (let uid = 0; uid < 19999; uid++) {
      rows.push({
        snapshot_date: "2026-06-01",
        netuid: 1,
        uid,
        hotkey: `M${uid}`,
        validator_permit: 0,
      });
    }
    const data = buildChainTurnover(rows, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.ok(
      data.neuron_retention < 1,
      "sub-perfect retention must not round up to 1",
    );
    assert.equal(data.neuron_retention, 0.9999); // clamped; naïve Math.round gives 1
  });

  test("rows without a hotkey or a valid netuid are skipped from the sets", () => {
    const rows = [
      {
        snapshot_date: "2026-05-01",
        netuid: 1,
        uid: 0,
        hotkey: null, // no hotkey → skipped
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-05-01",
        netuid: null, // no netuid → skipped
        uid: 1,
        hotkey: "V2",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        netuid: 1,
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
    ];
    const data = buildChainTurnover(rows, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.equal(data.validators_start, 0); // both start rows skipped
    assert.equal(data.validators_end, 1); // 1:V1
    assert.equal(data.neurons_start, 0);
    assert.equal(data.neurons_end, 1);
  });
});

describe("chain-turnover invariants", () => {
  test("retentions in [0,1], stability in [0,100], entered/exited consistent with set sizes", () => {
    const rows = [
      {
        snapshot_date: "2026-05-01",
        netuid: 1,
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-05-01",
        netuid: 2,
        uid: 0,
        hotkey: "V2",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        netuid: 1,
        uid: 0,
        hotkey: "V1",
        validator_permit: 1,
      },
      {
        snapshot_date: "2026-06-01",
        netuid: 2,
        uid: 0,
        hotkey: "V3",
        validator_permit: 1,
      },
    ];
    const data = buildChainTurnover(rows, {
      window: "30d",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    assert.ok(data.validator_retention >= 0 && data.validator_retention <= 1);
    assert.ok(data.neuron_retention >= 0 && data.neuron_retention <= 1);
    assert.ok(data.stability_score >= 0 && data.stability_score <= 100);
    assert.equal(
      data.validators_start - data.validators_exited,
      data.validators_end - data.validators_entered,
    );
  });
});

describe("loadChainTurnover", () => {
  function d1(rowsBySql = {}, captures = { sql: [], params: [] }) {
    return async (sql, params) => {
      captures.sql.push(sql);
      captures.params.push(params);
      for (const [pattern, rows] of Object.entries(rowsBySql)) {
        if (new RegExp(pattern).test(sql)) return rows;
      }
      return [];
    };
  }

  test("returns schema-stable empty on cold D1", async () => {
    const data = await loadChainTurnover(d1(), {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(data.window, "30d");
    assert.equal(data.comparable, false);
    assert.equal(data.subnet_count, 0);
    assert.equal(data.validator_retention, null);
    assert.equal(data.stability_score, null);
  });

  test("issues a NO-netuid-filter bounds + two-boundary SELECT and shapes the rows", async () => {
    const captures = { sql: [], params: [] };
    const data = await loadChainTurnover(
      d1(
        {
          "MIN\\(snapshot_date\\)": [
            { start_date: "2026-06-01", end_date: "2026-06-30" },
          ],
          "snapshot_date IN": [
            {
              snapshot_date: "2026-06-01",
              netuid: 1,
              uid: 0,
              hotkey: "V1",
              validator_permit: 1,
            },
            {
              snapshot_date: "2026-06-01",
              netuid: 2,
              uid: 0,
              hotkey: "V2",
              validator_permit: 1,
            },
            {
              snapshot_date: "2026-06-30",
              netuid: 1,
              uid: 0,
              hotkey: "V1",
              validator_permit: 1,
            },
            {
              snapshot_date: "2026-06-30",
              netuid: 2,
              uid: 0,
              hotkey: "V3",
              validator_permit: 1,
            },
          ],
        },
        captures,
      ),
      { windowLabel: "30d", windowDays: 30 },
    );
    // Bounds query: neuron_daily, NO `WHERE netuid` filter.
    assert.match(captures.sql[0], /MIN\(snapshot_date\)/);
    assert.match(captures.sql[0], /FROM neuron_daily/);
    assert.doesNotMatch(captures.sql[0], /netuid = \?/);
    assert.doesNotMatch(captures.sql[0], /WHERE netuid/);
    // Rows query: the two-boundary SELECT, ordered by date/netuid/uid, no filter.
    assert.match(captures.sql[1], /snapshot_date IN \(\?, \?\)/);
    assert.match(captures.sql[1], /netuid/); // reads the netuid column
    assert.doesNotMatch(captures.sql[1], /netuid = \?/);
    assert.match(captures.sql[1], /ORDER BY snapshot_date ASC, netuid ASC/);
    assert.deepEqual(captures.params[1], ["2026-06-01", "2026-06-30"]);
    assert.equal(data.subnet_count, 2);
    assert.equal(data.comparable, true);
  });

  test("omits the date cutoff for the all window (params has no cutoff)", async () => {
    const captures = { sql: [], params: [] };
    await loadChainTurnover(
      d1(
        {
          "MIN\\(snapshot_date\\)": [
            { start_date: "2026-06-01", end_date: "2026-06-30" },
          ],
          "snapshot_date IN": [],
        },
        captures,
      ),
      { windowLabel: "all", windowDays: null },
    );
    assert.match(captures.sql[0], /MIN\(snapshot_date\)/);
    assert.deepEqual(captures.params[0], []); // no cutoff param
    assert.doesNotMatch(captures.sql[0], /snapshot_date >=/);
  });

  test("binds the exact 30d cutoff date on the bounds query", async () => {
    const fixedNow = new Date("2026-06-30T12:00:00.000Z");
    const captures = { sql: [], params: [] };
    try {
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow);
      await loadChainTurnover(
        d1(
          {
            "MIN\\(snapshot_date\\)": [
              { start_date: "2026-05-31", end_date: "2026-06-30" },
            ],
            "snapshot_date IN": [],
          },
          captures,
        ),
        { windowLabel: "30d", windowDays: 30 },
      );
    } finally {
      vi.useRealTimers();
    }
    assert.match(captures.sql[0], /snapshot_date >= \?/);
    assert.deepEqual(captures.params[0], ["2026-05-31"]);
    assert.deepEqual(captures.params[1], ["2026-05-31", "2026-06-30"]);
  });
});

describe("GET /api/v1/chain/turnover", () => {
  // The MIN/MAX bounds query and the two-boundary read both hit `FROM
  // neuron_daily`, so route the bounds (MIN(snapshot_date)) query first.
  function neuronDailyEnv(bounds, rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /MIN\(snapshot_date\)/.test(sql) ? bounds : rows,
                }),
            }),
          };
        },
      },
    };
  }

  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/turnover${q}`);

  test("summarizes network-wide churn across subnets", async () => {
    const res = await handleRequest(
      req("?window=30d"),
      neuronDailyEnv(
        [{ start_date: "2026-06-01", end_date: "2026-06-30" }],
        [
          {
            snapshot_date: "2026-06-01",
            netuid: 1,
            uid: 0,
            hotkey: "V1",
            validator_permit: 1,
          },
          {
            snapshot_date: "2026-06-01",
            netuid: 2,
            uid: 0,
            hotkey: "V2",
            validator_permit: 1,
          },
          {
            snapshot_date: "2026-06-30",
            netuid: 1,
            uid: 0,
            hotkey: "V1",
            validator_permit: 1,
          },
          {
            snapshot_date: "2026-06-30",
            netuid: 2,
            uid: 0,
            hotkey: "V3",
            validator_permit: 1,
          },
        ],
      ),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.comparable, true);
    assert.equal(body.data.subnet_count, 2);
    assert.equal(body.data.start_date, "2026-06-01");
    assert.equal(body.data.end_date, "2026-06-30");
    assert.equal(body.data.validators_entered, 1); // 2:V3
    assert.equal(body.data.validators_exited, 1); // 2:V2
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("cold store → 200 with a schema-stable empty block", async () => {
    const res = await handleRequest(
      req(),
      neuronDailyEnv([{ start_date: null, end_date: null }], []),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.comparable, false);
    assert.equal(body.data.subnet_count, 0);
    assert.equal(body.data.validator_retention, null);
  });

  test("rejects an unexpected query parameter with 400", async () => {
    const res = await handleRequest(
      req("?bogus=1"),
      neuronDailyEnv([], []),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an invalid window with 400", async () => {
    const res = await handleRequest(
      req("?window=400d"),
      neuronDailyEnv([], []),
      {},
    );
    assert.equal(res.status, 400);
  });
});
