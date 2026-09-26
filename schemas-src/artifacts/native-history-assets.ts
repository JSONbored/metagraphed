import { z } from "zod";
import { CHAIN_FIREHOSE_TOPICS } from "../../src/chain-firehose-topics.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const nativeRoot = `metagraph/indexed-history/v1/(?:mainnet|testnet)/(?:${CHAIN_FIREHOSE_TOPICS.join("|")})/`;
export const NATIVE_HISTORY_ASSET_OBJECT_KEY = new RegExp(
  `^${nativeRoot}(?:generations/[a-f0-9]{64}/(?:block-manifest\\.json|manifest\\.json|files/\\d{5}\\.json|hash/(?:[a-f0-9]{3}|packed)\\.bin|blocks/(?:index\\.json|[a-f0-9]{4}\\.bin))|[a-f0-9]{64}/\\d{5,10}-[a-f0-9]{64}\\.(?:parquet|page-index\\.json))$`,
);

const reference = z
  .object({ sha256: digest, bytes: size.max(512 * 1024) })
  .strict();

export const NativeHistoryAssetReleaseSchema = z
  .object({
    version: z.literal(1),
    partitionCount: z.literal(16).optional(),
    shardPrefixLength: z.literal(3).optional(),
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
    shards: z.record(z.string().regex(/^[a-f0-9]{2,3}$/), reference),
  })
  .strict()
  .refine(
    (root) =>
      Object.keys(root.shards).every(
        (prefix) => prefix.length === (root.shardPrefixLength ?? 2),
      ),
    "History asset shard prefixes differ from the declared length",
  );

export const NativeHistoryAssetShardSchema = z
  .object({
    version: z.literal(1),
    objects: z.record(
      digest,
      z
        .object({
          key: z.string().max(1024).regex(NATIVE_HISTORY_ASSET_OBJECT_KEY),
          etag: z.string().regex(/^[a-f0-9]{32}(?:-\d+)?$/),
          partition: z
            .string()
            .regex(/^[a-f0-9]$/)
            .optional(),
          bytes: size.max(128 * 1024 * 1024),
          chunks: z
            .array(
              z
                .object({ sha256: digest, bytes: size.max(4 * 1024 * 1024) })
                .strict(),
            )
            .min(1)
            .max(1024),
        })
        .strict(),
    ),
  })
  .strict();

export type NativeHistoryAssetShard = z.infer<
  typeof NativeHistoryAssetShardSchema
>;
