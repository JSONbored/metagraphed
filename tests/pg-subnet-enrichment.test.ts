import { afterAll, expect, test, vi } from "vitest";
import { createPgSubnetEnrichmentStore } from "../src/pg-subnet-enrichment.ts";
import { selectedSubnetEnrichmentStore } from "../src/subnet-enrichment-store.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1048576 });
afterAll(() => decoder.close());
function fixture() {
  const calls: { sql: string; values: unknown[] }[] = [];
  let metadata = true;
  let many = false,
    owner: string | null = "owner";
  const read: PgStoreRuntime["read"] = {
    async query<Row>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("WITH selected"))
        return [
          {
            kind: 0,
            netuid: "7",
            snapshot_date: "2026-11-01",
            shard: "0",
            uid: null,
            hotkey: null,
            coldkey: null,
            payload: decoder.encode(
              '{"1":{"emission_tao":2,"take":0.1,"validator_permit":1}}',
            ),
          },
          {
            kind: 1,
            netuid: "7",
            snapshot_date: "2026-11-01",
            shard: "0",
            uid: "1",
            hotkey: "hot",
            coldkey: "cold",
            payload: null,
          },
        ] as Row[];
      if (sql.includes("snapshot_date,alpha_out_emission"))
        return (
          metadata
            ? [
                {
                  snapshot_date: "2026-11-01",
                  alpha_out_emission: 5,
                  alpha_price_tao: 2,
                },
              ]
            : []
        ) as Row[];
      return (many ? Array(100001).fill({}) : []) as Row[];
    },
    async first<Row>() {
      return owner === null ? null : ({ owner_coldkey: owner } as Row);
    },
  };
  const modes: unknown[] = [];
  const transaction: PgStoreRuntime["transaction"] = async (callback, mode) => {
    modes.push(mode);
    return callback({
      ...read,
      async run() {
        return { changes: 0 };
      },
    });
  };
  return {
    store: createPgSubnetEnrichmentStore({ read, transaction }, decoder),
    calls,
    modes,
    setMany() {
      many = true;
    },
    omitMetadata() {
      metadata = false;
    },
    clearOwner() {
      owner = null;
    },
  };
}

test("joins canonical daily rows and snapshots in one repeatable-read scope", async () => {
  const f = fixture();
  expect(await f.store.dailyRows(7, "2026-10-01", "owner", 10)).toEqual([
    {
      snapshot_date: "2026-11-01",
      uid: 1,
      hotkey: "hot",
      coldkey: "cold",
      validator_permit: 1,
      emission_tao: 2,
      take: 0.1,
      alpha_out_emission: 5,
    },
  ]);
  expect(
    (await f.store.dailyRows(7, "2026-10-01", "emission", 10))[0],
  ).toMatchObject({ alpha_price_tao: 2, alpha_out_emission: 5 });
  expect(f.modes).toEqual([
    { isolation: "repeatable read" },
    { isolation: "repeatable read" },
  ]);
  f.omitMetadata();
  expect(
    (await f.store.dailyRows(7, "2026-10-01", "emission", 10))[0],
  ).toMatchObject({ alpha_out_emission: null, alpha_price_tao: null });
  await expect(
    f.store.dailyRows(7, "2026-10-01", "invalid" as never, 10),
  ).rejects.toThrow("kind");
  expect(await f.store.dailyRows(1e30, "2026-10-01", "emission", 10)).toEqual(
    [],
  );
});

