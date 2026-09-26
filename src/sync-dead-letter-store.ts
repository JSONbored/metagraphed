import { Buffer } from "node:buffer";

/** Preserve transport bytes before acknowledgment, without replay (#12270). */
export async function preserveSyncDeadLetter(
  db: Pick<D1Database, "prepare"> | undefined,
  message: { readonly id?: string; readonly body: unknown },
  receivedAt: number,
): Promise<void> {
  if (!db || !message.id || message.id.length > 256)
    throw new Error("Sync dead letter needs a store and message identity");
  const body =
    message.body instanceof ArrayBuffer
      ? new Uint8Array(message.body)
      : message.body;
  const binary = body instanceof Uint8Array;
  // Buffer.from rejects undefined; JSON.stringify rejects cycles and bigint.
  const bytes = Buffer.from(binary ? body : JSON.stringify(body));
  if (bytes.length > 128 * 1024)
    throw new Error("Sync dead letter exceeds 128 KiB");
  const encoding = binary ? "base64" : "json";
  const sha = Buffer.from(
    await crypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  const stored = await db
    .prepare(
      `INSERT INTO sync_dead_letters(message_id,body_sha256,encoding,payload,received_at)
       VALUES(?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET message_id=excluded.message_id
       RETURNING body_sha256,encoding`,
    )
    .bind(
      message.id,
      sha,
      encoding,
      bytes.toString(binary ? "base64" : "utf8"),
      receivedAt,
    )
    .first<{ body_sha256: string; encoding: string }>();
  if (stored?.body_sha256 !== sha || stored.encoding !== encoding)
    throw new Error("Sync dead letter readback differs");
}
