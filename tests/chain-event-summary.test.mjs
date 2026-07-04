import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  buildChainEventSummary,
  loadChainEventSummary,
  CHAIN_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  CHAIN_EVENT_SUMMARY_WINDOWS,
} from "../src/chain-event-summary.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const OBS = 1_750_000_000_000;

function kindRow(
  event_kind,
  event_count,
  {
    subnet_count = 1,
    hotkey_count = 1,
    coldkey_count = 0,
    amount_tao = null,
    alpha_amount = null,
    first_block = 100,
    last_block = 120,
    first_observed_at = OBS,
    last_observed_at = OBS + 10_000,
  } = {},
) {
  return {
    event_kind,
    event_count,
    subnet_count,
    hotkey_count,
    coldkey_count,
    amount_tao,
    alpha_amount,
    first_block,
    last_block,
    first_observed_at,
    last_observed_at,
  };
}

describe("buildChainEventSummary", () => {
  test("groups event kinds into coarse categories with per-kind subnet reach", () => {
    const out = buildChainEventSummary(
      [
        kindRow("StakeAdded", "3", {
          subnet_count: 2,
          hotkey_count: "2",
          coldkey_count: "1",
          amount_tao: 3.3,
          alpha_amount: "0.4",
        }),
        kindRow("WeightsSet", 2, {
          subnet_count: 3,
          hotkey_count: 1,
          first_block: 90,
          last_block: 119,
          first_observed_at: 1_749_999_000_000,
          last_observed_at: 1_750_000_005_000,
        }),
        { event_kind: "", event_count: 99 },
      ],
      [
        {
          block_number: 120,
          event_index: 2,
          event_kind: "StakeAdded",
          netuid: 7,
          observed_at: 1_750_000_010_000,
        },
      ],
      { window: "7d", limit: 5, subnetCount: 4 },
    );
    assert.equal(out.schema_version, 1);
    assert.equal(out.window, "7d");
    assert.equal(out.subnet_count, 4);
    assert.equal(out.total_events, 5);
    assert.equal(out.kind_count, 2);
    assert.equal(out.category_count, 2);
    assert.equal(out.event_kinds[0].event_kind, "StakeAdded");
    assert.equal(out.event_kinds[0].subnet_count, 2);
    assert.equal(out.event_kinds[0].amount_tao, 3.3);
    assert.equal(out.categories[0].category, "stake");
    assert.equal(out.categories[0].event_count, 3);
    assert.equal(out.recent_event_count, 1);
    assert.equal(out.observed_at, "2025-06-15T15:06:50.000Z");
  });

  test("merges same-category bounds and tie-sorts deterministically", () => {
    const out = buildChainEventSummary(
      [
        kindRow("StakeAdded", 2, {
          amount_tao: 1,
          alpha_amount: 0.1,
          first_block: 200,
          last_block: 210,
          first_observed_at: 1_750_000_200_000,
          last_observed_at: 1_750_000_210_000,
        }),
        kindRow("StakeRemoved", 2, {
          amount_tao: 2,
          alpha_amount: 0.2,
          first_block: null,
          last_block: null,
          first_observed_at: null,
          last_observed_at: null,
        }),
        kindRow("StakeMoved", 2, {
          amount_tao: 3,
          alpha_amount: 0.3,
          first_block: 150,
          last_block: 250,
          first_observed_at: 1_750_000_150_000,
          last_observed_at: 1_750_000_260_000,
        }),
        kindRow("WeightsSet", 2, { first_block: 180, last_block: 181 }),
        kindRow("AxonServed", 2, { first_block: 190, last_block: 191 }),
      ],
      [{ block_number: 250, event_index: 0, event_kind: "StakeMoved" }],
      { window: "30d", limit: 1, subnetCount: 5 },
    );
    assert.deepEqual(
      out.event_kinds.map((row) => row.event_kind),
      ["WeightsSet", "AxonServed", "StakeAdded", "StakeMoved", "StakeRemoved"],
    );
    assert.deepEqual(
      out.categories.map((row) => row.category),
      ["stake", "consensus", "serving"],
    );
    assert.deepEqual(
      {
        event_count: out.categories[0].event_count,
        amount_tao: out.categories[0].amount_tao,
        first_block: out.categories[0].first_block,
        last_block: out.categories[0].last_block,
      },
      {
        event_count: 6,
        amount_tao: 6,
        first_block: 150,
        last_block: 250,
      },
    );
  });

  test("is schema-stable for malformed cold inputs", () => {
    const out = buildChainEventSummary(null, null, { subnetCount: null });
    assert.equal(out.window, null);
    assert.equal(out.observed_at, null);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.total_events, 0);
    assert.equal(out.limit, null);
    assert.deepEqual(out.categories, []);
    assert.deepEqual(out.event_kinds, []);
    assert.deepEqual(out.recent_events, []);
  });

  test("keeps unknown future kinds in the other category", () => {
    const out = buildChainEventSummary([kindRow("FutureRuntimeEvent", 1)], [], {
      subnetCount: 1,
    });
    assert.equal(out.event_kinds[0].event_kind, "FutureRuntimeEvent");
    assert.equal(out.event_kinds[0].category, "other");
    assert.equal(out.categories[0].category, "other");
  });

  test("coerces non-numeric subnet_count cells to zero", () => {
    const out = buildChainEventSummary(
      [kindRow("StakeAdded", 1, { subnet_count: "bad" })],
      [],
      { subnetCount: "nope" },
    );
    assert.equal(out.subnet_count, 0);
    assert.equal(out.event_kinds[0].subnet_count, 0);
  });

  test("coerces blank or negative amount cells and invalid block numbers", () => {
    const out = buildChainEventSummary(
      [
        kindRow("Transfer", 2, {
          amount_tao: "",
          alpha_amount: -1,
          first_block: -5,
          last_block: "bad",
        }),
        kindRow("DelegateAdded", 1, {
          amount_tao: "not-a-number",
        }),
      ],
      [],
      { subnetCount: 1 },
    );
    const transfer = out.event_kinds.find(
      (row) => row.event_kind === "Transfer",
    );
    const delegation = out.event_kinds.find(
      (row) => row.event_kind === "DelegateAdded",
    );
    assert.equal(transfer.amount_tao, 0);
    assert.equal(transfer.alpha_amount, 0);
    assert.equal(transfer.first_block, null);
    assert.equal(transfer.last_block, null);
    assert.equal(transfer.category, "transfer");
    assert.equal(delegation.category, "delegation");
    assert.equal(delegation.amount_tao, 0);
  });

  test("maps every coarse runtime category bucket", () => {
    const kinds = [
      "NeuronRegistered",
      "StakeAdded",
      "AxonServed",
      "WeightsSet",
      "DelegateAdded",
      "HotkeySwapped",
      "SubnetOwnerHotkeySet",
      "Transfer",
    ];
    const out = buildChainEventSummary(
      kinds.map((event_kind, i) => kindRow(event_kind, i + 1)),
      [],
      { subnetCount: kinds.length },
    );
    assert.deepEqual(
      [...new Set(out.event_kinds.map((row) => row.category))].sort(),
      [
        "consensus",
        "delegation",
        "governance",
        "identity",
        "registration",
        "serving",
        "stake",
        "transfer",
      ],
    );
  });

  test("derives observed_at from recent evidence when kind rows omit timestamps", () => {
    const out = buildChainEventSummary(
      [kindRow("StakeAdded", 1, { last_observed_at: null })],
      [
        {
          block_number: 100,
          event_index: 0,
          event_kind: "StakeAdded",
          netuid: 1,
          observed_at: OBS + 5000,
        },
      ],
      { limit: 1, subnetCount: 1 },
    );
    assert.equal(out.observed_at, new Date(OBS + 5000).toISOString());
  });
});

