import { Buffer } from "node:buffer";

/** Preserve failed transport bytes before Queue acknowledgment (#12270).
 * This never applies the sync write. Replay is a separate, reviewed operation. */
export async function preserveSyncDeadLetter(
  db: Pick<D1Database, "prepare"> | undefined,
  message: { readonly id?: string; readonly body: unknown },
  receivedAt: number,
): Promise<void> {
  if (!db || !message.id || message.id.length > 256)
    throw new Error("Sync dead letter needs a store and message identity");
  const binary =
    message.body instanceof ArrayBuffer || message.body instanceof Uint8Array;
  const serialized = binary ? null : JSON.stringify(message.body);
  if (!binary && serialized === undefined)
    throw new Error("Sync dead letter body is not serializable");
  const bytes = binary
    ? Buffer.from(new Uint8Array(message.body as ArrayBuffer | Uint8Array))
    : Buffer.from(serialized!, "utf8");
  if (bytes.length > 128 * 1024)
    throw new Error("Sync dead letter exceeds the transport byte bound");
  const encoding = binary ? "base64" : "json";
  const sha = Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  const written = await db
    .prepare(
      `INSERT INTO sync_dead_letters(message_id,body_sha256,encoding,payload,received_at)
       VALUES(?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`,
    )
    .bind(
      message.id,
      sha,
      encoding,
      bytes.toString(binary ? "base64" : "utf8"),
      receivedAt,
    )
    .run();
  if (!written.success) throw new Error("Sync dead letter persistence failed");
  const stored = await db
    .prepare(
      "SELECT body_sha256,encoding FROM sync_dead_letters WHERE message_id=?",
    )
    .bind(message.id)
    .first<{ body_sha256: string; encoding: string }>();
  if (stored?.body_sha256 !== sha || stored.encoding !== encoding)
    throw new Error("Sync dead letter readback differs from delivery");
}
