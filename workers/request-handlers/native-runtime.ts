import { NativeRuntimeRequestSchema } from "../../schemas-src/routes/native-runtime.ts";
import { boundedInternalJson } from "../../src/internal-json.ts";
import { readNativeRuntime } from "../../src/native-runtime.ts";
import {
  networkKvKey,
  chainNetworkFromChainName,
  type ChainNetworkId,
} from "../../src/chain-network.ts";
import { resolveClientIp } from "../config.ts";
import { errorResponse } from "../http.ts";
import { dataResponse } from "../responses.ts";

export async function handleNativeRuntime(
  request: Request,
  env: Env,
  selectedNetwork?: ChainNetworkId,
) {
  if (request.method !== "POST")
    return errorResponse(
      "method_not_allowed",
      "POST a bounded native runtime request.",
      405,
      {},
      { allow: "POST, OPTIONS" },
    );
  if (new URL(request.url).search)
    return errorResponse(
      "invalid_query",
      "Native runtime parameters belong in the JSON request body.",
      400,
    );
  let input;
  try {
    input = NativeRuntimeRequestSchema.parse(
      await boundedInternalJson(request, 32_768),
    );
  } catch {
    return errorResponse(
      "invalid_params",
      "Invalid native runtime request.",
      400,
    );
  }
  const network = selectedNetwork ?? chainNetworkFromChainName(input.network);
  if (
    selectedNetwork !== undefined &&
    input.network !== undefined &&
    chainNetworkFromChainName(input.network) !== selectedNetwork
  )
    return errorResponse(
      "invalid_params",
      "Request network contradicts the URL's network.",
      400,
    );
  input = { ...input, network: network === "testnet" ? "test" : "finney" };
  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(`native-runtime:${resolveClientIp(request)}`, network),
    });
    if (!success)
      return errorResponse(
        "native_runtime_rate_limited",
        "Too many native runtime requests; slow down.",
        429,
        {},
        { "retry-after": "60" },
      );
  }
  try {
    return dataResponse(env, await readNativeRuntime(input));
  } catch {
    return errorResponse(
      "native_runtime_failed",
      "The finalized native runtime request could not be completed.",
      502,
    );
  }
}
