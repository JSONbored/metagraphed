import { createHash } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import { z } from "zod";
import {
  RootBasketSourceSchema,
  ROOT_BASKET_READ_LIMITS,
  BasketRuntimeHeaderSchema as header,
  BasketRuntimeVersionSchema as version,
} from "../schemas-src/root-basket-runtime.ts";
import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import { bytesToHex, storageMapPrefix } from "./twox-storage-key.ts";
import {
  decodeBasketClaimPreview,
  decodeBasketClaimPreviews,
  decodeBasketIndex,
  decodeBasketPortfolio,
  decodeBasketPosition,
  decodeBasketPricing,
  decodeBasketPricingPage,
  decodeBasketSummary,
  decodeBasketTradingStatus,
  decodeBasketStakingHotkeys,
  decodeBasketBaseline,
  decodeBasketIndexSnapshot,
} from "./root-basket-runtime-codec.ts";

export type BasketRpc = {
  (method: string, params: unknown[]): Promise<unknown>;
  batch?(calls: { method: string; params: unknown[] }[]): Promise<unknown[]>;
};
export function basketReadBatch(
  rpc: BasketRpc,
  calls: { method: string; params: unknown[] }[],
) {
  return rpc.batch === undefined
    ? Promise.all(calls.map((call) => rpc(call.method, call.params)))
    : rpc.batch(calls);
}
export class UnsupportedBasketRuntimeError extends Error {}
const hash = RootBasketCaptureSchema.shape.finalized_block_hash;
const account = RootBasketCaptureSchema.shape.funds.element.shape.hotkey;
const API_NAME = "BetaBasketRuntimeApi";
export const BASKET_RUNTIME_API_ID = bytesToHex(
  blake2b(new TextEncoder().encode(API_NAME), { dkLen: 8 }),
);

/** Resolve one FINALIZED source before any basket read. Unknown layouts never
 * reach state_call. A resume hash must still be a canonical finalized ancestor;
 * a caller-supplied fork hash cannot masquerade as a finalized observation.
 */
