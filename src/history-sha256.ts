import { createHash } from "node:crypto";

/** Preserve exact UTF-8 strings and byte views used by immutable history keys. */
export function historySha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
