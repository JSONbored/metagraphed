import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainAlphaFlow,
  loadChainAlphaFlow,
  CHAIN_ALPHA_FLOW_LIMIT_MAX,
} from "../src/chain-alpha-flow.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const OBS = 1_700_000_000_000;

// One GROUP BY netuid, event_kind aggregate row from account_events (the alpha leg of the swap).
function ev(netuid, event_kind, total_alpha, event_count, last_observed = OBS) {
  return { netuid, event_kind, total_alpha, event_count, last_observed };
}

// netuid 1 net +70 (expanding), netuid 2 net -60 (contracting), netuid 3 net 0 (balanced).
const ROWS = [
  ev(1, "StakeAdded", 100, 5),
  ev(1, "StakeRemoved", 30, 2),
  ev(2, "StakeAdded", 20, 1),
  ev(2, "StakeRemoved", 80, 3),
  ev(3, "StakeAdded", 50, 2),
  ev(3, "StakeRemoved", 50, 2),
];

describe("buildChainAlphaFlow", () => {
  test("shapes per-subnet alpha flow ranked by net expansion, with direction labels", () => {
    const data = buildChainAlphaFlow(ROWS, { window: "30d" });
    assert.equal(data.schema_version, 1);
    assert.equal(data.window, "30d");
    assert.equal(data.subnet_count, 3);
    assert.equal(data.observed_at, new Date(OBS).toISOString());
    // ranked by net desc: +70, 0, -60 -> [1, 3, 2]
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [1, 3, 2],
    );
    const s1 = data.subnets.find((s) => s.netuid === 1);
    assert.equal(s1.total_alpha_in, 100);
    assert.equal(s1.total_alpha_out, 30);
    assert.equal(s1.net_alpha_flow, 70);
    assert.equal(s1.gross_alpha_flow, 130);
    assert.equal(s1.stake_events, 5);
    assert.equal(s1.unstake_events, 2);
    assert.equal(s1.direction, "expanding");
    assert.equal(
      data.subnets.find((s) => s.netuid === 2).direction,
      "contracting",
    );
    assert.equal(
      data.subnets.find((s) => s.netuid === 3).direction,
      "balanced",
    );
  });

  test("rolls up a network summary with expanding/contracting/flat counts", () => {
    const { network } = buildChainAlphaFlow(ROWS, { window: "30d" });
    assert.equal(network.total_alpha_in, 170);
    assert.equal(network.total_alpha_out, 160);
    assert.equal(network.net_alpha_flow, 10);
    assert.equal(network.gross_alpha_flow, 330);
    assert.equal(network.stake_events, 8);
    assert.equal(network.unstake_events, 7);
    assert.deepEqual(
      [network.expanding, network.contracting, network.flat],
      [1, 1, 1],
    );
  });

  test("summarizes the spread of per-subnet net flow into a distribution", () => {
    // per-subnet net flows [70, 0, -60] -> ascending [-60, 0, 70].
    const { net_flow_distribution: dist } = buildChainAlphaFlow(ROWS, {});
    assert.equal(dist.count, 3);
    assert.equal(dist.mean, 3.333333333); // 10/3 rounded to rao
    assert.equal(dist.min, -60);
    assert.equal(dist.p25, -60);
    assert.equal(dist.median, 0);
    assert.equal(dist.p75, 70);
    assert.equal(dist.p90, 70);
    assert.equal(dist.max, 70);
  });

  test("distribution counts every subnet even when the leaderboard is truncated", () => {
    const { net_flow_distribution: dist } = buildChainAlphaFlow(ROWS, {
      limit: 1,
    });
    assert.equal(dist.count, 3);
  });

  test("small net relative to gross reads as balanced (churn) and counts flat", () => {
    // net 2 on gross 100 = 2% < 5% threshold -> balanced. The expanding/contracting/flat count
    // must agree with the label: a churn subnet counts flat, not expanding, even though its raw
    // net is positive.
    const data = buildChainAlphaFlow(
      [ev(7, "StakeAdded", 51, 1), ev(7, "StakeRemoved", 49, 1)],
      {},
    );
    assert.equal(data.subnets[0].net_alpha_flow, 2);
    assert.equal(data.subnets[0].direction, "balanced");
    assert.deepEqual(
      [data.network.expanding, data.network.contracting, data.network.flat],
      [0, 0, 1],
    );
  });

  test("a subnet with only inflow (gross > 0, no outflow) is expanding", () => {
    const data = buildChainAlphaFlow([ev(5, "StakeAdded", 80, 4)], {});
    assert.equal(data.subnets[0].direction, "expanding");
    assert.equal(data.subnets[0].total_alpha_out, 0);
  });

  test("rounds alpha sums to rao precision (no IEEE-754 dust)", () => {
    const data = buildChainAlphaFlow(
      [ev(1, "StakeAdded", 0.3, 1), ev(1, "StakeRemoved", 0.1, 1)],
      {},
    );
    assert.equal(data.subnets[0].net_alpha_flow, 0.2); // 0.3 - 0.1, not 0.1999...
  });

  test("caps the leaderboard to limit but counts every subnet", () => {
    const data = buildChainAlphaFlow(ROWS, { limit: 1 });
    assert.equal(data.subnet_count, 3);
    assert.equal(data.subnets.length, 1);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("clamps a non-integer / negative / over-max / non-finite limit", () => {
    const n = (limit) => buildChainAlphaFlow(ROWS, { limit }).subnets.length;
    assert.equal(n(1.9), 1); // floored
    assert.equal(n(-5), 0); // negative -> 0
    assert.equal(n(9999), 3); // over-max clamps, capped by data
    assert.equal(n(Number.NaN), 3); // non-finite -> default
    assert.ok(CHAIN_ALPHA_FLOW_LIMIT_MAX >= 100);
  });

  test("ignores non-stake event kinds and malformed/null netuids", () => {
    const data = buildChainAlphaFlow(
      [
        ev(1, "StakeAdded", 100, 2),
        ev(1, "Transfer", 999, 9), // not a stake kind -> ignored
        {
          netuid: "bad",
          event_kind: "StakeAdded",
          total_alpha: 5,
          event_count: 1,
        },
        {
          netuid: null,
          event_kind: "StakeAdded",
          total_alpha: 5,
          event_count: 1,
        },
        // Blank and whitespace-only netuid strings both coerce to 0 via Number(); they must be
        // rejected outright, never counted as subnet 0.
        {
          netuid: "",
          event_kind: "StakeAdded",
          total_alpha: 7,
          event_count: 1,
        },
        {
          netuid: "   ",
          event_kind: "StakeAdded",
          total_alpha: 7,
          event_count: 1,
        },
        ev(1, "StakeRemoved", 40, 1),
      ],
      {},
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1); // not a phantom subnet 0 from the blank strings
    assert.equal(data.subnets[0].total_alpha_in, 100); // Transfer's 999 + blank rows' 7s excluded
    assert.equal(data.subnets[0].net_alpha_flow, 60);
  });

  test("a netuid whose only row is a non-stake kind is absent (no inactive bucket)", () => {
    const data = buildChainAlphaFlow(
      [ev(7, "Transfer", 500, 5), ev(3, "StakeAdded", 80, 2)],
      {},
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 3);
    assert.equal(data.network.flat, 0); // no zero-flow bucket was counted
    assert.equal(
      data.subnets.some((s) => s.netuid === 7),
      false,
    );
  });

  test("skips blank total_alpha rows instead of counting phantom stake events", () => {
    for (const blank of ["", "   "]) {
      const data = buildChainAlphaFlow(
        [
          {
            netuid: 1,
            event_kind: "StakeAdded",
            total_alpha: blank,
            event_count: 9,
          },
          {
            netuid: 1,
            event_kind: "StakeRemoved",
            total_alpha: blank,
            event_count: 4,
          },
          ev(1, "StakeAdded", 100, 2),
          ev(1, "StakeRemoved", 40, 1),
        ],
        {},
      );
      assert.equal(
        data.network.stake_events,
        2,
        `stake events for total_alpha ${JSON.stringify(blank)}`,
      );
      assert.equal(data.network.unstake_events, 1);
      assert.equal(data.subnets[0].total_alpha_in, 100);
      assert.equal(data.subnets[0].total_alpha_out, 40);
    }
  });

  test("skips null/blank/non-numeric/negative total_alpha rows instead of materializing zero-flow subnets", () => {
    const data = buildChainAlphaFlow(
      [
        {
          netuid: 9,
          event_kind: "StakeAdded",
          total_alpha: null,
          event_count: 2,
          last_observed: OBS,
        },
        {
          netuid: 8,
          event_kind: "StakeRemoved",
          total_alpha: "abc",
          event_count: 3,
          last_observed: 0,
        },
        {
          netuid: 6,
          event_kind: "StakeAdded",
          total_alpha: -50, // negative aggregate -> malformed (alpha is always >= 0), skipped
          event_count: 2,
          last_observed: OBS,
        },
      ],
      {},
    );
    assert.equal(data.subnet_count, 0);
    assert.deepEqual(data.subnets, []);
    assert.equal(data.observed_at, null);
  });

  test("ignores out-of-range and non-positive timestamps that cannot be rendered as ISO", () => {
    // 1e100 is out of JS Date range; 0 and negatives are non-positive. All coerce to null on an
    // otherwise-valid (non-skipped) row, so the newest real timestamp still wins.
    const data = buildChainAlphaFlow(
      [
        ev(2, "StakeAdded", 5, 1, 1e100),
        ev(4, "StakeAdded", 6, 1, 0),
        ev(3, "StakeAdded", 7, 1, OBS),
      ],
      {},
    );
    assert.equal(data.subnet_count, 3);
    assert.equal(data.observed_at, new Date(OBS).toISOString());
  });

  test("a non-numeric event_count coerces to 0 (no phantom events)", () => {
    // A valid alpha row (positive alpha, valid netuid/kind) whose event_count is non-numeric must
    // contribute its alpha but count 0 events, not NaN.
    const data = buildChainAlphaFlow(
      [
        {
          netuid: 1,
          event_kind: "StakeAdded",
          total_alpha: 100,
          event_count: "x",
        },
      ],
      {},
    );
    assert.equal(data.subnets[0].total_alpha_in, 100);
    assert.equal(data.subnets[0].stake_events, 0);
  });

  test("a zero-alpha swap yields a gross-0 balanced subnet counted flat", () => {
    // A StakeAdded row whose alpha leg summed to 0 (valid, >= 0) makes gross 0, which classifies as
    // balanced (no directional move) and counts flat rather than expanding.
    const data = buildChainAlphaFlow([ev(4, "StakeAdded", 0, 3)], {});
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].gross_alpha_flow, 0);
    assert.equal(data.subnets[0].direction, "balanced");
    assert.deepEqual(
      [data.network.expanding, data.network.contracting, data.network.flat],
      [0, 0, 1],
    );
  });

  test("breaks a net-flow tie by netuid ascending", () => {
    // netuid 5 and netuid 3 both net +10 -> tie, broken by the lower netuid first.
    const data = buildChainAlphaFlow(
      [ev(5, "StakeAdded", 10, 1), ev(3, "StakeAdded", 10, 1)],
      {},
    );
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [3, 5],
    );
  });

  test("cold / empty input yields a schema-stable zeroed card", () => {
    for (const rows of [[], null]) {
      const data = buildChainAlphaFlow(rows, { window: "7d" });
      assert.equal(data.schema_version, 1);
      assert.equal(data.window, "7d");
      assert.equal(data.observed_at, null);
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.net_flow_distribution, null);
      assert.equal(data.network.net_alpha_flow, 0);
      assert.equal(data.network.expanding, 0);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildChainAlphaFlow([], {}).window, null);
  });
});