export async function openRootBasketRuntime(
  rpc: BasketRpc,
  network: z.infer<typeof RootBasketSourceSchema>["network"],
  asOf?: string,
) {
  const finalizedHash = hash.parse(await rpc("chain_getFinalizedHead", []));
  const blockHash = asOf === undefined ? finalizedHash : hash.parse(asOf);
  const [rawHeader, rawVersion, rawGenesis] = await basketReadBatch(rpc, [
    { method: "chain_getHeader", params: [blockHash] },
    { method: "state_getRuntimeVersion", params: [blockHash] },
    { method: "chain_getBlockHash", params: [0] },
  ]);
  const block = header.parse(rawHeader);
  const height = BigInt(block.number);
  if (blockHash !== finalizedHash) {
    const [finalizedHeader, canonicalHash] = await basketReadBatch(rpc, [
      { method: "chain_getHeader", params: [finalizedHash] },
      { method: "chain_getBlockHash", params: [block.number] },
    ]);
    if (
      height > BigInt(header.parse(finalizedHeader).number) ||
      canonicalHash !== blockHash
    )
      throw new Error("Basket resume source is not canonical finalized state");
  }
  const runtime = version.parse(rawVersion);
  const matching = runtime.apis.filter(
    ([id]) => id.toLowerCase() === BASKET_RUNTIME_API_ID,
  );
  if (
    runtime.specName !== "node-subtensor" ||
    runtime.specVersion !== 469 ||
    matching.length !== 1 ||
    matching[0]![1] !== 5
  )
    throw new UnsupportedBasketRuntimeError(
      "Unsupported basket runtime layout",
    );
  const metadata = await rpc("state_getMetadata", [blockHash]);
  if (
    typeof metadata !== "string" ||
    metadata.length > 2 + 2 * ROOT_BASKET_READ_LIMITS.bytes ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(metadata)
  )
    throw new Error("Invalid basket runtime metadata");
  const source = RootBasketSourceSchema.parse({
    network,
    network_genesis_hash: rawGenesis,
    finalized_block_hash: blockHash,
    finalized_block: height.toString(),
    runtime_spec_version: runtime.specVersion,
    runtime_api_version: matching[0]![1],
    decoder_version: "subtensor-v469-370bac46-v1",
    metadata_sha256: `0x${createHash("sha256")
      .update(Buffer.from(metadata.slice(2), "hex"))
      .digest("hex")}`,
  });
  const call = (method: string, encoded = "0x") =>
    rpc("state_call", [`${API_NAME}_${method}`, encoded, blockHash]);
  const oneAccount = (value: string) => account.parse(value);
  const pair = (hotkey: string, coldkey: string) =>
    oneAccount(hotkey) + oneAccount(coldkey).slice(2);
  const storage = (item: string, owner?: string) => {
    let key = bytesToHex(storageMapPrefix("SubtensorModule", item));
    if (owner !== undefined) {
      const bytes = Buffer.from(oneAccount(owner).slice(2), "hex");
      key +=
        bytesToHex(blake2b(bytes, { dkLen: 16 })).slice(2) +
        oneAccount(owner).slice(2);
    }
    return rpc("state_getStorage", [key, blockHash]);
  };
  const stakingHotkeys = async (coldkey: string) =>
    decodeBasketStakingHotkeys(await storage("StakingHotkeys", coldkey));
  const belongsTo = <T extends { hotkey: string }>(
    value: T | null,
    hotkey: string,
  ): T | null => {
    if (value !== null && value.hotkey !== hotkey)
      throw new Error("Basket response belongs to another fund");
    return value;
  };
  const relationshipRows = <T extends { hotkey: string }>(
    rows: T[],
    hotkeys: string[],
  ) => {
    const owners = new Set(hotkeys);
    const seen = new Set<string>();
    for (const row of rows) {
      if (!owners.has(row.hotkey) || seen.has(row.hotkey))
        throw new Error("Invalid basket relationship response");
      seen.add(row.hotkey);
    }
    return rows;
  };
  return {
    source,
    async pricingPage(
      startAfter: string | null,
      limit: number = ROOT_BASKET_READ_LIMITS.page,
    ) {
      z.number().int().min(1).max(ROOT_BASKET_READ_LIMITS.page).parse(limit);
      const cursor =
        startAfter === null ? "00" : `01${oneAccount(startAfter).slice(2)}`;
      const size = Uint8Array.of(limit & 255, (limit >>> 8) & 255, 0, 0);
      const raw = await call(
        "get_all_beta_pricing",
        `0x${cursor}${bytesToHex(size).slice(2)}`,
      );
      const page = decodeBasketPricingPage(raw);
      if (
        page.pricing.length > limit ||
        (page.next_after !== null && page.next_after === startAfter)
      )
        throw new Error("Invalid basket pricing page progress");
      if (
        new Set(page.pricing.map((row) => row.hotkey)).size !==
        page.pricing.length
      )
        throw new Error("Duplicate basket pricing fund");
      return {
        ...page,
        response_sha256: `0x${createHash("sha256")
          .update(Buffer.from((raw as string).slice(2), "hex"))
          .digest("hex")}`,
      };
    },
    async pricing(hotkey: string) {
      return belongsTo(
        decodeBasketPricing(await call("get_beta_pricing", oneAccount(hotkey))),
        hotkey,
      );
    },
    async summary(hotkey: string) {
      const summary = decodeBasketSummary(
        await call("get_validator_basket_summary", oneAccount(hotkey)),
      );
      if (summary.hotkey !== hotkey)
        throw new Error("Basket summary belongs to another fund");
      return summary;
    },
    async tradingStatus(hotkey: string) {
      return decodeBasketTradingStatus(
        await call("get_basket_trading_status", oneAccount(hotkey)),
      );
    },
    async position(hotkey: string, coldkey: string) {
      return belongsTo(
        decodeBasketPosition(
          await call("get_beta_position", pair(hotkey, coldkey)),
        ),
        hotkey,
      );
    },
    async portfolio(coldkey: string) {
      // The official method silently visits at most 256 relationships. Verify
      // that ceiling against pinned storage before describing it as complete.
      const hotkeys = await stakingHotkeys(coldkey);
      if (hotkeys.length > ROOT_BASKET_READ_LIMITS.positions)
        throw new Error("Basket portfolio requires relationship pagination");
      return relationshipRows(
        decodeBasketPortfolio(
          await call("get_beta_portfolio", oneAccount(coldkey)),
        ),
        hotkeys,
      );
    },
    async claimPreview(hotkey: string, coldkey: string) {
      return belongsTo(
        decodeBasketClaimPreview(
          await call("get_basket_claim_preview", pair(hotkey, coldkey)),
        ),
        hotkey,
      );
    },
    async claimPreviews(coldkey: string) {
      const hotkeys = await stakingHotkeys(coldkey);
      if (hotkeys.length > ROOT_BASKET_READ_LIMITS.accountPage)
        throw new Error(
          "Basket claim previews require relationship pagination",
        );
      return relationshipRows(
        decodeBasketClaimPreviews(
          await call("get_root_basket_claim_previews", oneAccount(coldkey)),
        ),
        hotkeys,
      );
    },
    async accountPage(
      coldkey: string,
      offset = 0,
      limit: number = ROOT_BASKET_READ_LIMITS.accountPage,
    ) {
      z.number()
        .int()
        .min(0)
        .max(ROOT_BASKET_READ_LIMITS.relationships)
        .parse(offset);
      z.number()
        .int()
        .min(1)
        .max(ROOT_BASKET_READ_LIMITS.accountPage)
        .parse(limit);
      const hotkeys = await stakingHotkeys(coldkey);
      if (offset > hotkeys.length)
        throw new Error("Invalid basket account page offset");
      const selected = hotkeys.slice(offset, offset + limit);
      // One bounded batch, correlated by id at the RPC boundary. No unbounded
      // coldkey-wide preview and no HTTP round trip per position/claim pair.
      const values =
        selected.length === 0
          ? []
          : await basketReadBatch(
              rpc,
              selected.flatMap((hotkey) => [
                {
                  method: "state_call",
                  params: [
                    `${API_NAME}_get_beta_position`,
                    pair(hotkey, coldkey),
                    blockHash,
                  ],
                },
                {
                  method: "state_call",
                  params: [
                    `${API_NAME}_get_basket_claim_preview`,
                    pair(hotkey, coldkey),
                    blockHash,
                  ],
                },
              ]),
            );
      const entries = selected.map((hotkey, i) => ({
        hotkey,
        position: belongsTo(decodeBasketPosition(values[i * 2]), hotkey),
        claim: belongsTo(decodeBasketClaimPreview(values[i * 2 + 1]), hotkey),
      }));
      const next = offset + selected.length;
      return {
        entries,
        total_relationships: hotkeys.length,
        next_offset: next === hotkeys.length ? null : next,
      };
    },
    async index() {
      return decodeBasketIndex(await call("get_beta_index"));
    },
    stakingHotkeys,
    async baseline(hotkey: string) {
      return decodeBasketBaseline(await storage("BetaBaseline", hotkey));
    },
    async indexSnapshot() {
      return decodeBasketIndexSnapshot(await storage("BetaIndexSnapshot"));
    },
  };
}
