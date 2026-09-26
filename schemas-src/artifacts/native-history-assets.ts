import { z } from "zod";
import { CHAIN_FIREHOSE_TOPICS } from "../../src/chain-firehose-topics.ts";
import {
  HistoryAssetReleaseSchema,
  HistoryAssetShardSchema,
} from "./history-assets.ts";

const nativeRoot = `metagraph/indexed-history/v1/(?:mainnet|testnet)/(?:${CHAIN_FIREHOSE_TOPICS.join("|")})/`;
export const NATIVE_HISTORY_ASSET_OBJECT_KEY = new RegExp(
  `^${nativeRoot}(?:generations/[a-f0-9]{64}/(?:block-manifest\\.json|manifest\\.json|files/\\d{5}\\.json|hash/(?:[a-f0-9]{3}|packed)\\.bin|blocks/(?:index\\.json|[a-f0-9]{4}\\.bin))|[a-f0-9]{64}/\\d{5,10}-[a-f0-9]{64}\\.(?:parquet|page-index\\.json))$`,
);

/** Native releases use the canonical catalog vocabulary with explicit native
 * scopes and object limits. Feed declarations keep their existing bounds. */
export const NativeHistoryAssetReleaseSchema =
  HistoryAssetReleaseSchema.safeExtend({
    prefixes: z
      .array(
        z
          .string()
          .max(256)
          .regex(new RegExp(`^${nativeRoot}$`)),
      )
      .min(1)
      .max(8)
      .optional(),
  });

export const NativeHistoryAssetShardSchema = HistoryAssetShardSchema.extend({
  objects: z.record(
    HistoryAssetShardSchema.shape.objects.keyType,
    HistoryAssetShardSchema.shape.objects.valueType.extend({
      key: z.string().max(1024).regex(NATIVE_HISTORY_ASSET_OBJECT_KEY),
      bytes: z
        .number()
        .int()
        .min(1)
        .max(128 * 1024 * 1024),
    }),
  ),
});

export type NativeHistoryAssetShard = z.infer<
  typeof NativeHistoryAssetShardSchema
>;
