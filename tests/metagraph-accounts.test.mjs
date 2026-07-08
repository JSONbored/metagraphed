import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildGlobalAccounts,
  loadGlobalAccounts,
  DEFAULT_GLOBAL_ACCOUNT_SORT,
} from "../src/metagraph-accounts.mjs";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

const NEURON_ROW = {
  netuid: 1,
  uid: 0,
  hotkey: "5Hk1",
  coldkey: "5Co1",
  validator_permit: 1,
  emission_tao: 22.1,
  stake_tao: 1000.5,
  block_number: 8454388,
  captured_at: 1750000000000,
};

const GLOBAL_ACCOUNT_CSV_HEADER =
  "ss58,hotkey_count,subnet_count,uid_count,validator_count,delegated_stake_tao,total_emission_tao,event_count,stake_dominance,last_seen_at,latest_captured_at,last_update_at,latest_block_number,subnets";

describe("metagraph-accounts builders", () => {
  test("buildGlobalAccounts groups coldkeys across subnets and merges event activity", () => {
    const data = buildGlobalAccounts(
      [
        { ...NEURON_ROW, netuid: 1, uid: 0, hotkey: "5Hk1", stake_tao: 10 },
        { ...NEURON_ROW, netuid: 2, uid: 1, hotkey: "5Hk2", stake_tao: 20 },
        {
          ...NEURON_ROW,
          netuid: 3,
          uid: 0,
          hotkey: "5Hk9",
          coldkey: "5Co9",
          stake_tao: 100,
        },
      ],
      [
        {
          coldkey: "5Co1",
          event_count: 12,
          last_seen_at: 1750000100000,
          last_block: 8454390,
        },
        {
          coldkey: "5Co9",
          event_count: 3,
          last_seen_at: 1740000000000,
          last_block: 8454000,
        },
      ],
      { sort: "total_stake", limit: 10 },
    );
    assert.equal(data.sort, "total_stake");
    assert.equal(data.account_count, 2);
    assert.equal(data.accounts[0].ss58, "5Co9");
    assert.equal(data.accounts[0].delegated_stake_tao, 100);
    assert.equal(data.accounts[0].subnet_count, 1);
    assert.equal(data.accounts[0].hotkey_count, 1);
    assert.equal(data.accounts[0].event_count, 3);
    assert.equal(data.accounts[1].ss58, "5Co1");
    assert.equal(data.accounts[1].delegated_stake_tao, 30);
    assert.equal(data.accounts[1].subnet_count, 2);
    assert.equal(data.accounts[1].hotkey_count, 2);
    assert.equal(data.accounts[1].uid_count, 2);
    assert.equal(data.accounts[1].validator_count, 2);
    assert.equal(data.accounts[1].event_count, 12);
    assert.equal(data.accounts[1].last_seen_at, "2025-06-15T15:08:20.000Z");
    assert.equal(data.accounts[1].last_update_at, "2025-06-15T15:08:20.000Z");
    assert.ok(
      data.accounts[0].stake_dominance > data.accounts[1].stake_dominance,
    );
  });

  test("buildGlobalAccounts includes event-only coldkeys with zero neuron footprint", () => {
    const data = buildGlobalAccounts(
      [],
      [
        {
          coldkey: "5CoOnly",
          event_count: 7,
          last_seen_at: 1750000000000,
          last_block: 8454388,
        },
      ],
      { sort: "event_count", limit: 5 },
    );
    assert.equal(data.accounts.length, 1);
    assert.equal(data.accounts[0].ss58, "5CoOnly");
    assert.equal(data.accounts[0].delegated_stake_tao, 0);
    assert.equal(data.accounts[0].event_count, 7);
    assert.equal(data.accounts[0].subnet_count, 0);
    assert.equal(data.accounts[0].stake_dominance, null);
  });

  test("buildGlobalAccounts is cold-safe and normalizes direct-call options", () => {
    const empty = buildGlobalAccounts(null, null, {
      sort: "bogus",
      limit: 999,
    });
    assert.equal(empty.sort, DEFAULT_GLOBAL_ACCOUNT_SORT);
    assert.equal(empty.limit, 100);
    assert.deepEqual(empty.accounts, []);
    assert.equal(empty.account_count, 0);

    const clamped = buildGlobalAccounts([], [], {
      sort: "uid_count",
      limit: 0,
    });
    assert.equal(clamped.limit, 0);
    assert.deepEqual(clamped.accounts, []);
  });

  test("buildGlobalAccounts sorts by last_update_at with ss58 tie-break", () => {
    const data = buildGlobalAccounts(
      [
        {
          ...NEURON_ROW,
          coldkey: "5CoA",
          captured_at: 1000,
          stake_tao: 1,
        },
        {
          ...NEURON_ROW,
          coldkey: "5CoB",
          captured_at: 2000,
          stake_tao: 1,
        },
      ],
      [],
      { sort: "last_update_at", limit: 10 },
    );
    assert.equal(data.accounts[0].ss58, "5CoB");
    assert.equal(data.accounts[1].ss58, "5CoA");
  });

  test("loadGlobalAccounts queries neurons and account_events aggregates", async () => {
    const calls = [];
    const data = await loadGlobalAccounts(async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM neurons")) {
        return [{ ...NEURON_ROW }];
      }
      return [
        {
          coldkey: "5Co1",
          event_count: 4,
          last_seen_at: 1750000000000,
          last_block: 8454388,
        },
      ];
    });
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /FROM neurons/);
    assert.match(calls[1].sql, /FROM account_events/);
    assert.match(calls[1].sql, /GROUP BY coldkey/);
    assert.equal(data.accounts.length, 1);
    assert.equal(data.accounts[0].event_count, 4);
  });
});