describe("loadChainEventSummary", () => {
  test("probes subnet reach then reads kind aggregates and recent evidence", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      if (/GROUP BY event_kind/.test(sql)) {
        return [kindRow("StakeAdded", 2, { subnet_count: 3 })];
      }
      if (/MAX\(observed_at\) AS newest_observed/.test(sql)) {
        return [{ subnet_count: 4, newest_observed: OBS }];
      }
      return [{ block_number: 10, event_index: 1, event_kind: "StakeAdded" }];
    };
    const out = await loadChainEventSummary(d1, {
      windowLabel: "90d",
      limit: 50,
    });
    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /MAX\(observed_at\) AS newest_observed/);
    assert.match(calls[1].sql, /COUNT\(DISTINCT netuid\) AS subnet_count/);
    assert.match(calls[1].sql, /GROUP BY event_kind/);
    assert.doesNotMatch(calls[1].sql, /WHERE netuid = \?/);
    assert.match(calls[2].sql, /ORDER BY block_number DESC, event_index DESC/);
    assert.doesNotMatch(calls[2].sql, /WHERE netuid = \?/);
    assert.equal(calls[2].params.at(-1), 50);
    assert.equal(out.window, "90d");
    assert.equal(out.limit, 50);
    assert.equal(out.subnet_count, 4);
    assert.equal(out.total_events, 2);
  });

  test("falls back to the default direct-call window", async () => {
    let cutoff;
    const out = await loadChainEventSummary(
      async (sql, params) => {
        if (/MAX\(observed_at\) AS newest_observed/.test(sql)) {
          cutoff = params[0];
          return [{ subnet_count: 0, newest_observed: null }];
        }
        return [];
      },
      { windowLabel: "bogus" },
    );
    const expectedCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(cutoff - expectedCutoff) < 1000);
    assert.equal(out.window, "30d");
    assert.equal(out.subnet_count, 0);
  });

  test("counts distinct actors over hotkey-or-uid identity for WeightsSet", async () => {
    let kindSql;
    const out = await loadChainEventSummary(
      async (sql) => {
        if (/GROUP BY event_kind/.test(sql)) {
          kindSql = sql;
          return [
            kindRow("WeightsSet", 3, {
              hotkey_count: 3,
              subnet_count: 2,
            }),
          ];
        }
        if (/MAX\(observed_at\) AS newest_observed/.test(sql)) {
          return [{ subnet_count: 2, newest_observed: OBS }];
        }
        return [];
      },
      { windowLabel: "7d" },
    );
    assert.match(kindSql, /WHEN uid IS NOT NULL THEN 'uid:' \|\| netuid/);
    assert.equal(out.event_kinds[0].hotkey_count, 3);
  });

  test("skips kind/recent reads on a cold store", async () => {
    const calls = [];
    const out = await loadChainEventSummary(
      async (sql, params) => {
        calls.push({ sql, params });
        return [{ subnet_count: 0, newest_observed: null }];
      },
      { windowLabel: "7d" },
    );
    assert.equal(calls.length, 1);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.total_events, 0);
    assert.deepEqual(out.event_kinds, []);
    assert.deepEqual(out.recent_events, []);
  });

  test("exports the same window constants as the subnet summary route", () => {
    assert.deepEqual(CHAIN_EVENT_SUMMARY_WINDOWS, {
      "7d": 7,
      "30d": 30,
      "90d": 90,
    });
  });

  test("clamps recent evidence limit to the configured max", async () => {
    const d1 = async (sql) => {
      if (/MAX\(observed_at\) AS newest_observed/.test(sql)) {
        return [{ subnet_count: 1, newest_observed: OBS }];
      }
      if (/GROUP BY event_kind/.test(sql)) return [];
      return [];
    };
    const out = await loadChainEventSummary(d1, {
      windowLabel: "7d",
      limit: CHAIN_EVENT_SUMMARY_RECENT_LIMIT_MAX + 100,
    });
    assert.equal(out.limit, CHAIN_EVENT_SUMMARY_RECENT_LIMIT_MAX);
  });

  test("falls back to probe newest_observed when shaped rows lack timestamps", async () => {
    const out = await loadChainEventSummary(
      async (sql) => {
        if (/MAX\(observed_at\) AS newest_observed/.test(sql)) {
          return [{ subnet_count: 2, newest_observed: OBS }];
        }
        if (/GROUP BY event_kind/.test(sql)) {
          return [
            kindRow("NeuronRegistered", 1, {
              first_observed_at: null,
              last_observed_at: null,
              first_block: null,
              last_block: null,
            }),
          ];
        }
        return [];
      },
      { windowLabel: "7d" },
    );
    assert.equal(out.observed_at, new Date(OBS).toISOString());
  });

  test("returns subnet_count zero when the probe query yields no row", async () => {
    const calls = [];
    const out = await loadChainEventSummary(
      async (sql, params) => {
        calls.push({ sql, params });
        if (/MAX\(observed_at\) AS newest_observed/.test(sql)) return [];
        throw new Error(`unexpected query: ${sql}`);
      },
      { windowLabel: "30d" },
    );
    assert.equal(calls.length, 1);
    assert.equal(out.subnet_count, 0);
    assert.equal(out.total_events, 0);
    assert.equal(out.observed_at, null);
  });
});

