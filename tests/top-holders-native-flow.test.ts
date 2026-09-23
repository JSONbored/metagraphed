import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  computeTopHoldersFlow,
  buildTopHoldersFlowRows,
} from "../src/top-holders-flow-tier.ts";
import { loadNativeTopHoldersFlow } from "../src/top-holders-native-flow.ts";
import { NATIVE_PROJECTION_STALE_MS } from "../src/native-projection-store.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import * as holdings from "../src/top-holders-holdings.ts";
import type { ChainNetworkId } from "../src/chain-network.ts";

const read = (name: string) =>
  JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          `./fixtures/native-projections/${name}.json.gz`,
          import.meta.url,
        ),
      ),
    ).toString(),
  );
const native = read("native");
const serving = read("serving");
const now = native.now as number;
function fixture(network: ChainNetworkId = "mainnet") {
  const current = `metagraph/native-projections/v1/${network}/current.json`;
  const manifest = JSON.parse(serving[current].raw);
  manifest.generatedAt = now;
  for (const source of manifest.sources) source.cutoff = now - 90 * 86_400_000;
  const descriptor = manifest.artifacts.find((item: { artifactKey: string }) =>
    item.artifactKey.endsWith("/chain-stake-flow.json"),
  );
  const body = structuredClone(
    native.artifacts[network].find((item: { key: string }) =>
      item.key.endsWith("/chain-stake-flow.json"),
    ).body,
  );
  const entries = new Map<string, { raw: string; etag: string }>();
  const put = (key: string, value: unknown) => {
    const raw = JSON.stringify(value);
    entries.set(key, { raw, etag: "fixture" });
    return { key, etag: "fixture", bytes: Buffer.byteLength(raw) };
  };
  const publish = () => {
    descriptor.object = put(descriptor.object.key, body);
    put(current, manifest);
  };
  publish();
  const get = vi.fn(async (key: string) => {
    const object = entries.get(key);
    return object
      ? {
          etag: object.etag,
          size: Buffer.byteLength(object.raw),
          json: async () => JSON.parse(object.raw),
        }
      : null;
  });
  return {
    body,
    manifest,
    publish,
    entries,
    get,
    env: {
      NATIVE_PROJECTIONS: "enabled",
      METAGRAPH_ARCHIVE: { get },
    } as unknown as Env,
  };
}
beforeEach(() => {
  resetModuleState();
  vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw Error("Native flows must never query SQL");
  });
});
afterEach(() => vi.restoreAllMocks());

test("both native populations reproduce canonical flow rankings without SQL", async () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const { env, body, get } = fixture(network);
    const actual = await computeTopHoldersFlow(env, network);
    assert.deepEqual(
      actual!.rows,
      buildTopHoldersFlowRows(body.top_holders_flow_rows, now),
    );
    assert.equal(actual!.generated_at, new Date(now).toISOString());
    assert.ok((actual!.rows as unknown[]).length > 0);
    assert.equal(get.mock.calls.length, 2);
    assert.ok(get.mock.calls.every(([key]) => key.includes(`/${network}/`)));
  }
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
});

test("mainnet holdings join all native flow candidates with independent timestamps", async () => {
  const { env, body, publish } = fixture();
  const rows = Array.from({ length: 1002 }, (_, i) => ({
    coldkey: `account-${i.toString().padStart(4, "0")}`,
    net_flow_7d: i,
    net_flow_30d: i,
    net_flow_90d: i,
  }));
  body.top_holders_flow_rows = rows;
  publish();
  const capturedAt = now + 30_000;
  const ledger = {
    capturedAt,
    sorts: ["total_tao"],
    cells: new Map([["account-0000", { total_tao: 9000 }]]),
  };
  const readHoldings = vi
    .spyOn(holdings, "topHoldersHoldings")
    .mockResolvedValue(ledger);
  const actual = await computeTopHoldersFlow(env);
  assert.deepEqual(
    actual!.rows,
    buildTopHoldersFlowRows(rows, now, 1000, ledger),
  );
  const retained = (actual!.rows as Record<string, unknown>[]).find(
    (row) => row.ss58 === "account-0000",
  )!;
  assert.equal(retained.net_flow_90d, 0);
  assert.equal(retained.captured_at, now);
  assert.equal(retained.holdings_captured_at, capturedAt);
  assert.equal(
    actual!.holdings_generated_at,
    new Date(now + 60_000).toISOString(),
  );
  assert.equal(readHoldings.mock.calls.length, 1);
  const testnet = await computeTopHoldersFlow(
    fixture("testnet").env,
    "testnet",
  );
  assert.equal(testnet!.holdings_generated_at, undefined);
  assert.equal(readHoldings.mock.calls.length, 1);
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
});

test("missing or malformed selected facts decline without SQL or fabricated zeros", async () => {
  for (const rows of [
    undefined,
    null,
    {},
    [null],
    [{ coldkey: "a", net_flow_7d: "bad", net_flow_30d: 1, net_flow_90d: 1 }],
  ]) {
    const { env, body, publish } = fixture();
    body.top_holders_flow_rows = rows;
    publish();
    assert.equal(await computeTopHoldersFlow(env), null);
  }
  const missing = fixture();
  missing.entries.clear();
  assert.equal(await computeTopHoldersFlow(missing.env), null);
  const empty = fixture();
  empty.body.top_holders_flow_rows = [];
  empty.publish();
  assert.deepEqual((await computeTopHoldersFlow(empty.env))!.rows, []);
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
});

test("flow freshness follows the native generation and never relabels old windows", async () => {
  const { env } = fixture();
  assert.ok(
    await loadNativeTopHoldersFlow(
      env,
      "mainnet",
      now + NATIVE_PROJECTION_STALE_MS,
    ),
  );
  assert.equal(
    await loadNativeTopHoldersFlow(
      env,
      "mainnet",
      now + NATIVE_PROJECTION_STALE_MS + 1,
    ),
    null,
  );
  assert.equal(await loadNativeTopHoldersFlow(env, "mainnet", now - 1), null);
  assert.equal(await loadNativeTopHoldersFlow({}, "mainnet", now), undefined);
});
