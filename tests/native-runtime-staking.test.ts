import assert from "node:assert/strict";
import { test } from "vitest";
import { bittensorNativeFixture } from "./fixtures/native-bittensor.ts";
import { queryNativeRuntime } from "../src/native-runtime.ts";
import { nativeHex } from "../src/native-runtime-values.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

// Source-derived v470 contracts encoded by the pinned independent reference
// library. These are synthetic fixtures, never observations of deployed state.
// runtime-api/src/lib.rs; pallets/swap/runtime-api/src/lib.rs;
// pallets/subtensor/src/rpc_info/stake_info.rs and subnets/collateral.rs.
for (const netuid of [0, 19]) test(`v470 staking quotes and available holdings are exact at one finalized subnet ${netuid} source`, async () => {
  const { wrapped, registry } = bittensorNativeFixture(true);
  const hot = `0x${"11".repeat(32)}`, cold = `0x${"22".repeat(32)}`;
  const block = `0x${"33".repeat(32)}`, genesis = `0x${"44".repeat(32)}`;
  const swap = { tao_amount: "9007199254740983", alpha_amount: "4503599627370496", tao_fee: "10", alpha_fee: "0", tao_slippage: "0", alpha_slippage: "1" };
  const reverse = { tao_amount: "17", alpha_amount: "10", tao_fee: "0", alpha_fee: "1", tao_slippage: "2", alpha_slippage: "0" };
  const stake = { hotkey: hot, coldkey: cold, netuid, stake: "9007199254740993", locked: "0", emission: "1", tao_emission: "0", drain: "0", is_registered: true };
  const available = { total: "18014398509481986", locked: "13510798882111490", available: "4503599627370496" };
  const collateral = { locked: "8007199254740993", drain_ratio: "18446744073709551616", min_locked: "100", earned: "18446744073709551615" };
  const calls: { method: string; params: unknown[] }[] = [];
  const encode = (type: string, value: unknown) => nativeHex(registry.createType(type, value).toU8a());
  const methods: Record<string, [string, unknown[], string, unknown]> = {
    SwapRuntimeApi_current_alpha_price: ["NetUid", [netuid], "u64", "2000000000"],
    SwapRuntimeApi_sim_swap_tao_for_alpha: ["(NetUid,TaoBalance)", [netuid, "9007199254740993"], "SimSwapResult", swap],
    SwapRuntimeApi_sim_swap_alpha_for_tao: ["(NetUid,AlphaBalance)", [netuid, "11"], "SimSwapResult", reverse],
    StakeInfoRuntimeApi_get_stake_info_for_hotkey_coldkey_netuid: ["(AccountId32,AccountId32,NetUid)", [hot, cold, netuid], "Option<StakeInfo>", stake],
    StakeInfoRuntimeApi_get_stake_availability_for_coldkeys: ["(Vec<AccountId32>,Option<Vec<NetUid>>)", [[cold], [netuid]], "BTreeMap<AccountId32,BTreeMap<NetUid,StakeAvailability>>", [[cold, [[netuid, available]]]]],
  };
  const rpc: BasketRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "chain_getFinalizedHead") return block;
    if (method === "chain_getHeader") return { number: "0x1f4" };
    if (method === "chain_getBlockHash") return params[0] === 0 ? genesis : block;
    if (method === "state_getStorageHash") return null;
    if (method === "state_getRuntimeVersion") return { specName: "node-subtensor", specVersion: 470, transactionVersion: 1 };
    if (method === "state_getStorage") { assert.equal(params[1], block); return encode("MinerCollateralState", collateral); }
    if (method === "state_call") {
      if (params[0] === "Metadata_metadata_at_version") return wrapped;
      const row = methods[String(params[0])]; assert.ok(row);
      assert.equal(params[1], encode(row[0], row[0] === "NetUid" ? netuid : row[1]));
      assert.equal(params[2], block);
      return encode(row[2], row[3]);
    }
    throw new Error(`Unexpected hermetic staking RPC ${method}`);
  };
  rpc.batch = rows => Promise.all(rows.map(row => rpc(row.method, row.params)));
  const result = await queryNativeRuntime({ operations: [
    { kind: "runtime", api: "SwapRuntimeApi", member: "current_alpha_price", args: [netuid] },
    { kind: "runtime", api: "SwapRuntimeApi", member: "sim_swap_tao_for_alpha", args: [netuid, "9007199254740993"] },
    { kind: "runtime", api: "SwapRuntimeApi", member: "sim_swap_alpha_for_tao", args: [netuid, "11"] },
    { kind: "runtime", api: "StakeInfoRuntimeApi", member: "get_stake_info_for_hotkey_coldkey_netuid", args: [hot, cold, netuid] },
    { kind: "runtime", api: "StakeInfoRuntimeApi", member: "get_stake_availability_for_coldkeys", args: [[cold], { variant: "Some", fields: [netuid] }] },
    { kind: "storage", pallet: "SubtensorModule", member: "MinerCollateral", args: [netuid, hot, cold] },
  ] }, rpc);
  assert.equal(result.source.finalized_block_hash, block);
  assert.equal(result.results[0]!.value, "2000000000");
  assert.deepEqual(result.results[1]!.value, swap);
  assert.deepEqual(result.results[2]!.value, reverse);
  assert.deepEqual(result.results[3]!.value, { variant: "Some", fields: { ...stake, netuid: String(netuid) } });
  assert.deepEqual(result.results[4]!.value, [[cold, [[String(netuid), available]]]]);
  assert.deepEqual(result.results[5]!.value, collateral);
  assert.equal(calls.filter(row => row.method === "state_call" && row.params[0] !== "Metadata_metadata_at_version").length, 5);
});