describe("GET /api/v1/chain/event-summary", () => {
  function eventSummaryEnv({ probeRow, kindRows, recentRows }) {
    return {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: {
        prepare(sql) {
          return {
            bind: () => ({
              all: () =>
                Promise.resolve({
                  results: /GROUP BY event_kind/.test(sql)
                    ? kindRows
                    : /MAX\(observed_at\) AS newest_observed/.test(sql)
                      ? probeRow
                      : recentRows,
                }),
            }),
          };
        },
      },
    };
  }

  const req = (q = "") =>
    new Request(`https://api.metagraph.sh/api/v1/chain/event-summary${q}`);
  const cold = {
    probeRow: [{ subnet_count: 0, newest_observed: null }],
    kindRows: [],
    recentRows: [],
  };
  const warm = {
    probeRow: [{ subnet_count: 3, newest_observed: OBS }],
    kindRows: [
      kindRow("StakeAdded", 5, { subnet_count: 2 }),
      kindRow("WeightsSet", 3, { subnet_count: 3 }),
    ],
    recentRows: [
      {
        block_number: 120,
        event_index: 1,
        event_kind: "StakeAdded",
        netuid: 7,
        observed_at: OBS,
      },
    ],
  };

  test("dispatches to the network-wide event summary", async () => {
    const res = await handleRequest(
      req("?window=7d&limit=5"),
      eventSummaryEnv(warm),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.data.subnet_count, 3);
    assert.equal(body.data.event_kinds[0].event_kind, "StakeAdded");
    assert.equal(body.data.event_kinds[0].subnet_count, 2);
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/chain/event-summary.json",
    );
  });

  test("serves a HEAD probe through the GET cache key with no body", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/chain/event-summary", {
        method: "HEAD",
      }),
      eventSummaryEnv(warm),
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  test("serves a schema-stable empty summary on a cold store", async () => {
    const res = await handleRequest(req(), eventSummaryEnv(cold), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.subnet_count, 0);
    assert.deepEqual(body.data.categories, []);
    assert.deepEqual(body.data.event_kinds, []);
    assert.deepEqual(body.data.recent_events, []);
  });

  test("rejects an unsupported window with 400", async () => {
    const res = await handleRequest(
      req("?window=1y"),
      eventSummaryEnv(cold),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("rejects an unknown query param with 400", async () => {
    const res = await handleRequest(req("?bogus=1"), eventSummaryEnv(cold), {});
    assert.equal(res.status, 400);
  });

  test("rejects an out-of-range limit with 400", async () => {
    const res = await handleRequest(req("?limit=0"), eventSummaryEnv(cold), {});
    assert.equal(res.status, 400);
  });

  test("rejects ?format=csv as an unknown param (JSON-only route)", async () => {
    const res = await handleRequest(
      req("?format=csv"),
      eventSummaryEnv(cold),
      {},
    );
    assert.equal(res.status, 400);
  });

  test("defaults to the 30d window when omitted", async () => {
    const res = await handleRequest(req(), eventSummaryEnv(warm), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.window, "30d");
  });
});

describe("chain/event-summary edge cache", () => {
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
                  results: /GROUP BY event_kind/.test(sql)
                    ? [kindRow("StakeAdded", 1, { subnet_count: 1 })]
                    : /MAX\(observed_at\) AS newest_observed/.test(sql)
                      ? [{ subnet_count: 2, newest_observed: OBS }]
                      : [],
                }),
            }),
          };
        },
      },
    };
    const waits = [];
    const call = () =>
      handleRequest(
        new Request("https://api.metagraph.sh/api/v1/chain/event-summary"),
        env,
        { waitUntil: (promise) => waits.push(promise) },
      );
    const res = await call();
    assert.equal(res.status, 200);
    const cached = await call();
    assert.equal(cached.status, 200);
    assert.equal(store.size, 1);
    await Promise.all(waits);
  });
});
