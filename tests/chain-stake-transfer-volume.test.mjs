import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainStakeTransferVolume,
  loadChainStakeTransferVolume,
  CHAIN_STAKE_TRANSFER_VOLUME_LIMIT_MAX,
  STAKE_TRANSFERRED_EVENT_KIND,
} from "../src/chain-stake-transfer-volume.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const OBS = 1_700_000_000_000;

// One per-origin-subnet account_events StakeTransferred volume aggregate row (the loader GROUPs BY
// netuid: COALESCE(SUM(amount_tao)) volume_tao, COUNT(*) transfers, MAX(observed_at) last_observed).
function vrow(netuid, volume_tao, transfers, last_observed = OBS) {
  return { netuid, volume_tao, transfers, last_observed };
}

// netuid 1: 40 TAO over 4 transfers -> 10 avg.
// netuid 2: 30 TAO over 2 transfers -> 15 avg.
// netuid 5: 25 TAO over 10 transfers -> 2.5 avg.
const SUBNETS = [vrow(1, 40, 4), vrow(2, 30, 2), vrow(5, 25, 10)];

describe("buildChainStakeTransferVolume", () => {
  test("shapes the per-subnet leaderboard ranked by total volume", () => {
    const data = buildChainStakeTransferVolume(SUBNETS, { window: "7d" });
    assert.equal(data.schema_version, 1);
    assert.equal(data.window, "7d");
    assert.equal(data.observed_at, new Date(OBS).toISOString());
    assert.equal(data.subnet_count, 3);
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [1, 2, 5],
    );
    const s1 = data.subnets.find((s) => s.netuid === 1);
    assert.equal(s1.volume_tao, 40);
    assert.equal(s1.transfers, 4);
    assert.equal(s1.avg_transfer_tao, 10);
    assert.equal(data.subnets.find((s) => s.netuid === 2).avg_transfer_tao, 15);
    assert.equal(
      data.subnets.find((s) => s.netuid === 5).avg_transfer_tao,
      2.5,
    );
  });

  test("rolls up the total volume, transfer count, and network average", () => {
    const { network } = buildChainStakeTransferVolume(SUBNETS, {
      window: "7d",
    });
    assert.equal(network.total_volume_tao, 95); // 40 + 30 + 25
    assert.equal(network.transfers, 16); // 4 + 2 + 10
    assert.equal(network.avg_transfer_tao, 5.9375); // 95 / 16
  });

  test("summarises the spread of per-subnet volume", () => {
    const { volume_distribution } = buildChainStakeTransferVolume(SUBNETS, {
      window: "7d",
    });
    // volumes 40, 30, 25 -> ascending [25, 30, 40].
    assert.equal(volume_distribution.count, 3);
    assert.equal(volume_distribution.min, 25);
    assert.equal(volume_distribution.p25, 25);
    assert.equal(volume_distribution.median, 30);
    assert.equal(volume_distribution.p75, 40);
    assert.equal(volume_distribution.p90, 40);
    assert.equal(volume_distribution.max, 40);
    assert.equal(volume_distribution.mean, roundTao(95 / 3));
  });

  test("ties on volume break by netuid ascending", () => {
    const data = buildChainStakeTransferVolume(
      [vrow(9, 50, 5), vrow(4, 50, 2)],
      {
        window: "7d",
      },
    );
    assert.deepEqual(
      data.subnets.map((s) => s.netuid),
      [4, 9],
    );
  });

  test("limit caps the leaderboard; distribution and count stay network-wide", () => {
    const data = buildChainStakeTransferVolume(SUBNETS, {
      window: "7d",
      limit: 2,
    });
    assert.equal(data.subnets.length, 2);
    assert.equal(data.subnet_count, 3);
    assert.equal(data.volume_distribution.count, 3);
  });

  test("limit above the max clamps; a non-numeric limit uses the default", () => {
    const big = buildChainStakeTransferVolume(SUBNETS, {
      window: "7d",
      limit: CHAIN_STAKE_TRANSFER_VOLUME_LIMIT_MAX + 500,
    });
    assert.equal(big.subnets.length, 3);
    const bogus = buildChainStakeTransferVolume(SUBNETS, {
      window: "7d",
      limit: "abc",
    });
    assert.equal(bogus.subnets.length, 3);
  });

  test("merges duplicate netuid rows (sum volume and transfers)", () => {
    const data = buildChainStakeTransferVolume(
      [vrow(1, 20, 2), vrow(1, 15, 1)],
      { window: "7d" },
    );
    assert.equal(data.subnet_count, 1);
    const s = data.subnets[0];
    assert.equal(s.volume_tao, 35); // 20 + 15
    assert.equal(s.transfers, 3); // 2 + 1
    assert.equal(s.avg_transfer_tao, roundTao(35 / 3));
  });

  test("rounds summed volume to rao precision (no IEEE-754 drift)", () => {
    // 0.1 + 0.2 = 0.30000000000000004 in float; rao rounding pins it to 0.3.
    const data = buildChainStakeTransferVolume(
      [vrow(1, 0.1, 1), vrow(1, 0.2, 1)],
      { window: "7d" },
    );
    assert.equal(data.subnets[0].volume_tao, 0.3);
    assert.equal(data.network.total_volume_tao, 0.3);
  });

  test("skips malformed/blank/negative netuid, null-volume, and zero-transfer rows", () => {
    const data = buildChainStakeTransferVolume(
      [
        vrow(1, 40, 4),
        { netuid: null, volume_tao: 10, transfers: 1 },
        { netuid: "", volume_tao: 10, transfers: 1 },
        { netuid: "  ", volume_tao: 10, transfers: 1 },
        { netuid: "bad", volume_tao: 10, transfers: 1 },
        { netuid: -1, volume_tao: 10, transfers: 1 },
        { netuid: 2, volume_tao: null, transfers: 1 }, // no summable volume
        vrow(3, 10, 0), // zero transfers: not a transfer surface
      ],
      { window: "7d" },
    );
    assert.equal(data.subnet_count, 1);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("an out-of-range newest_observed yields null instead of throwing a RangeError", () => {
    const data = buildChainStakeTransferVolume([vrow(1, 40, 4, 1e100)], {
      window: "7d",
    });
    assert.equal(data.observed_at, null);
    assert.equal(data.subnet_count, 1);
  });

  test("an omitted window is emitted as null in both shapes", () => {
    assert.equal(buildChainStakeTransferVolume(SUBNETS, {}).window, null);
    assert.equal(buildChainStakeTransferVolume([], {}).window, null);
  });

  test("empty, non-array, or all-invalid rows yield the empty block", () => {
    for (const rows of [[], "not-an-array", [{ netuid: null }]]) {
      const data = buildChainStakeTransferVolume(rows, { window: "7d" });
      assert.equal(data.subnet_count, 0);
      assert.deepEqual(data.subnets, []);
      assert.equal(data.volume_distribution, null);
      assert.equal(data.network.total_volume_tao, 0);
      assert.equal(data.network.avg_transfer_tao, null);
    }
  });
});

// Mirror of the module's rao-space rounding so the test asserts against the same precision.
function roundTao(value) {
  return Math.round(value * 1e9) / 1e9;
}

describe("loadChainStakeTransferVolume", () => {
  test("sums amount_tao per netuid for StakeTransferred over the window", async () => {
    let captured;
    const before = Date.now();
    const d1 = async (sql, params) => {
      captured = { sql, params };
      return SUBNETS;
    };
    const data = await loadChainStakeTransferVolume(d1, {
      windowLabel: "7d",
      windowDays: 7,
      limit: 20,
    });
    const after = Date.now();
    assert.match(
      captured.sql,
      /COALESCE\(SUM\(amount_tao\), 0\) AS volume_tao/,
    );
    assert.match(captured.sql, /COUNT\(\*\) AS transfers/);
    assert.match(
      captured.sql,
      /WHERE event_kind = \? AND observed_at >= \? GROUP BY netuid/,
    );
    assert.equal(captured.params[0], STAKE_TRANSFERRED_EVENT_KIND);
    const dayMs = 24 * 60 * 60 * 1000;
    assert.ok(captured.params[1] >= before - 7 * dayMs - 5);
    assert.ok(captured.params[1] <= after - 7 * dayMs + 5);
    assert.equal(data.subnet_count, 3);
    assert.equal(data.subnets[0].netuid, 1);
  });

  test("a cold store (no rows) returns the empty block", async () => {
    const data = await loadChainStakeTransferVolume(async () => [], {
      windowLabel: "7d",
      windowDays: 7,
    });
    assert.equal(data.subnet_count, 0);
    assert.equal(data.observed_at, null);
    assert.equal(data.network.total_volume_tao, 0);
  });
});

describe("GET /api/v1/chain/stake-transfer-volume", () => {
  function volumeEnv(rows) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind: () => ({
              all: () => Promise.resolve({ results: rows }),
            }),
          };
        },
      },
    };
  }
  const req = (q = "") =>
    new Request(
      `https://api.metagraph.sh/api/v1/chain/stake-transfer-volume${q}`,
    );

  test("dispatches to the network stake-transfer-volume scorecard", async () => {
    const res = await handleRequest(req("?window=7d"), volumeEnv(SUBNETS), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 3);
    assert.equal(body.data.subnets[0].netuid, 1);
    assert.equal(body.data.network.total_volume_tao, 95);
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/chain/stake-transfer-volume.json",
    );
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/stake-transfer-volume",
        { method: "HEAD" },
      ),
      volumeEnv(SUBNETS),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("serves a schema-stable empty card on a cold store", async () => {
    const res = await handleRequest(req(), volumeEnv([]), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.subnets, []);
    assert.equal(body.data.volume_distribution, null);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(req("?window=90d"), volumeEnv([]), {});
    assert.equal(res.status, 400);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(req("?bogus=1"), volumeEnv([]), {});
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(req("?limit=0"), volumeEnv([]), {});
    assert.equal(res.status, 400);
  });

  const CSV_HEADER = "netuid,volume_tao,transfers,avg_transfer_tao";

  test("exports the per-subnet leaderboard as CSV with ?format=csv", async () => {
    const res = await handleRequest(
      req("?window=7d&format=csv"),
      volumeEnv(SUBNETS),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(
      res.headers.get("content-disposition"),
      /attachment; filename="chain-stake-transfer-volume\.csv"/,
    );
    const lines = (await res.text()).trim().split("\r\n");
    assert.equal(lines[0], CSV_HEADER);
    // Ranked by volume desc: netuid 1 (40), 2 (30), 5 (25).
    assert.equal(lines.length, 4);
    assert.equal(lines[1], "1,40,4,10");
  });

  test("honors Accept: text/csv the same as ?format=csv", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/stake-transfer-volume",
        { headers: { accept: "text/csv" } },
      ),
      volumeEnv(SUBNETS),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
  });

  test("emits a header-only CSV on a cold store", async () => {
    const res = await handleRequest(req("?format=csv"), volumeEnv([]), {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal((await res.text()).trim(), CSV_HEADER);
  });

  test("serves a CSV HEAD probe with the CSV headers and no body", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/chain/stake-transfer-volume?format=csv",
        { method: "HEAD" },
      ),
      volumeEnv(SUBNETS),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(await res.text(), "");
  });

  test("rejects an unsupported format value with 400", async () => {
    const res = await handleRequest(req("?format=xml"), volumeEnv([]), {});
    assert.equal(res.status, 400);
  });
});

describe("chain/stake-transfer-volume edge cache", () => {
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
        prepare() {
          return {
            bind: () => ({
              all: () => Promise.resolve({ results: SUBNETS }),
            }),
          };
        },
      },
    };
    const waits = [];
    const call = () =>
      handleRequest(
        new Request(
          "https://api.metagraph.sh/api/v1/chain/stake-transfer-volume",
        ),
        env,
        { waitUntil: (promise) => waits.push(promise) },
      );
    const res = await call();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.subnet_count, 3);
    await Promise.all(waits);
    assert.equal(store.size, 1);
    const cached = await call();
    assert.equal(cached.status, 200);
    assert.equal((await cached.json()).data.subnet_count, 3);
  });
});
