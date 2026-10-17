import { historySha256 } from "./history-sha256.ts";
import { Buffer } from "node:buffer";

export const SYNC_QUARANTINE_PREFIX = "sync-quarantine:v1:";
export const SYNC_QUARANTINE_MAX_BYTES = 192 * 1024;
export type SyncDeadLetterStore = Pick<KVNamespace, "get" | "put" | "list">;

export function syncDeadLetterObservationKey(
  custodySha256: string,
  attempts: number,
  sha256: string,
): string {
  return `${SYNC_QUARANTINE_PREFIX}${custodySha256}:${String(attempts).padStart(16, "0")}:${sha256}`;
}

/** Bound stored bytes before copying them into memory, including corrupt keys. */
export async function readSyncDeadLetterEnvelope(
  store: Pick<KVNamespace, "get">,
  key: string,
): Promise<Buffer | null> {
  const stream = await store.get(key, "stream");
  if (stream === null) return null;
  const output = Buffer.alloc(SYNC_QUARANTINE_MAX_BYTES);
  const reader = stream.getReader();
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.length > output.length)
        throw new Error("Sync dead letter exceeds envelope budget");
      output.set(next.value, offset);
      offset += next.value.length;
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  return output.subarray(0, offset);
}

/** Reject values JSON serialization would silently change or discard. */
function assertJson(value: unknown, ancestors = new Set<unknown>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      !Object.is(value, -0))
  )
    return;
  if (typeof value !== "object" || ancestors.has(value))
    throw new Error("Sync dead letter is not JSON");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length
  )
    throw new Error("Sync dead letter is not JSON");
  const properties = Object.getOwnPropertyDescriptors(value);
  if (array) delete properties.length;
  if (
    array &&
    (Object.keys(properties).length !== value.length ||
      Object.keys(properties).some(
        (key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length,
      ))
  )
    throw new Error("Sync dead letter is not JSON");
  ancestors.add(value);
  for (const descriptor of Object.values(properties)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error("Sync dead letter is not JSON");
    assertJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

/** Preserve stable custody and one exact delivery observation independently.
 * Binary bodies retain transport bytes; JSON retains the consumer-observed
 * value, not the producer's original serialization. A verified observation may
 * belong to an earlier attempt; this is not a complete attempt history. */
export async function preserveSyncDeadLetter(
  store: SyncDeadLetterStore | undefined,
  queue: string,
  message: {
    readonly id?: string;
    readonly body: unknown;
    readonly timestamp?: Date;
    readonly attempts?: number;
  },
): Promise<void> {
  const publishedAt =
    message.timestamp instanceof Date ? message.timestamp.getTime() : undefined;
  if (
    !store ||
    queue !== "sync-batches-dlq" ||
    typeof message.id !== "string" ||
    !message.id ||
    message.id.length > 256 ||
    !Number.isSafeInteger(publishedAt) ||
    publishedAt! < 0 ||
    !Number.isSafeInteger(message.attempts) ||
    message.attempts! < 1
  )
    throw new Error("Sync dead letter needs a store and delivery identity");
  const body =
    message.body instanceof ArrayBuffer
      ? new Uint8Array(message.body)
      : message.body;
  const binary = body instanceof Uint8Array;
  if (!binary) assertJson(body);
  const bytes = Buffer.from(binary ? body : JSON.stringify(body));
  if (bytes.length > 128 * 1024)
    throw new Error("Sync dead letter exceeds 128 KiB");
  const envelope = Buffer.from(
    JSON.stringify({
      version: 2,
      kind: "custody",
      queue,
      message_id: message.id,
      published_at: publishedAt,
      representation: binary ? "bytes" : "json",
      body_bytes: bytes.length,
      body_sha256: historySha256(bytes),
      payload: bytes.toString("base64"),
    }),
  );
  const custodySha256 = historySha256(envelope);
  const key = SYNC_QUARANTINE_PREFIX + custodySha256;
  let stored = await readSyncDeadLetterEnvelope(store, key);
  if (stored !== null && !envelope.equals(stored))
    throw new Error("Sync dead letter readback differs");

  // Discover an older actual observation through a stable prefix, rather than
  // requiring each new delivery's fresh key to become immediately readable.
  // Attempt-first lexical order keeps the earliest visible candidate stable.
  const prefix = key + ":";
  const page = await store.list({ prefix, limit: 1 });
  if (
    !Array.isArray(page.keys) ||
    page.keys.length > 1 ||
    typeof page.list_complete !== "boolean" ||
    (!page.keys.length && !page.list_complete)
  )
    throw new Error("Sync dead letter observation page differs");
  let attempts = message.attempts!;
  const candidate = page.keys[0]?.name;
  if (page.keys.length && typeof candidate !== "string")
    throw new Error("Sync dead letter observation key differs");
  if (candidate !== undefined) {
    const suffix = candidate.slice(prefix.length);
    const match = /^(\d{16}):([a-f0-9]{64})$/.exec(suffix);
    if (
      !candidate.startsWith(prefix) ||
      !match ||
      match[0].length !== suffix.length ||
      !Number.isSafeInteger(Number(match[1])) ||
      Number(match[1]) < 1
    )
      throw new Error("Sync dead letter observation key differs");
    attempts = Number(match[1]);
  }
  const observation = Buffer.from(
    JSON.stringify({
      version: 2,
      kind: "observation",
      custody_sha256: custodySha256,
      attempts,
    }),
  );
  const observationKey = syncDeadLetterObservationKey(
    custodySha256,
    attempts,
    historySha256(observation),
  );
  if (candidate !== undefined && candidate !== observationKey)
    throw new Error("Sync dead letter observation digest differs");
  let observed = await readSyncDeadLetterEnvelope(store, observationKey);
  if (
    (candidate !== undefined && observed === null) ||
    (observed !== null && !observation.equals(observed))
  )
    throw new Error("Sync dead letter observation readback differs");

  // Stage both immutable records before confirmation. A later delivery can
  // confirm these same bytes after a cached miss or a lost write response.
  // KV has no CAS: compliant concurrent writers produce identical key/value
  // pairs; every observed mismatch is refused without overwriting it.
  if (stored === null) await store.put(key, envelope.toString("utf8"));
  if (observed === null)
    await store.put(observationKey, observation.toString("utf8"));
  if (stored === null) stored = await readSyncDeadLetterEnvelope(store, key);
  if (observed === null)
    observed = await readSyncDeadLetterEnvelope(store, observationKey);
  if (stored === null || !envelope.equals(stored))
    throw new Error("Sync dead letter readback differs");
  if (observed === null || !observation.equals(observed))
    throw new Error("Sync dead letter observation readback differs");
}
