import { afterEach, expect, test, vi } from "vitest";
import {
  decodeNativeStakeHolding,
  nativeStakeHoldingQuery,
  nativeUnstakeMax,
} from "./native-stake-holding";
import type { NativeArtifact } from "./native-runtime";

const hot = `0x${"11".repeat(32)}`,
  cold = `0x${"22".repeat(32)}`;
function fixture(netuid = 0): NativeArtifact {
  return {
    schema_version: 1,
    source: {
      network: "finney",
      network_genesis_hash: `0x${"44".repeat(32)}`,
      finalized_block_hash: `0x${"33".repeat(32)}`,
      finalized_block: "500",
      runtime_spec_version: 470,
      runtime_transaction_version: 1,
      runtime_code_hash: `0x${"55".repeat(32)}`,
      metadata_sha256: `0x${"66".repeat(32)}`,
      metadata_version: 15,
    },
    types: [],
    results: [
      {
        kind: "runtime",
        api: "StakeInfoRuntimeApi",
        member: "get_stake_info_for_hotkey_coldkey_netuid",
        contract: null,
        value: {
          variant: "Some",
          fields: { hotkey: hot, coldkey: cold, netuid: String(netuid), stake: "9007199254740993" },
        },
      },
      {
        kind: "runtime",
        api: "StakeInfoRuntimeApi",
        member: "get_stake_availability_for_coldkeys",
        contract: null,
        value: [
          [
            cold,
            [
              [
                String(netuid),
                {
                  total: "18014398509481986",
                  locked: "13510798882111490",
                  available: "4503599627370496",
                },
              ],
            ],
          ],
        ],
      },
      {
        kind: "runtime",
        api: "SwapRuntimeApi",
        member: "current_alpha_price",
        contract: null,
        value: "1000000000",
      },
      {
        kind: "storage",
        pallet: "SubtensorModule",
        member: "MinerCollateral",
        contract: null,
        value: null,
      },
    ],
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("Root Max uses actual stake and account locks without a nominator snapshot", () => {
  const holding = decodeNativeStakeHolding(fixture(), hot, cold, 0);
  expect(holding.stakeAtomic).toBe(9007199254740993n);
  expect(holding.availableAtomic).toBe(4503599627370496n);
  expect(nativeUnstakeMax(holding, "alpha")).toBe("4503599.627370496");
  expect(nativeUnstakeMax(holding, "tao")).toBe("4503599.627370496");
  expect(nativeUnstakeMax(null, "alpha")).toBeNull();
  expect(nativeUnstakeMax({ ...holding, priceAtomic: 0n }, "tao")).toBeNull();
  expect(nativeUnstakeMax({ ...holding, priceAtomic: 3000000001n }, "tao")).toBe(
    "13510798.886615087",
  );
});
test("one hotkey never inherits another hotkey's free stake or an absent position", () => {
  const data = fixture(19);
  data.results[1]!.value = [
    [cold, [["19", { total: "18014398509481986", locked: "0", available: "18014398509481986" }]]],
  ];
  expect(decodeNativeStakeHolding(data, hot, cold, 19).availableAtomic).toBe(9007199254740993n);
  data.results[0]!.value = { variant: "None", fields: {} };
  expect(decodeNativeStakeHolding(data, hot, cold, 19).availableAtomic).toBe(0n);
  data.results[1]!.value = [[cold, []]];
  expect(decodeNativeStakeHolding(data, hot, cold, 19).availableAtomic).toBe(0n);
});
test("TAO Max remains representable when price times holdings exceeds the runtime amount width", () => {
  const holding = decodeNativeStakeHolding(fixture(19), hot, cold, 19);
  expect(
    nativeUnstakeMax(
      { ...holding, availableAtomic: (1n << 64n) - 1n, priceAtomic: 2000000000n },
      "tao",
    ),
  ).toBe("18446744073.709551615");
});
test("miner collateral limits the selected hotkey even when sibling stake is free", () => {
  const data = fixture(19);
  data.results[1]!.value = [
    [cold, [["19", { total: "18014398509481986", locked: "0", available: "10007199254740993" }]]],
  ];
  data.results[3]!.value = { locked: "8007199254740993" };
  expect(decodeNativeStakeHolding(data, hot, cold, 19).availableAtomic).toBe(1000000000000000n);
  data.results[3]!.value = { locked: "9007199254740994" };
  expect(decodeNativeStakeHolding(data, hot, cold, 19).availableAtomic).toBe(0n);
  data.results[1]!.value = [[cold, [["19", { total: "1", locked: "2", available: "0" }]]]];
  expect(decodeNativeStakeHolding(data, hot, cold, 19).availableAtomic).toBe(0n);
});
test("invalid identity, quantities and availability cannot become a Max transaction", () => {
  const mutations: ((data: NativeArtifact) => void)[] = [
    (data) => {
      data.results[0]!.api = "Other";
    },
    (data) => {
      data.results[0]!.value = null;
    },
    (data) => {
      data.results[0]!.value = { variant: "Invalid", fields: {} };
    },
    (data) => {
      data.results[0]!.value = {
        variant: "Some",
        fields: { hotkey: cold, coldkey: cold, netuid: "0", stake: "1" },
      };
    },
    (data) => {
      data.results[0]!.value = {
        variant: "Some",
        fields: { hotkey: hot, coldkey: cold, netuid: "19", stake: "1" },
      };
    },
    (data) => {
      data.results[2]!.value = "18446744073709551616";
    },
    (data) => {
      data.results[1]!.value = {};
    },
    (data) => {
      data.results[1]!.value = [[hot, []]];
    },
    (data) => {
      data.results[1]!.value = [[cold, [["19", {}]]]];
    },
    (data) => {
      data.results[1]!.value = [[cold, [["0", { total: "10", locked: "11", available: "1" }]]]];
    },
    (data) => {
      data.results[1]!.value = [[cold, [["0", { total: "10", locked: "2", available: "10" }]]]];
    },
    (data) => {
      data.results[1]!.value = [[cold, [["0", { total: 10, locked: "2", available: "8" }]]]];
    },
  ];
  for (const mutate of mutations) {
    const data = fixture();
    mutate(data);
    expect(() => decodeNativeStakeHolding(data, hot, cold, 0)).toThrow();
  }
});
test("the holding read bounds both account and subnet instead of scanning the chain", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify({ ok: true, data: fixture(19), meta: {} })),
  );
  vi.stubGlobal("fetch", fetch);
  const query = nativeStakeHoldingQuery(hot, cold, 19);
  const controller = new AbortController();
  const result = await query.queryFn!({ signal: controller.signal } as never);
  expect(result.availableAtomic).toBe(4503599627370496n);
  const init = fetch.mock.calls[0]![1]!;
  expect(init.signal).toBe(controller.signal);
  const request = JSON.parse(String(init.body));
  expect(request.operations[1]).toEqual({
    kind: "runtime",
    api: "StakeInfoRuntimeApi",
    member: "get_stake_availability_for_coldkeys",
    args: [[cold], { variant: "Some", fields: [19] }],
  });
  expect(request.operations).toHaveLength(4);
  expect(request.operations[3]).toEqual({
    kind: "storage",
    pallet: "SubtensorModule",
    member: "MinerCollateral",
    args: [19, hot, cold],
  });
  expect(nativeStakeHoldingQuery(hot, null, 19).enabled).toBe(false);
});
