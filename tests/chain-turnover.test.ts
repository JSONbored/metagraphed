import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildChainTurnover,
  loadChainTurnover,
  CHAIN_TURNOVER_LIMIT_MAX,
  DEFAULT_CHAIN_TURNOVER_WINDOW,
} from "../src/chain-turnover.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

// One neuron_daily validator row (the loader scopes the read to validator_permit = 1).
function vrow(
  snapshot_date: string,
  netuid: unknown,
  hotkey: string,
  validator_permit = 1,
) {
  return { snapshot_date, netuid, hotkey, validator_permit };
}

const START = "2026-05-31";
const END = "2026-06-30";

// netuid 1: {A,B} -> {B,D} (A exits, D enters); netuid 2: {C} -> {C} (stable).
const ROWS = [
  vrow(START, 1, "A"),
  vrow(START, 1, "B"),
  vrow(START, 2, "C"),
  vrow(END, 1, "B"),
  vrow(END, 1, "D"),
  vrow(END, 2, "C"),
];

describe("buildChainTurnover", () => {
  test("computes per-subnet validator churn ranked most-volatile first", () => {
    const data = buildChainTurnover(ROWS, {
      window: "30d",
      startDate: START,
      endDate: END,
    });
    assert.equal(data.schema_version, 1);
    assert.equal(data.comparable, true);
    assert.equal(data.subnet_count, 2);
    // netuid 1 churned (1 in, 1 out) so it ranks ahead of the stable netuid 2.
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [1, 2],
    );
    const s1 = data.subnets.find((s) => s.netuid === 1)!;
    assert.equal(s1.validators_start, 2);
    assert.equal(s1.validators_end, 2);
    assert.equal(s1.validators_entered, 1); // D
    assert.equal(s1.validators_exited, 1); // A
    assert.equal(s1.validator_retention, 0.3333); // |{B}| / |{A,B,D}| = 1/3
    assert.equal(s1.stability_score, 33);
    const s2 = data.subnets.find((s) => s.netuid === 2)!;
    assert.equal(s2.validators_entered, 0);
    assert.equal(s2.validators_exited, 0);
    assert.equal(s2.validator_retention, 1);
    assert.equal(s2.stability_score, 100);
  });

  test("rolls up a network summary over the union validator set", () => {
    const { network } = buildChainTurnover(ROWS, {
      window: "30d",
      startDate: START,
      endDate: END,
    });
    // union start {A,B,C}, end {B,C,D}: A exits, D enters, {B,C} retained.
    assert.equal(network.validators_start, 3);
    assert.equal(network.validators_end, 3);
    assert.equal(network.validators_entered, 1);
    assert.equal(network.validators_exited, 1);
    assert.equal(network.validator_retention, 0.5); // 2/4
    assert.equal(network.stability_score, 50);
  });

  test("summarizes the spread of per-subnet stability into a distribution", () => {
    // netuid 1 stability 33, netuid 2 stability 100 -> scores [33, 100].
    const { stability_distribution: dist } = buildChainTurnover(ROWS, {
      startDate: START,
      endDate: END,
    });
    assert.equal(dist!.count, 2);
    assert.equal(dist!.mean, 66.5);
    assert.equal(dist!.min, 33);
    assert.equal(dist!.p25, 33); // nearest-rank: ceil(.25*2)=1 -> asc[0]
    // conventional median of an even set = mean of the two middles (33 + 100) / 2,
    // NOT the lower-middle 33 a nearest-rank p50 returns.
    assert.equal(dist!.median, 66.5);
    assert.equal(dist!.p75, 100); // ceil(.75*2)=2 -> asc[1]
    assert.equal(dist!.p90, 100);
    assert.equal(dist!.max, 100);
  });

  test("distribution counts every subnet even when the leaderboard is truncated", () => {
    const { stability_distribution: dist } = buildChainTurnover(ROWS, {
      startDate: START,
      endDate: END,
      limit: 1,
    });
    assert.equal(dist!.count, 2); // both subnets, though only 1 is returned
  });

  test("a hotkey validating on several subnets counts once network-wide", () => {
    // A validates on both subnets at both boundaries: union set is just {A}, fully retained,
    // even though it appears in two per-subnet sets.
    const rows = [
      vrow(START, 1, "A"),
      vrow(START, 2, "A"),
      vrow(END, 1, "A"),
      vrow(END, 2, "A"),
    ];
    const { network } = buildChainTurnover(rows, {
      startDate: START,
      endDate: END,
    });
    assert.equal(network.validators_start, 1);
    assert.equal(network.validators_end, 1);
    assert.equal(network.validator_retention, 1);
  });

  test("stability never rounds a churned set up to a flawless 100", () => {
    // 400 validators start; rotate exactly one out and one in -> retention 399/401 ≈ 0.99501,
    // which Math.round would push to 100. The anti-overstatement clamp must hold it at 99.
    const rows = [];
    for (let i = 0; i < 400; i += 1) rows.push(vrow(START, 1, `hk_${i}`));
    for (let i = 1; i < 400; i += 1) rows.push(vrow(END, 1, `hk_${i}`)); // drop hk_0
    rows.push(vrow(END, 1, "hk_new")); // add one
    const data = buildChainTurnover(rows, { startDate: START, endDate: END });
    const s1 = data.subnets[0];
    assert.equal(s1.validators_entered, 1);
    assert.equal(s1.validators_exited, 1);
    assert.ok(s1.validator_retention < 1);
    assert.equal(s1.stability_score, 99); // clamped, not 100
  });

  test("handles subnets present at only one boundary", () => {
    // netuid 1 at both, netuid 2 only at start (fully exited), netuid 3 only at end (new).
    const rows = [
      vrow(START, 1, "A"),
      vrow(START, 2, "B"),
      vrow(END, 1, "A"),
      vrow(END, 3, "C"),
    ];
    const data = buildChainTurnover(rows, { startDate: START, endDate: END });
    const s2 = data.subnets.find((s) => s.netuid === 2)!;
    assert.equal(s2.validators_start, 1);
    assert.equal(s2.validators_end, 0); // start.perNetuid has it, end falls back to empty
    assert.equal(s2.validators_exited, 1);
    assert.equal(s2.validator_retention, 0);
    const s3 = data.subnets.find((s) => s.netuid === 3)!;
    assert.equal(s3.validators_start, 0); // end.perNetuid has it, start falls back to empty
    assert.equal(s3.validators_end, 1);
    assert.equal(s3.validators_entered, 1);
  });

  test("breaks a gross-churn tie by netuid ascending", () => {
    // netuid 5 and netuid 3 each rotate exactly one validator (gross churn 2) -> tie,
    // broken by the lower netuid first.
    const rows = [
      vrow(START, 5, "A"),
      vrow(START, 3, "C"),
      vrow(END, 5, "B"),
      vrow(END, 3, "D"),
    ];
    const data = buildChainTurnover(rows, { startDate: START, endDate: END });
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [3, 5],
    );
  });

  test("caps the leaderboard to limit but counts every subnet", () => {
    const data = buildChainTurnover(ROWS, {
      startDate: START,
      endDate: END,
      limit: 1,
    });
    assert.equal(data.subnet_count, 2);
    assert.equal(data.subnets.length, 1);
    assert.equal(data.subnets[0].netuid, 1); // the most volatile
  });

  test("clamps a non-integer / negative / over-max limit", () => {
    const n = (limit: number) =>
      buildChainTurnover(ROWS, { startDate: START, endDate: END, limit })
        .subnets.length;
    assert.equal(n(1.9), 1); // floored
    assert.equal(n(-5), 0); // negative -> 0
    assert.equal(n(9999), 2); // over-max clamps, capped by data (2 subnets)
    assert.equal(n(Number.NaN), 2); // non-finite -> default (>= data length here)
    assert.ok(CHAIN_TURNOVER_LIMIT_MAX >= 100);
  });

  test("validator_retention clamps a sub-perfect jaccard that would round up to 1", () => {
    // 20000 validators at start, 19999 retained at end (one exits): jaccard = 19999/20000 =
    // 0.99995, which Math.round(0.99995 * 10000) / 10000 = 1 without the clamp. round() must
    // intercept it and return 0.9999, so a churned set never reports a flawless retention.
    const rows = [];
    for (let i = 0; i < 20000; i += 1) rows.push(vrow(START, 1, `v_${i}`));
    for (let i = 0; i < 19999; i += 1) rows.push(vrow(END, 1, `v_${i}`)); // drop v_19999
    const data = buildChainTurnover(rows, { startDate: START, endDate: END });
    assert.equal(data.subnets[0].validator_retention, 0.9999); // clamped, not 1
  });

  test("ignores non-validator rows (validator_permit != 1)", () => {
    const rows = [
      vrow(START, 1, "A"),
      vrow(START, 1, "M", 0), // a miner, must be ignored
      vrow(END, 1, "A"),
      vrow(END, 1, "M", 0),
    ];
    const data = buildChainTurnover(rows, { startDate: START, endDate: END });
    assert.equal(data.subnets[0].validators_start, 1); // only A
    assert.equal(data.subnets[0].validators_end, 1);
    assert.equal(data.subnets[0].validator_retention, 1);
  });

  test("skips rows with a malformed, null, or blank-string netuid", () => {
    const rows = [
      vrow(START, 1, "A"),
      { snapshot_date: START, netuid: "bad", hotkey: "Z", validator_permit: 1 },
      { snapshot_date: START, netuid: null, hotkey: "N", validator_permit: 1 },
      // Blank and whitespace-only strings both coerce to 0 via Number(); they must be rejected
      // outright, never counted as a phantom subnet 0.
      { snapshot_date: START, netuid: "", hotkey: "E", validator_permit: 1 },
      { snapshot_date: START, netuid: "  ", hotkey: "W", validator_permit: 1 },
      vrow(END, 1, "A"),
    ];
    const data = buildChainTurnover(rows, { startDate: START, endDate: END });
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1); // not a phantom subnet 0 from the blank strings
  });

  test("rows carrying no validators yield an empty scorecard, never NaN", () => {
    // Both boundaries have rows, but every row is a miner (validator_permit 0): no per-subnet
    // sets, so the leaderboard + distribution are empty and the network jaccard(empty, empty)
    // resolves to a defined retention of 1 rather than NaN.
    const rows = [vrow(START, 1, "A", 0), vrow(END, 1, "A", 0)];
    const data = buildChainTurnover(rows, { startDate: START, endDate: END });
    assert.equal(data.subnet_count, 0);
    assert.deepEqual(data.subnets, []);
    assert.equal(data.stability_distribution, null);
    assert.equal(data.network.validators_start, 0);
    assert.equal(data.network.validator_retention, 1); // jaccard(empty, empty) = 1
    assert.equal(data.network.stability_score, 100);
  });

  test("cold / unresolvable-boundary inputs yield a schema-stable empty block", () => {
    for (const opts of [
      { window: "30d", startDate: null, endDate: null },
      { window: "30d", startDate: START, endDate: END }, // rows empty below
    ]) {
      const data = buildChainTurnover([], opts);
      assert.equal(data.schema_version, 1);
      assert.equal(data.comparable, false);
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.network.validator_retention, null);
      assert.equal(data.network.stability_score, null);
      assert.equal(data.stability_distribution, null);
    }
  });

  test("a boundary date resolving to no rows is not comparable", () => {
    // Rows exist only for the end date -> the start boundary is unresolvable.
    const data = buildChainTurnover([vrow(END, 1, "A")], {
      startDate: START,
      endDate: END,
    });
    assert.equal(data.comparable, false);
    assert.deepEqual(data.subnets, []);
  });

  test("a single snapshot (start === end) with rows yields the empty block", () => {
    // Even with real rows on that date, comparing a snapshot to itself is not a change; the
    // builder must return the empty block (comparable:false, empty leaderboard), matching the
    // loader and schema — not populated subnets with trivially-perfect retention.
    const data = buildChainTurnover([vrow(END, 1, "A"), vrow(END, 2, "B")], {
      startDate: END,
      endDate: END,
    });
    assert.equal(data.comparable, false);
    assert.equal(data.subnet_count, 0);
    assert.deepEqual(data.subnets, []);
    assert.equal(data.stability_distribution, null);
  });

  test("non-array input yields the empty block", () => {
    const data = buildChainTurnover(null, { startDate: START, endDate: END });
    assert.equal(data.subnet_count, 0);
    assert.deepEqual(data.subnets, []);
  });
});

