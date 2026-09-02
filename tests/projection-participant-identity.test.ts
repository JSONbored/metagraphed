import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  LAKEHOUSE_NAMESPACES,
  projectionKey,
  type ChainNetworkId,
} from "../src/chain-network.ts";
import { loadChainServingFromArtifact } from "../src/chain-serving-artifact.ts";
import { loadChainPrometheusFromArtifact } from "../src/chain-prometheus-artifact.ts";
import { loadChainWeightsFromArtifact } from "../src/chain-weights-artifact.ts";
import { ROLLUP_POPULATION_CAP } from "../src/chain-event-rollup-cold-tier.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import {
  PROJECTION_LANES,
  runProjectionLane,
} from "../src/projection-lanes.ts";

const NOW = Date.UTC(2026, 8, 2, 12);
const OBSERVED = NOW - 60_000;
const DAY_MS = 86_400_000;
const realFetch = globalThis.fetch;
let db: DatabaseSync;
let failQuery: (sql: string) => boolean;

beforeEach(() => {
  resetModuleState();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  db = new DatabaseSync(":memory:");
  for (const namespace of Object.values(LAKEHOUSE_NAMESPACES)) {
    db.exec(`ATTACH DATABASE ':memory:' AS ${namespace}`);
    db.exec(`CREATE TABLE ${namespace}.account_events (
      netuid INTEGER, event_kind TEXT, observed_at INTEGER,
      coldkey TEXT, hotkey TEXT, uid INTEGER
    )`);
  }
  failQuery = () => false;
  // Execute the actual projection SQL. Canned aggregate rows cannot detect
  // counting a column that is NULL on every event of the selected kind.
  globalThis.fetch = (async (_input, init) => {
    const sql = String(JSON.parse(String(init?.body)).query);
    if (failQuery(sql)) return new Response("unavailable", { status: 503 });
    const rows = db.prepare(sql).all();
    return Response.json({ success: true, result: { rows } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  resetModuleState();
  db.close();
});

const CASES = [
  {
    lane: "chain-serving",
    kind: "AxonServed",
    count: "announcements",
    distinct: "distinct_servers",
    participants: 2,
    events: 4,
    rows: [
      [19, "hotkey-a", null],
      [19, "hotkey-a", null],
      [50, "hotkey-a", null],
      [50, "hotkey-b", null],
    ],
    read: loadChainServingFromArtifact,
  },
  {
    lane: "chain-prometheus",
    kind: "PrometheusServed",
    count: "announcements",
    distinct: "distinct_exporters",
    participants: 1,
    events: 3,
    rows: [
      [19, "hotkey-a", null],
      [19, "hotkey-a", null],
      [50, "hotkey-a", null],
    ],
    read: loadChainPrometheusFromArtifact,
  },
  {
    lane: "chain-weights",
    kind: "WeightsSet",
    count: "weight_sets",
    distinct: "distinct_setters",
    participants: 3,
    events: 4,
    rows: [
      [19, null, 0],
      [19, null, 0],
      [19, null, 1],
      [50, null, 0],
    ],
    read: loadChainWeightsFromArtifact,
  },
] as const;

function insertEvents(
  scenario: (typeof CASES)[number],
  network: ChainNetworkId,
) {
  const namespace = LAKEHOUSE_NAMESPACES[network];
  const insert = db.prepare(`INSERT INTO ${namespace}.account_events
    (netuid, event_kind, observed_at, hotkey, uid) VALUES (?, ?, ?, ?, ?)`);
  for (const [netuid, hotkey, uid] of scenario.rows) {
    insert.run(netuid, scenario.kind, OBSERVED, hotkey, uid);
  }
  insert.run(99, scenario.kind, NOW - 31 * DAY_MS, "old-hotkey", 99);
  const other =
    LAKEHOUSE_NAMESPACES[network === "mainnet" ? "testnet" : "mainnet"];
  db.prepare(
    `INSERT INTO ${other}.account_events
    (netuid, event_kind, observed_at, hotkey, uid) VALUES (?, ?, ?, ?, ?)`,
  ).run(88, scenario.kind, OBSERVED, "other-network", 88);
}

function storage() {
  const objects = new Map<string, string>();
  const writes: string[] = [];
  const env = {
    R2_SQL_TOKEN: "cfut_test",
    METAGRAPH_ARCHIVE: {
      async put(key: string, value: string) {
        writes.push(key);
        objects.set(key, value);
      },
      async get(key: string) {
        const value = objects.get(key);
        return value === undefined
          ? null
          : { json: async () => JSON.parse(value) };
      },
    },
  } as unknown as Env;
  return { env, objects, writes };
}

for (const scenario of CASES) {
  describe(scenario.lane, () => {
    const lane = PROJECTION_LANES.find(
      (entry) => entry.name === scenario.lane,
    )!;

    for (const network of ["mainnet", "testnet"] as const) {
      test(`${network} publishes and serves participants without coldkeys`, async () => {
        insertEvents(scenario, network);
        const { env, objects, writes } = storage();
        const result = await runProjectionLane(env, lane, {}, network);
        assert.equal(result.ok, true);
        const key = projectionKey(lane.artifactKey, network);
        assert.deepEqual(writes, [key]);
        const artifact = JSON.parse(objects.get(key)!);
        assert.equal(artifact.row_count, 4);
        for (const window of ["7d", "30d"]) {
          expect(artifact.windows[window].network).toMatchObject({
            [scenario.distinct]: scenario.participants,
            newest_observed: OBSERVED,
          });
          const card = await scenario.read(env, { window }, network);
          expect(card).toMatchObject({
            observed_at: new Date(OBSERVED).toISOString(),
            subnet_count: 2,
            network: {
              [scenario.distinct]: scenario.participants,
              [scenario.count]: scenario.events,
            },
          });
          assert.equal(card?.subnets.length, 2);
        }
      });
    }

    test("an empty window publishes measured zeroes", async () => {
      const { env, objects } = storage();
      assert.equal((await runProjectionLane(env, lane)).ok, true);
      const artifact = JSON.parse(objects.get(lane.artifactKey)!);
      assert.equal(artifact.row_count, 0);
      for (const window of ["7d", "30d"]) {
        expect(artifact.windows[window]).toMatchObject({
          rows: [],
          network: { [scenario.distinct]: 0, newest_observed: null },
        });
        expect(await scenario.read(env, { window })).toMatchObject({
          subnet_count: 0,
          network: { [scenario.distinct]: 0, [scenario.count]: 0 },
        });
      }
    });

    test("a failed later window preserves the previous publication", async () => {
      insertEvents(scenario, "mainnet");
      const { env, objects, writes } = storage();
      const previous = JSON.stringify({ previous: "verified artifact" });
      objects.set(lane.artifactKey, previous);
      failQuery = (sql) => sql.includes(String(NOW - 30 * DAY_MS));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await runProjectionLane(env, lane, {
        recordException: async () => true,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "compute_declined");
      assert.deepEqual(writes, []);
      assert.equal(objects.get(lane.artifactKey), previous);
    });

    test.each(["unreadable", "capped"] as const)(
      "an %s subnet population preserves the previous publication",
      async (population) => {
        if (population === "unreadable") {
          insertEvents(scenario, "mainnet");
          failQuery = (sql) =>
            sql.startsWith("SELECT count(*) AS subnet_count");
        } else {
          const insert = db.prepare(`INSERT INTO chain.account_events
            (netuid, event_kind, observed_at, hotkey, uid) VALUES (?, ?, ?, ?, ?)`);
          const [, hotkey, uid] = scenario.rows[0];
          for (let netuid = 0; netuid <= ROLLUP_POPULATION_CAP; netuid += 1) {
            insert.run(netuid, scenario.kind, OBSERVED, hotkey, uid);
          }
        }
        const { env, objects, writes } = storage();
        const previous = JSON.stringify({ previous: "complete artifact" });
        objects.set(lane.artifactKey, previous);
        vi.spyOn(console, "error").mockImplementation(() => {});
        const result = await runProjectionLane(env, lane, {
          recordException: async () => true,
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "compute_declined");
        assert.deepEqual(writes, []);
        assert.equal(objects.get(lane.artifactKey), previous);
      },
    );
  });
}
