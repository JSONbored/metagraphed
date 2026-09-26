import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export interface HistoryTransferSource {
  key: string;
  bytes: number;
  sha256: string;
  etag: string;
}

interface Chunk {
  sha256: string;
  bytes: number;
}

export interface HistoryTransferIo {
  get(source: HistoryTransferSource): Promise<{
    body: ReadableStream<Uint8Array> | null;
    size: number;
    etag: string;
  } | null>;
  session(
    partition: string,
    manifest: Record<string, { hash: string; size: number }>,
  ): Promise<{ jwt: string; buckets: string[][] }>;
  upload(jwt: string, body: FormData): Promise<{ jwt?: string }>;
}

const CHUNK_BYTES = 128 * 1024;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
const digest = (kind: string, raw: Uint8Array) =>
  createHash(kind).update(raw).digest("hex");

async function readExact(body: ReadableStream<Uint8Array>, bytes: number) {
  const reader = body.getReader();
  const raw = new Uint8Array(bytes);
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.length > bytes)
        throw new Error("History transfer source exceeds its bound");
      raw.set(next.value, offset);
      offset += next.value.length;
    }
    if (offset !== bytes)
      throw new Error("History transfer source is truncated");
    return raw;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Discover chunk hashes and upload from the same bounded source read. Upload
 * sessions stage bytes only: the caller must independently verify them, publish
 * a complete manifest retaining the old release, and qualify readers before
 * deleting any source. This function never publishes or deletes anything. */
export async function transferHistoryAssets(
  sources: readonly HistoryTransferSource[],
  io: HistoryTransferIo,
) {
  if (sources.length < 1 || sources.length > 16)
    throw new Error("Invalid history transfer batch");
  const keys = new Set<string>();
  let sourceBytes = 0;
  for (const source of sources) {
    if (
      !Number.isSafeInteger(source.bytes) ||
      source.bytes <= 0 ||
      source.bytes > MAX_BATCH_BYTES ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !/^[a-f0-9]{32}$/.test(source.etag) ||
      !source.key.endsWith(`/${source.sha256}.bin`) ||
      keys.has(source.key)
    )
      throw new Error("Invalid history transfer source");
    keys.add(source.key);
    sourceBytes += source.bytes;
  }
  if (sourceBytes > MAX_BATCH_BYTES)
    throw new Error("History transfer batch exceeds its memory budget");

  const groups = new Map<string, Map<string, Uint8Array>>();
  const files: { source: HistoryTransferSource; chunks: Chunk[] }[] = [];
  for (const source of sources) {
    const object = await io.get(source);
    if (
      !object?.body ||
      object.size !== source.bytes ||
      object.etag !== source.etag
    ) {
      await object?.body?.cancel();
      throw new Error("History transfer source identity changed");
    }
    const raw = await readExact(object.body, source.bytes);
    if (
      digest("sha256", raw) !== source.sha256 ||
      digest("md5", raw) !== source.etag
    )
      throw new Error("History transfer source content changed");
    const chunks: Chunk[] = [];
    for (let offset = 0; offset < raw.length; offset += CHUNK_BYTES) {
      const bytes = raw.subarray(offset, offset + CHUNK_BYTES);
      const sha256 = digest("sha256", bytes);
      chunks.push({ sha256, bytes: bytes.length });
      const partition = sha256[0]!;
      let group = groups.get(partition);
      if (!group) groups.set(partition, (group = new Map()));
      group.set(sha256, bytes);
    }
    files.push({ source: { ...source }, chunks });
  }

  let uploadRequests = 0;
  let uploadedBytes = 0;
  // Validate every hash before starting uploads. Four bounded lanes overlap
  // network latency; the I/O adapter still enforces the account request rate.
  const partitions = [...groups].map(([partition, chunks]) => {
    const byHash = new Map(
      [...chunks].map(([sha256, raw]) => [sha256.slice(0, 32), raw]),
    );
    if (byHash.size !== chunks.size)
      throw new Error("History transfer upload hash collision");
    const manifest = Object.fromEntries(
      [...chunks].map(([sha256, raw]) => [
        `/${sha256}.mgpack`,
        { hash: sha256.slice(0, 32), size: raw.length },
      ]),
    );
    return { partition, manifest, byHash };
  });
  async function uploadPartition({
    partition,
    manifest,
    byHash,
  }: (typeof partitions)[number]) {
    const session = await io.session(partition, manifest);
    if (
      typeof session.jwt !== "string" ||
      session.jwt.length < 1 ||
      session.jwt.length > 8192 ||
      !Array.isArray(session.buckets)
    )
      throw new Error("Invalid history transfer upload session");
    const missing = new Set<string>();
    for (const bucket of session.buckets) {
      if (!Array.isArray(bucket) || bucket.length === 0)
        throw new Error("Invalid history transfer upload bucket");
      for (const hash of bucket) {
        if (!byHash.has(hash) || missing.has(hash))
          throw new Error("History transfer session requested unknown bytes");
        missing.add(hash);
      }
    }
    let completed = session.buckets.length === 0;
    for (const bucket of session.buckets) {
      const form = new FormData();
      for (const hash of bucket) {
        const raw = byHash.get(hash)!;
        form.set(
          hash,
          new Blob([Buffer.from(raw).toString("base64")], {
            type: "application/octet-stream",
          }),
          hash,
        );
        uploadedBytes += raw.length;
      }
      const result = await io.upload(session.jwt, form);
      uploadRequests++;
      completed = typeof result.jwt === "string" && result.jwt.length > 0;
    }
    if (!completed)
      throw new Error("History transfer upload completion missing");
  }
  let cursor = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(4, partitions.length) },
    async () => {
      while (!failed && cursor < partitions.length) {
        const partition = partitions[cursor++]!;
        try {
          await uploadPartition(partition);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );
  // A failed lane waits for already-started work before returning. Callers can
  // then clean up the staging helper without abandoning an in-flight upload.
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return {
    files,
    sourceBytes,
    uploadedBytes,
    uploadRequests,
    sessions: groups.size,
  };
}
