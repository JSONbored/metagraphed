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
