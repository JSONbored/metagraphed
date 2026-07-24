import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainStakeFlow,
  CHAIN_STAKE_FLOW_LIMIT_MAX,
} from "../src/chain-stake-flow.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const OBS = 1_700_000_000_000;

// One GROUP BY netuid, event_kind aggregate row from account_events.
function ev(
  netuid: unknown,
  event_kind: string,
  total_tao: unknown,
  event_count: number,
  last_observed: unknown = OBS,
) {
  return { netuid, event_kind, total_tao, event_count, last_observed };
}

// netuid 1 net +70 (inflow), netuid 2 net -60 (outflow), netuid 3 net 0 (balanced).
const ROWS = [
  ev(1, "StakeAdded", 100, 5),
  ev(1, "StakeRemoved", 30, 2),
  ev(2, "StakeAdded", 20, 1),
  ev(2, "StakeRemoved", 80, 3),
  ev(3, "StakeAdded", 50, 2),
  ev(3, "StakeRemoved", 50, 2),
];

describe("buildChainStakeFlow", () => {
  test("shapes per-subnet flow ranked by net inflow, with direction labels", () => {
    const data = buildChainStakeFlow(ROWS, { window: "30d" });
    assert.equal(data.schema_version, 1);
    assert.equal(data.window, "30d");
    assert.equal(data.subnet_count, 3);
    assert.equal(data.observed_at, new Date(OBS).toISOString());
    // ranked by net desc: +70, 0, -60 -> [1, 3, 2]
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [1, 3, 2],
    );
    const s1 = data.subnets.find((s) => s.netuid === 1)!;
    assert.equal(s1.total_staked_tao, 100);
    assert.equal(s1.total_unstaked_tao, 30);
    assert.equal(s1.net_flow_tao, 70);
    assert.equal(s1.gross_flow_tao, 130);
    assert.equal(s1.stake_events, 5);
    assert.equal(s1.unstake_events, 2);
    assert.equal(s1.direction, "inflow");
    assert.equal(
      data.subnets.find((s) => s.netuid === 2)!.direction,
      "outflow",
    );
    assert.equal(
      data.subnets.find((s) => s.netuid === 3)!.direction,
      "balanced",
    );
  });

  test("rolls up a network summary with gaining/losing/flat counts", () => {
    const { network } = buildChainStakeFlow(ROWS, { window: "30d" });
    assert.equal(network.total_staked_tao, 170);
    assert.equal(network.total_unstaked_tao, 160);
    assert.equal(network.net_flow_tao, 10);
    assert.equal(network.gross_flow_tao, 330);
    assert.equal(network.stake_events, 8);
    assert.equal(network.unstake_events, 7);
    assert.deepEqual(
      [network.gaining, network.losing, network.flat],
      [1, 1, 1],
    );
  });

  test("summarizes the spread of per-subnet net flow into a distribution", () => {
    // per-subnet net flows [70, 0, -60] -> ascending [-60, 0, 70].
    const { net_flow_distribution: dist } = buildChainStakeFlow(ROWS, {});
    assert.equal(dist!.count, 3);
    assert.equal(dist!.mean, 3.333333333); // 10/3 rounded to rao
    assert.equal(dist!.min, -60);
    assert.equal(dist!.p25, -60);
    assert.equal(dist!.median, 0);
    assert.equal(dist!.p75, 70);
    assert.equal(dist!.p90, 70);
    assert.equal(dist!.max, 70);
  });

  test("distribution counts every subnet even when the leaderboard is truncated", () => {
    const { net_flow_distribution: dist } = buildChainStakeFlow(ROWS, {
      limit: 1,
    });
    assert.equal(dist!.count, 3);
  });

  test("small net relative to gross reads as balanced (churn) and counts flat", () => {
    // net 2 on gross 100 = 2% < 5% threshold -> balanced. The network gaining/losing/flat count
    // must agree with the label: a churn subnet counts flat, not gaining, even though its raw
    // net is positive.
    const data = buildChainStakeFlow(
      [ev(7, "StakeAdded", 51, 1), ev(7, "StakeRemoved", 49, 1)],
      {},
    );
    assert.equal(data.subnets[0].net_flow_tao, 2);
    assert.equal(data.subnets[0].direction, "balanced");
    assert.deepEqual(
      [data.network.gaining, data.network.losing, data.network.flat],
      [0, 0, 1],
    );
  });

  test("a subnet with only inflow (gross > 0, no outflow) is inflow", () => {
    const data = buildChainStakeFlow([ev(5, "StakeAdded", 80, 4)], {});
    assert.equal(data.subnets[0].direction, "inflow");
    assert.equal(data.subnets[0].total_unstaked_tao, 0);
  });

  test("rounds TAO sums to rao precision (no IEEE-754 dust)", () => {
    const data = buildChainStakeFlow(
      [ev(1, "StakeAdded", 0.3, 1), ev(1, "StakeRemoved", 0.1, 1)],
      {},
    );
    assert.equal(data.subnets[0].net_flow_tao, 0.2); // 0.3 - 0.1, not 0.1999...
  });

  test("caps the leaderboard to limit but counts every subnet", () => {
    const data = buildChainStakeFlow(ROWS, { limit: 1 });
    assert.equal(data.subnet_count, 3);
    assert.equal(data.subnets.length, 1);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("clamps a non-integer / negative / over-max / non-finite limit", () => {
    const n = (limit: number) =>
      buildChainStakeFlow(ROWS, { limit }).subnets.length;
    assert.equal(n(1.9), 1); // floored
    assert.equal(n(-5), 0); // negative -> 0
    assert.equal(n(9999), 3); // over-max clamps, capped by data
    assert.equal(n(Number.NaN), 3); // non-finite -> default
    assert.ok(CHAIN_STAKE_FLOW_LIMIT_MAX >= 100);
  });

  test("ignores non-stake event kinds and malformed/null netuids", () => {
    const data = buildChainStakeFlow(
      [
        ev(1, "StakeAdded", 100, 2),
        ev(1, "Transfer", 999, 9), // not a stake kind -> ignored
        {
          netuid: "bad",
          event_kind: "StakeAdded",
          total_tao: 5,
          event_count: 1,
        },
        {
          netuid: null,
          event_kind: "StakeAdded",
          total_tao: 5,
          event_count: 1,
        },
        // Blank and whitespace-only netuid strings both coerce to 0 via Number(); they must be
        // rejected outright, never counted as subnet 0.
        { netuid: "", event_kind: "StakeAdded", total_tao: 7, event_count: 1 },
        {
          netuid: "   ",
          event_kind: "StakeAdded",
          total_tao: 7,
          event_count: 1,
        },
        ev(1, "StakeRemoved", 40, 1),
      ],
      {},
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1); // not a phantom subnet 0 from the blank strings
    assert.equal(data.subnets[0].total_staked_tao, 100); // Transfer's 999 + blank rows' 7s excluded
    assert.equal(data.subnets[0].net_flow_tao, 60);
  });

  test("a netuid whose only row is a non-stake kind is absent (no inactive bucket)", () => {
    // Subnet 7 appears solely via a Transfer row (no StakeAdded/StakeRemoved). It must not
    // materialize an all-zero "inactive" subnet: the contract represents active stake-flow
    // subnets only. Subnet 3 has a real stake row and is the only subnet returned.
    const data = buildChainStakeFlow(
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

  test("skips blank total_tao rows instead of counting phantom stake events", () => {
    for (const blank of ["", "   "]) {
      const data = buildChainStakeFlow(
        [
          {
            netuid: 1,
            event_kind: "StakeAdded",
            total_tao: blank,
            event_count: 9,
          },
          {
            netuid: 1,
            event_kind: "StakeRemoved",
            total_tao: blank,
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
        `stake events for total_tao ${JSON.stringify(blank)}`,
      );
      assert.equal(data.network.unstake_events, 1);
      assert.equal(data.subnets[0].total_staked_tao, 100);
      assert.equal(data.subnets[0].total_unstaked_tao, 40);
    }
  });

  test("skips null/blank/non-numeric total_tao rows instead of materializing zero-flow subnets", () => {
    const data = buildChainStakeFlow(
      [
        {
          netuid: 9,
          event_kind: "StakeAdded",
          total_tao: null,
          event_count: 2,
          last_observed: OBS,
        },
        {
          netuid: 8,
          event_kind: "StakeRemoved",
          total_tao: "abc",
          event_count: 3,
          last_observed: 0,
        },
      ],
      {},
    );
    assert.equal(data.subnet_count, 0);
    assert.deepEqual(data.subnets, []);
    assert.equal(data.observed_at, null);
  });

  test("ignores out-of-range timestamps that cannot be rendered as ISO", () => {
    const data = buildChainStakeFlow(
      [ev(2, "StakeAdded", 5, 1, 1e100), ev(3, "StakeAdded", 7, 1, OBS)],
      {},
    );
    assert.equal(data.subnet_count, 2);
    assert.equal(data.observed_at, new Date(OBS).toISOString());
  });

  test("breaks a net-flow tie by netuid ascending", () => {
    // netuid 5 and netuid 3 both net +10 -> tie, broken by the lower netuid first.
    const data = buildChainStakeFlow(
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
      const data = buildChainStakeFlow(rows, { window: "7d" });
      assert.equal(data.schema_version, 1);
      assert.equal(data.window, "7d");
      assert.equal(data.observed_at, null);
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.net_flow_distribution, null);
      assert.equal(data.network.net_flow_tao, 0);
      assert.equal(data.network.gaining, 0);
    }
  });

  test("omitted window defaults to null", () => {
    assert.equal(buildChainStakeFlow([], {}).window, null);
  });

  test("ignores a malformed out-of-range timestamp instead of throwing", () => {
    const data = buildChainStakeFlow([ev(4, "StakeAdded", 10, 1, 1e100)], {
      window: "7d",
    });
    assert.equal(data.subnet_count, 1);
    assert.equal(data.observed_at, null);
  });
});

describe("GET /api/v1/chain/stake-flow", () => {
  function stakeFlowEnv(rows: Row[]) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
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
    new Request(`https://api.metagraph.sh/api/v1/chain/stake-flow${q}`);

  // #4909/#6013: account_events' D1 write path is retired and the table is
  // dropped in production, so this handler no longer queries D1 at all --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
    let d1Called = false;
    const env = stakeFlowEnv(ROWS);
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const res = await handleRequest(
      req("?window=7d"),
      env as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(typeof body.data.network, "object");
    assert.equal(d1Called, false);
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/stake-flow", {
        method: "HEAD",
      }),
      stakeFlowEnv(ROWS) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), ""); // HEAD carries no body
  });

  test("serves a schema-stable empty card on a cold store", async () => {
    const res = await handleRequest(
      req(),
      stakeFlowEnv([]) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(body.data.net_flow_distribution, null);
  });

  // #4832 Tier 2: METAGRAPH_ACCOUNT_EVENTS_SOURCE reused (same account_events
  // table this handler already reads, no new flag) -- tryPostgresTier's own
  // fallback contract is unit-tested in workers/postgres-tier.ts's own
  // tests, so these two just prove the wiring: a Postgres hit is served
  // as-is with D1 never queried, and a Postgres failure falls back to D1.
  test("flag=postgres serves the DATA_API response, D1 never queried", async () => {
    let d1Called = false;
    const env = {
      ...stakeFlowEnv([]),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            window: "7d",
            observed_at: "2026-01-01T00:00:00.000Z",
            subnet_count: 99,
            network: {},
            net_flow_distribution: null,
            subnets: [{ netuid: 42 }],
          }),
      },
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      d1Called = true;
      throw new Error(
        "D1 must not be queried when Postgres serves the request",
      );
    };
    const res = await handleRequest(
      req("?window=7d"),
      env as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 99);
    assert.equal(d1Called, false);
  });

  // #4909/#6013: the D1 "fallback" is a schema-stable empty stub, not a real
  // D1 read (account_events is retired) -- a Postgres failure degrades to the
  // empty card, not to whatever a D1 mock might return.
  test("flag=postgres falls back to the empty stub (not D1) when DATA_API fails", async () => {
    const env = {
      ...stakeFlowEnv(ROWS),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          throw new Error("boom");
        },
      },
    };
    const res = await handleRequest(
      req("?window=7d"),
      env as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(
      req("?window=90d"),
      stakeFlowEnv([]) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(
      req("?bogus=1"),
      stakeFlowEnv([]) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(
      req("?limit=0"),
      stakeFlowEnv([]) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });

  // #4909/#6013: even a "warm" D1 mock never reaches the response -- the CSV
  // export is always header-only now (account_events is retired).
  test("CSV export with ?format=csv is header-only even with a warm D1 mock", async () => {
    const res = await handleRequest(
      req("?window=7d&format=csv"),
      stakeFlowEnv(ROWS) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(
      res.headers.get("content-disposition"),
      /attachment; filename="chain-stake-flow\.csv"/,
    );
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0],
      "netuid,total_staked_tao,total_unstaked_tao,net_flow_tao,gross_flow_tao,stake_events,unstake_events,direction",
    );
  });

  test("honors Accept: text/csv the same as ?format=csv", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/stake-flow", {
        headers: { accept: "text/csv" },
      }),
      stakeFlowEnv(ROWS) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
  });

  test("emits a header-only CSV on a cold store", async () => {
    const res = await handleRequest(
      req("?format=csv"),
      stakeFlowEnv([]) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(
      (await res.text()).trim(),
      "netuid,total_staked_tao,total_unstaked_tao,net_flow_tao,gross_flow_tao,stake_events,unstake_events,direction",
    );
  });

  test("serves a CSV HEAD probe with the CSV headers and no body", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/stake-flow?format=csv",
        {
          method: "HEAD",
        },
      ),
      stakeFlowEnv(ROWS) as unknown as Env,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(await res.text(), ""); // HEAD carries no body
  });

  test("rejects an unsupported format value with 400", async () => {
    const res = await handleRequest(
      req("?format=xml"),
      stakeFlowEnv([]) as unknown as Env,
      {},
    );
    assert.equal(res.status, 400);
  });
});

