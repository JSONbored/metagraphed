import { z } from "zod";
import { artifactBucket, type ArtifactStoreEnv } from "./projection-store.ts";
import { r2ParquetSource } from "./indexed-parquet.ts";

const ROOT = "metagraph/account-weight-setters-native/v1/mainnet";
const DAY = 86_400_000;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signed = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const Entry = z.strictObject({
  id: hash,
  offset: integer,
  length: integer.positive().max(2 * 1024 * 1024),
  rawBytes: integer.positive().max(16 * 1024 * 1024),
  rows: integer.positive().max(262144),
  events: integer.positive(),
  object: z.strictObject({
    key: z.string(),
    etag: z.string().min(1),
    bytes: integer.positive().max(16 * 1024 * 1024),
  }),
});
const Manifest = z.strictObject({
  version: z.literal(1),
  network: z.literal("mainnet"),
  table: z.literal("account_events"),
  generation: hash,
  generatedAt: integer,
  retainedFrom: integer,
  readerCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sourceRows: integer,
  events: integer,
  source: z.strictObject({
    table_uuid: z.string().min(1),
    snapshot: z.string().regex(/^[0-9]+$/),
    sequence: integer,
    coverage: z.string().nullable(),
    identity: hash,
  }),
  entries: z.array(Entry).max(32768),
});
const Payload = z.strictObject({
  selector: z.string().max(256),
  rows: z
    .array(z.tuple([signed.nullable(), integer, integer.positive()]))
    .max(262144),
});
type Group = {
  netuid: number | null;
  weight_sets: number;
  first_observed: number;
  last_observed: number;
};

async function decode(compressed: ArrayBuffer, size: number) {
  const reader = new Response(compressed)
    .body!.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const raw = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.length > size)
        throw Error("Weight index exceeds decoded budget");
      raw.set(part.value, offset);
      offset += part.value.length;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (offset !== size) throw Error("Truncated weight index");
  return Payload.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw),
    ),
  );
}

/** Exact hotkey/UID union over one complete source snapshot. A selected bad
 * publication declines; it cannot trigger a warehouse scan or a partial card. */
export async function loadNativeAccountWeightSetters(
  env: unknown,
  hotkey: string,
  slots: readonly { netuid: number; uid: number }[],
  cutoff: number,
  now = Date.now(),
): Promise<Group[] | null | undefined> {
  const bucket = artifactBucket(env as ArtifactStoreEnv) as Pick<
    R2Bucket,
    "get"
  > | null;
  if (!bucket) return undefined;
  try {
    const object = await bucket.get(`${ROOT}/current.json`);
    if (!object) return undefined;
    if (object.size <= 0 || object.size > 8 * 1024 * 1024) return null;
    const manifest = Manifest.parse(await object.json());
    if (
      manifest.generatedAt > now ||
      now - manifest.generatedAt > 2 * 60 * 60 * 1000 ||
      manifest.retainedFrom !==
        (Math.floor(manifest.generatedAt / DAY) - 32) * DAY ||
      cutoff < manifest.retainedFrom ||
      manifest.sourceRows < manifest.events ||
      manifest.entries.reduce((n, entry) => n + entry.events, 0) !==
        manifest.events
    )
      return null;
    for (const [i, entry] of manifest.entries.entries()) {
      if (
        (i > 0 && entry.id <= manifest.entries[i - 1].id) ||
        !new RegExp(`^${ROOT}/packs/[0-9a-f]{64}\\.bin$`).test(
          entry.object.key,
        ) ||
        entry.offset + entry.length > entry.object.bytes
      )
        return null;
    }
    const proof = await bucket.get(
      `${ROOT}/${manifest.generation}/manifest.json`,
    );
    if (
      !proof ||
      proof.size !== object.size ||
      JSON.stringify(Manifest.parse(await proof.json())) !==
        JSON.stringify(manifest)
    )
      return null;
    const selectors = [
      ...new Set([
        `h:${hotkey}`,
        ...slots.map((s) => `u:${s.netuid}:${s.uid}`),
      ]),
    ];
    if (selectors.length > 512) return null;
    const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
    const selected = [];
    for (const selector of selectors) {
      const id = [
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(selector),
          ),
        ),
      ]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      const entry = byId.get(id);
      if (entry) selected.push({ selector, entry });
    }
    if (
      selected.reduce((n, item) => n + item.entry.length, 0) >
        32 * 1024 * 1024 ||
      selected.reduce((n, item) => n + item.entry.rawBytes, 0) >
        128 * 1024 * 1024
    )
      return null;
    const source = r2ParquetSource(bucket),
      groups = new Map<number | null, Group>();
    // Four compressed ranges overlap latency while decode remains sequential.
    // At most 8 MiB of prefetched compressed data accompanies one decoded body.
    for (let start = 0; start < selected.length; start += 4) {
      const batch = await Promise.all(
        selected.slice(start, start + 4).map(async (item) => ({
          ...item,
          bytes: await source.read(
            item.entry.object.key,
            item.entry.object.etag,
            item.entry.offset,
            item.entry.length,
          ),
        })),
      );
      for (const { selector, entry, bytes } of batch) {
        const payload = await decode(bytes, entry.rawBytes);
        if (
          payload.selector !== selector ||
          payload.rows.length !== entry.rows ||
          payload.rows.reduce((n, row) => n + row[2], 0) !== entry.events
        )
          return null;
        let previous: [number | null, number, number] | undefined;
        for (const row of payload.rows) {
          const [netuid, observed, count] = row;
          if (
            (selector.startsWith("u:") &&
              String(netuid) !== selector.split(":")[1]) ||
            observed < manifest.retainedFrom ||
            (previous &&
              ((netuid ?? -Infinity) < (previous[0] ?? -Infinity) ||
                (netuid === previous[0] && observed <= previous[1])))
          )
            return null;
          previous = row;
          if (observed < cutoff) continue;
          let group = groups.get(netuid);
          if (!group) {
            group = {
              netuid,
              weight_sets: 0,
              first_observed: observed,
              last_observed: observed,
            };
            groups.set(netuid, group);
          }
          group.weight_sets += count;
          group.first_observed = Math.min(group.first_observed, observed);
          group.last_observed = Math.max(group.last_observed, observed);
        }
      }
    }
    return [...groups.values()];
  } catch {
    return null;
  }
}
