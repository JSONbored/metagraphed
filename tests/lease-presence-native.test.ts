import assert from "node:assert/strict";
import { test, vi } from "vitest";
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);
import { loadNativeLeasePresence } from "../src/lease-presence-native.ts";
import { loadSubnetLeaseHistoryColdTier } from "../src/chain-events-cold-tier.ts";
import type { ChainNetworkId } from "../src/chain-network.ts";

const now = 1790208000000;
function fixture(network: ChainNetworkId = "mainnet") {
  const manifest = {
    version: 1,
    state: "complete",
    network,
    table: "chain_events",
    generation: "a".repeat(64),
    generatedAt: now,
    sourceFiles: 2,
    sourceRows: 895485314,
    source: {
      table_uuid: "uuid",
      snapshot: "9007199254740993",
      sequence: 1,
      coverage: null,
      identity: "b".repeat(64),
    },
    counts: { SubnetLeaseCreated: 0, SubnetLeaseTerminated: 0 },
  };
  let mode = "ok";
  const reads: string[] = [];
  const root = `metagraph/lease-presence-native/v1/${network}`;
  const env = {
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        reads.push(key);
        if (mode === "throw") throw Error("unavailable");
        if (mode === "missing") return null;
        const proof = !key.endsWith("current.json");
        assert.equal(
          key,
          proof
            ? `${root}/${manifest.generation}/manifest.json`
            : `${root}/current.json`,
        );
        if (proof && mode === "no-proof") return null;
        return {
          size:
            mode === "no-size"
              ? undefined
              : mode === "zero"
                ? 0
                : mode === "oversize"
                  ? 65537
                  : proof && mode === "size-mismatch"
                    ? 1
                    : 1000,
          async json() {
            if (mode === "malformed") throw Error("bad json");
            return proof && mode === "mismatch"
              ? { ...manifest, sourceRows: manifest.sourceRows + 1 }
              : structuredClone(manifest);
          },
        };
      },
    },
  };
  return { env, manifest, reads, mode: (value: string) => (mode = value) };
}

test("full-snapshot absence and presence use two bounded objects on both networks", async () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const f = fixture(network);
    assert.equal(await loadNativeLeasePresence(f.env, network, now), false);
    assert.equal(f.reads.length, 2);
    f.manifest.counts.SubnetLeaseCreated = 1;
    assert.equal(await loadNativeLeasePresence(f.env, network, now), true);
    f.manifest.counts.SubnetLeaseCreated = 0;
    f.manifest.counts.SubnetLeaseTerminated = 1;
    assert.equal(await loadNativeLeasePresence(f.env, network, now), true);
    f.manifest.counts.SubnetLeaseTerminated = 0;
    f.manifest.sourceFiles = 0;
    f.manifest.sourceRows = 0;
    assert.equal(await loadNativeLeasePresence(f.env, network, now), false);
  }
});

test("missing selection alone permits the transitional fallback", async () => {
  for (const env of [undefined, null, {}])
    assert.equal(await loadNativeLeasePresence(env, "mainnet", now), undefined);
  const f = fixture();
  f.mode("missing");
  assert.equal(await loadNativeLeasePresence(f.env, "mainnet", now), undefined);
});

test("selected malformed, oversized or unproven history always declines", async () => {
  for (const mode of [
    "throw",
    "no-size",
    "zero",
    "oversize",
    "malformed",
    "no-proof",
    "size-mismatch",
    "mismatch",
  ]) {
    const f = fixture();
    f.mode(mode);
    assert.equal(
      await loadNativeLeasePresence(f.env, "mainnet", now),
      null,
      mode,
    );
  }
});

test("scope, freshness and complete physical censuses are required", async () => {
  const mutations = [
    { network: "testnet" },
    { state: "partial" },
    { generatedAt: now + 1 },
    { generatedAt: now - 7200001 },
    { counts: { SubnetLeaseCreated: 895485315, SubnetLeaseTerminated: 0 } },
    { counts: { SubnetLeaseCreated: -1, SubnetLeaseTerminated: 0 } },
    { sourceRows: 1 },
    { sourceFiles: 0 },
  ];
  for (const mutation of mutations) {
    const f = fixture();
    Object.assign(f.manifest, mutation);
    assert.equal(await loadNativeLeasePresence(f.env, "mainnet", now), null);
  }
  const f = fixture();
  assert.equal(
    await loadNativeLeasePresence(f.env, "mainnet", now + 7200000),
    false,
  );
});

test("cold-tier lease contract is preserved without a SQL request", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("SQL forbidden"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    for (const network of ["mainnet", "testnet"] as const) {
      const f = fixture(network);
      const env = f.env as unknown as Env;
      assert.deepEqual(await loadSubnetLeaseHistoryColdTier(env, 1, network), {
        rows: [],
      });
      if (network === "mainnet")
        assert.deepEqual(await loadSubnetLeaseHistoryColdTier(env, 2), {
          rows: [],
        });
      f.manifest.counts.SubnetLeaseCreated = 1;
      assert.equal(await loadSubnetLeaseHistoryColdTier(env, 1, network), null);
      f.mode("mismatch");
      assert.equal(await loadSubnetLeaseHistoryColdTier(env, 1, network), null);
    }
    assert.equal(fetch.mock.calls.length, 0);
  } finally {
    fetch.mockRestore();
    clock.mockRestore();
  }
});
