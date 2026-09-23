import { z } from "zod";
import { artifactBucket, type ArtifactStoreEnv } from "./projection-store.ts";

const ROOT = "metagraph/rpc-usage-native/v1";
const DAY = 86_400_000;
const integer = z.number().int().nonnegative();
const text = z.string().max(2048).nullable();
const Row = z.tuple([
  integer,
  text,
  text,
  text,
  z.boolean().nullable(),
  z.number().int().nullable(),
  z.number().int().nullable(),
  text,
  integer.min(1).max(1_000_000).nullable(),
]);
export type NativeRpcRow = z.infer<typeof Row>;
const ObjectRef = z.strictObject({
  key: z.string(),
  etag: z.string().min(1),
  bytes: integer.positive().max(2 * 1024 * 1024),
});
const Manifest = z.strictObject({
  version: z.literal(1),
  table: z.literal("rpc_proxy_events"),
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  generatedAt: integer,
  retainedFrom: integer,
  rowCount: integer.max(8192 * 2048),
  sourceRows: integer,
  source: z.strictObject({
    tableUuid: z.string().min(1),
    snapshot: z.string().regex(/^[0-9]+$/),
    sequence: integer,
    sources: z
      .array(
        z.strictObject({
          bucket: z.string().min(1),
          key: z.string().min(1),
          etag: z.string().min(1),
          bytes: integer.positive(),
          rows: integer,
        }),
      )
      .max(10_000),
  }),
  chunks: z
    .array(
      z.strictObject({
        object: ObjectRef,
        rawBytes: integer.positive().max(2 * 1024 * 1024),
        rows: integer.positive().max(8192),
        first: integer,
        last: integer,
      }),
    )
    .max(2048),
});

async function rowsFromObject(object: R2ObjectBody, bytes: number) {
  const reader = object.body
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const raw = new Uint8Array(bytes);
  let offset = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.length > bytes)
        throw new Error("RPC chunk exceeds declared size");
      raw.set(part.value, offset);
      offset += part.value.length;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (offset !== bytes) throw new Error("Truncated RPC chunk");
  return z
    .array(Row)
    .max(8192)
    .parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw),
      ),
    );
}

/** Undefined means unpublished; selected corrupt data never enables SQL. */
export async function readNativeRpcRows(
  env: unknown,
  cutoff: number,
  until: number | null,
  now: number,
  consume: (row: NativeRpcRow) => void,
): Promise<boolean | undefined> {
  const bucket = artifactBucket(env as ArtifactStoreEnv) as Pick<
    R2Bucket,
    "get"
  > | null;
  if (!bucket) return undefined;
  try {
    const pointer = await bucket.get(`${ROOT}/current.json`);
    if (!pointer) return undefined;
    if (pointer.size <= 0 || pointer.size > 1024 * 1024) return false;
    const manifest = Manifest.parse(await pointer.json());
    if (
      manifest.generatedAt > now ||
      now - manifest.generatedAt > 2 * DAY ||
      manifest.retainedFrom !==
        (Math.floor(manifest.generatedAt / DAY) - 32) * DAY ||
      cutoff < manifest.retainedFrom ||
      manifest.sourceRows < manifest.rowCount ||
      manifest.source.sources.reduce((n, s) => n + s.rows, 0) !==
        manifest.sourceRows ||
      manifest.chunks.reduce((n, c) => n + c.rows, 0) !== manifest.rowCount ||
      manifest.source.sources.some(
        (s, i, all) => i > 0 && s.key <= all[i - 1].key,
      )
    )
      return false;
    const proof = await bucket.get(
      `${ROOT}/${manifest.generation}/manifest.json`,
    );
    if (
      !proof ||
      proof.size !== pointer.size ||
      JSON.stringify(Manifest.parse(await proof.json())) !==
        JSON.stringify(manifest)
    )
      return false;
    const selected: typeof manifest.chunks = [];
    for (const chunk of manifest.chunks) {
      if (
        !new RegExp(`^${ROOT}/chunks/[0-9a-f]{64}\\.json\\.gz$`).test(
          chunk.object.key,
        ) ||
        chunk.first < manifest.retainedFrom ||
        chunk.first > chunk.last ||
        chunk.last > manifest.generatedAt + DAY ||
        Math.floor(chunk.first / DAY) !== Math.floor(chunk.last / DAY)
      )
        return false;
      if (chunk.last < cutoff || (until !== null && chunk.first >= until))
        continue;
      selected.push(chunk);
    }
    if (
      selected.length > 1024 ||
      selected.reduce((n, c) => n + c.object.bytes, 0) > 64 * 1024 * 1024 ||
      selected.reduce((n, c) => n + c.rawBytes, 0) > 512 * 1024 * 1024
    )
      return false;
    for (const chunk of selected) {
      const object = await bucket.get(chunk.object.key, {
        onlyIf: { etagMatches: chunk.object.etag },
      });
      if (
        !object ||
        !("body" in object) ||
        object.etag !== chunk.object.etag ||
        object.size !== chunk.object.bytes
      )
        return false;
      const rows = await rowsFromObject(object, chunk.rawBytes);
      if (
        rows.length !== chunk.rows ||
        Math.min(...rows.map((r) => r[0])) !== chunk.first ||
        Math.max(...rows.map((r) => r[0])) !== chunk.last
      )
        return false;
      for (const row of rows)
        if (row[0] >= cutoff && (until === null || row[0] < until))
          consume(row);
    }
    return true;
  } catch {
    return false;
  }
}
