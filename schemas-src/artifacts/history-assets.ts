import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const HISTORY_ASSET_OBJECT_KEY =
  /^metagraph\/indexed-history\/v1\/(?:mainnet|testnet)\/extrinsics\/generations\/[a-f0-9]{64}\/feeds\/v1\/(?:[^/]+\/)*[a-f0-9]{64}\.(?:json|bin)$/;

const reference = z
  .object({ sha256: digest, bytes: size.max(512 * 1024) })
  .strict();

export const HistoryAssetReleaseSchema = z
  .object({
    version: z.literal(1),
    partitionCount: z
      .union([z.literal(16), z.literal(32), z.literal(64)])
      .optional(),
    prefixes: z
      .array(
        z
          .string()
          .max(256)
          .regex(
            /^metagraph\/indexed-history\/v1\/(?:mainnet|testnet)\/extrinsics\/generations\/[a-f0-9]{64}\/feeds\/v1\/$/,
          ),
      )
      .min(1)
      .max(64)
      .optional(),
    shards: z.record(z.string().regex(/^[a-f0-9]{2}$/), reference),
  })
  .strict();

export const HistoryAssetShardSchema = z
  .object({
    version: z.literal(1),
    objects: z.record(
      digest,
      z
        .object({
          key: z.string().max(1024).regex(HISTORY_ASSET_OBJECT_KEY),
          etag: z.string().regex(/^[a-f0-9]{32}(?:-\d+)?$/),
          bytes: size.max(16 * 1024 * 1024),
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

export type HistoryAssetShard = z.infer<typeof HistoryAssetShardSchema>;
