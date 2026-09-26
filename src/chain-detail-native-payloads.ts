// Exact compressed bytes live with the hot D1 data. Common calls compress into
// their own row; exceptional values use immutable chunks below D1's 2 MB limit.
import type { D1StoreBinding } from "./d1-store.ts";

export const NATIVE_PAYLOAD_PREFIX = "\0metagraphed:payload:v1:";
const INLINE_ENCODED_BYTES = 128 * 1024;
const CHUNK_BYTES = 1_490_000;

function database(env: unknown): D1StoreBinding {
  const db = (env as { D1_STATE?: D1StoreBinding } | null)?.D1_STATE;
  if (!db) throw new Error("Chain detail payload D1 is unbound");
  return db;
}
function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function decode(encoded: string, size: number): Uint8Array {
  if (encoded.length !== 4 * Math.ceil(size / 3))
    throw new Error("Truncated native chain detail payload");
  const binary = atob(encoded);
  if (binary.length !== size || btoa(binary) !== encoded)
    throw new Error("Corrupt native chain detail payload encoding");
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function readNativePayload(
  env: unknown,
  hash: string,
  size: number,
  location: string,
): Promise<Uint8Array> {
  if (location.startsWith("inline:")) {
    const encoded = location.slice(7);
    if (encoded.length > INLINE_ENCODED_BYTES)
      throw new Error("Native inline payload exceeds byte budget");
    return decode(encoded, size);
  }
  const count = Math.ceil(size / CHUNK_BYTES);
  const { results } = await database(env)
    .prepare(
      "SELECT part, data FROM chain_detail_payload_chunks WHERE sha256 = ? ORDER BY part LIMIT 13",
    )
    .bind(hash)
    .all<{ part: number; data: string }>();
  if (results.length !== count)
    throw new Error("Missing native chain detail payload chunks");
  const bytes = new Uint8Array(size);
  for (const [i, row] of results.entries()) {
    if (row.part !== i)
      throw new Error("Corrupt native chain detail payload ordering");
    bytes.set(
      decode(row.data, Math.min(CHUNK_BYTES, size - i * CHUNK_BYTES)),
      i * CHUNK_BYTES,
    );
  }
  return bytes;
}

/** Finish and verify all chunks before publishing a row reference. A failed
 * row transaction can leave only unreferenced immutable chunks. */
export async function writeNativePayload(
  env: unknown,
  hash: string,
  rawBytes: number,
  bytes: Uint8Array,
  encoding: "gzip" | "raw",
): Promise<string> {
  const prefix = `${NATIVE_PAYLOAD_PREFIX}${hash}:${rawBytes}:${bytes.length}:${encoding}:`;
  if (4 * Math.ceil(bytes.length / 3) <= INLINE_ENCODED_BYTES)
    return prefix + "inline:" + encode(bytes);
  const db = database(env);
  const statements = [];
  for (let i = 0; i * CHUNK_BYTES < bytes.length; i++)
    statements.push(
      db
        .prepare(
          "INSERT INTO chain_detail_payload_chunks (sha256, part, data) VALUES (?, ?, ?) ON CONFLICT (sha256, part) DO NOTHING",
        )
        .bind(
          hash,
          i,
          encode(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)),
        ),
    );
  await db.batch(statements);
  const stored = await readNativePayload(env, hash, bytes.length, "d1");
  if (stored.some((byte, i) => byte !== bytes[i]))
    throw new Error("Native chain detail payload conflict");
  return prefix + "d1";
}
