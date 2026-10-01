import {
  loadRootBaskets,
  validateRootBasketPage,
} from "../../src/root-baskets-read.ts";
import { routeQuery } from "../../src/route-query.ts";
import { isFinneySs58Address } from "../../src/finney-ss58.ts";
import { type ChainNetworkId, networkKvKey } from "../../src/chain-network.ts";
import { resolveClientIp } from "../config.ts";
import { errorResponse } from "../http.ts";
import { contractVersion, envelopeResponse } from "../responses.ts";

export async function handleRootBaskets(
  request: Request,
  env: Env,
  url: URL,
  network: ChainNetworkId,
  ss58?: string,
) {
  const params = routeQuery(url);
  try {
    validateRootBasketPage(params);
  } catch (cause) {
    return errorResponse("invalid_params", (cause as Error).message, 400);
  }
  if (ss58 !== undefined && !isFinneySs58Address(ss58))
    return errorResponse(
      "invalid_ss58",
      "ss58 must be a valid finney SS58 account.",
      400,
    );
  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: networkKvKey(`root-baskets:${resolveClientIp(request)}`, network),
    });
    if (!success)
      return errorResponse(
        "root_baskets_rate_limited",
        "Too many live basket requests; slow down.",
        429,
        {},
        { "retry-after": "60" },
      );
  }
  return envelopeResponse(
    request,
    {
      data: await loadRootBaskets(params, network, ss58),
      meta: { contract_version: contractVersion(env) },
    },
    "short",
  );
}
