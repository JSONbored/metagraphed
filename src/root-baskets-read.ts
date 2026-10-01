import { z } from "zod";
import {
  RootBasketsQuerySchema,
  AccountRootBasketsQuerySchema,
  RootBasketsArtifactSchema,
} from "../schemas-src/routes/root-baskets.ts";
import { ROOT_BASKET_READ_LIMITS } from "../schemas-src/root-basket-runtime.ts";
import { DEFAULT_CHAIN_NETWORK, type ChainNetworkId } from "./chain-network.ts";
import { isFinneySs58Address } from "./account-balance.ts";
import { decodeSs58 } from "./ss58.ts";
import { bytesToHex } from "./twox-storage-key.ts";
import { rootBasketRpc } from "./root-basket-rpc.ts";
import {
  openRootBasketRuntime,
  UnsupportedBasketRuntimeError,
  type BasketRpc,
} from "./root-basket-runtime.ts";

export function validateRootBasketPage(
  params:
    | z.infer<typeof RootBasketsQuerySchema>
    | z.infer<typeof AccountRootBasketsQuerySchema>,
) {
  if (
    (("cursor" in params && params.cursor !== undefined) ||
      ("offset" in params && (params.offset ?? 0) > 0)) &&
    params.as_of === undefined
  )
    throw new Error(
      "Resuming a basket page requires as_of from the first response",
    );
  if (
    "hotkey" in params &&
    params.hotkey !== undefined &&
    (("cursor" in params && params.cursor !== undefined) ||
      params.limit !== undefined)
  )
    throw new Error("Fund detail does not accept cursor or limit");
}

export async function loadRootBaskets(
  params:
    | z.infer<typeof RootBasketsQuerySchema>
    | z.infer<typeof AccountRootBasketsQuerySchema>,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
  ss58?: string,
  rpc: BasketRpc = rootBasketRpc(network),
): Promise<z.infer<typeof RootBasketsArtifactSchema>> {
  const parsed =
    ss58 === undefined
      ? RootBasketsQuerySchema.parse(params)
      : AccountRootBasketsQuerySchema.parse(params);
  validateRootBasketPage(parsed);
  if (ss58 !== undefined && !isFinneySs58Address(ss58))
    throw new Error("Invalid finney SS58 account");
  try {
    const runtime = await openRootBasketRuntime(rpc, network, parsed.as_of);
    let data: z.infer<typeof RootBasketsArtifactSchema> & {
      status: "available";
    };
    if (ss58 !== undefined) {
      const query = AccountRootBasketsQuerySchema.parse(parsed);
      const limit = query.limit ?? ROOT_BASKET_READ_LIMITS.accountPage;
      const offset = query.offset ?? 0;
      const page = await runtime.accountPage(
        bytesToHex(decodeSs58(ss58)!.publicKey),
        offset,
        limit,
      );
      data = {
        schema_version: 1,
        network,
        status: "available",
        source: runtime.source,
        data: { kind: "account", ss58, ...page, offset, limit },
      };
    } else {
      const query = RootBasketsQuerySchema.parse(parsed);
      if (query.hotkey !== undefined) {
        const [pricing, summary, trading, baseline] = await Promise.all([
          runtime.pricing(query.hotkey),
          runtime.summary(query.hotkey),
          runtime.tradingStatus(query.hotkey),
          runtime.baseline(query.hotkey),
        ]);
        data = {
          schema_version: 1,
          network,
          status: "available",
          source: runtime.source,
          data: { kind: "fund", pricing, summary, trading, baseline },
        };
      } else {
        const limit = query.limit ?? ROOT_BASKET_READ_LIMITS.page;
        const page = await runtime.pricingPage(query.cursor ?? null, limit);
        data = {
          schema_version: 1,
          network,
          status: "available",
          source: runtime.source,
          data: {
            kind: "directory",
            pricing: page.pricing,
            next_after: page.next_after,
            limit,
          },
        };
      }
    }
    return RootBasketsArtifactSchema.parse(data);
  } catch (cause) {
    return {
      schema_version: 1,
      network,
      status:
        cause instanceof UnsupportedBasketRuntimeError
          ? "unsupported"
          : "unavailable",
      source: null,
      data: null,
    };
  }
}
