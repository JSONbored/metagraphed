import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildGlobalAccounts,
  loadGlobalAccounts,
  DEFAULT_GLOBAL_ACCOUNT_SORT,
  GLOBAL_ACCOUNT_SORTS,
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

  test("buildGlobalAccounts handles sparse rows, subnet caps, and D1 string coercion", () => {
    const subnets = Array.from({ length: 12 }, (_, index) => ({
      ...NEURON_ROW,
      netuid: index + 1,
      uid: index,
      hotkey: `5Hk${index}`,
      coldkey: "5CoCap",
      stake_tao: 100 - index,
      emission_tao: 10 - index,
      validator_permit: index % 2 === 0 ? true : 0,
      block_number: String(1000 + index),
      captured_at: String(1750000000000 + index),
    }));
    const data = buildGlobalAccounts(
      [
        ...subnets,
        { ...NEURON_ROW, coldkey: "", netuid: 99, uid: 0 },
        { ...NEURON_ROW, coldkey: "5CoBad", netuid: null, uid: 0 },
        { ...NEURON_ROW, coldkey: "5CoBad", netuid: 1, uid: "bad" },
        {
          ...NEURON_ROW,
          hotkey: null,
          coldkey: "5CoNullHotkey",
          netuid: 7,
          uid: 0,
        },
      ],
      [
        { coldkey: "", event_count: 9, last_seen_at: 1, last_block: 1 },
        {
          coldkey: "5CoCap",
          event_count: "15",
          last_seen_at: "1750000000500",
          last_block: "8454399",
        },
      ],
      { sort: "subnet_count", limit: 1 },
    );
    assert.equal(data.accounts.length, 1);
    const top = data.accounts[0];
    assert.equal(top.ss58, "5CoCap");
    assert.equal(top.subnet_count, 12);
    assert.equal(top.uid_count, 12);
    assert.equal(top.hotkey_count, 12);
    assert.equal(top.validator_count, 6);
    assert.equal(top.event_count, 15);
    assert.equal(top.latest_block_number, 8454399);
    assert.equal(top.subnets.length, 10);
    assert.equal(top.subnets[0].netuid, 1);
    assert.equal(top.subnets[9].netuid, 10);
    assert.equal(data.captured_at, new Date(1750000000011).toISOString());
    assert.equal(data.block_number, 1011);
  });

  test("buildGlobalAccounts sorts by every supported leaderboard key", () => {
    const rows = [
      {
        ...NEURON_ROW,
        coldkey: "5CoA",
        hotkey: "5Ha",
        stake_tao: 10,
        emission_tao: 1,
        validator_permit: 1,
        captured_at: 1000,
      },
      {
        ...NEURON_ROW,
        coldkey: "5CoB",
        hotkey: "5Hb",
        stake_tao: 20,
        emission_tao: 5,
        validator_permit: 0,
        captured_at: 2000,
      },
      {
        ...NEURON_ROW,
        coldkey: "5CoC",
        hotkey: "5Hc",
        stake_tao: 5,
        emission_tao: 10,
        validator_permit: 1,
        captured_at: 3000,
      },
    ];
    const events = [
      {
        coldkey: "5CoA",
        event_count: 1,
        last_seen_at: 1000,
        last_block: 10,
      },
      {
        coldkey: "5CoB",
        event_count: 50,
        last_seen_at: 5000,
        last_block: 20,
      },
      {
        coldkey: "5CoC",
        event_count: 10,
        last_seen_at: 3000,
        last_block: 30,
      },
    ];
    const expectedTop = {
      total_stake: "5CoB",
      total_emission: "5CoC",
      subnet_count: "5CoA",
      uid_count: "5CoA",
      hotkey_count: "5CoA",
      validator_count: "5CoA",
      event_count: "5CoB",
      last_update_at: "5CoB",
      stake_dominance: "5CoB",
    };
    for (const sort of GLOBAL_ACCOUNT_SORTS) {
      const data = buildGlobalAccounts(rows, events, { sort, limit: 3 });
      assert.equal(data.sort, sort);
      assert.equal(data.accounts[0].ss58, expectedTop[sort], sort);
    }
  });

  test("buildGlobalAccounts nulls dominance and timestamps on junk input", () => {
    const data = buildGlobalAccounts(
      [
        {
          ...NEURON_ROW,
          coldkey: "5CoJunk",
          hotkey: "",
          stake_tao: -1,
          emission_tao: "bad",
          captured_at: "not-a-date",
          block_number: "bad",
          validator_permit: true,
        },
        {
          ...NEURON_ROW,
          coldkey: "5CoZero",
          stake_tao: 0,
          emission_tao: 0,
          captured_at: null,
        },
      ],
      [
        {
          coldkey: "5CoJunk",
          event_count: null,
          last_seen_at: "",
          last_block: null,
        },
      ],
      { sort: "last_update_at", limit: 10 },
    );
    assert.equal(data.captured_at, null);
    assert.equal(data.block_number, null);
    assert.equal(data.accounts[0].stake_dominance, null);
    assert.equal(data.accounts[0].last_seen_at, null);
    assert.equal(data.accounts[0].latest_captured_at, null);
    assert.equal(data.accounts[0].last_update_at, null);
    assert.equal(data.accounts[0].delegated_stake_tao, 0);
    assert.equal(data.accounts[1].stake_dominance, null);
  });

  test("buildGlobalAccounts uses ss58 tie-breakers and non-finite limit fallback", () => {
    const data = buildGlobalAccounts(
      [
        { ...NEURON_ROW, coldkey: "5CoZ", stake_tao: 5 },
        { ...NEURON_ROW, coldkey: "5CoY", stake_tao: 5 },
      ],
      [],
      { sort: "total_stake", limit: Number.NaN },
    );
    assert.equal(data.limit, 20);
    assert.equal(data.accounts[0].ss58, "5CoY");
    assert.equal(data.accounts[1].ss58, "5CoZ");
  });

  test("buildGlobalAccounts breaks captured_at ties using block_number", () => {
    const data = buildGlobalAccounts(
      [
        {
          ...NEURON_ROW,
          coldkey: "5CoTie",
          captured_at: 1000,
          block_number: 5,
          stake_tao: 1,
        },
        {
          ...NEURON_ROW,
          coldkey: "5CoTie",
          netuid: 2,
          uid: 1,
          captured_at: 1000,
          block_number: 10,
          stake_tao: 1,
        },
      ],
      [],
      { sort: "total_stake", limit: 10 },
    );
    assert.equal(data.accounts[0].latest_block_number, 10);
    assert.equal(data.block_number, 10);
  });

  test("buildGlobalAccounts keeps null block_number on the newest capture", () => {
    const data = buildGlobalAccounts(
      [
        {
          ...NEURON_ROW,
          coldkey: "5CoNull",
          captured_at: 2000,
          block_number: null,
        },
        {
          ...NEURON_ROW,
          coldkey: "5CoNull",
          netuid: 2,
          uid: 1,
          captured_at: 1000,
          block_number: 99,
        },
      ],
      [],
      { limit: 10 },
    );
    assert.equal(data.accounts[0].latest_block_number, null);
    assert.equal(data.block_number, null);
  });

  test("buildGlobalAccounts sorts subnet footprints by emission, netuid, and uid", () => {
    const data = buildGlobalAccounts(
      [
        {
          ...NEURON_ROW,
          netuid: 3,
          uid: 9,
          coldkey: "5CoSort",
          stake_tao: 10,
          emission_tao: 1,
        },
        {
          ...NEURON_ROW,
          netuid: 3,
          uid: 1,
          coldkey: "5CoSort",
          stake_tao: 10,
          emission_tao: 2,
        },
        {
          ...NEURON_ROW,
          netuid: 2,
          uid: 0,
          coldkey: "5CoSort",
          stake_tao: 10,
          emission_tao: 2,
        },
      ],
      [],
      { limit: 10 },
    );
    assert.deepEqual(
      data.accounts[0].subnets.map((subnet) => [subnet.netuid, subnet.uid]),
      [
        [2, 0],
        [3, 1],
        [3, 9],
      ],
    );
  });

  test("buildGlobalAccounts promotes event last_block when it exceeds neuron height", () => {
    const data = buildGlobalAccounts(
      [
        {
          ...NEURON_ROW,
          coldkey: "5CoEvt",
          block_number: 100,
          captured_at: 1000,
        },
      ],
      [
        {
          coldkey: "5CoEvt",
          event_count: 1,
          last_seen_at: 1000,
          last_block: 500,
        },
      ],
      { limit: 10 },
    );
    assert.equal(data.accounts[0].latest_block_number, 500);
  });

  test("buildGlobalAccounts ignores zero captures and negative netuids", () => {
    const data = buildGlobalAccounts(
      [
        {
          ...NEURON_ROW,
          coldkey: "5CoSkip",
          captured_at: 0,
          block_number: 1,
        },
        {
          ...NEURON_ROW,
          coldkey: "5CoSkip",
          netuid: -1,
          uid: 0,
          captured_at: 2000,
        },
      ],
      [],
      { limit: 10 },
    );
    assert.equal(data.accounts.length, 1);
    assert.equal(data.accounts[0].latest_captured_at, null);
    assert.equal(data.captured_at, null);
  });

  test("buildGlobalAccounts clamps oversized limits", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...NEURON_ROW,
      coldkey: `5Co${index}`,
      uid: index,
      netuid: index + 1,
    }));
    const data = buildGlobalAccounts(rows, [], { limit: 999 });
    assert.equal(data.limit, 100);
    assert.equal(data.account_count, 3);
  });

  test("buildGlobalAccounts treats null stake_dominance as lowest sort rank", () => {
    const data = buildGlobalAccounts(
      [
        { ...NEURON_ROW, coldkey: "5CoB", stake_tao: 0 },
        { ...NEURON_ROW, coldkey: "5CoA", stake_tao: 0 },
      ],
      [],
      { sort: "stake_dominance", limit: 10 },
    );
    assert.equal(data.accounts[0].stake_dominance, null);
    assert.equal(data.accounts[1].stake_dominance, null);
    assert.equal(data.accounts[0].ss58, "5CoA");
  });

  test("buildGlobalAccounts rejects out-of-range captures and uid-ties subnet ordering", () => {
    const data = buildGlobalAccounts(
      [
        {
          ...NEURON_ROW,
          coldkey: "5CoRange",
          captured_at: 8640000000000001,
          block_number: 1,
        },
        {
          ...NEURON_ROW,
          coldkey: "5CoUid",
          netuid: 1,
          uid: 2,
          stake_tao: 10,
          emission_tao: 1,
        },
        {
          ...NEURON_ROW,
          coldkey: "5CoUid",
          netuid: 1,
          uid: 1,
          stake_tao: 10,
          emission_tao: 1,
        },
      ],
      [],
      { limit: 10 },
    );
    const ranged = data.accounts.find((entry) => entry.ss58 === "5CoRange");
    assert.equal(ranged.latest_captured_at, null);
    assert.equal(data.captured_at, null);
    const uidSorted = data.accounts.find((entry) => entry.ss58 === "5CoUid");
    assert.deepEqual(
      uidSorted.subnets.map((subnet) => subnet.uid),
      [1, 2],
    );
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

  test("GET /accounts?format=csv emits a header-only cold export", async () => {
    const { text } = await getText("/api/v1/accounts?format=csv", {
      ...createLocalArtifactEnv(),
      METAGRAPH_HEALTH_DB: combinedD1(),
    });
    assert.equal(text, GLOBAL_ACCOUNT_CSV_HEADER);
  });
});