describe("loadChainTurnover", () => {
  test("resolves boundary dates then reads the validator rows and shapes them", async () => {
    const calls: Row[] = [];
    const d1 = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (/MIN\(snapshot_date\)/.test(sql)) {
        return [{ start_date: START, end_date: END }];
      }
      return ROWS;
    };
    const data = await loadChainTurnover(d1, { windowLabel: "30d", limit: 20 });
    assert.match(calls[0].sql, /date\(MAX\(snapshot_date\), \?\)/); // anchored to stored MAX
    assert.equal(calls[0].params[0], "-30 days");
    assert.match(
      calls[1].sql,
      /validator_permit = 1 AND snapshot_date IN \(\?, \?\)/,
    );
    assert.deepEqual(calls[1].params, [START, END]);
    assert.equal(data.window, "30d");
    assert.equal(data.subnet_count, 2);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("defaults the window and returns empty on a cold store", async () => {
    let cutoff: unknown;
    const d1 = async (sql: string, params: unknown[]) => {
      if (/MIN\(snapshot_date\)/.test(sql)) {
        cutoff = params[0];
        return [{ start_date: null, end_date: null }];
      }
      return [];
    };
    const data = await loadChainTurnover(d1, {});
    assert.equal(data.window, DEFAULT_CHAIN_TURNOVER_WINDOW);
    assert.equal(cutoff, "-30 days");
    assert.equal(data.comparable, false);
    assert.deepEqual(data.subnets, []);
  });

  test("an unknown windowLabel falls back to the default for BOTH days and emitted window", async () => {
    let cutoff: unknown;
    const d1 = async (sql: string, params: unknown[]) => {
      if (/MIN\(snapshot_date\)/.test(sql)) {
        cutoff = params[0];
        return [{ start_date: null, end_date: null }];
      }
      return [];
    };
    const data = await loadChainTurnover(d1, { windowLabel: "bogus" });
    assert.equal(cutoff, "-30 days"); // fell back to the 30d default for the day lookup
    assert.equal(data.window, "30d"); // and the emitted window is the normalized default, not "bogus"
  });

  test("a single available snapshot (start === end) skips the read and is not comparable", async () => {
    const calls: string[] = [];
    const d1 = async (sql: string) => {
      calls.push(sql);
      if (/MIN\(snapshot_date\)/.test(sql)) {
        return [{ start_date: END, end_date: END }];
      }
      return [];
    };
    const data = await loadChainTurnover(d1, { windowLabel: "7d" });
    assert.equal(calls.length, 1); // no second (rows) query
    assert.equal(data.comparable, false);
    assert.deepEqual(data.subnets, []);
  });
});

describe("GET /api/v1/chain/turnover", () => {
  function neuronDailyEnv({ bounds, rows }: { bounds: Row[]; rows: Row[] }) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
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

  const request = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/turnover${q}`);

  test("serves a schema-stable empty scorecard on a cold store", async () => {
    const res = await handleRequest(
      request(),
      neuronDailyEnv({
        bounds: [{ start_date: null, end_date: null }],
        rows: [],
      }) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.comparable, false);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(body.data.stability_distribution, null);
  });

  test("rejects an unsupported query param with 400", async () => {
    const res = await handleRequest(
      request("?bogus=1"),
      neuronDailyEnv({ bounds: [], rows: [] }) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(
      request("?window=1y"),
      neuronDailyEnv({ bounds: [], rows: [] }) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(
      request("?limit=0"),
      neuronDailyEnv({ bounds: [], rows: [] }) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });

  const TURNOVER_CSV_HEADER =
    "netuid,validators_start,validators_end,validators_entered,validators_exited,validator_retention,stability_score";
  const warm = { bounds: [{ start_date: START, end_date: END }], rows: ROWS };
  const cold = { bounds: [{ start_date: null, end_date: null }], rows: [] };

  test("honors Accept: text/csv the same as ?format=csv", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/turnover", {
        headers: { accept: "text/csv" },
      }),
      neuronDailyEnv(warm) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
  });

  test("emits a header-only CSV on a cold store", async () => {
    const res = await handleRequest(
      request("?format=csv"),
      neuronDailyEnv(cold) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal((await res.text()).trim(), TURNOVER_CSV_HEADER);
  });

  test("serves a CSV HEAD probe with the CSV headers and no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/turnover?format=csv", {
        method: "HEAD",
      }),
      neuronDailyEnv(warm) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(await res.text(), ""); // HEAD carries no body
  });

  test("rejects an unsupported format value with 400", async () => {
    const res = await handleRequest(
      request("?format=xml"),
      neuronDailyEnv(cold) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });
});

// #4909 D1 retirement: the "chain/turnover edge cache" describe block that
// used to live here asserted the edge cache busts when the mocked D1
// neuron_daily stamp changes. neurons/neuron_daily's D1 write path is
// retired (#4772) and the tables are dropped in production, so
// handleChainTurnover no longer queries D1 for its data at all — the
// response is a fixed schema-stable-empty literal on a Postgres miss and
// never varies with the D1 fixture, so there is nothing left for a
// stamp-busts-the-cache assertion to observe.
//
// #5358: the "readNeuronDailyCacheStamp" describe block that used to live here
// unit-tested the neuron_daily-backed stamp resolver directly. That function
// (and its siblings readSubnetNeuronsCacheStamp / readNeuronsCacheStamp /
// withNeuronsEdgeCache) has been deleted from
// workers/request-handlers/analytics.mjs: it read the same dropped D1
// neuron_daily table described above, so its stamp had been permanently frozen
// since #4772 and could never bust the edge cache on new data. GET
// /api/v1/chain/turnover now busts on the shared health-cron `last_run_at` KV
// stamp instead, exercised end-to-end by the "GET /api/v1/chain/turnover"
// describe block above.
