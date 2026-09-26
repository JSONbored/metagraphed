import {
  HISTORY_ASSET_OBJECT_KEY,
  HistoryAssetReleaseSchema,
  HistoryAssetShardSchema,
  type HistoryAssetShard,
} from "../schemas-src/artifacts/history-assets.ts";
import type { ParquetRangeSource } from "./indexed-parquet.ts";
import { createHistoryAssetMetadataReader } from "./history-asset-metadata.ts";

const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 256;
const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A pinned release relocates immutable feed bytes, preserving their original
 * ETag and exact ranges. An unmapped object retains its ordinary R2 reader. */
export function historyAssetSource(
  env: unknown,
  fallback: ParquetRangeSource,
  bindingPrefix: "HISTORY" | "ACCOUNT_HISTORY" = "HISTORY",
): ParquetRangeSource {
  const bindings = (env ?? {}) as Record<string, unknown>;
  const assets = bindings[`${bindingPrefix}_ASSETS`] as
    Pick<Fetcher, "fetch"> | undefined;
  const release = bindings[`${bindingPrefix}_ASSET_RELEASE`];
  if (assets === undefined && release === undefined) return fallback;
  const releaseReference =
    typeof release === "string"
      ? /^([a-f0-9]{64}):([1-9]\d{0,5})$/.exec(release)
      : null;
  if (
    !assets ||
    typeof assets.fetch !== "function" ||
    !releaseReference ||
    Number(releaseReference[2]) > 512 * 1024
  )
    throw new Error("Incomplete immutable history asset configuration");

  // These limits count transferred bytes, including metadata and over-read
  // inside chunks, separately from the native reader's logical range budget.
  let bytes = 0,
    requests = 0,
    retained = 0;
  let maxBytes = 128 * 1024 * 1024,
    maxRequests = 1024;
  let partitions: Pick<Fetcher, "fetch">[] | undefined;
  const cache = new Map<string, Uint8Array>();
  let releasePromise:
    Promise<ReturnType<typeof HistoryAssetReleaseSchema.parse>> | undefined;
  const shards = new Map<string, Promise<HistoryAssetShard>>();
  const metadataReaders = new Map<
    object,
    ReturnType<typeof createHistoryAssetMetadataReader>
  >();

  async function readAsset(
    hash: string,
    size: number,
    payload = false,
    metadata = !payload,
  ): Promise<Uint8Array> {
    const prior = cache.get(hash);
    if (prior) {
      if (prior.length !== size)
        throw new Error("Immutable history asset size conflict");
      cache.delete(hash);
      cache.set(hash, prior);
      return prior;
    }
    const store =
      payload && partitions ? partitions[parseInt(hash[0], 16)] : assets!;
    if (metadata) {
      let read = metadataReaders.get(store);
      if (!read) {
        read = createHistoryAssetMetadataReader(store);
        metadataReaders.set(store, read);
      }
      return read(hash, size, () => readAsset(hash, size, payload, false));
    }
    if (++requests > maxRequests || bytes + size > maxBytes)
      throw new Error("Immutable history asset transfer budget exceeded");
    bytes += size;
    const response = await store.fetch(
      new Request(`https://history-assets.invalid/${hash}.mgpack`, {
        headers: { "accept-encoding": "identity" },
      }),
    );
    const length = response.headers.get("content-length");
    if (
      response.status !== 200 ||
      !response.body ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) !== size))
    ) {
      await response.body?.cancel();
      throw new Error("Immutable history asset missing or changed");
    }
    const output = new Uint8Array(size),
      reader = response.body.getReader();
    let offset = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (offset + next.value.length > size)
          throw new Error("Immutable history asset exceeds its size bound");
        output.set(next.value, offset);
        offset += next.value.length;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const raw = output;
    if (offset !== size || (await sha256(raw)) !== hash)
      throw new Error("Immutable history asset content identity changed");
    while (
      retained + raw.length > MAX_CACHE_BYTES ||
      cache.size >= MAX_CACHE_ENTRIES
    ) {
      const [key, value] = cache.entries().next().value!;
      cache.delete(key);
      retained -= value.length;
    }
    cache.set(hash, raw);
    retained += raw.length;
    return raw;
  }

  async function locate(key: string) {
    releasePromise ??= readAsset(
      releaseReference![1],
      Number(releaseReference![2]),
    ).then((raw) => {
      const root = HistoryAssetReleaseSchema.parse(
        JSON.parse(text.decode(raw)),
      );
      if (root.partitionCount) {
        partitions = Array.from({ length: root.partitionCount }, (_, i) => {
          const binding = (env as Record<string, Pick<Fetcher, "fetch">>)[
            `${bindingPrefix}_ASSETS_${i.toString(16)}`
          ];
          if (!binding || typeof binding.fetch !== "function")
            throw new Error("Incomplete immutable history asset partitions");
          return binding;
        });
        // Smaller payload chunks preserve bounded over-read without exceeding
        // the per-deployment file limit. These are transfer, not heap limits;
        // native logical query budgets and the 8 MiB cache remain unchanged.
        maxBytes = 512 * 1024 * 1024;
        maxRequests = 4096;
      }
      return root;
    });
    const root = await releasePromise;
    if (
      root.prefixes &&
      !root.prefixes.some((prefix) => key.startsWith(prefix))
    )
      return undefined;
    const identity = await sha256(new TextEncoder().encode(key)),
      prefix = identity.slice(0, root.shardPrefixLength ?? 2),
      reference = root.shards[prefix];
    if (!reference) return undefined;
    let pending = shards.get(prefix);
    if (!pending) {
      // Parsed metadata is also bounded; never retain every shard in a query.
      if (shards.size >= 16) shards.delete(shards.keys().next().value!);
      pending = readAsset(reference.sha256, reference.bytes).then((raw) =>
        HistoryAssetShardSchema.parse(JSON.parse(text.decode(raw))),
      );
      shards.set(prefix, pending);
    }
    const object = (await pending).objects[identity];
    if (partitions && object?.chunks.some((chunk) => chunk.bytes > 128 * 1024))
      throw new Error("Partitioned history asset chunk exceeds its size bound");
    if (
      object &&
      (object.key !== key ||
        object.chunks.reduce((sum, c) => sum + c.bytes, 0) !== object.bytes)
    )
      throw new Error("Immutable history asset object mapping changed");
    return object;
  }

  return {
    async read(key, etag, offset, length) {
      if (!HISTORY_ASSET_OBJECT_KEY.test(key))
        return fallback.read(key, etag, offset, length);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 16 * 1024 * 1024 ||
        !Number.isSafeInteger(offset + length)
      )
        throw new Error("Invalid immutable history asset range");
      const object = await locate(key);
      if (!object) return fallback.read(key, etag, offset, length);
      if (object.etag !== etag || offset + length > object.bytes)
        throw new Error("Immutable history asset original identity changed");
      const output = new Uint8Array(length),
        end = offset + length;
      let position = 0,
        written = 0;
      for (const chunk of object.chunks) {
        const chunkEnd = position + chunk.bytes;
        if (position < end && chunkEnd > offset) {
          const raw = await readAsset(
              chunk.sha256,
              chunk.bytes,
              true,
              object.key.endsWith(".json"),
            ),
            from = Math.max(offset, position) - position,
            to = Math.min(end, chunkEnd) - position;
          output.set(raw.subarray(from, to), written);
          written += to - from;
        }
        position = chunkEnd;
      }
      return output.buffer;
    },
  };
}
