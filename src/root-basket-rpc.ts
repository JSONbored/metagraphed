import { ROOT_BASKET_READ_LIMITS } from "../schemas-src/root-basket-runtime.ts";
import { rpcUrlForNetwork, type ChainNetworkId } from "./chain-network.ts";
import { chainRpc, chainRpcBatch } from "./chain-rpc.ts";
import type { BasketRpc } from "./root-basket-runtime.ts";

const READ_METHODS = new Set([
  "chain_getFinalizedHead",
  "chain_getHeader",
  "chain_getBlockHash",
  "state_getRuntimeVersion",
  "state_getMetadata",
  "state_getStorage",
  "state_call",
]);

/** Reuse the shared correlated RPC transport and existing network endpoints.
 * Count streamed JSON bytes before parsing; hex is twice its decoded size. */
export function rootBasketRpc(
  network: ChainNetworkId,
  fetchImpl: typeof fetch = fetch,
): BasketRpc {
  const url = rpcUrlForNetwork(network);
  const options = {
    fetchImpl,
    timeoutMs: 5_000,
    maxResponseBytes: 2 * ROOT_BASKET_READ_LIMITS.bytes + 65_536,
  };
  const validate = (method: string) => {
    if (!READ_METHODS.has(method)) throw new Error("Basket RPC is read-only");
  };
  const rpc: BasketRpc = async (method, params) => {
    validate(method);
    return chainRpc(url, method, params, options);
  };
  rpc.batch = async (calls) => {
    if (calls.length > 2 * ROOT_BASKET_READ_LIMITS.accountPage)
      throw new Error("Basket RPC batch exceeds work budget");
    calls.forEach((call) => validate(call.method));
    const results = await chainRpcBatch(url, calls, options);
    return results.map((result) => {
      if (!result.ok) throw new Error("Basket RPC batch failed");
      return result.result;
    });
  };
  return rpc;
}
