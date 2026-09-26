// Large decoded calls retain exact logical bytes in compressed inline values
// or immutable D1 chunks. R2 references remain readable during retirement.
import {
  NATIVE_PAYLOAD_PREFIX,
  readNativePayload,
  writeNativePayload,
} from "./chain-detail-native-payloads.ts";
const PREFIX = "\0metagraphed:r2:";
const INLINE_BYTES = 128 * 1024;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const FIELDS = ["call_args", "args"] as const;
type Row = Record<string, unknown>;

function bucket(env: unknown): R2Bucket {
  const binding = (env as { METAGRAPH_ARCHIVE?: R2Bucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!binding) throw new Error("Chain detail payload archive is unbound");
  return binding;
}
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function objectKey(hash: string, compressed: boolean): string {
  return `metagraph/d1-chain-payloads/v1/${hash}.json${compressed ? ".gz" : ""}`;
}

async function writeLegacyPayload(
  env: unknown,
  hash: string,
  rawBytes: number,
  bytes: Uint8Array,
  compressed: boolean,
): Promise<string> {
  const archive = bucket(env);
  const key = objectKey(hash, compressed);
  // Captures and retries often repeat the same large call. Reuse an
  // immutable object before sending its body again; the conditional put
  // still handles a competing writer between this head and the upload.
  let object = await archive.head(key);
  if (!object) {
    object = await archive.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { sha256: hash, rawBytes: String(rawBytes) },
      httpMetadata: { contentType: "application/octet-stream" },
    });
    if (!object) object = await archive.head(key);
  }
  if (
    !object ||
    object.size !== bytes.byteLength ||
    object.customMetadata?.sha256 !== hash
  )
    throw new Error("Chain detail payload object conflict");
  return `${PREFIX}v2:${hash}:${rawBytes}:${bytes.byteLength}:${compressed ? "gzip" : "raw"}`;
}

/** Prepare exact payloads before committing their chain-detail references. */
export async function storeChainDetailPayloads(
  env: unknown,
  rows: Row[],
): Promise<Row[]> {
  // Enable only after both production readers support the new reference.
  const native =
    (env as { NATIVE_CHAIN_PAYLOADS?: string } | null)
      ?.NATIVE_CHAIN_PAYLOADS === "enabled";
  const output: Row[] = [];
  const prepared = new Map<string, string>();
  let total = 0;
  for (const row of rows) {
    const next = { ...row };
    for (const field of FIELDS) {
      const value = row[field];
      if (typeof value !== "string") continue;
      if (value.startsWith(PREFIX) || value.startsWith(NATIVE_PAYLOAD_PREFIX))
        throw new Error("Reserved chain detail payload reference");
      const raw = new TextEncoder().encode(value);
      total += raw.byteLength;
      if (raw.byteLength > MAX_VALUE_BYTES || total > MAX_BATCH_BYTES)
        throw new RangeError("Chain detail payload exceeds byte budget");
      if (raw.byteLength <= INLINE_BYTES) continue;
      const hash = await digest(raw);
      const prior = prepared.get(hash);
      if (prior !== undefined) {
        next[field] = prior;
        continue;
      }
      const zipped = new Uint8Array(
        await new Response(
          new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer(),
      );
      const compressed = zipped.byteLength < raw.byteLength;
      const bytes = compressed ? zipped : raw;
      next[field] = native
        ? await writeNativePayload(
            env,
            hash,
            raw.byteLength,
            bytes,
            compressed ? "gzip" : "raw",
          )
        : await writeLegacyPayload(
            env,
            hash,
            raw.byteLength,
            bytes,
            compressed,
          );
      prepared.set(hash, next[field] as string);
    }
    output.push(next);
  }
  return output;
}

/** Hydrate only selected rows, with a cumulative decompression budget and a
 * digest over logical bytes. v1 also reads the initial uncompressed migration. */
export async function restoreChainDetailPayloads(
  env: unknown,
  rows: Row[],
): Promise<Row[]> {
  let total = 0;
  const cache = new Map<string, string>();
  const output: Row[] = [];
  for (const row of rows) {
    const next = { ...row };
    for (const field of FIELDS) {
      const reference = row[field];
      if (
        typeof reference !== "string" ||
        (!reference.startsWith(PREFIX) &&
          !reference.startsWith(NATIVE_PAYLOAD_PREFIX))
      )
        continue;
      const native = reference.startsWith(NATIVE_PAYLOAD_PREFIX);
      const nativeMatch = native
        ? /^([a-f0-9]{64}):([1-9][0-9]*):([1-9][0-9]*):(gzip|raw):(d1|inline:[A-Za-z0-9+/]*={0,2})$/.exec(
            reference.slice(NATIVE_PAYLOAD_PREFIX.length),
          )
        : null;
      const match =
        /^(?:v1:([a-f0-9]{64}):([1-9][0-9]*)|v2:([a-f0-9]{64}):([1-9][0-9]*):([1-9][0-9]*):(gzip|raw))$/.exec(
          reference.slice(PREFIX.length),
        );
      if (native ? !nativeMatch : !match)
        throw new Error("Invalid chain detail payload reference");
      const hash = native ? nativeMatch![1] : (match![1] ?? match![3]);
      const rawBytes = Number(
        native ? nativeMatch![2] : (match![2] ?? match![4]),
      );
      const storedBytes = Number(
        native ? nativeMatch![3] : (match![5] ?? match![2]),
      );
      const compressed = (native ? nativeMatch![4] : match![6]) === "gzip";
      total += rawBytes;
      if (
        !Number.isSafeInteger(rawBytes) ||
        !Number.isSafeInteger(storedBytes) ||
        rawBytes > MAX_VALUE_BYTES ||
        storedBytes > MAX_VALUE_BYTES ||
        total > MAX_BATCH_BYTES
      )
        throw new RangeError("Chain detail payload exceeds byte budget");
      let value = cache.get(reference);
      if (value === undefined) {
        let body: ReadableStream<Uint8Array>;
        if (native) {
          const bytes = await readNativePayload(
            env,
            hash,
            storedBytes,
            nativeMatch![5],
          );
          body = new Blob([bytes]).stream();
        } else {
          const object = await bucket(env).get(objectKey(hash, compressed));
          if (!object || object.size !== storedBytes)
            throw new Error("Missing or truncated chain detail payload");
          body = object.body;
        }
        const stream = compressed
          ? body.pipeThrough(new DecompressionStream("gzip"))
          : body;
        const reader = stream.getReader();
        const bytes = new Uint8Array(rawBytes);
        let offset = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (offset + chunk.value.byteLength > rawBytes)
              throw new Error(
                "Chain detail payload expands beyond declared size",
              );
            bytes.set(chunk.value, offset);
            offset += chunk.value.byteLength;
          }
        } finally {
          await reader.cancel();
        }
        if (offset !== rawBytes || (await digest(bytes)) !== hash)
          throw new Error("Corrupt chain detail payload");
        value = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        cache.set(reference, value);
      }
      next[field] = value;
    }
    output.push(next);
  }
  return output;
}
