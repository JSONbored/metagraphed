import assert from "node:assert/strict";
import { bittensorNativeFixture } from "./native-bittensor.ts";
import { readNativeRuntime } from "../../src/native-runtime.ts";
import { nativeHex } from "../../src/native-runtime-values.ts";
import type { BasketRpc } from "../../src/root-basket-runtime.ts";

// Synthetic v470 contract values encoded/decoded by the pinned independent
// SCALE library. This fixture never opens a socket or calls global fetch.
const { wrapped, registry } = bittensorNativeFixture(true);
const block = `0x${"33".repeat(32)}`;
const genesis = `0x${"44".repeat(32)}`;
export const readRuntimeStakeFixture: typeof readNativeRuntime = (input) => {
  const rpc: BasketRpc = async (method, params) => {
    if (method === "chain_getFinalizedHead") return block;
    if (method === "chain_getHeader") return { number: "0x1f4" };
    if (method === "chain_getBlockHash")
      return input.network === "test" ? `0x${"55".repeat(32)}` : genesis;
    if (method === "state_getStorageHash") return null;
    if (method === "state_getRuntimeVersion")
      return {
        specName: "node-subtensor",
        specVersion: 470,
        transactionVersion: 1,
      };
    assert.equal(method, "state_call");
    assert.equal(params[2], block);
    if (params[0] === "Metadata_metadata_at_version") return wrapped;
    const encode = (type: string, value: unknown) =>
      nativeHex(registry.createType(type, value).toU8a());
    if (params[0] === "SwapRuntimeApi_current_alpha_price") {
      const netuid = Number(
        registry.createType("NetUid", params[1]).toString(),
      );
      return encode(
        "u64",
        netuid === 999 ? "0" : netuid === 0 ? "1000000000" : "2000000000",
      );
    }
    assert.ok(
      [
        "SwapRuntimeApi_sim_swap_tao_for_alpha",
        "SwapRuntimeApi_sim_swap_alpha_for_tao",
      ].includes(String(params[0])),
    );
    const tuple = JSON.parse(
      registry.createType("(NetUid,u64)", params[1]).toString(),
    ) as [number, string | number];
    const netuid = Number(tuple[0]),
      amount = BigInt(tuple[1]);
    const stake = params[0] === "SwapRuntimeApi_sim_swap_tao_for_alpha";
    const fee = netuid === 0 ? 0n : amount / 1000n;
    const impact =
      amount >= 20_000_000_000_000n
        ? 108n
        : amount >= 10_000_000_000_000n
          ? 103n
          : 1005n;
    const out =
      netuid === 0
        ? amount
        : (amount * (impact === 1005n ? 1000n : 100n) * (stake ? 1n : 2n)) /
          (impact * (stake ? 2n : 1n));
    const values =
      netuid === 999
        ? [0n, 0n, 0n, 0n]
        : [
            stake ? amount - fee : out,
            stake ? out : amount - fee,
            stake ? fee : 0n,
            stake ? 0n : fee,
          ];
    return encode("SimSwapResult", {
      tao_amount: values[0]!.toString(),
      alpha_amount: values[1]!.toString(),
      tao_fee: values[2]!.toString(),
      alpha_fee: values[3]!.toString(),
      tao_slippage: "0",
      alpha_slippage: "0",
    });
  };
  rpc.batch = (rows) =>
    Promise.all(rows.map((row) => rpc(row.method, row.params)));
  return readNativeRuntime(input, rpc);
};