test("relational helpers validate identities and refuse incomplete populations", async () => {
  const f = fixture();
  expect(await f.store.ownerColdkey(7)).toBe("owner");
  f.clearOwner();
  expect(await f.store.ownerColdkey(7)).toBeNull();
  for (const method of [
    f.store.ownerPositions,
    f.store.declarations,
    f.store.treasury,
  ]) {
    expect(await method(7)).toEqual([]);
    expect(await method(1e30)).toEqual([]);
    expect(await method(-1e30)).toEqual([]);
    await expect(method(1.5)).rejects.toThrow("identity");
  }
  expect(await f.store.ownerColdkey(1e30)).toBeNull();
  await expect(f.store.ownerColdkey(Infinity)).rejects.toThrow("identity");
  expect(await f.store.usdDays(0, 86400000)).toEqual([]);
  for (const bounds of [
    [NaN, 0],
    [0, Infinity],
    [0, 367 * 86400000],
  ])
    await expect(f.store.usdDays(bounds[0], bounds[1])).rejects.toThrow(
      "window",
    );
  f.setMany();
  for (const method of [
    f.store.ownerPositions,
    f.store.declarations,
    f.store.treasury,
  ])
    await expect(method(7)).rejects.toThrow("complete-row");
  expect(
    selectedSubnetEnrichmentStore({ SUBNET_ENRICHMENT_STORE: f.store }),
  ).toBe(f.store);
  for (const value of [null, {}, 4])
    expect(selectedSubnetEnrichmentStore(value)).toBeNull();
  for (const value of [null, {}, {}])
    expect(() =>
      selectedSubnetEnrichmentStore({ SUBNET_ENRICHMENT_STORE: value }),
    ).toThrow("Invalid");
});

test("native subnet routes require their capabilities and retain opaque errors", async () => {
  const ctx = { waitUntil() {} };
  const store = {
    async dailyRows() {
      return [];
    },
    async ownerColdkey() {
      return null;
    },
    async ownerPositions() {
      return [];
    },
    async declarations() {
      return [];
    },
    async treasury() {
      return [];
    },
    async usdDays() {
      return [
        { observed_at: null, usd_per_tao: null },
        { observed_at: 1793491200000, usd_per_tao: 300 },
      ];
    },
  };
  const env = {
    ...dataApiEnv(),
    SUBNET_ENRICHMENT_STORE: store,
    NEURON_DAILY_VIEW_STORE: {
      async rows() {
        return [];
      },
      async window() {
        return { startDate: null, endDate: null };
      },
    },
    NEURON_VIEW_STORE: {
      async rows() {
        return [];
      },
    },
    NEURON_SNAPSHOT_STORE: {
      async subnetRows() {
        return [];
      },
      async burnHotkey() {
        return null;
      },
    },
    NEURON_METRIC_STORE: {
      async dailyRows() {
        return [];
      },
      async performanceRows() {
        return [];
      },
    },
  };
  const read = (route: string, selected: object = env) =>
    worker.fetch(
      new Request(`https://example.com/api/v1/subnets/7/${route}`),
      { ...dataApiEnv(), ...selected },
      ctx,
    );
  for (const route of [
    "miner-fairness",
    "emission-split/history",
    "owner-capture",
    "cost-to-participate",
    "treasury",
  ]) {
    expect((await read(route)).status, route).toBe(200);
    expect((await read(route, dataApiEnv())).status).toBe(503);
  }
  for (const [route, name] of [
    ["miner-fairness", "NEURON_DAILY_VIEW_STORE"],
    ["miner-fairness", "NEURON_VIEW_STORE"],
    ["emission-split/history", "NEURON_SNAPSHOT_STORE"],
    ["cost-to-participate", "NEURON_METRIC_STORE"],
  ]) {
    const missing: Record<string, unknown> = { ...env };
    delete missing[name];
    expect((await read(route, missing)).status).toBe(503);
  }
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(
      (await read("treasury", { ...env, SUBNET_ENRICHMENT_STORE: null }))
        .status,
    ).toBe(502);
    expect(
      (
        await read("owner-capture", {
          ...env,
          SUBNET_ENRICHMENT_STORE: {
            ...store,
            async ownerColdkey() {
              return "owner";
            },
          },
        })
      ).status,
    ).toBe(200);
  } finally {
    spy.mockRestore();
  }
});