describe("chain/stake-flow edge cache", () => {
  // `caches` is `declare const caches: CacheStorage` -- a module-scope const,
  // not a `globalThis` property -- so stubbing/restoring it for a test needs
  // this cast (matches workers/request-handlers/analytics.ts's own precedent).
  const globalWithCaches = globalThis as unknown as { caches: Row };
  let originalCaches: Row;
  afterEach(() => {
    globalWithCaches.caches = originalCaches;
  });

  test("routes through the edge cache with caches enabled", async () => {
    originalCaches = globalWithCaches.caches;
    const store = new Map<string, Response>();
    globalWithCaches.caches = {
      default: {
        async match(request: Request) {
          const cached = store.get(request.url);
          return cached ? cached.clone() : undefined;
        },
        async put(request: Request, response: Response) {
          store.set(request.url, response.clone());
        },
      },
    };
    const env = {
      ...createLocalArtifactEnv(),
      // A non-null health:meta stamp so withEdgeCache actually engages (it skips caching when
      // the analytics cron stamp is null).
      METAGRAPH_CONTROL: {
        async get(key: string) {
          return key === "health:meta"
            ? { last_run_at: "2026-06-30T00:00:00.000Z" }
            : null;
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
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
    // withEdgeCache writes via ctx.waitUntil, so capture the background put and await it.
    const waits: Promise<unknown>[] = [];
    const call = () =>
      handleRequest(
        new Request("https://api.metagraph.sh/api/v1/chain/stake-flow"),
        env as unknown as Env,
        { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
      );
    const res = await call();
    assert.equal(res.status, 200);
    const body = await res.json();
    // #4909/#6013: account_events is retired, so even this "warm" D1 mock
    // never reaches the response -- subnet_count stays 0.
    assert.equal(body.data.subnet_count, 0);
    await Promise.all(waits); // let the deferred cache put settle
    assert.equal(store.size, 1); // the response was cached under one key
    // A second request is served from that cached entry (the mocked match() returns it).
    const cached = await call();
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).data.subnet_count, 0);
  });
});