describe("loadChainAlphaFlow", () => {
  test("queries account_events over the window cutoff and shapes the result", async () => {
    const calls = [];
    const before = Date.now();
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return ROWS;
    };
    const data = await loadChainAlphaFlow(d1, {
      windowLabel: "7d",
      windowDays: 7,
      limit: 20,
    });
    const after = Date.now();
    assert.match(calls[0].sql, /FROM account_events/);
    assert.match(
      calls[0].sql,
      /COALESCE\(SUM\(alpha_amount\), 0\) AS total_alpha/,
    );
    assert.match(calls[0].sql, /event_kind IN \(\?, \?\)/);
    assert.match(calls[0].sql, /GROUP BY netuid, event_kind/);
    assert.equal(calls[0].params[0], "StakeAdded");
    assert.equal(calls[0].params[1], "StakeRemoved");
    const dayMs = 24 * 60 * 60 * 1000;
    assert.ok(calls[0].params[2] >= before - 7 * dayMs - 5);
    assert.ok(calls[0].params[2] <= after - 7 * dayMs + 5);
    assert.equal(data.window, "7d");
    assert.equal(data.subnet_count, 3);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("an omitted/garbled windowDays defensively falls back to the 7d default cutoff", async () => {
    let captured;
    const before = Date.now();
    await loadChainAlphaFlow(
      async (sql, params) => {
        captured = { sql, params };
        return [];
      },
      { windowLabel: "7d" }, // no windowDays -> must not produce a NaN cutoff
    );
    const after = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    assert.ok(Number.isFinite(captured.params[2]));
    assert.ok(captured.params[2] >= before - 7 * dayMs - 5);
    assert.ok(captured.params[2] <= after - 7 * dayMs + 5);
  });

  test("cold store yields the empty card", async () => {
    const data = await loadChainAlphaFlow(async () => [], {
      windowLabel: "30d",
      windowDays: 30,
    });
    assert.equal(data.subnet_count, 0);
    assert.deepEqual(data.subnets, []);
  });
});

describe("GET /api/v1/chain/alpha-flow", () => {
  function alphaFlowEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /FROM account_events/.test(sql) ? rows : [],
                }),
            }),
          };
        },
      },
    };
  }
  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/alpha-flow${q}`);

  test("dispatches to the network alpha-flow scorecard", async () => {
    const res = await handleRequest(req("?window=7d"), alphaFlowEnv(ROWS), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 3);
    assert.equal(body.data.subnets[0].netuid, 1);
    assert.equal(typeof body.data.network, "object");
    assert.equal(body.meta.artifact_path, "/metagraph/chain/alpha-flow.json");
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/alpha-flow", {
        method: "HEAD",
      }),
      alphaFlowEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), ""); // HEAD carries no body
  });

  test("ignores malformed out-of-range timestamps instead of returning 500", async () => {
    const res = await handleRequest(
      req(),
      alphaFlowEnv([ev(4, "StakeAdded", 10, 1, 1e100)]),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 1);
    assert.equal(body.data.observed_at, null);
  });

  test("serves a schema-stable empty card on a cold store", async () => {
    const res = await handleRequest(req(), alphaFlowEnv([]), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(body.data.net_flow_distribution, null);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(req("?window=90d"), alphaFlowEnv([]), {});
    assert.equal(res.status, 400);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(req("?bogus=1"), alphaFlowEnv([]), {});
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(req("?limit=0"), alphaFlowEnv([]), {});
    assert.equal(res.status, 400);
  });

  const CSV_HEADER =
    "netuid,total_alpha_in,total_alpha_out,net_alpha_flow,gross_alpha_flow,stake_events,unstake_events,direction";

  test("exports the per-subnet leaderboard as CSV with ?format=csv", async () => {
    const res = await handleRequest(
      req("?window=7d&format=csv"),
      alphaFlowEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(
      res.headers.get("content-disposition"),
      /attachment; filename="chain-alpha-flow\.csv"/,
    );
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines[0], CSV_HEADER);
    // Biggest net expansion first: netuid 1 (net +70) leads, then 3 (0), then 2 (-60).
    assert.equal(lines.length, 4); // header + 3 subnet rows
    assert.equal(lines[1], "1,100,30,70,130,5,2,expanding");
  });

  test("honors Accept: text/csv the same as ?format=csv", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/alpha-flow", {
        headers: { accept: "text/csv" },
      }),
      alphaFlowEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
  });

  test("emits a header-only CSV on a cold store", async () => {
    const res = await handleRequest(req("?format=csv"), alphaFlowEnv([]), {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal((await res.text()).trim(), CSV_HEADER);
  });

  test("serves a CSV HEAD probe with the CSV headers and no body", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/alpha-flow?format=csv",
        {
          method: "HEAD",
        },
      ),
      alphaFlowEnv(ROWS),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(await res.text(), ""); // HEAD carries no body
  });

  test("rejects an unsupported format value with 400", async () => {
    const res = await handleRequest(req("?format=xml"), alphaFlowEnv([]), {});
    assert.equal(res.status, 400);
  });
});

describe("chain/alpha-flow edge cache", () => {
  let originalCaches;
  afterEach(() => {
    globalThis.caches = originalCaches;
  });

  test("routes through the edge cache with caches enabled", async () => {
    originalCaches = globalThis.caches;
    const store = new Map();
    globalThis.caches = {
      default: {
        async match(request) {
          const cached = store.get(request.url);
          return cached ? cached.clone() : undefined;
        },
        async put(request, response) {
          store.set(request.url, response.clone());
        },
      },
    };
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === "health:meta"
            ? { last_run_at: "2026-06-30T00:00:00.000Z" }
            : null;
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /FROM account_events/.test(sql) ? ROWS : [],
                }),
            }),
          };
        },
      },
    };
    const waits = [];
    const call = () =>
      handleRequest(
        new Request("https://api.metagraph.sh/api/v1/chain/alpha-flow"),
        env,
        { waitUntil: (promise) => waits.push(promise) },
      );
    const res = await call();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 3);
    await Promise.all(waits);
    assert.equal(store.size, 1);
    const cached = await call();
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).data.subnet_count, 3);
  });
});
