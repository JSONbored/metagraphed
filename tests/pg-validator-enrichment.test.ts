import { expect, test, vi } from "vitest";
import { createPgValidatorEnrichmentStore } from "../src/pg-validator-enrichment.ts";
import { selectedValidatorEnrichmentStore } from "../src/validator-enrichment-store.ts";
import type { ReadStoreDb } from "../src/read-store.ts";
import {
  readNewestNeuronCapture,
  readNeuronDirectoryRows,
} from "../src/neuron-snapshot-read.ts";
import worker, { loadValidatorDetailsFromStore } from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

function fixture() {
  let capture: unknown = "1793491200000";
  const calls: string[] = [];
  const read: ReadStoreDb = {
    async query<Row>(sql: string) {
      calls.push(sql);
      return (
        sql.includes("neurons_passes") && capture !== undefined
          ? [{ captured_at: capture }]
          : []
      ) as Row[];
    },
    async first() {
      throw new Error("unused");
    },
  };
  return {
    store: createPgValidatorEnrichmentStore({ read }),
    calls,
    setCapture(value: unknown) {
      capture = value;
    },
  };
}

test("typed enrichment reads only its four relational sources", async () => {
  const f = fixture();
  expect(await f.store.prices()).toEqual([]);
  expect(await f.store.tempos()).toEqual([]);
  expect(await f.store.identities()).toEqual([]);
  expect(await f.store.latestCompletedCapture()).toBe(1793491200000);
  for (const value of [undefined, null, 0, -1, "invalid", 1.5, 1e30]) {
    f.setCapture(value);
    expect(await f.store.latestCompletedCapture()).toBeNull();
  }
  expect(f.calls[0]).toContain("MAX(snapshot_date)");
  expect(f.calls[1]).toContain("app.subnet_hyperparams");
  expect(f.calls[2]).toContain("app.account_identity");
  expect(
    selectedValidatorEnrichmentStore({ VALIDATOR_ENRICHMENT_STORE: f.store }),
  ).toBe(f.store);
  for (const value of [null, {}, 4])
    expect(selectedValidatorEnrichmentStore(value)).toBeNull();
  for (const value of [null, {}, { prices() {} }])
    expect(() =>
      selectedValidatorEnrichmentStore({ VALIDATOR_ENRICHMENT_STORE: value }),
    ).toThrow("Invalid");
});

test("native enriched routes retain selection, cold, batching and opaque failure behavior", async () => {
  const context = { waitUntil() {} };
  const calls: unknown[] = [];
  const view = {
    async rows(query: unknown) {
      calls.push(query);
      return [];
    },
  };
  const live = {
    async directoryRows() {
      return [];
    },
    async newestCapture() {
      return 0;
    },
    async economicsRows() {
      return [];
    },
  };
  const summary = {
    async nominatorCounts() {
      return [];
    },
    async completeRows() {
      return [];
    },
    async dailyValidators() {
      return [];
    },
    async dailyTotals() {
      return [];
    },
    async subnetHistory() {
      return [];
    },
  };
  const enrichment = fixture().store;
  const env = {
    ...dataApiEnv(),
    NEURON_VIEW_STORE: view,
    NEURON_LIVE_STORE: live,
    NEURON_SUMMARY_STORE: summary,
    VALIDATOR_ENRICHMENT_STORE: enrichment,
  };
  const get = (path: string, selected: object = env) =>
    worker.fetch(
      new Request(`https://example.com/api/v1/${path}`),
      { ...dataApiEnv(), ...selected },
      context,
    );
  for (const path of [
    "validators/missing",
    "validators",
    "validators?sort=total_stake&limit=1",
    "validators/operators",
    "accounts",
    "accounts?limit=2",
    "accounts/directory",
    "accounts/missing/portfolio",
    "internal/neurons-snapshot-stamp",
  ])
    expect((await get(path)).status, path).toBe(200);
  expect((await get("internal/validator-details")).status).toBe(400);
  expect(
    (
      await get(
        "internal/validator-details?hotkeys=5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      )
    ).status,
  ).toBe(200);
  for (const name of [
    "NEURON_VIEW_STORE",
    "NEURON_LIVE_STORE",
    "NEURON_SUMMARY_STORE",
    "VALIDATOR_ENRICHMENT_STORE",
  ]) {
    const missing: Record<string, unknown> = { ...env };
    delete missing[name];
    expect((await get("validators/missing", missing)).status).toBe(503);
  }
  await expect(readNewestNeuronCapture(undefined, {})).rejects.toThrow(
    "capability",
  );
  await expect(readNeuronDirectoryRows(undefined, {})).rejects.toThrow(
    "capability",
  );
  await expect(
    loadValidatorDetailsFromStore(undefined, dataApiEnv(), ["a"]),
  ).rejects.toThrow("capability");
  expect(
    (
      await get("validators/missing", {
        ...env,
        VALIDATOR_ENRICHMENT_STORE: undefined,
      })
    ).status,
  ).toBe(502);
  expect(
    (await get("validators/missing", { ...env, NEURON_VIEW_STORE: undefined }))
      .status,
  ).toBe(502);
  await expect(
    loadValidatorDetailsFromStore(undefined, env, []),
  ).rejects.toThrow("bound");
  await expect(
    loadValidatorDetailsFromStore(undefined, env, Array(17).fill("a")),
  ).rejects.toThrow("bound");
  await loadValidatorDetailsFromStore(undefined, env, ["a", "b", "a"]);
  expect(calls.at(-1)).toMatchObject({
    hotkeys: ["a", "b"],
    validatorsOnly: true,
  });
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const failure = await get("validators/missing", {
      ...env,
      NEURON_VIEW_STORE: {
        async rows() {
          throw new Error("private failure");
        },
      },
    });
    expect(failure.status).toBe(502);
    expect(await failure.json()).toEqual({ error: "data query failed" });
    expect((await get("validators/%E0%A4%A")).status).toBe(502);
    expect((await get("unmatched")).status).toBe(503);
  } finally {
    spy.mockRestore();
  }
});