function combinedD1({ neurons = [], events = [] } = {}) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            all() {
              if (sql.includes("FROM neurons")) {
                return Promise.resolve({
                  results: neurons.filter(
                    (row) =>
                      typeof row.coldkey === "string" && row.coldkey.length > 0,
                  ),
                });
              }
              if (sql.includes("FROM account_events")) {
                return Promise.resolve({ results: events });
              }
              if (sql.includes("MAX(captured_at)")) {
                const captured = neurons
                  .map((row) => Number(row.captured_at))
                  .filter((value) => Number.isFinite(value) && value > 0);
                return Promise.resolve({
                  results: [
                    {
                      captured_at:
                        captured.length > 0 ? Math.max(...captured) : null,
                    },
                  ],
                });
              }
              return Promise.resolve({ results: [] });
            },
          };
        },
      };
    },
  };
}

const getJson = async (path, env) => {
  const res = await handleRequest(
    new Request(`https://api.metagraph.sh${path}`),
    env,
    {},
  );
  return { res, body: await res.json() };
};

const getText = async (path, env) => {
  const res = await handleRequest(
    new Request(`https://api.metagraph.sh${path}`),
    env,
    {},
  );
  return { res, text: await res.text() };
};

describe("GET /api/v1/accounts via the Worker", () => {
  test("returns the global account directory", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: combinedD1({
        neurons: [
          { ...NEURON_ROW, netuid: 1, uid: 0, hotkey: "5Hk1", stake_tao: 10 },
          { ...NEURON_ROW, netuid: 2, uid: 1, hotkey: "5Hk2", stake_tao: 20 },
          {
            ...NEURON_ROW,
            netuid: 3,
            uid: 0,
            hotkey: "5Hk9",
            coldkey: "5Co9",
            stake_tao: 100,
          },
        ],
        events: [
          {
            coldkey: "5Co1",
            event_count: 12,
            last_seen_at: 1750000100000,
            last_block: 8454390,
          },
        ],
      }),
    };
    const { res, body } = await getJson(
      "/api/v1/accounts?sort=total_stake&limit=2",
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(body.data.sort, "total_stake");
    assert.equal(body.data.limit, 2);
    assert.equal(body.data.account_count, 2);
    assert.equal(body.data.accounts[0].ss58, "5Co9");
    assert.equal(body.data.accounts[1].ss58, "5Co1");
    assert.equal(body.meta.artifact_path, "/metagraph/accounts.json");
    assert.equal(body.meta.source, "metagraph-snapshot");
  });

  test("GET /accounts?format=csv exports the global account directory", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: combinedD1({
        neurons: [{ ...NEURON_ROW, stake_tao: 100 }],
        events: [
          {
            coldkey: "5Co1",
            event_count: 5,
            last_seen_at: 1750000000000,
            last_block: 8454388,
          },
        ],
      }),
    };
    const { res, text } = await getText(
      "/api/v1/accounts?sort=uid_count&limit=1&format=csv",
      env,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    const lines = text.split("\r\n");
    assert.equal(lines[0], GLOBAL_ACCOUNT_CSV_HEADER);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^5Co1,1,1,1,1,100,22\.1,5,/);
  });

  test("GET /accounts rejects invalid query params", async () => {
    const env = {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: combinedD1(),
    };
    const { res } = await getJson("/api/v1/accounts?sort=bogus", env);
    assert.equal(res.status, 400);
    const unsupported = await getJson("/api/v1/accounts?foo=bar", env);
    assert.equal(unsupported.res.status, 400);
    const badLimit = await getJson("/api/v1/accounts?limit=0", env);
    assert.equal(badLimit.res.status, 400);
  });
});