test("native directory refresh serves the same materialized cards and completed stamp", async () => {
  const stamp = 1793491200000;
  const values = new Map<string, string>();
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil(value: Promise<unknown>) {
      pending.push(value);
    },
  };
  const kv = {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      return value === null || type !== "json" ? value : JSON.parse(value);
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  };
  const row = {
    hotkey: "a",
    coldkey: "cold",
    netuid: 7,
    uid: 1,
    validator_permit: 1,
    stake_tao: 2,
    emission_tao: 1,
    captured_at: stamp,
    block_number: 99,
  };
  let capture: number | null = stamp;
  const enrichment = {
    ...fixture().store,
    async latestCompletedCapture() {
      return capture;
    },
  };
  const env = {
    ...dataApiEnv({ METAGRAPH_CONTROL: kv }),
    NEURON_VIEW_STORE: {
      async rows() {
        return [row];
      },
    },
    NEURON_LIVE_STORE: {
      async directoryRows() {
        return [row];
      },
      async newestCapture() {
        return stamp;
      },
      async economicsRows() {
        return [];
      },
    },
    NEURON_SUMMARY_STORE: {
      async nominatorCounts() {
        return [];
      },
      async completeRows() {
        return [];
      },
      async dailyValidators() {
        return [];
      },
      async dailyTotals() {
        return [];
      },
      async subnetHistory() {
        return [];
      },
    },
    VALIDATOR_ENRICHMENT_STORE: enrichment,
  };
  const { refreshExplorerDirectoryMaterialization } =
    await import("../workers/data-api.ts");
  expect(
    await refreshExplorerDirectoryMaterialization(env, context, stamp),
  ).toBe(true);
  for (const path of [
    "validators/operators",
    "accounts/directory",
    "internal/neurons-snapshot-stamp",
  ]) {
    const response = await worker.fetch(
      new Request(`https://example.com/api/v1/${path}`),
      env,
      context,
    );
    expect(response.status).toBe(200);
    await Promise.all(pending);
  }
  capture = null;
  expect(
    await (
      await worker.fetch(
        new Request(
          "https://example.com/api/v1/internal/neurons-snapshot-stamp",
        ),
        env,
        context,
      )
    ).json(),
  ).toEqual({ captured_at: null });
  expect(
    (
      await worker.fetch(
        new Request("https://example.com/api/v1/accounts/directory"),
        env,
        context,
      )
    ).status,
  ).toBe(200);
  await Promise.all(pending);
});
